const nativeDefaults = vi.hoisted(() => ({ permissionMode: 'interactive' }))
vi.mock('../server/services/settings-service.js', () => ({
  getGlobalSettings: () => ({ defaultPermissionModeByEngine: { 'mistral-vibe': nativeDefaults.permissionMode } }),
}))

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Hono } from 'hono'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { closeDb, getDb } from '../server/db/index.js'
import { runMigrations } from '../server/db/migrations.js'
import internalMcp from '../server/routes/internal-mcp.js'
import mcp from '../server/routes/mcp.js'
import {
  createExternalMcpCredential,
  EXTERNAL_TOOL_CATALOGUE,
} from '../server/services/external-mcp-credentials-service.js'
import { createInternalMcpCapability } from '../server/services/internal-mcp-capability-service.js'

const captured = vi.hoisted(() => ({
  requests: [] as Array<{ body: Record<string, unknown>; files: string[] }>,
  status: 200,
  prCalls: [] as string[],
  prStatus: 200,
  lifecycleCalls: [] as Array<{ path: string; body?: unknown }>,
  worktreePurged: false,
}))
vi.mock('../server/routes/workspaces.js', async () => {
  const { Hono } = await import('hono')
  return {
    default: new Hono()
      .get('/:id', (c) =>
        c.json({
          id: c.req.param('id'),
          workingBranch: 'feature/work',
          worktreeOwned: true,
          archivedAt: '2026-10-10',
          worktreePurgedAt: captured.worktreePurged ? '2026-10-10' : null,
        }),
      )
      .patch('/:id', async (c) => {
        const body = await c.req.json()
        captured.lifecycleCalls.push({ path: c.req.path, body })
        return c.json({ id: c.req.param('id'), ...body })
      })
      .post('/:id/archive', (c) => {
        captured.lifecycleCalls.push({ path: c.req.path })
        return c.json({ id: c.req.param('id'), archivedAt: '2026-10-10' })
      })
      .post('/:id/purge-worktree', (c) => {
        captured.lifecycleCalls.push({ path: c.req.path })
        return c.json({ workspace: { id: c.req.param('id') }, warnings: ['Branch kept'], outcome: 'purged' })
      })
      .post('/:id/restore-worktree', (c) => {
        captured.lifecycleCalls.push({ path: c.req.path })
        return c.json({
          workspace: { id: c.req.param('id'), archivedAt: '2026-10-10', worktreePurgedAt: null },
          outcome: 'restored',
          source: 'local-branch',
        })
      })
      .post('/:id/unarchive', (c) => {
        captured.lifecycleCalls.push({ path: c.req.path })
        return c.json({ id: c.req.param('id'), archivedAt: null, worktreePurgedAt: null })
      })
      .delete('/:id', async (c) => {
        captured.lifecycleCalls.push({ path: c.req.path, body: await c.req.json() })
        return c.body(null, 204)
      })
      .post('/', async (c) => {
        let body: Record<string, unknown>
        let files: string[] = []
        if (c.req.header('content-type')?.startsWith('multipart/form-data')) {
          const form = await c.req.formData()
          body = JSON.parse(form.get('workspace') as string)
          files = await Promise.all(
            form.getAll('attachments').map(async (value) => {
              const file = value as File
              return `${file.name}:${await file.text()}`
            }),
          )
        } else body = await c.req.json()
        captured.requests.push({ body, files })
        return captured.status === 200
          ? c.json({ id: 'created', ...body }, 201)
          : c.json({ error: 'Unavailable engine', step: 'validate' }, 400)
      }),
  }
})
vi.mock('../server/routes/pull-requests.js', async () => {
  const { Hono } = await import('hono')
  return {
    default: new Hono()
      .post('/diagnose', async (c) => {
        const input = await c.req.json()
        captured.prCalls.push('diagnose')
        return c.json({
          fingerprint: 'fresh',
          pr: {
            number: input.prNumber,
            url: 'https://github.com/team/repo/pull/12',
            headBranch: 'feature/pr',
            baseBranch: 'develop',
          },
          report: {
            projectPath: input.projectPath,
            headBranch: 'feature/pr',
            targetWorktreePath: '/tmp/pr-tree',
            blockers: [],
            workspace: { state: 'none' },
            worktree: { state: 'none' },
            localChanges: { present: false, modified: 0, staged: 0, untracked: 0 },
            ongoingOperation: null,
            branch: { state: 'absent' },
          },
        })
      })
      .post('/resolve', async (c) => {
        captured.prCalls.push('resolve')
        const input = await c.req.json()
        expect(input).toMatchObject({
          fingerprint: 'fresh',
          prNumber: 12,
          headBranch: 'feature/pr',
          baseBranch: 'develop',
        })
        return captured.prStatus === 200
          ? c.json({ worktreePath: '/tmp/pr-tree' })
          : c.json({ error: 'Repository changed', report: { branch: { state: 'diverged' } } }, 409)
      }),
  }
})
const app = new Hono().route('/api/mcp', mcp).route('/api/internal-mcp', internalMcp)
let externalToken: string
let previousHome: string | undefined
let directory: string
beforeEach(() => {
  captured.requests = []
  captured.status = 200
  captured.prCalls = []
  captured.prStatus = 200
  captured.lifecycleCalls = []
  captured.worktreePurged = false
  directory = mkdtempSync(join(tmpdir(), 'kobo-mcp-create-'))
  previousHome = process.env.KOBO_HOME
  process.env.KOBO_HOME = directory
  externalToken = createExternalMcpCredential({
    name: 'Transport test',
    allWorkspaces: true,
    tools: EXTERNAL_TOOL_CATALOGUE.map((tool) => tool.name),
  }).token
  closeDb()
  runMigrations(getDb(join(directory, 'test.db')))
})
afterEach(() => {
  process.env.KOBO_HOME = previousHome
  closeDb()
  rmSync(directory, { recursive: true, force: true })
})

const args = {
  name: 'Mission',
  project_path: '/tmp/project',
  source_branch: 'develop',
  working_branch: 'feature/work',
  engine: 'codex',
  model: 'custom-model',
  reasoning_effort: 'high',
  description: 'Do the work',
  tasks: ['Work'],
  acceptance_criteria: ['Verified'],
  tags: ['API'],
  agent_permission_mode: 'strict',
  auto_loop: true,
  auto_loop_session_mode: 'continuous',
  brainstorm_model: 'brainstorm-model',
  brainstorm_reasoning_effort: 'medium',
  auto_loop_final_review: {
    engine: 'claude-code',
    model: 'review-model',
    reasoning_effort: 'high',
    additional_instructions: 'Review all',
  },
  workflow_policy: { commit: 'manual', push: 'manual', publish: 'automatic' },
  skip_setup_script: false,
  comparison_id: 'comparison',
  creation_id: 'creation',
  attachments: [
    {
      name: 'requirements.md',
      mime_type: 'text/markdown',
      data_base64: Buffer.from('Requirements').toString('base64'),
    },
  ],
}
function content(result: Awaited<ReturnType<Client['callTool']>>) {
  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text)
}
async function httpClient() {
  const client = new Client({ name: 'creation-test', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://localhost/api/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${externalToken}` } },
      fetch: async (input, init) => app.fetch(new Request(input, init)),
    }),
  )
  return client
}
it('advertises creation and PR diagnosis and forwards every option and attachment through HTTP', async () => {
  const client = await httpClient()
  try {
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toContain('create_workspace')
    expect(names).toContain('diagnose_workspace_pr')
    const result = await client.callTool({ name: 'create_workspace', arguments: args })
    expect(result.isError).not.toBe(true)
    expect(content(result)).toMatchObject({ id: 'created' })
    expect(captured.requests).toEqual([
      {
        body: {
          name: 'Mission',
          projectPath: '/tmp/project',
          sourceBranch: 'develop',
          workingBranch: 'feature/work',
          engine: 'codex',
          model: 'custom-model',
          reasoningEffort: 'high',
          description: 'Do the work',
          tasks: ['Work'],
          acceptanceCriteria: ['Verified'],
          tags: ['API'],
          agentPermissionMode: 'strict',
          autoLoop: true,
          autoLoopSessionMode: 'continuous',
          brainstormModel: 'brainstorm-model',
          brainstormReasoningEffort: 'medium',
          autoLoopFinalReview: {
            engine: 'claude-code',
            model: 'review-model',
            reasoningEffort: 'high',
            additionalInstructions: 'Review all',
          },
          workflowPolicy: { commit: 'manual', push: 'manual', publish: 'automatic' },
          skipSetupScript: false,
          comparisonId: 'comparison',
          creationId: 'creation',
        },
        files: ['requirements.md:Requirements'],
      },
    ])
  } finally {
    await client.close()
  }
})
it.each(['', 'internal-workspace'])(
  'supports the same creation contract over stdio (workspace=%s)',
  async (workspaceId) => {
    const authenticatedApp = new Hono()
    authenticatedApp.use('*', async (c, next) => {
      if (c.req.path !== '/api/internal-mcp' && c.req.header('Authorization') !== `Bearer ${externalToken}`)
        return c.json({ error: 'Unauthorized' }, 401)
      return next()
    })
    authenticatedApp.route('/', app)
    const listener = serve({ fetch: authenticatedApp.fetch, hostname: '127.0.0.1', port: 0 })
    if (!listener.listening) await new Promise<void>((resolve) => listener.once('listening', resolve))
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('Missing listener')
    const managed = createInternalMcpCapability({
      workspaceId: workspaceId || 'unused',
      sessionId: 'test',
      readOnly: false,
    })
    const client = new Client({ name: 'external-creation', version: '1' })
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: ['--import', 'tsx', 'src/mcp-server/kobo-tasks-server.ts'],
          env: {
            PATH: process.env.PATH ?? '',
            KOBO_HOME: directory,
            KOBO_DB_PATH: getDb().name,
            KOBO_WORKSPACE_ID: workspaceId,
            KOBO_MCP_SESSION_TOKEN: managed.token,
            KOBO_BACKEND_URL: `http://127.0.0.1:${address.port}`,
            KOBO_MCP_TOKEN: externalToken,
          },
          stderr: 'pipe',
        }),
      )
      const schema = (await client.listTools()).tools.find((tool) => tool.name === 'create_workspace')?.inputSchema
      expect(schema?.properties).toHaveProperty('auto_loop_final_review')
      const result = await client.callTool({ name: 'create_workspace', arguments: args })
      expect(result.isError).not.toBe(true)
      expect(content(result)).toMatchObject({
        id: 'created',
        brainstormModel: 'brainstorm-model',
        workflowPolicy: args.workflow_policy,
      })
      expect(captured.requests[0]?.files).toEqual(['requirements.md:Requirements'])
      const large = await client.callTool(
        {
          name: 'create_workspace',
          arguments: {
            ...args,
            attachments: [
              {
                name: 'large.txt',
                mime_type: 'text/plain',
                data_base64: Buffer.alloc(8 * 1024 * 1024, 65).toString('base64'),
              },
            ],
          },
        },
        undefined,
        { timeout: 10_000 },
      )
      expect(large.isError).not.toBe(true)
      expect(captured.requests[1]?.files[0]?.length).toBe('large.txt:'.length + 8 * 1024 * 1024)
      const native = await client.callTool({
        name: 'create_workspace',
        arguments: {
          name: 'Vibe',
          project_path: '/tmp/project',
          source_branch: 'main',
          working_branch: 'feature/vibe',
          engine: 'mistral-vibe',
          agent_permission_mode: 'interactive',
          model: 'auto',
        },
      })
      expect(native.isError).not.toBe(true)
      expect(content(native)).toMatchObject({ engine: 'mistral-vibe', agentPermissionMode: 'interactive' })
      const invalid = await client.callTool({
        name: 'create_workspace',
        arguments: {
          name: 'Bad',
          project_path: '/tmp/project',
          source_branch: 'main',
          working_branch: 'feature/bad',
          engine: 'unknown',
        },
      })
      expect(invalid.isError).toBe(true)
      await exerciseLifecycleTools(client, workspaceId || 'target')
    } finally {
      await client.close()
      await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())))
    }
  },
  15_000,
)
it('allows a creation attachment above the SDK HTTP default limit without widening ordinary dialogue requests', async () => {
  const client = await httpClient()
  try {
    const result = await client.callTool({
      name: 'create_workspace',
      arguments: {
        ...args,
        attachments: [
          {
            name: 'large.txt',
            mime_type: 'text/plain',
            data_base64: Buffer.alloc(4 * 1024 * 1024, 65).toString('base64'),
          },
        ],
      },
    })
    expect(result.isError).not.toBe(true)
    expect(captured.requests).toHaveLength(1)
    const res = await app.request('/api/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${externalToken}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'send_workspace_message', arguments: { workspace_id: 'a', content: 'a'.repeat(1024 * 1024) } },
      }),
    })
    expect(res.status).toBe(413)
  } finally {
    await client.close()
  }
})
it('reports backend validation as an MCP error without a successful receipt', async () => {
  captured.status = 400
  const client = await httpClient()
  try {
    const result = await client.callTool({ name: 'create_workspace', arguments: args })
    expect(result.isError).toBe(true)
    expect(content(result)).toMatchObject({ error: expect.stringContaining('Unavailable engine') })
  } finally {
    await client.close()
  }
})

it('diagnoses and resumes an existing PR through the HTTP routes using canonical branches', async () => {
  const client = await httpClient()
  const prArgs = { project_path: '/tmp/project', pr_url: 'https://github.com/team/repo/pull/12' }
  try {
    const report = await client.callTool({ name: 'diagnose_workspace_pr', arguments: prArgs })
    expect(content(report)).toMatchObject({ fingerprint: 'fresh' })
    expect(captured.prCalls).toEqual(['diagnose'])
    expect(captured.requests).toHaveLength(0)
    const result = await client.callTool({ name: 'create_workspace', arguments: { ...prArgs, name: 'Continue PR' } })
    expect(result.isError).not.toBe(true)
    expect(captured.prCalls).toEqual(['diagnose', 'diagnose', 'resolve'])
    expect(captured.requests[0]?.body).toMatchObject({
      sourceBranch: 'develop',
      workingBranch: 'feature/pr',
      worktreePath: '/tmp/pr-tree',
      prUrl: prArgs.pr_url,
      skipSetupScript: true,
    })
  } finally {
    await client.close()
  }
})
it('preserves the stale PR report in an HTTP MCP error without creating a workspace', async () => {
  captured.prStatus = 409
  const client = await httpClient()
  try {
    const result = await client.callTool({
      name: 'create_workspace',
      arguments: { name: 'PR', project_path: '/tmp/project', pr_url: 'https://github.com/team/repo/pull/12' },
    })
    expect(result.isError).toBe(true)
    expect(content(result)).toMatchObject({
      status: 409,
      stage: 'resolve',
      details: { report: { branch: { state: 'diverged' } } },
    })
    expect(captured.requests).toHaveLength(0)
  } finally {
    await client.close()
  }
})

async function exerciseLifecycleTools(client: Client, statusWorkspaceId = 'target') {
  for (const [name, arguments_] of [
    ['set_workspace_status', { workspace_id: statusWorkspaceId, status: 'executing' }],
    ['archive_workspace', { workspace_id: 'target' }],
    ['purge_workspace_worktree', { workspace_id: 'target', confirm_purge: true }],
    ['unarchive_workspace', { workspace_id: 'target' }],
    ['restore_workspace', { workspace_id: 'target' }],
    [
      'delete_workspace',
      {
        workspace_id: 'target',
        confirm_delete: true,
        confirmation_branch: 'feature/work',
        delete_local_branch: true,
        delete_remote_branch: true,
      },
    ],
  ] as const) {
    const result = await client.callTool({ name, arguments: arguments_ })
    expect(result.isError, name).not.toBe(true)
    if (name === 'purge_workspace_worktree')
      expect(content(result)).toMatchObject({ warnings: ['Branch kept'], outcome: 'purged' })
    if (name === 'delete_workspace') expect(content(result)).toMatchObject({ ok: true })
  }
  expect(captured.lifecycleCalls.map((call) => call.path)).toEqual([
    `/${statusWorkspaceId}`,
    '/target/archive',
    '/target/purge-worktree',
    '/target/unarchive',
    '/target/restore-worktree',
    '/target/unarchive',
    '/target',
  ])
  expect(captured.lifecycleCalls.at(-1)?.body).toEqual({
    confirmationBranch: 'feature/work',
    deleteLocalBranch: true,
    deleteRemoteBranch: true,
  })
}
it('exposes archive, purge, delete and restoration with their options through HTTP MCP', async () => {
  captured.worktreePurged = true
  const client = await httpClient()
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'set_workspace_status',
        'archive_workspace',
        'purge_workspace_worktree',
        'delete_workspace',
        'unarchive_workspace',
        'restore_workspace',
      ]),
    )
    await exerciseLifecycleTools(client)
  } finally {
    await client.close()
  }
})

it('accepts Mistral creation and rejects invalid native selections through HTTP MCP', async () => {
  const client = await httpClient()
  try {
    const base = {
      name: 'Vibe',
      project_path: '/tmp/project',
      source_branch: 'main',
      working_branch: 'feature/vibe',
      engine: 'mistral-vibe',
    }
    const good = await client.callTool({ name: 'create_workspace', arguments: base })
    expect(good.isError).not.toBe(true)
    expect(content(good)).toMatchObject({ engine: 'mistral-vibe' })
    for (const selection of [{ engine: 'unknown' }, { agent_permission_mode: 'plan' }, { model: 'custom' }]) {
      const bad = await client.callTool({ name: 'create_workspace', arguments: { ...base, ...selection } })
      expect(bad.isError).toBe(true)
    }
    expect(captured.requests).toHaveLength(1)
  } finally {
    await client.close()
  }
})

it('enforces status tool and workspace grants before any status dispatch', async () => {
  externalToken = createExternalMcpCredential({
    name: 'Status only',
    workspaceIds: ['target'],
    tools: ['set_workspace_status'],
  }).token
  const client = await httpClient()
  try {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['set_workspace_status'])
    expect(
      (
        await client.callTool({
          name: 'set_workspace_status',
          arguments: { workspace_id: 'other', status: 'executing' },
        })
      ).isError,
    ).toBe(true)
    expect(captured.lifecycleCalls).toEqual([])
    expect(
      (
        await client.callTool({
          name: 'set_workspace_status',
          arguments: { workspace_id: 'target', status: 'executing' },
        })
      ).isError,
    ).not.toBe(true)
    expect(captured.lifecycleCalls).toEqual([{ path: '/target', body: { status: 'executing' } }])
  } finally {
    await client.close()
  }
  externalToken = createExternalMcpCredential({
    name: 'Read only',
    workspaceIds: ['target'],
    tools: ['get_workspace'],
  }).token
  const reader = await httpClient()
  try {
    expect(
      (
        await reader.callTool({
          name: 'set_workspace_status',
          arguments: { workspace_id: 'target', status: 'error' },
        })
      ).isError,
    ).toBe(true)
    expect(captured.lifecycleCalls).toHaveLength(1)
  } finally {
    await reader.close()
  }
})
