import { Hono } from 'hono'
import { getDb } from '../db/index.js'
import {
  listProviderAccounts,
  ProviderAccountsError,
  switchProviderAccount,
  validateAccountId,
} from '../services/provider-accounts-service.js'
import { refreshNow } from '../services/usage/poller.js'
import {
  clearReliabilityReset,
  computeEngineReliability,
  getReliabilityResetAt,
  resetReliability,
} from '../services/usage/reliability.js'
import type { ProviderId } from '../services/usage/types.js'

const app = new Hono()

// GET /api/usage/reliability — how each engine and model actually behaved.
app.get('/reliability', (c) => {
  try {
    const db = getDb()
    return c.json({ engines: computeEngineReliability(db), resetAt: getReliabilityResetAt(db) })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// POST /api/usage/reliability/reset - count again from now. Sessions are kept.
// Declared before `/:providerId/refresh` so the static path is never captured.
app.post('/reliability/reset', (c) => {
  try {
    const db = getDb()
    const resetAt = resetReliability(db)
    return c.json({ engines: computeEngineReliability(db), resetAt })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// DELETE /api/usage/reliability/reset - count the whole history again.
app.delete('/reliability/reset', (c) => {
  try {
    const db = getDb()
    clearReliabilityReset(db)
    return c.json({ engines: computeEngineReliability(db), resetAt: null })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

function accountError(error: unknown): ProviderAccountsError {
  return error instanceof ProviderAccountsError ? error : new ProviderAccountsError('accounts_command_failed')
}

app.get('/:providerId/accounts', async (c) => {
  try {
    return c.json(await listProviderAccounts(c.req.param('providerId')))
  } catch (error) {
    const safe = accountError(error)
    return c.json({ error: safe.message, code: safe.code }, safe.status)
  }
})

app.post('/:providerId/accounts/switch', async (c) => {
  try {
    const body: unknown = await c.req.json().catch(() => null)
    const accountId = validateAccountId(
      typeof body === 'object' && body !== null && 'accountId' in body ? body.accountId : undefined,
    )
    return c.json(await switchProviderAccount(c.req.param('providerId'), accountId))
  } catch (error) {
    const safe = accountError(error)
    return c.json({ error: safe.message, code: safe.code }, safe.status)
  }
})

app.post('/:providerId/refresh', async (c) => {
  const providerId = c.req.param('providerId') as ProviderId
  try {
    const snap = await refreshNow(providerId)
    if (!snap) {
      return c.json({ error: `Unknown provider '${providerId}'` }, 404)
    }
    return c.json({ snapshot: snap }, 200)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

export default app
