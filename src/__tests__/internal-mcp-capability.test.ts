import { describe, expect, it } from 'vitest'
import {
  authorizeInternalMcpTool,
  createInternalMcpCapability,
  revokeInternalMcpCapability,
} from '../server/services/internal-mcp-capability-service.js'

describe('managed MCP launch authorization', () => {
  it('rejects explicit mutations in ordinary Plan sessions', () => {
    const capability = createInternalMcpCapability({ workspaceId: 'own', sessionId: 'session', readOnly: true })
    expect(() => authorizeInternalMcpTool(capability.token, 'create_task', {})).toThrow(/read-only/)
    expect(() => authorizeInternalMcpTool(capability.token, 'delete_workspace', { workspace_id: 'other' })).toThrow(
      /read-only/,
    )
    expect(authorizeInternalMcpTool(capability.token, 'list_tasks', {}).workspaceId).toBe('own')
  })
  it('revokes all tools without affecting a replacement launch', () => {
    const old = createInternalMcpCapability({ workspaceId: 'own', sessionId: 'session', readOnly: false })
    const replacement = createInternalMcpCapability({ workspaceId: 'own', sessionId: 'session', readOnly: false })
    revokeInternalMcpCapability(old.token)
    expect(() => authorizeInternalMcpTool(old.token, 'create_task', {})).toThrow(/capability/)
    expect(() => authorizeInternalMcpTool(old.token, 'list_tasks', {})).toThrow(/capability/)
    expect(authorizeInternalMcpTool(replacement.token, 'create_task', {}).sessionId).toBe('session')
  })
  it('keeps writable cross-workspace dialogue but refuses self messaging and forged scoped targets', () => {
    const cap = createInternalMcpCapability({ workspaceId: 'own', sessionId: 'session', readOnly: false })
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
      env: {
        KOBO_FINAL_REVIEW_TOKEN: 'report',
        KOBO_FINAL_REVIEW_SESSION_ID: 'session',
        KOBO_PROGRESS_SESSION_TOKEN: 'progress',
      },
    })
    expect(() => authorizeInternalMcpTool(cap.token, 'submit_final_review', {})).not.toThrow()
    expect(() => authorizeInternalMcpTool(cap.token, 'submit_session_handoff', {})).toThrow()
    expect(() => authorizeInternalMcpTool(cap.token, 'remember', {})).toThrow(/read-only/)
  })
})
