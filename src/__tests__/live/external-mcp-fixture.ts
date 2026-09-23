import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { closeDb, getDb } from '../../server/db/index.js'
import { runMigrations } from '../../server/db/migrations.js'
import { createWorkspace, updateWorkspaceStatus } from '../../server/services/workspace-service.js'

export async function createLiveMcpFixture(engine: 'codex' | 'claude-code', model: string) {
  const directory = mkdtempSync(join(tmpdir(), 'kobo-mcp-live-'))
  const previousHome = process.env.KOBO_HOME
  const repository = join(directory, 'repo')
  const worktree = join(directory, 'worktree')
  const home = join(directory, 'home')
  let backend: ChildProcess | undefined
  let output = ''
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KOBO_HOME: home,
    KOBO_ENFORCE_LOCAL_HOME: '',
    PORT: '0',
    SERVER_PORT: '0',
    KOBO_DEV_CLIENT_ORIGIN: '',
    KOBO_NETWORK_ACCESS_ENABLED: 'false',
    KOBO_NETWORK_ACCESS_BEHIND_PROXY: 'false',
  }
  // This child is the production backend with an isolated home, not a Vitest module.
  delete env.VITEST
  async function stop() {
    const owned = backend
    backend = undefined
    if (!owned?.pid) return
    const closed = new Promise<void>((resolveClose) => {
      if (owned.exitCode !== null || owned.signalCode !== null) resolveClose()
      else owned.once('close', () => resolveClose())
    })
    owned.kill('SIGTERM')
    await Promise.race([closed, delay(8000, undefined, { ref: false })])
    try {
      process.kill(-owned.pid, 'SIGKILL')
    } catch {
      /* Process group already exited. */
    }
    await closed
  }
  async function cleanup() {
    await stop()
    closeDb()
    if (previousHome === undefined) delete process.env.KOBO_HOME
    else process.env.KOBO_HOME = previousHome
    rmSync(directory, { recursive: true, force: true })
  }
  try {
    mkdirSync(repository)
    mkdirSync(home)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, stdio: 'pipe' })
    git('init', '-b', 'main')
    writeFileSync(
      join(repository, 'AGENTS.md'),
      'This is an isolated protocol smoke test. Respond to the requested marker without tools or file changes.\n',
    )
    git('add', 'AGENTS.md')
    // Fixture history only: the Kōbō checkout is never staged or committed.
    git('-c', 'user.name=Kobo Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Fixture')
    git('remote', 'add', 'origin', repository)
    git('fetch', 'origin')
    git('worktree', 'add', '-b', 'smoke', worktree)
    process.env.KOBO_HOME = home
    closeDb()
    runMigrations(getDb())
    const workspace = createWorkspace({
      name: 'External MCP live test',
      projectPath: repository,
      worktreePath: worktree,
      sourceBranch: 'main',
      workingBranch: 'smoke',
      engine,
      model,
      agentPermissionMode: 'plan',
      reasoningEffort: 'low',
    })
    updateWorkspaceStatus(workspace.id, 'idle')
    closeDb()
    async function start(): Promise<string> {
      output = ''
      backend = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
        cwd: resolve('.'),
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      backend.on('error', (error) => {
        output += error.message
      })
      const capture = (data: Buffer) => {
        output = (output + data.toString()).slice(-32_000)
      }
      backend.stdout?.on('data', capture)
      backend.stderr?.on('data', capture)
      const deadline = Date.now() + 25_000
      while (Date.now() < deadline) {
        if (backend.exitCode !== null || backend.signalCode !== null)
          throw new Error(`Isolated backend exited: ${output.slice(-4000)}`)
        const port = output.match(/http:\/\/localhost:(\d+)/)?.[1]
        if (port) return `http://127.0.0.1:${port}`
        await delay(100)
      }
      throw new Error(`Isolated backend startup timed out: ${output.slice(-4000)}`)
    }
    return {
      workspaceId: workspace.id,
      home,
      dbPath: join(home, 'kobo.db'),
      start,
      stop,
      cleanup,
      diagnostics: () => {
        const events = getDb(join(home, 'kobo.db'))
          .prepare(
            "SELECT payload FROM ws_events WHERE type='agent:error' OR (type='agent:event' AND json_extract(payload, '$.kind')='error') ORDER BY rowid DESC LIMIT 3",
          )
          .all()
        return `${JSON.stringify(events)}\n${output.slice(-2000)}`
      },
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}
