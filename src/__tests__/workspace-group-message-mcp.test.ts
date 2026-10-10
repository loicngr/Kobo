import { beforeEach, expect, it, vi } from 'vitest'
import { executeWorkspaceGroupMessageTool } from '../server/services/workspace-group-message-mcp-service.js'
import { GroupMessageError } from '../server/services/workspace-group-message-service.js'
import { validateWorkspaceGroupMessageArguments } from '../shared/workspace-group-message-tools.js'

const mocks = vi.hoisted(() => ({ list: vi.fn(), start: vi.fn(), get: vi.fn() }))
vi.mock('../server/services/workspace-service.js', () => ({ listWorkspaces: mocks.list }))
vi.mock('../server/services/workspace-group-message-service.js', () => ({
  startGroupMessageBatch: mocks.start,
  getGroupMessageBatch: mocks.get,
  GroupMessageError: class extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message)
    }
  },
}))
beforeEach(() => vi.resetAllMocks())
it('intersects running dev servers with the tag and workspace status filters', () => {
  mocks.list.mockReturnValue([
    { id: 'a', name: 'A', tags: ['API'], status: 'idle', devServerStatus: 'running' },
    { id: 'b', name: 'B', tags: ['API'], status: 'idle', devServerStatus: 'starting' },
    { id: 'c', name: 'C', tags: ['API'], status: 'idle', devServerStatus: 'stopped' },
    { id: 'd', name: 'D', tags: ['UI'], status: 'idle', devServerStatus: 'running' },
    { id: 'e', name: 'E', tags: ['API'], status: 'executing', devServerStatus: 'running' },
  ])
  const filters = { tags: ['API'], statuses: ['idle'], dev_server_running: true }
  expect(executeWorkspaceGroupMessageTool('preview_workspace_group_message', filters)).toMatchObject({
    total: 1,
    recipients: [{ workspaceId: 'a' }],
  })
  expect(
    executeWorkspaceGroupMessageTool('preview_workspace_group_message', { ...filters, dev_server_running: false }),
  ).toMatchObject({ total: 3 })
})
it('previews OR tags/statuses intersected, omitting archived and purged workspaces with deterministic pagination', () => {
  mocks.list.mockReturnValue([
    { id: 'b', name: 'B', tags: ['API'], status: 'idle', autoLoop: true },
    { id: 'a', name: 'A', tags: ['UI'], status: 'executing', autoLoop: false },
    { id: 'c', name: 'C', tags: ['API'], status: 'error' },
    { id: 'd', name: 'D', tags: ['Other'], status: 'idle' },
    { id: 'e', name: 'E', tags: ['API'], status: 'idle', worktreePurgedAt: 'date' },
    { id: 'f', name: 'F', tags: ['API'], status: 'idle', archivedAt: 'date' },
  ])
  expect(
    executeWorkspaceGroupMessageTool('preview_workspace_group_message', {
      tags: ['API', 'UI'],
      statuses: ['idle', 'executing'],
      limit: 1,
      offset: 1,
    }),
  ).toEqual({
    total: 2,
    offset: 1,
    limit: 1,
    recipients: [{ workspaceId: 'b', name: 'B', tags: ['API'], status: 'idle', delivery: 'next_iteration' }],
  })
})
it('sends only explicit IDs and preserves source attribution', () => {
  const source = { kind: 'mcp' as const, clientName: 'Agent', transport: 'stdio' as const }
  mocks.start.mockReturnValue({ id: 'request', complete: false, recipients: [] })
  expect(
    executeWorkspaceGroupMessageTool(
      'send_workspace_group_message',
      { request_id: 'request', workspace_ids: ['a'], content: 'Bonjour' },
      source,
    ),
  ).toMatchObject({ id: 'request', complete: false })
  expect(mocks.start).toHaveBeenCalledWith({ requestId: 'request', workspaceIds: ['a'], content: 'Bonjour' }, source)
})
it('returns persisted result and reports missing requests', () => {
  mocks.get.mockReturnValueOnce({ id: 'request', complete: true })
  expect(executeWorkspaceGroupMessageTool('get_workspace_group_message', { request_id: 'request' })).toEqual({
    id: 'request',
    complete: true,
  })
  expect(() => executeWorkspaceGroupMessageTool('get_workspace_group_message', { request_id: 'missing' })).toThrow(
    'not found',
  )
})
it.each([
  ['send_workspace_group_message', { request_id: 'r', tags: ['API'], content: 'Hi' }],
  ['send_workspace_group_message', { request_id: 'r', workspace_ids: ['a', 'a'], content: 'Hi' }],
  ['send_workspace_group_message', { request_id: 'r', workspace_ids: ['*'], content: 'Hi' }],
  ['send_workspace_group_message', { request_id: 'r', workspace_ids: ['a'], content: ' ' }],
  [
    'send_workspace_group_message',
    { request_id: 'r', workspace_ids: Array.from({ length: 201 }, (_, i) => `a${i}`), content: 'Hi' },
  ],
  ['preview_workspace_group_message', { statuses: ['invalid'] }],
  ['preview_workspace_group_message', { tags: 'API' }],
  ['preview_workspace_group_message', { limit: 201 }],
  ['preview_workspace_group_message', { offset: -1 }],
  ['preview_workspace_group_message', { dev_server_running: 'true' }],
  ['preview_workspace_group_message', { dev_server_running: 1 }],
  ['preview_workspace_group_message', { dev_server_running: null }],
  ['get_workspace_group_message', { request_id: '../a' }],
  ['get_workspace_group_message', { request_id: 'r', extra: true }],
])('rejects invalid arguments for %s', (name, args) => {
  expect(() => validateWorkspaceGroupMessageArguments(name, args)).toThrow()
  expect(mocks.start).not.toHaveBeenCalled()
})

it('preserves a backend idempotency conflict as a structured MCP error', () => {
  mocks.start.mockImplementation(() => {
    throw new GroupMessageError('Request ID already used', 409)
  })
  expect(() =>
    executeWorkspaceGroupMessageTool('send_workspace_group_message', {
      request_id: 'r',
      workspace_ids: ['a'],
      content: 'Hi',
    }),
  ).toThrow(expect.objectContaining({ status: 409, message: 'Request ID already used' }))
})
