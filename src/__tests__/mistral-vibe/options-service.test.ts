import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  request: vi.fn(),
  connect: vi.fn(),
  close: vi.fn(),
  workspace: vi.fn(),
}))
vi.mock('../../server/services/agent/engines/mistral-vibe/spawn.js', () => ({ spawnVibeAcp: mocks.spawn }))
vi.mock('../../server/services/agent/engines/mistral-vibe/client.js', () => ({
  connectVibeAcp: mocks.connect,
  requestVibeAcp: mocks.request,
  closeVibeAcpSession: mocks.close,
}))
vi.mock('../../server/services/workspace-service.js', () => ({ getWorkspace: mocks.workspace }))
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
const response = (model = 'alias') => ({
  sessionId: 'native',
  configOptions: [
    { id: 'mode', type: 'select', currentValue: 'ask', options: [{ value: 'ask', name: 'Ask' }] },
    {
      id: 'model',
      type: 'select',
      currentValue: model,
      options: [
        { value: 'alias', name: 'Native alias' },
        { value: 'other', name: 'Other' },
      ],
    },
    { id: 'thinking', type: 'select', currentValue: 'off', options: [{ value: 'off', name: 'Disabled' }] },
  ],
})
let closed: ReturnType<typeof deferred>
let stop: ReturnType<typeof vi.fn>
afterEach(() => vi.unstubAllEnvs())
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  closed = deferred()
  stop = vi.fn(async (cooperate) => {
    await cooperate?.()
    closed.resolve()
  })
  mocks.spawn.mockReturnValue({ child: {}, closed: closed.promise, stop })
  mocks.connect.mockReturnValue({ close: vi.fn() })
  mocks.request.mockImplementation(async (_connection, method) =>
    method === 'initialize'
      ? { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } }
      : response(),
  )
})
it('coalesces discovery, inherits native environment, sends no prompt/setter/MCP and publishes only after closure', async () => {
  vi.stubEnv('KOBO_MCP_SESSION_TOKEN', 'must-not-be-granted')
  const { getMistralOptions } = await import('../../server/services/mistral-options-service.js')
  stop.mockImplementation(async (cooperate) => {
    await cooperate?.()
    await closed.promise
  })
  let settled = false
  const input = { projectPath: process.cwd(), model: 'alias' }
  const first = getMistralOptions(input).then((value) => {
    settled = true
    return value
  })
  const second = getMistralOptions(input)
  await vi.waitFor(() => expect(stop).toHaveBeenCalled())
  expect(settled).toBe(false)
  expect(mocks.spawn).toHaveBeenCalledOnce()
  const env = mocks.spawn.mock.calls[0]![0].env
  expect(env).toMatchObject({
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    VIBE_ACTIVE_MODEL: 'alias',
    VIBE_DEFAULT_AGENT: 'ask',
  })
  expect(Object.keys(env).filter((key) => /^KOBO_.*TOKEN$/.test(key))).toEqual([])
  expect(mocks.request.mock.calls.map((call) => call[1])).toEqual(['initialize', 'session/new'])
  expect(mocks.request.mock.calls[1]![2].mcpServers).toEqual([])
  closed.resolve()
  expect(await first).toEqual(await second)
  expect(mocks.close).toHaveBeenCalledWith(expect.anything(), { sessionId: 'native', active: false, canClose: true })
  await getMistralOptions(input)
  expect(mocks.spawn).toHaveBeenCalledOnce()
})
it('rejects a profile model mismatch and closes without persisting or prompting', async () => {
  const { getMistralOptions } = await import('../../server/services/mistral-options-service.js')
  await expect(getMistralOptions({ projectPath: process.cwd(), model: 'other' })).rejects.toThrow(/profile/)
  expect(stop).toHaveBeenCalled()
  expect(mocks.request.mock.calls).toHaveLength(2)
})
it('retains failed cleanup slots until actual closed confirmation', async () => {
  const { getMistralOptions } = await import('../../server/services/mistral-options-service.js')
  stop.mockRejectedValue(new Error('private native stderr'))
  for (let i = 0; i < 4; i++)
    await expect(getMistralOptions({ projectPath: process.cwd(), model: `alias-${i}` })).rejects.toThrow(
      /ownership retained/,
    )
  await expect(getMistralOptions({ projectPath: process.cwd() })).rejects.toThrow(/busy/)
  expect(mocks.spawn).toHaveBeenCalledTimes(4)
  closed.resolve()
  stop.mockResolvedValue(undefined)
  await expect(getMistralOptions({ projectPath: process.cwd() })).resolves.toHaveProperty('model')
})
it('rejects invalid contexts before spawning and skips pure Auto preflight', async () => {
  const { getMistralOptions, preflightMistralConfiguration } = await import(
    '../../server/services/mistral-options-service.js'
  )
  for (const input of [
    { projectPath: '/not-present-kobo' },
    { projectPath: 'bad\0' },
    { workspaceId: 'missing' },
    { workspaceId: 'w', projectPath: process.cwd() },
    { agentPermissionMode: 'plan' },
  ])
    await expect(getMistralOptions(input)).rejects.toThrow()
  await preflightMistralConfiguration(
    'mistral-vibe',
    { projectPath: '/not-present-kobo' },
    { model: 'auto', reasoningEffort: 'auto' },
  )
  expect(mocks.spawn).not.toHaveBeenCalled()
})

it('defers Auto-model resume thinking validation to the loaded session instead of new-session defaults', async () => {
  const { preflightMistralConfiguration } = await import('../../server/services/mistral-options-service.js')
  const selection = { model: 'auto', reasoningEffort: 'max', agentPermissionMode: 'interactive' }
  await preflightMistralConfiguration('mistral-vibe', { projectPath: process.cwd() }, selection, true)
  expect(mocks.spawn).not.toHaveBeenCalled()
  await expect(
    preflightMistralConfiguration('mistral-vibe', { projectPath: process.cwd() }, selection),
  ).rejects.toThrow(/thinking selection/)
  expect(mocks.spawn).toHaveBeenCalledOnce()
  await expect(
    preflightMistralConfiguration(
      'mistral-vibe',
      { projectPath: process.cwd() },
      { ...selection, reasoningEffort: 'bad\0value' },
      true,
    ),
  ).rejects.toThrow(/Invalid/)
})
