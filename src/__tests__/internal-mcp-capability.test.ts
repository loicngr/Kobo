import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  authorizeInternalMcpTool,
  createInternalMcpCapability,
  revokeInternalMcpCapability,
} from '../server/services/internal-mcp-capability-service.js'
import { _setSettingsPath, updateGlobalSettings } from '../server/services/settings-service.js'

describe('managed MCP launch authorization', () => {
  it('rejects explicit mutations in ordinary Plan sessions', () => {
    const capability = createInternalMcpCapability({
      workspaceId: 'own',
      sessionId: 'session',
      readOnly: true,
      restricted: false,
    })
    expect(() => authorizeInternalMcpTool(capability.token, 'create_task', {})).toThrow(/read-only/)
    expect(() => authorizeInternalMcpTool(capability.token, 'set_workspace_status', { status: 'executing' })).toThrow(
      /read-only/,
    )
    expect(() => authorizeInternalMcpTool(capability.token, 'delete_workspace', { workspace_id: 'other' })).toThrow(
      /read-only/,
    )
    expect(authorizeInternalMcpTool(capability.token, 'list_tasks', {}).workspaceId).toBe('own')
  })
  it('revokes all tools without affecting a replacement launch', () => {
    const old = createInternalMcpCapability({
      workspaceId: 'own',
      sessionId: 'session',
      readOnly: false,
      restricted: false,
    })
    const replacement = createInternalMcpCapability({
      workspaceId: 'own',
      sessionId: 'session',
      readOnly: false,
      restricted: false,
    })
    revokeInternalMcpCapability(old.token)
    expect(() => authorizeInternalMcpTool(old.token, 'create_task', {})).toThrow(/capability/)
    expect(() => authorizeInternalMcpTool(old.token, 'list_tasks', {})).toThrow(/capability/)
    expect(authorizeInternalMcpTool(replacement.token, 'create_task', {}).sessionId).toBe('session')
  })
  it('keeps writable cross-workspace dialogue but refuses self messaging and forged scoped targets', () => {
    const cap = createInternalMcpCapability({
      workspaceId: 'own',
      sessionId: 'session',
      readOnly: false,
      restricted: false,
    })
    expect(() => authorizeInternalMcpTool(cap.token, 'send_workspace_message', { workspace_id: 'other' })).not.toThrow()
    expect(() => authorizeInternalMcpTool(cap.token, 'send_workspace_message', { workspace_id: 'own' })).toThrow(
      /own workspace/,
    )
    expect(() => authorizeInternalMcpTool(cap.token, 'create_task', { workspace_id: 'other' })).toThrow(/workspace/)
    expect(() => authorizeInternalMcpTool(cap.token, 'invented_tool', {})).toThrow(/Unknown/)
  })
  it('only permits the bound reporting exception in a restricted launch', () => {
    const cap = createInternalMcpCapability({
      workspaceId: 'own',
      sessionId: 'session',
      readOnly: true,
      restricted: true,
      env: {
        KOBO_FINAL_REVIEW_TOKEN: 'report',
        KOBO_FINAL_REVIEW_SESSION_ID: 'session',
        KOBO_PROGRESS_SESSION_TOKEN: 'progress',
      },
    })
    expect(() => authorizeInternalMcpTool(cap.token, 'submit_final_review', {})).not.toThrow()
    expect(() => authorizeInternalMcpTool(cap.token, 'submit_session_handoff', {})).toThrow()
    expect(() => authorizeInternalMcpTool(cap.token, 'remember', {})).toThrow(/read-only/)
    expect(() => authorizeInternalMcpTool(cap.token, 'set_workspace_status', { status: 'completed' })).toThrow(
      /read-only/,
    )
  })
  it.each([
    { readOnly: false, restricted: false, post: true },
    { readOnly: true, restricted: false, post: true },
    { readOnly: true, restricted: true, post: false },
  ])('Slack tools for readOnly=$readOnly restricted=$restricted', ({ readOnly, restricted, post }) => {
    const cap = createInternalMcpCapability({ workspaceId: 'own', sessionId: 'session', readOnly, restricted })
    expect(() => authorizeInternalMcpTool(cap.token, 'slack_read_thread', { thread_ts: '1.1' })).not.toThrow()
    for (const args of [
      { text: 'hi' },
      { text: 'hi', buttons: [{ label: 'A' }], multiple: true },
      { text: 'hi', files: ['report.md'] },
    ]) {
      if (post) expect(() => authorizeInternalMcpTool(cap.token, 'slack_post_message', args)).not.toThrow()
      else
        expect(() => authorizeInternalMcpTool(cap.token, 'slack_post_message', args)).toThrow(
          'This managed MCP launch is read-only',
        )
    }
    if (post)
      expect(() => authorizeInternalMcpTool(cap.token, 'slack_close_buttons', { message_ts: '1.1' })).not.toThrow()
    else
      expect(() => authorizeInternalMcpTool(cap.token, 'slack_close_buttons', { message_ts: '1.1' })).toThrow(
        'This managed MCP launch is read-only',
      )
    for (const name of ['slack_read_thread', 'slack_post_message', 'slack_close_buttons'])
      expect(() => authorizeInternalMcpTool(cap.token, name, { text: 'hi', workspace_id: 'other' })).toThrow(
        /read-only|bound to its launch workspace/,
      )
  })
  it('F5: every non-read-only Slack tool is allowed in Plan and refused when restricted', async () => {
    const { SLACK_TOOLS } = await import('../shared/slack-tools.js')
    const plan = createInternalMcpCapability({ workspaceId: 'own', sessionId: 's', readOnly: true, restricted: false })
    const restricted = createInternalMcpCapability({
      workspaceId: 'own',
      sessionId: 's',
      readOnly: true,
      restricted: true,
    })
    const writes = SLACK_TOOLS.filter((t) => !t.annotations?.readOnlyHint).map((t) => t.name)
    expect(writes.length).toBeGreaterThan(0)
    for (const name of writes) {
      expect(() => authorizeInternalMcpTool(plan.token, name, {})).not.toThrow()
      expect(() => authorizeInternalMcpTool(restricted.token, name, {})).toThrow('This managed MCP launch is read-only')
    }
  })
  it('slack_close_buttons is managed only and absent from restricted dispatcher lists', async () => {
    const { EXTERNAL_TOOL_CATALOGUE } = await import('../server/services/external-mcp-credentials-service.js')
    expect(EXTERNAL_TOOL_CATALOGUE.map((t) => t.name)).not.toContain('slack_close_buttons')
    const { SLACK_TOOLS } = await import('../shared/slack-tools.js')
    const close = SLACK_TOOLS.find((t) => t.name === 'slack_close_buttons')
    // Handoff and final-review dispatcher lists keep only read-only tools (plus their own report tool).
    expect(close?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false })
  })
  it('allows workspace questions in Plan and keeps them out of restricted launches and external MCP', async () => {
    const { EXTERNAL_TOOL_CATALOGUE } = await import('../server/services/external-mcp-credentials-service.js')
    expect(EXTERNAL_TOOL_CATALOGUE.map((t) => t.name)).not.toContain('ask_user_question')
    for (const restricted of [true, false]) {
      const cap = createInternalMcpCapability({ workspaceId: 'own', sessionId: 's', readOnly: true, restricted })
      const ask = () => authorizeInternalMcpTool(cap.token, 'ask_user_question', {})
      if (restricted) expect(ask).toThrow(/read-only/)
      else expect(ask).not.toThrow()
    }
  })
  it('Plan operator interactions do not grant unrelated writes', () => {
    const plan = createInternalMcpCapability({
      workspaceId: 'own',
      sessionId: 'session',
      readOnly: true,
      restricted: false,
    })
    for (const name of ['create_task', 'remember', 'send_workspace_message', 'start_dev_server'])
      expect(() => authorizeInternalMcpTool(plan.token, name, { workspace_id: 'other' })).toThrow(/read-only/)
  })
  it('rejects another workspace_id for Slack tools in a writable launch', () => {
    const cap = createInternalMcpCapability({
      workspaceId: 'own',
      sessionId: 'session',
      readOnly: false,
      restricted: false,
    })
    for (const name of ['slack_read_thread', 'slack_post_message', 'slack_close_buttons'])
      expect(() => authorizeInternalMcpTool(cap.token, name, { workspace_id: 'other' })).toThrow(
        'Tool is bound to its launch workspace',
      )
  })
})

describe('agent workspace lifecycle switch', () => {
  const COVERED = [
    'create_workspace',
    'delete_workspace',
    'archive_workspace',
    'unarchive_workspace',
    'purge_workspace_worktree',
    'restore_workspace',
  ]
  const MESSAGE = 'Workspace lifecycle tools are disabled for agents. An operator can enable them in Settings.'
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kobo-lifecycle-switch-'))
    _setSettingsPath(join(dir, 'settings.json'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  const writable = () =>
    createInternalMcpCapability({ workspaceId: 'own', sessionId: 'session', readOnly: false, restricted: false })

  it.each(COVERED)('%s is refused by default, allowed once enabled, read per call', (name) => {
    const cap = writable()
    expect(() => authorizeInternalMcpTool(cap.token, name, {})).toThrow(MESSAGE)
    updateGlobalSettings({ agentWorkspaceLifecycleEnabled: true })
    expect(() => authorizeInternalMcpTool(cap.token, name, {})).not.toThrow()
    updateGlobalSettings({ agentWorkspaceLifecycleEnabled: false })
    expect(() => authorizeInternalMcpTool(cap.token, name, {})).toThrow(MESSAGE)
  })
  it.each(COVERED)('%s stays refused for read-only and restricted launches when enabled', (name) => {
    updateGlobalSettings({ agentWorkspaceLifecycleEnabled: true })
    for (const restricted of [false, true]) {
      const cap = createInternalMcpCapability({ workspaceId: 'own', sessionId: 's', readOnly: true, restricted })
      expect(() => authorizeInternalMcpTool(cap.token, name, {})).toThrow(/read-only/)
    }
  })
  it('does not affect other tools in either state', () => {
    const cap = writable()
    for (const enabled of [false, true]) {
      updateGlobalSettings({ agentWorkspaceLifecycleEnabled: enabled })
      for (const name of [
        'add_workspace_tags',
        'set_workspace_status',
        'run_setup_script',
        'diagnose_workspace_pr',
        'create_task',
      ])
        expect(() => authorizeInternalMcpTool(cap.token, name, {})).not.toThrow()
    }
  })
})
