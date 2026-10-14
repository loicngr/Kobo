import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))
vi.mock('../server/services/usage/poller.js', () => ({
  withUsageAccountSwitch: vi.fn(async (_provider: string, operation: () => Promise<unknown>) => operation()),
}))

import { listProviderAccounts, switchProviderAccount } from '../server/services/provider-accounts-service.js'
import { withUsageAccountSwitch } from '../server/services/usage/poller.js'

type Callback = (error: (Error & { code?: string }) | null, stdout: string, stderr: string) => void
const callbacks: Callback[] = []
const originalPlatform = process.platform
const claude = {
  schemaVersion: 1,
  activeAccountNumber: 1,
  accounts: [
    { number: 1, email: 'one@example.org', alias: 'Personal', active: true, accessToken: 'SECRET' },
    { number: 2, email: 'two@example.org', organizationName: 'Team', active: false, disabled: true },
  ],
  credentials: 'SECRET',
}
const codex = {
  provider: 'codex',
  activeAccountNumber: null,
  accounts: [{ number: 3, email: 'three@example.org', label: 'Plus', active: false, disabled: false }],
}
function respond(payload: unknown) {
  const callback = callbacks.shift()
  expect(callback).toBeDefined()
  callback?.(null, JSON.stringify(payload), '')
}
async function drain() {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}
async function success(payload: unknown) {
  await drain()
  respond(payload)
  await drain()
}

beforeEach(() => {
  vi.clearAllMocks()
  callbacks.length = 0
  vi.stubEnv('CLAUDE_SECURESTORAGE_CONFIG_DIR', undefined)
  vi.stubEnv('CLAUDE_CONFIG_DIR', undefined)
  vi.stubEnv('CODEX_HOME', undefined)
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    callbacks.push(args.at(-1) as Callback)
    return {} as ReturnType<typeof execFile>
  })
})
afterEach(() => {
  vi.unstubAllEnvs()
  Object.defineProperty(process, 'platform', { value: originalPlatform })
})

describe('provider accounts adapter', () => {
  it('allowlists Claude metadata and runs a bounded command without a shell in the runtime environment', async () => {
    const pending = listProviderAccounts('claude-code')
    await success(claude)
    expect(await pending).toEqual({
      available: true,
      accounts: [
        { id: '1', email: 'one@example.org', label: 'Personal', active: true, disabled: false },
        { id: '2', email: 'two@example.org', label: 'Team', active: false, disabled: true },
      ],
    })
    const [command, args, options] = vi.mocked(execFile).mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ]
    expect(command).toBe('ccswap')
    expect(args).toEqual(['list', '--provider', 'claude', '--json'])
    const { env, ...safeOptions } = options
    expect(safeOptions).toMatchObject({
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
      shell: false,
      killSignal: 'SIGKILL',
    })
    expect(env === process.env).toBe(true)
  })

  it('supports Codex and an unmanaged current login without inventing an active slot', async () => {
    const pending = listProviderAccounts('codex')
    await success(codex)
    expect(await pending).toEqual({
      available: true,
      accounts: [{ id: '3', email: 'three@example.org', label: 'Plus', active: false, disabled: false }],
    })
    expect(vi.mocked(execFile).mock.calls[0]?.[1]).toEqual(['codex', 'list', '--json'])
  })

  it('returns unavailable only for a missing executable', async () => {
    const pending = listProviderAccounts('codex')
    await drain()
    callbacks.shift()?.(Object.assign(new Error('SECRET'), { code: 'ENOENT' }), '', 'SECRET')
    expect(await pending).toEqual({ available: false, accounts: [] })
  })

  it.each(['not json SECRET', '{}', '{"provider":"codex","accounts": [{"number":"--help"}]}'])(
    'rejects malformed output safely (%s)',
    async (raw) => {
      const pending = listProviderAccounts('codex')
      const rejection = expect(pending).rejects.toMatchObject({
        code: 'accounts_command_failed',
        message: 'Account operation failed.',
      })
      await drain()
      callbacks.shift()?.(null, raw, 'SECRET')
      await rejection
    },
  )

  it('does not forward subprocess failures or secrets', async () => {
    const pending = listProviderAccounts('claude-code')
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'accounts_command_failed',
      message: 'Account operation failed.',
    })
    await drain()
    callbacks.shift()?.(Object.assign(new Error('SECRET'), { code: 'ETIMEDOUT' }), 'SECRET', 'SECRET')
    await rejection
  })

  it.each(['other', '--help'])('rejects unsupported provider %s before spawning', async (provider) => {
    await expect(listProviderAccounts(provider)).rejects.toMatchObject({ code: 'accounts_unknown_provider' })
    expect(execFile).not.toHaveBeenCalled()
  })

  it.each(['--help', '1; touch /tmp/file', '', '0', '01', '9007199254740992', 2])(
    'rejects invalid slot %s before spawning',
    async (slot) => {
      await expect(switchProviderAccount('codex', slot)).rejects.toMatchObject({ code: 'accounts_invalid_account' })
      expect(execFile).not.toHaveBeenCalled()
    },
  )

  it.each(['2', '9'])('refuses disabled or removed slot %s after reloading the list', async (slot) => {
    const pending = switchProviderAccount('claude-code', slot)
    const rejection = expect(pending).rejects.toMatchObject({
      code: slot === '2' ? 'accounts_disabled' : 'accounts_not_found',
    })
    await success(claude)
    await rejection
    expect(execFile).toHaveBeenCalledTimes(1)
    expect(withUsageAccountSwitch).not.toHaveBeenCalled()
  })

  it('switches Claude with quota invalidation and returns freshly read account metadata', async () => {
    const pending = switchProviderAccount('claude-code', '1')
    await success(claude)
    await success({ schemaVersion: 1, switched: true, to: { number: 1 } })
    await success(claude)
    expect((await pending).accounts[0]?.active).toBe(true)
    expect(vi.mocked(execFile).mock.calls[1]?.[1]).toEqual(['switch', '1', '--json'])
    expect(withUsageAccountSwitch).toHaveBeenCalledWith('claude-code', expect.any(Function))
  })

  it('serializes the complete validation/switch/list operation across providers', async () => {
    const first = switchProviderAccount('codex', '3')
    const second = listProviderAccounts('claude-code')
    await drain()
    expect(execFile).toHaveBeenCalledTimes(1)
    await success(codex)
    expect(vi.mocked(execFile).mock.calls[1]?.[1]).toEqual(['codex', 'switch', '3', '--json'])
    await success({ provider: 'codex', switched: true, to: { number: 3 } })
    expect(vi.mocked(execFile).mock.calls[2]?.[1]).toEqual(['codex', 'list', '--json'])
    await success({ ...codex, activeAccountNumber: 3, accounts: [{ ...codex.accounts[0], active: true }] })
    await first
    await success(claude)
    await second
    expect(withUsageAccountSwitch).not.toHaveBeenCalled()
  })

  it('does not switch a different Claude secure store', async () => {
    vi.stubEnv('CLAUDE_SECURESTORAGE_CONFIG_DIR', '/another/profile')
    await expect(switchProviderAccount('claude-code', '1')).rejects.toMatchObject({
      code: 'accounts_unsupported_environment',
    })
    expect(execFile).not.toHaveBeenCalled()
  })
  it('accepts the empty Codex switch stdout in ccswap 0.37 and verifies the active slot afterwards', async () => {
    const pending = switchProviderAccount('codex', '3')
    await success(codex)
    callbacks.shift()?.(null, '', '')
    await drain()
    await success({ ...codex, activeAccountNumber: 3, accounts: [{ ...codex.accounts[0], active: true }] })
    expect((await pending).accounts[0]?.active).toBe(true)
  })

  it('rejects an unconfirmed switch even when the CLI exited successfully', async () => {
    const pending = switchProviderAccount('codex', '3')
    const rejection = expect(pending).rejects.toMatchObject({ code: 'accounts_command_failed' })
    await success(codex)
    await success({ switched: true, to: { number: 3 } })
    await success(codex)
    await rejection
  })

  it('expires a queued switch without executing it after the caller has received busy', async () => {
    vi.useFakeTimers()
    try {
      const listing = listProviderAccounts('codex')
      await drain()
      const switching = switchProviderAccount('codex', '3')
      const rejection = expect(switching).rejects.toMatchObject({ code: 'accounts_busy' })
      await vi.advanceTimersByTimeAsync(5_000)
      await rejection
      await success(codex)
      await listing
      expect(execFile).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
  it('refuses an explicit default Claude directory on macOS because it selects a hashed Keychain service', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(os.homedir(), '.claude'))
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const switches = (args[1] as string[]).includes('switch')
      ;(args.at(-1) as Callback)(
        null,
        JSON.stringify(switches ? { schemaVersion: 1, switched: true, to: { number: 1 } } : claude),
        '',
      )
      return {} as ReturnType<typeof execFile>
    })
    await expect(switchProviderAccount('claude-code', '1')).rejects.toMatchObject({
      code: 'accounts_unsupported_environment',
      status: 409,
    })
    expect(execFile).not.toHaveBeenCalled()
  })

  it.each([
    ['claude-code', 'CLAUDE_CONFIG_DIR', 'list'],
    ['claude-code', 'CLAUDE_CONFIG_DIR', 'switch'],
    ['codex', 'CODEX_HOME', 'list'],
    ['codex', 'CODEX_HOME', 'switch'],
  ])('rejects relative %s %s for %s before accessing another profile', async (provider, variable, operation) => {
    vi.stubEnv(variable, '../profile')
    const payload =
      provider === 'codex'
        ? { ...codex, activeAccountNumber: 3, accounts: [{ ...codex.accounts[0], active: true }] }
        : claude
    const slot = provider === 'codex' ? '3' : '1'
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const switches = (args[1] as string[]).includes('switch')
      const callback = args.at(-1) as Callback
      callback(
        null,
        JSON.stringify(switches ? { schemaVersion: 1, switched: true, to: { number: Number(slot) } } : payload),
        '',
      )
      return {} as ReturnType<typeof execFile>
    })
    const pending = operation === 'list' ? listProviderAccounts(provider) : switchProviderAccount(provider, slot)
    await expect(pending).rejects.toMatchObject({
      code: 'accounts_unsupported_environment',
      status: 409,
      message: 'Account switching is unsupported in this runtime environment.',
    })
    expect(execFile).not.toHaveBeenCalled()
  })

  it.each([
    ['claude-code', 'CLAUDE_CONFIG_DIR', '/container/claude'],
    ['codex', 'CODEX_HOME', '/container/codex'],
  ])('preserves absolute %s profiles in the container environment', async (provider, variable, home) => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    vi.stubEnv(variable, home)
    vi.stubEnv('HOME', '/container/runtime-home')
    const payload =
      provider === 'codex'
        ? { ...codex, activeAccountNumber: 3, accounts: [{ ...codex.accounts[0], active: true }] }
        : claude
    const slot = provider === 'codex' ? '3' : '1'
    const listing = listProviderAccounts(provider)
    await success(payload)
    expect((await listing).available).toBe(true)
    const switching = switchProviderAccount(provider, slot)
    await success(payload)
    await success({ schemaVersion: 1, switched: true, to: { number: Number(slot) } })
    await success(payload)
    expect((await switching).accounts.some((account) => account.id === slot && account.active)).toBe(true)
    for (const call of vi.mocked(execFile).mock.calls) {
      const options = call[2] as { env: NodeJS.ProcessEnv; cwd: string }
      expect(options.env === process.env).toBe(true)
      expect(options.env[variable]).toBe(home)
      expect(options.env.HOME).toBe('/container/runtime-home')
      expect(options.cwd).toBe('/container/runtime-home')
    }
  })
})
