import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import { closeDb, getDb } from '../../server/db/index.js'
import { runMigrations } from '../../server/db/migrations.js'
import { createMistralVibeEngine } from '../../server/services/agent/engines/mistral-vibe/engine.js'
import type { AgentEvent, EngineProcess, StartOptions } from '../../server/services/agent/engines/types.js'
import { getMistralOptions, preflightMistralConfiguration } from '../../server/services/mistral-options-service.js'
import { getActiveSession } from '../../server/services/workspace-service.js'
import { cleanupLiveFixture } from './cleanup-live-fixture.js'
import { createLiveMcpFixture } from './external-mcp-fixture.js'
import { createOfflineVibeProvider } from './mistral-offline-provider.js'

const offline = process.env.KOBO_LIVE_MISTRAL_OFFLINE === '1'
const paid = process.env.KOBO_LIVE_MISTRAL_PROVIDER === '1'

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}
function removeNativeDirectory(directory: string) {
  chmodSync(directory, 0o700)
  for (const entry of readdirSync(directory, { withFileTypes: true }))
    if (entry.isDirectory()) removeNativeDirectory(join(directory, entry.name))
  rmSync(directory, { recursive: true, force: true })
}

it.skipIf(!offline)(
  'runs the real 3.0.1 adapter offline, resumes with fresh MCP, confirms modes and stops native jobs',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kobo-vibe-adapter-'))
    const previousHome = process.env.KOBO_HOME
    const provider = await createOfflineVibeProvider(directory)
    const launches: EngineProcess[] = []
    const errors: unknown[] = []
    try {
      const home = join(directory, 'kobo')
      const native = join(directory, 'native')
      mkdirSync(home)
      mkdirSync(native)
      process.env.KOBO_HOME = home
      closeDb()
      runMigrations(getDb())
      const env: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined]))
      Object.assign(env, {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        KOBO_HOME: home,
        VIBE_HOME: native,
        VIBE_ENABLE_TELEMETRY: 'false',
        VIBE_ENABLE_UPDATE_CHECKS: 'false',
        VIBE_ENABLE_AUTO_UPDATE: 'false',
        VIBE_TEST_DISABLE_AUTO_TITLE: '1',
        VIBE_DEFAULT_AGENT: 'ask',
        VIBE_DISABLED_SKILLS: '["*"]',
        VIBE_ACTIVE_MODEL: 'probe',
        KOBO_PROBE_KEY: 'dummy-offline-key',
        VIBE_PROVIDERS: JSON.stringify([
          { name: 'stub', api_base: provider.url, api_key_env_var: 'KOBO_PROBE_KEY', backend: 'generic' },
        ]),
        VIBE_MODELS: JSON.stringify([{ name: 'probe', alias: 'probe', provider: 'stub', thinking: 'off' }]),
      })
      expect(execFileSync('vibe-acp', ['--version'], { env, encoding: 'utf8' }).trim()).toContain('3.0.1')
      writeFileSync(
        join(directory, 'job.mjs'),
        `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(join(directory, 'job.pid'))},String(process.pid)); setInterval(()=>{},1000);`,
      )
      const base: StartOptions = {
        workspaceId: 'offline-native',
        workingDir: directory,
        prompt: 'FIRST_PROBE',
        backendUrl: 'http://127.0.0.1:1',
        koboHome: home,
        env,
        model: 'auto',
        effort: 'auto',
        agentPermissionMode: 'interactive',
        settings: {} as StartOptions['settings'],
      }
      async function launch(marker: string, overrides: Partial<StartOptions> = {}) {
        const events: AgentEvent[] = []
        const runtime = await createMistralVibeEngine().start(
          {
            ...base,
            ...overrides,
            mcpServers: [
              ...(overrides.mcpServers ?? []),
              {
                name: 'kobo-probe',
                command: process.execPath,
                args: [resolve('src/__tests__/fixtures/mistral-acp/marker-mcp.mjs')],
                env: { KOBO_PROBE_MARKER: marker, KOBO_PROBE_PIDS: join(directory, 'mcp.pids') },
              },
            ],
          },
          (event) => {
            events.push(event)
            if (
              event.kind !== 'session:user-input-requested' ||
              overrides.prompt === 'REVIEW_PROBE' ||
              (overrides.prompt === 'STOP_PROBE' && event.requestKind === 'question')
            )
              return
            queueMicrotask(() =>
              runtime.resolvePendingUserInput(
                event.toolCallId,
                event.requestKind === 'question'
                  ? { kind: 'question', answers: { q0: 'One' } }
                  : {
                      kind: JSON.stringify(event.payload).includes('-denied.txt')
                        ? 'permission-deny'
                        : 'permission-allow',
                    },
              ),
            )
          },
        )
        launches.push(runtime)
        await runtime.ready
        return { runtime, events }
      }
      const first = await launch('first-launch')
      await first.runtime.initialPromptAccepted
      await first.runtime.closed
      expect(first.events.filter((event) => event.kind === 'error')).toEqual([])
      expect(first.events).toContainEqual(expect.objectContaining({ kind: 'session:started', model: 'probe' }))
      expect(first.events).toContainEqual(expect.objectContaining({ kind: 'session:ended', reason: 'completed' }))
      expect(first.events).toContainEqual(
        expect.objectContaining({ kind: 'session:user-input-requested', requestKind: 'permission' }),
      )
      expect(first.events).toContainEqual(
        expect.objectContaining({ kind: 'session:user-input-requested', requestKind: 'question' }),
      )
      expect(existsSync(join(directory, 'first-denied.txt'))).toBe(false)
      expect(readFileSync(join(directory, 'first-allowed.txt'), 'utf8')).toBe('native-file')
      expect(provider.readResults.first).toContain('native-file')
      expect(provider.answers.first).toContain('One')
      const resumed = await launch('second-launch', {
        prompt: 'RESUME_PROBE',
        resumeFromEngineSessionId: first.runtime.engineSessionId,
      })
      await resumed.runtime.initialPromptAccepted
      await resumed.runtime.closed
      expect(resumed.events.filter((event) => event.kind === 'error')).toEqual([])
      expect(resumed.runtime.engineSessionId).toBe(first.runtime.engineSessionId)
      expect(resumed.events).toContainEqual(expect.objectContaining({ kind: 'session:started', model: 'probe' }))
      const text = resumed.events
        .filter((event) => event.kind === 'message:text')
        .map((event) => event.text)
        .join('')
      expect(text).toContain('ADAPTER_RESUME_COMPLETE')
      expect(text).not.toContain('ADAPTER_FIRST_COMPLETE')
      expect(
        resumed.events.filter(
          (event) => event.kind === 'session:user-input-requested' && event.requestKind === 'question',
        ),
      ).toHaveLength(1)
      expect(existsSync(join(directory, 'resume-denied.txt'))).toBe(false)
      expect(readFileSync(join(directory, 'resume-allowed.txt'), 'utf8')).toBe('native-file')
      expect(provider.readResults.resume).toContain('native-file')
      expect(provider.answers.resume).toContain('One')
      for (const mode of ['strict', 'bypass'] as const) {
        const current = await launch(`${mode}-launch`, { agentPermissionMode: mode, prompt: 'MODE_PROBE' })
        await current.runtime.initialPromptAccepted
        await current.runtime.closed
        expect(current.events.filter((event) => event.kind === 'error')).toEqual([])
        expect(current.events).toContainEqual(expect.objectContaining({ kind: 'session:ended', reason: 'completed' }))
      }
      expect(provider.markers).toEqual(['first-launch', 'second-launch', 'strict-launch', 'bypass-launch'])
      const reviewer = await launch('review-launch', {
        prompt: 'REVIEW_PROBE',
        mcpServers: [
          {
            name: 'kobo-tasks',
            command: process.execPath,
            args: [resolve('src/__tests__/fixtures/mistral-acp/marker-mcp.mjs')],
            env: {
              KOBO_REVIEW_ONLY: '1',
              KOBO_PROBE_MARKER: 'review-role',
              KOBO_PROBE_PIDS: join(directory, 'mcp.pids'),
            },
          },
        ],
      })
      await vi.waitFor(
        () =>
          expect(reviewer.events).toContainEqual(
            expect.objectContaining({ kind: 'session:user-input-requested', requestKind: 'permission' }),
          ),
        { timeout: 30_000 },
      )
      expect(reviewer.events.some((event) => event.kind === 'session:ended')).toBe(false)
      expect(existsSync(join(directory, 'review-denied.txt'))).toBe(false)
      const approval = reviewer.events.find((event) => event.kind === 'session:user-input-requested')!
      if (approval.kind !== 'session:user-input-requested') throw new Error('Missing native approval')
      reviewer.runtime.resolvePendingUserInput(approval.toolCallId, { kind: 'permission-deny' })
      await reviewer.runtime.initialPromptAccepted
      await reviewer.runtime.closed
      expect(reviewer.events.filter((event) => event.kind === 'error')).toEqual([])
      expect(existsSync(join(directory, 'review-denied.txt'))).toBe(false)
      const stopping = await launch('first-launch', { prompt: 'STOP_PROBE' })
      const deadline = Date.now() + 30_000
      while (
        !stopping.events.some(
          (event) => event.kind === 'session:user-input-requested' && event.requestKind === 'question',
        ) &&
        Date.now() < deadline
      )
        await delay(20)
      expect(stopping.events).toContainEqual(
        expect.objectContaining({ kind: 'session:user-input-requested', requestKind: 'question' }),
      )
      const pid = Number(readFileSync(join(directory, 'job.pid'), 'utf8'))
      expect(alive(pid)).toBe(true)
      await stopping.runtime.stop()
      await stopping.runtime.closed
      expect(alive(pid)).toBe(false)
      expect(stopping.events).toContainEqual(expect.objectContaining({ kind: 'session:ended', reason: 'killed' }))
      for (const launch of launches) expect(alive(launch.pid!)).toBe(false)
      for (const pid of readFileSync(join(directory, 'mcp.pids'), 'utf8').trim().split('\n').map(Number))
        expect(alive(pid)).toBe(false)
      const before = readdirSync(directory).sort()
      for (const restricted of [{ agentPermissionMode: 'plan' as const }, { readOnly: true }])
        await expect(createMistralVibeEngine().start({ ...base, ...restricted }, () => {})).rejects.toThrow(
          /Plan|read-only/,
        )
      expect(readdirSync(directory).sort()).toEqual(before)
      console.info(
        'Native adapter: Vibe 3.0.1, interactive/strict/bypass + MCP, deny/allow/question, resume replay suppressed, managed job and MCP exit confirmed',
      )
    } catch (error) {
      errors.push(error)
    } finally {
      await cleanupLiveFixture(
        {
          stop: launches.map((launch) => () => launch.stop()),
          close: [() => provider.close(), closeDb],
          restore: () => {
            if (previousHome === undefined) delete process.env.KOBO_HOME
            else process.env.KOBO_HOME = previousHome
          },
          remove: () => removeNativeDirectory(directory),
          directory,
        },
        errors,
      )
    }
  },
)

it.skipIf(!offline)(
  'discovers native model-specific choices without writes and persists explicit ACP choices only at launch',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kobo-vibe-options-'))
    const native = join(directory, 'native')
    const config = join(native, 'config.toml')
    mkdirSync(native)
    let providerRequests = 0
    const providerSelections: Array<{ model: string; reasoningEffort: string }> = []
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk as Buffer)
      const { model, reasoning_effort } = JSON.parse(Buffer.concat(chunks).toString())
      providerSelections.push({ model, reasoningEffort: reasoning_effort })
      providerRequests++
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(
        `data: ${JSON.stringify({ id: 'offline-options', object: 'chat.completion.chunk', model: 'probe_b', choices: [{ index: 0, delta: { role: 'assistant', content: 'OPTIONS_OK' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'offline-options', object: 'chat.completion.chunk', model: 'probe_b', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      )
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing offline address')
    const launches: EngineProcess[] = []
    const errors: unknown[] = []
    try {
      // Only this disposable native home is read/written; HOME/PATH remain inherited.
      for (const key of Object.keys(process.env)) if (key.startsWith('VIBE_')) vi.stubEnv(key, undefined)
      for (const [key, value] of Object.entries({
        VIBE_HOME: native,
        KOBO_HOME: join(directory, 'kobo'),
        KOBO_PROBE_KEY: 'dummy',
        VIBE_ENABLE_TELEMETRY: 'false',
        VIBE_ENABLE_UPDATE_CHECKS: 'false',
        VIBE_ENABLE_AUTO_UPDATE: 'false',
        VIBE_TEST_DISABLE_AUTO_TITLE: '1',
        VIBE_DISABLED_SKILLS: '["*"]',
        VIBE_PROVIDERS: JSON.stringify([
          {
            name: 'stub',
            api_base: `http://127.0.0.1:${address.port}/v1`,
            api_key_env_var: 'KOBO_PROBE_KEY',
            backend: 'generic',
          },
        ]),
      }))
        vi.stubEnv(key, value)
      writeFileSync(
        config,
        `active_model = "probe_a"
default_agent = "ask"
[[models]]
name = "probe_a"
alias = "probe_a"
provider = "stub"
thinking = "off"
thinking_levels = ["off", "high"]
[[models]]
name = "probe_b"
alias = "probe_b"
provider = "stub"
thinking = "off"
thinking_levels = ["off", "low", "max"]
`,
      )
      const before = readFileSync(config, 'utf8')
      for (const agentPermissionMode of ['interactive', 'strict', 'bypass']) {
        const options = await getMistralOptions({ projectPath: directory, model: 'probe_b', agentPermissionMode })
        expect(options.model.currentValue).toBe('probe_b')
        expect(options.thinking.options.map((option) => option.value)).toEqual(['off', 'low', 'max'])
      }
      const defaults = await getMistralOptions({ projectPath: directory })
      expect(defaults.model.currentValue).toBe('probe_a')
      expect(defaults.thinking.options.map((option) => option.value)).toEqual(['off', 'high'])
      expect(readFileSync(config, 'utf8')).toBe(before)
      expect(providerRequests).toBe(0)
      const base: StartOptions = {
        workspaceId: 'offline-options',
        workingDir: directory,
        prompt: 'Reply OPTIONS_OK.',
        backendUrl: 'http://127.0.0.1:1',
        koboHome: process.env.KOBO_HOME!,
        settings: {} as StartOptions['settings'],
        agentPermissionMode: 'interactive',
        model: 'probe_b',
        effort: 'max',
      }
      async function launch(overrides: Partial<StartOptions>) {
        const events: AgentEvent[] = []
        const runtime = await createMistralVibeEngine().start({ ...base, ...overrides }, (event) => events.push(event))
        launches.push(runtime)
        await runtime.ready
        await runtime.initialPromptAccepted
        await runtime.closed
        expect(events.filter((event) => event.kind === 'error')).toEqual([])
        expect(events).toContainEqual(expect.objectContaining({ kind: 'session:started', model: 'probe_b' }))
        return runtime
      }
      const explicit = await launch({})
      const persisted = readFileSync(config, 'utf8')
      expect(persisted).not.toBe(before)
      expect(persisted).toMatch(/active_model\s*=\s*["']probe_b["']/)
      expect(persisted).toMatch(/thinking\s*=\s*["']max["']/)
      await launch({ model: 'auto', effort: 'auto', resumeFromEngineSessionId: explicit.engineSessionId })
      expect(readFileSync(config, 'utf8')).toBe(persisted)
      expect(providerRequests).toBe(2)
      const changedDefaults = before
        .replace('thinking = "off"', 'thinking = "high"')
        .replace('thinking = "off"', 'thinking = "low"')
      writeFileSync(config, changedDefaults)
      await launch({ model: 'auto', effort: 'auto', resumeFromEngineSessionId: explicit.engineSessionId })
      expect(readFileSync(config, 'utf8')).toBe(changedDefaults)
      await launch({ model: 'probe_b', effort: 'auto', resumeFromEngineSessionId: explicit.engineSessionId })
      writeFileSync(config, changedDefaults)
      const selection = { model: 'auto', reasoningEffort: 'max', agentPermissionMode: 'interactive' }
      await expect(
        preflightMistralConfiguration('mistral-vibe', { projectPath: directory }, selection),
      ).rejects.toThrow(/thinking selection/)
      await preflightMistralConfiguration('mistral-vibe', { projectPath: directory }, selection, true)
      await launch({ model: 'auto', effort: 'max', resumeFromEngineSessionId: explicit.engineSessionId })
      expect(providerSelections).toEqual(
        Array.from({ length: 5 }, () => ({ model: 'probe_b', reasoningEffort: 'max' })),
      )
      expect(providerRequests).toBe(5)
      console.info(
        `Native controls: ${process.platform}, Vibe 3.0.1, discovery interactive/strict/bypass, probe_a off/high, probe_b off/low/max, discovery config bytes unchanged and provider requests 0; explicit model/thinking persisted only in temporary VIBE_HOME; Auto resume unchanged, provider requests ${providerRequests}`,
      )
    } catch (error) {
      errors.push(error)
    } finally {
      await cleanupLiveFixture(
        {
          stop: launches.map((launch) => () => launch.stop()),
          close: [
            async () => {
              server.closeAllConnections()
              await new Promise<void>((resolve) => server.close(() => resolve()))
            },
          ],
          restore: () => vi.unstubAllEnvs(),
          remove: () => removeNativeDirectory(directory),
          directory,
        },
        errors,
      )
    }
  },
)

it.skipIf(!paid)(
  'runs the separately authorized real-provider mission',
  async () => {
    // This scenario requires explicit provider credentials in the server environment.
    const native = mkdtempSync(join(tmpdir(), 'kobo-vibe-provider-'))
    const previousNative = process.env.VIBE_HOME
    process.env.VIBE_HOME = native
    const fixture = await createLiveMcpFixture('mistral-vibe', 'auto').catch(async (error) => {
      await cleanupLiveFixture(
        {
          stop: [],
          close: [],
          restore: () => {
            if (previousNative === undefined) delete process.env.VIBE_HOME
            else process.env.VIBE_HOME = previousNative
          },
          remove: () => removeNativeDirectory(native),
          directory: native,
        },
        [error],
      )
      throw error
    })
    const errors: unknown[] = []
    try {
      expect(
        execFileSync('vibe-acp', ['--version'], {
          env: { ...process.env, VIBE_ENABLE_UPDATE_CHECKS: 'false', VIBE_ENABLE_AUTO_UPDATE: 'false' },
          encoding: 'utf8',
        }).trim(),
      ).toContain('3.0.1')
      writeFileSync(
        join(fixture.worktree, 'AGENTS.md'),
        'Isolated smoke mission. Follow only the requested checks. Never commit, push, install dependencies or contact unrelated services.\n',
      )
      writeFileSync(join(fixture.worktree, 'input.txt'), 'native-smoke-input\n')
      const url = await fixture.start()
      const api = `${url}/api/workspaces/${fixture.workspaceId}`
      const db = getDb(fixture.dbPath)
      async function request(path: string, body?: object, method = 'POST') {
        const response = await fetch(path, {
          method,
          headers: { 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        })
        expect(response.ok, `HTTP ${response.status} for ${new URL(path).pathname}`).toBe(true)
        return response.json()
      }
      type Pending = { kind: string; toolCallId: string; input?: { questions?: { id: string }[] }; toolInput?: unknown }
      const decisions: string[] = []
      async function settle(holdQuestion = false) {
        const deadline = Date.now() + 150_000
        while (Date.now() < deadline) {
          const snapshot = await request(`${url}/api/workspaces/info`, undefined, 'GET')
          const pending = snapshot.pendingInputs[fixture.workspaceId] as Pending[]
          const head = pending[0]
          if (head?.kind === 'permission') {
            const decision = JSON.stringify(head.toolInput).includes('denied.txt') ? 'deny' : 'allow'
            decisions.push(decision)
            await request(`${api}/deferred-permission/decision`, {
              toolCallId: head.toolCallId,
              decision,
              scope: 'once',
            })
          } else if (head?.kind === 'question') {
            if (holdQuestion) return
            decisions.push('question')
            await request(`${api}/deferred-tool-use/answer`, {
              toolCallId: head.toolCallId,
              answers: Object.fromEntries((head.input?.questions ?? []).map((question) => [question.id, 'One'])),
            })
          }
          const workspace = snapshot.workspaces.find((item: { id: string }) => item.id === fixture.workspaceId)
          expect(['error', 'quota']).not.toContain(workspace.status)
          if (!snapshot.agentLiveness[fixture.workspaceId]) return
          await delay(200)
        }
        throw new Error('Provider mission exceeded the bounded scenario deadline')
      }
      const before = execFileSync('git', ['status', '--porcelain'], { cwd: fixture.worktree, encoding: 'utf8' })
      const originalFiles = readdirSync(fixture.worktree).sort()
      const originalContents = ['AGENTS.md', 'input.txt'].map((file) =>
        readFileSync(join(fixture.worktree, file), 'utf8'),
      )
      expect(
        (
          await fetch(api, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentPermissionMode: 'plan' }),
          })
        ).status,
      ).toBe(400)
      expect(
        (
          await fetch(`${api}/start-review`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ engine: 'mistral-vibe', model: 'auto', agentPermissionMode: 'plan' }),
          })
        ).status,
      ).toBe(400)
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: fixture.worktree, encoding: 'utf8' })).toBe(before)
      expect(readdirSync(fixture.worktree).sort()).toEqual(originalFiles)
      expect(['AGENTS.md', 'input.txt'].map((file) => readFileSync(join(fixture.worktree, file), 'utf8'))).toEqual(
        originalContents,
      )
      expect(db.prepare('SELECT count(*) AS n FROM agent_sessions').get()).toEqual({ n: 0 })
      await request(`${api}/start`, {
        prompt: `Perform only this bounded smoke mission, in order:
1. Read input.txt. Attempt write_file denied.txt with text denied (the human will deny it); never retry it by another tool. Write allowed.txt with exact text native-smoke-ok after approval.
2. Ask one native ask_user_question with choices One/Two and await its answer.
3. Use managed kobo-tasks MCP: list_tasks; list_memory_scopes then remember a workspace fact key native-smoke, title Native smoke, body This disposable workspace uses input.txt for its smoke fixture, using the returned generation. Create and finish one progress bar labelled Native smoke with activity_key native-smoke and succeeded outcome.
4. Reply exactly PROVIDER_FIRST_COMPLETE. Do not do any other work.`,
      })
      await settle()
      expect(decisions).toContain('deny')
      expect(decisions).toContain('allow')
      expect(decisions).toContain('question')
      expect(existsSync(join(fixture.worktree, 'denied.txt'))).toBe(false)
      expect(readFileSync(join(fixture.worktree, 'allowed.txt'), 'utf8').trim()).toBe('native-smoke-ok')
      expect(
        db
          .prepare(
            "SELECT count(*) AS n FROM memory_entries WHERE memory_key='native-smoke' AND source_engine='mistral-vibe'",
          )
          .get(),
      ).toEqual({ n: 1 })
      expect(
        db
          .prepare(
            "SELECT count(*) AS n FROM session_progress_bars WHERE activity_key='native-smoke' AND status='succeeded'",
          )
          .get(),
      ).toEqual({ n: 1 })
      const taskCalls = db
        .prepare(
          "SELECT count(*) AS n FROM ws_events WHERE type='agent:event' AND json_extract(payload,'$.kind')='tool:call' AND payload LIKE '%list_tasks%'",
        )
        .get() as { n: number }
      expect(taskCalls.n).toBeGreaterThan(0)
      const session = getActiveSession(fixture.workspaceId)!
      expect(session?.engineSessionId).toBeTruthy()
      const eventRows = () =>
        db
          .prepare(
            "SELECT payload FROM ws_events WHERE type='agent:event' AND json_extract(payload,'$.kind')='message:text' ORDER BY rowid",
          )
          .all() as { payload: string }[]
      const firstText = eventRows()
        .map((row) => (JSON.parse(row.payload) as { text: string }).text)
        .join('')
      expect(firstText).toContain('PROVIDER_FIRST_COMPLETE')
      const firstCount = eventRows().length
      await request(`${api}/start`, {
        resume: true,
        agentSessionId: session.id,
        prompt: 'Reply exactly PROVIDER_RESUME_COMPLETE without tools.',
      })
      await settle()
      const resumedText = eventRows()
        .slice(firstCount)
        .map((row) => (JSON.parse(row.payload) as { text: string }).text)
        .join('')
      expect(resumedText).toContain('PROVIDER_RESUME_COMPLETE')
      expect(resumedText).not.toContain('PROVIDER_FIRST_COMPLETE')
      const latest = getActiveSession(fixture.workspaceId)
      expect(latest?.id).toBe(session.id)
      expect(latest?.engineSessionId).toBe(session.engineSessionId)
      writeFileSync(
        join(fixture.worktree, 'job.mjs'),
        "import {writeFileSync} from 'node:fs'; writeFileSync('live-job.pid',String(process.pid));setInterval(()=>{},1000);",
      )
      await request(`${api}/start`, {
        resume: true,
        agentSessionId: session.id,
        prompt: `Use native run_typescript tools.process.start to run command ${JSON.stringify(`exec ${process.execPath} job.mjs`)}. Then ask a native question One/Two and wait. Do not stop the process yourself.`,
      })
      await settle(true)
      const jobPid = Number(readFileSync(join(fixture.worktree, 'live-job.pid'), 'utf8'))
      expect(alive(jobPid)).toBe(true)
      await request(`${api}/stop`)
      expect(alive(jobPid)).toBe(false)
      const other = process.env.KOBO_LIVE_HANDOFF_ENGINE
      if (other === 'claude-code' || other === 'codex') {
        const model = process.env.KOBO_LIVE_HANDOFF_MODEL
        if (!model) throw new Error('KOBO_LIVE_HANDOFF_MODEL is required with KOBO_LIVE_HANDOFF_ENGINE')
        await request(`${api}/switch-engine`, {
          engine: other,
          model,
          reasoningEffort: 'auto',
          agentPermissionMode: 'interactive',
          handoff: 'Read input.txt and reply HANDOFF_OTHER_COMPLETE. Do not modify files.',
        })
        await settle()
        expect(
          eventRows()
            .map((row) => (JSON.parse(row.payload) as { text: string }).text)
            .join(''),
        ).toContain('HANDOFF_OTHER_COMPLETE')
        await request(`${api}/switch-engine`, {
          engine: 'mistral-vibe',
          model: 'auto',
          reasoningEffort: 'auto',
          agentPermissionMode: 'interactive',
          handoff: 'Read input.txt and reply HANDOFF_VIBE_COMPLETE. Do not modify files.',
        })
        await settle()
        expect(
          eventRows()
            .map((row) => (JSON.parse(row.payload) as { text: string }).text)
            .join(''),
        ).toContain('HANDOFF_VIBE_COMPLETE')
      }
    } catch (error) {
      errors.push(error)
    } finally {
      await cleanupLiveFixture(
        {
          stop: [() => fixture.cleanup()],
          close: [],
          restore: () => {
            if (previousNative === undefined) delete process.env.VIBE_HOME
            else process.env.VIBE_HOME = previousNative
          },
          remove: () => removeNativeDirectory(native),
          directory: native,
        },
        errors,
      )
    }
  },
  600_000,
)
