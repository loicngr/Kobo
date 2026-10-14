import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import type { AccountProviderId, ProviderAccount, ProviderAccounts } from '../../shared/provider-accounts.js'
import { withUsageAccountSwitch } from './usage/poller.js'

const ERRORS = {
  accounts_unknown_provider: [404, 'Unknown account provider.'],
  accounts_invalid_account: [400, 'Invalid account selection.'],
  accounts_not_found: [404, 'Account is no longer available.'],
  accounts_disabled: [409, 'Account is disabled.'],
  accounts_unavailable: [503, 'Account switching is unavailable.'],
  accounts_unsupported_environment: [409, 'Account switching is unsupported in this runtime environment.'],
  accounts_command_failed: [502, 'Account operation failed.'],
  accounts_busy: [429, 'Account operations are busy.'],
} as const

export class ProviderAccountsError extends Error {
  readonly status: (typeof ERRORS)[keyof typeof ERRORS][0]
  constructor(readonly code: keyof typeof ERRORS) {
    super(ERRORS[code][1])
    this.status = ERRORS[code][0]
  }
}

// ccswap shares backup/config state across providers. Keep validation and the
// post-switch read in the same queue, not just the mutating child process.
let operations: Promise<unknown> = Promise.resolve()
let queued = 0
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  if (queued >= 32) return Promise.reject(new ProviderAccountsError('accounts_busy'))
  queued++
  return new Promise<T>((resolve, reject) => {
    let expired = false
    const timeout = setTimeout(() => {
      expired = true
      reject(new ProviderAccountsError('accounts_busy'))
    }, 5_000)
    const result = operations
      .then(async () => {
        clearTimeout(timeout)
        // The caller has already received busy; never perform a delayed switch.
        if (expired) return
        resolve(await operation())
      })
      .catch(reject)
    operations = result.finally(() => {
      queued--
    })
  })
}

function providerId(value: string): AccountProviderId {
  if (value !== 'claude-code' && value !== 'codex') throw new ProviderAccountsError('accounts_unknown_provider')
  return value
}

function assertRuntime(provider: AccountProviderId): void {
  if (provider !== 'claude-code') return
  // ccswap 0.37 writes the regular active store, not Claude's separate secure
  // store override or macOS's hashed Keychain service for ANY nonempty
  // CLAUDE_CONFIG_DIR, even when it explicitly names the default directory.
  const config = process.env.CLAUDE_CONFIG_DIR
  if (process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR !== undefined || (process.platform === 'darwin' && config)) {
    throw new ProviderAccountsError('accounts_unsupported_environment')
  }
}

function run(args: string[], allowEmpty = false): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // Inherit the actual server/container identity and homes. Never invoke a
    // shell, docker, SSH, or resolve a binary relative to a workspace checkout.
    execFile(
      'ccswap',
      args,
      {
        encoding: 'utf8',
        shell: false,
        killSignal: 'SIGKILL',
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        cwd: os.homedir(),
        env: process.env,
      },
      (error, stdout) => {
        if (error) {
          reject(
            new ProviderAccountsError(error.code === 'ENOENT' ? 'accounts_unavailable' : 'accounts_command_failed'),
          )
          return
        }
        if (allowEmpty && !stdout.trim()) {
          resolve(null)
          return
        }
        try {
          resolve(JSON.parse(stdout))
        } catch {
          reject(new ProviderAccountsError('accounts_command_failed'))
        }
      },
    )
  })
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function display(value: unknown): string {
  return typeof value === 'string'
    ? value
        .replace(/[\p{Cc}\p{Cf}]/gu, '')
        .trim()
        .slice(0, 320)
    : ''
}

async function list(provider: AccountProviderId): Promise<ProviderAccounts> {
  const home = provider === 'codex' ? process.env.CODEX_HOME : process.env.CLAUDE_CONFIG_DIR
  // Agent subprocesses run in their worktrees, the quota provider in the server
  // cwd, and ccswap in HOME. Relative (including empty) overrides cannot name
  // the same credential store reliably. Require an absolute path or no override.
  if (home !== undefined && !path.isAbsolute(home)) {
    throw new ProviderAccountsError('accounts_unsupported_environment')
  }
  const raw = await run(provider === 'codex' ? ['codex', 'list', '--json'] : ['list', '--provider', 'claude', '--json'])
  if (
    !object(raw) ||
    !Array.isArray(raw.accounts) ||
    raw.accounts.length > 1000 ||
    (provider === 'claude-code' ? raw.schemaVersion !== 1 : raw.provider !== 'codex')
  ) {
    throw new ProviderAccountsError('accounts_command_failed')
  }
  const seen = new Set<string>()
  const accounts: ProviderAccount[] = raw.accounts.map((row: unknown) => {
    if (
      !object(row) ||
      typeof row.number !== 'number' ||
      !Number.isSafeInteger(row.number) ||
      row.number < 1 ||
      typeof row.active !== 'boolean' ||
      (row.disabled !== undefined && typeof row.disabled !== 'boolean')
    ) {
      throw new ProviderAccountsError('accounts_command_failed')
    }
    const id = String(row.number)
    if (seen.has(id)) throw new ProviderAccountsError('accounts_command_failed')
    seen.add(id)
    return {
      id,
      email: display(row.email),
      label: display(provider === 'codex' ? row.label : row.alias) || display(row.organizationName),
      active: row.active,
      disabled: row.disabled === true,
    }
  })
  return { available: true, accounts }
}

export async function listProviderAccounts(value: string): Promise<ProviderAccounts> {
  const provider = providerId(value)
  return serialize(async () => {
    try {
      return await list(provider)
    } catch (error) {
      if (error instanceof ProviderAccountsError && error.code === 'accounts_unavailable')
        return { available: false, accounts: [] }
      throw error
    }
  })
}

export function validateAccountId(accountId: unknown): string {
  if (typeof accountId !== 'string' || !/^[1-9]\d{0,15}$/.test(accountId) || !Number.isSafeInteger(Number(accountId))) {
    throw new ProviderAccountsError('accounts_invalid_account')
  }
  return accountId
}

export async function switchProviderAccount(value: string, accountId: unknown): Promise<ProviderAccounts> {
  const provider = providerId(value)
  const selectedId = validateAccountId(accountId)
  return serialize(async () => {
    assertRuntime(provider)
    const current = await list(provider)
    const selected = current.accounts.find((account) => account.id === selectedId)
    if (!selected) throw new ProviderAccountsError('accounts_not_found')
    if (selected.disabled) throw new ProviderAccountsError('accounts_disabled')
    const change = async () => {
      const raw = await run(
        provider === 'codex' ? ['codex', 'switch', selectedId, '--json'] : ['switch', selectedId, '--json'],
        provider === 'codex',
      )
      // ccswap 0.37's Codex dispatcher discards the switch return value.
      // Empty stdout is accepted only here; the following list must confirm it.
      if (provider === 'codex' && raw === null) return
      if (
        !object(raw) ||
        typeof raw.switched !== 'boolean' ||
        !object(raw.to) ||
        raw.to.number !== Number(selectedId) ||
        (provider === 'claude-code' && raw.schemaVersion !== 1)
      ) {
        throw new ProviderAccountsError('accounts_command_failed')
      }
    }
    if (provider === 'claude-code') await withUsageAccountSwitch(provider, change)
    else await change()
    const updated = await list(provider)
    if (!updated.accounts.some((account) => account.id === selectedId && account.active)) {
      throw new ProviderAccountsError('accounts_command_failed')
    }
    return updated
  })
}
