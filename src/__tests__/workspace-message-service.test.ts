import { beforeEach, expect, it, vi } from 'vitest'

vi.mock('../server/services/agent/orchestrator.js', () => ({
  sendMessage: vi.fn(),
  startAgent: vi.fn(),
  isShuttingDown: vi.fn(() => false),
  isAgentUnavailableError: (message: string) => message.startsWith('No agent running'),
}))
vi.mock('../server/services/workspace-service.js', () => ({
  getWorkspace: vi.fn(),
  getActiveSession: vi.fn(),
  updateWorkspaceStatus: vi.fn(),
}))
vi.mock('../server/services/auto-loop-service.js', () => ({
  getStatus: vi.fn(() => ({ auto_loop: false })),
  disable: vi.fn(),
}))
vi.mock('../server/services/websocket-service.js', () => ({ emit: vi.fn(() => 'event-id'), emitEphemeral: vi.fn() }))

import * as agent from '../server/services/agent/orchestrator.js'
import * as autoLoop from '../server/services/auto-loop-service.js'
import { emit, emitEphemeral } from '../server/services/websocket-service.js'
import { deliverWorkspaceMessage } from '../server/services/workspace-message-service.js'
import * as workspaces from '../server/services/workspace-service.js'
import { withWorkspaceLifecycleGuard } from '../server/utils/workspace-lifecycle-guard.js'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(agent.isShuttingDown).mockReturnValue(false)
  vi.mocked(agent.sendMessage).mockResolvedValue()
  vi.mocked(agent.startAgent).mockReturnValue({ agentSessionId: 'resumed' } as never)
  vi.mocked(workspaces.getActiveSession).mockReturnValue({ id: 'active' } as never)
  vi.mocked(workspaces.getWorkspace).mockReturnValue({
    id: 'ws',
    worktreePath: '/tmp/worktree',
    status: 'executing',
    agentPermissionMode: 'strict',
    model: 'model',
    reasoningEffort: 'high',
  } as never)
})

it('delivers to the selected session and persists a correlated message', async () => {
  expect(
    await deliverWorkspaceMessage('ws', { content: 'hello', sessionId: 'active', clientMessageId: 'external-1' }),
  ).toEqual({ sessionId: 'active' })
  expect(agent.sendMessage).toHaveBeenCalledWith('ws', 'hello', 'active')
  expect(emit).toHaveBeenCalledWith(
    'ws',
    'user:message',
    expect.objectContaining({ content: 'hello', clientMessageId: 'external-1' }),
    'active',
    { requirePersistence: true },
  )
})

it('resumes an unavailable agent using the workspace permission mode', async () => {
  vi.mocked(agent.sendMessage).mockRejectedValue(new Error('No agent running'))
  expect(await deliverWorkspaceMessage('ws', { content: 'continue' })).toEqual({ sessionId: 'resumed' })
  expect(agent.startAgent).toHaveBeenCalledWith(
    'ws',
    '/tmp/worktree',
    'continue',
    'model',
    true,
    'strict',
    undefined,
    'high',
  )
})

it.each([
  { status: 'compacting' },
  { status: 'awaiting-user' },
  { archivedAt: 'yesterday' },
  { worktreePurgedAt: 'yesterday' },
])('rejects an unavailable workspace state %j before delivery', async (fields) => {
  vi.mocked(workspaces.getWorkspace).mockReturnValue({ id: 'ws', ...fields } as never)
  await expect(deliverWorkspaceMessage('ws', { content: 'hello' })).rejects.toThrow()
  expect(agent.sendMessage).not.toHaveBeenCalled()
  expect(agent.startAgent).not.toHaveBeenCalled()
  expect(emit).not.toHaveBeenCalled()
})

it('rejects a missing workspace', async () => {
  vi.mocked(workspaces.getWorkspace).mockReturnValue(null)
  await expect(deliverWorkspaceMessage('missing', { content: 'hello' })).rejects.toThrow('not found')
})

it('does not start a replacement after a delivery or persistence error', async () => {
  vi.mocked(agent.sendMessage).mockRejectedValue(new Error('Session is not active'))
  await expect(deliverWorkspaceMessage('ws', { content: 'hello', clientMessageId: 'id' })).rejects.toThrow('not active')
  expect(agent.startAgent).not.toHaveBeenCalled()
  expect(emitEphemeral).toHaveBeenCalledWith('ws', 'chat:rejected', expect.objectContaining({ clientMessageId: 'id' }))
})

it('refuses a lifecycle operation in progress', async () => {
  await withWorkspaceLifecycleGuard('ws', async () => {
    await expect(deliverWorkspaceMessage('ws', { content: 'hello' })).rejects.toThrow('operation')
  })
  expect(agent.sendMessage).not.toHaveBeenCalled()
})

it('does not resume when persisting the accepted message fails', async () => {
  vi.mocked(emit).mockImplementationOnce(() => {
    throw new Error('No agent running: persistence failed')
  })
  await expect(deliverWorkspaceMessage('ws', { content: 'hello', clientMessageId: 'id' })).rejects.toThrow(
    'persistence failed',
  )
  expect(agent.sendMessage).toHaveBeenCalledOnce()
  expect(agent.startAgent).not.toHaveBeenCalled()
})

it('refuses delivery during shutdown', async () => {
  vi.mocked(agent.isShuttingDown).mockReturnValue(true)
  await expect(deliverWorkspaceMessage('ws', { content: 'hello' })).rejects.toThrow('shutting down')
  expect(agent.sendMessage).not.toHaveBeenCalled()
})

it('disables an active auto-loop when redirecting the agent', async () => {
  vi.mocked(autoLoop.getStatus).mockReturnValueOnce({ auto_loop: true, auto_loop_ready: true } as never)
  await deliverWorkspaceMessage('ws', { content: 'new direction' })
  expect(autoLoop.disable).toHaveBeenCalledWith('ws', 'user-action')
})
