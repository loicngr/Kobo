import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/services/provider-accounts-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/services/provider-accounts-service.js')>()
  return { ...actual, listProviderAccounts: vi.fn(), switchProviderAccount: vi.fn() }
})
vi.mock('../server/services/usage/poller.js', () => ({ refreshNow: vi.fn(), withUsageAccountSwitch: vi.fn() }))

import app from '../server/routes/usage.js'
import {
  listProviderAccounts,
  ProviderAccountsError,
  switchProviderAccount,
} from '../server/services/provider-accounts-service.js'

beforeEach(() => vi.clearAllMocks())
const accounts = {
  available: true,
  accounts: [{ id: '1', email: 'user@example.org', label: 'Personal', active: true, disabled: false }],
}
const post = (body: string) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body })

describe('provider account routes', () => {
  it.each(['claude-code', 'codex'])('lists %s accounts', async (provider) => {
    vi.mocked(listProviderAccounts).mockResolvedValueOnce(accounts)
    const response = await app.request(`/${provider}/accounts`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(accounts)
    expect(listProviderAccounts).toHaveBeenCalledWith(provider)
  })
  it('reports an optional missing CLI as unavailable', async () => {
    vi.mocked(listProviderAccounts).mockResolvedValueOnce({ available: false, accounts: [] })
    const response = await app.request('/codex/accounts')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ available: false, accounts: [] })
  })
  it('switches only with the explicit selected numeric slot', async () => {
    vi.mocked(switchProviderAccount).mockResolvedValueOnce(accounts)
    const response = await app.request('/claude-code/accounts/switch', post('{"accountId":"1"}'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(accounts)
    expect(switchProviderAccount).toHaveBeenCalledWith('claude-code', '1')
  })
  it.each(['bad json', 'null', '[]', '{}', '{"accountId":2}', '{"accountId":"--help"}'])(
    'rejects invalid bodies (%s)',
    async (body) => {
      const response = await app.request('/codex/accounts/switch', post(body))
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'accounts_invalid_account' })
      expect(switchProviderAccount).not.toHaveBeenCalled()
    },
  )
  it('maps known failures to safe stable errors', async () => {
    vi.mocked(switchProviderAccount).mockRejectedValueOnce(new ProviderAccountsError('accounts_disabled'))
    const response = await app.request('/codex/accounts/switch', post('{"accountId":"1"}'))
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'Account is disabled.', code: 'accounts_disabled' })
  })
  it('does not leak unexpected subprocess errors', async () => {
    vi.mocked(listProviderAccounts).mockRejectedValueOnce(new Error('SECRET token stderr'))
    const response = await app.request('/codex/accounts')
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'Account operation failed.', code: 'accounts_command_failed' })
  })
})
