export type AccountProviderId = 'claude-code' | 'codex'

export interface ProviderAccount {
  id: string
  email: string
  label: string
  active: boolean
  disabled: boolean
}

export interface ProviderAccounts {
  available: boolean
  accounts: ProviderAccount[]
}
