import { readIntegrationsFile, writeIntegrationsFile } from '../integration-config-service.js'

/** Stored under key `slack` in KOBO_HOME/integrations.json (not an MCP launch spec). */
export interface SlackCredentials {
  botToken: string
  appToken: string
}

export function getSlackCredentials(): SlackCredentials | null {
  let entry: unknown
  try {
    entry = readIntegrationsFile().slack
  } catch {
    return null // an unreadable file must never block Slack startup paths
  }
  if (entry === null || typeof entry !== 'object') return null
  const { botToken, appToken } = entry as Record<string, unknown>
  if (typeof botToken !== 'string' || typeof appToken !== 'string') return null
  return { botToken, appToken }
}

/** null deletes the entry. Error messages never contain token values. */
export function saveSlackCredentials(value: unknown): void {
  const file = readIntegrationsFile()
  if (value === null) {
    delete file.slack
  } else {
    const v = (value ?? {}) as Record<string, unknown>
    const botToken = typeof v.botToken === 'string' ? v.botToken.trim() : ''
    const appToken = typeof v.appToken === 'string' ? v.appToken.trim() : ''
    if (!botToken.startsWith('xoxb-')) throw new Error('Invalid Slack bot token')
    if (!appToken.startsWith('xapp-')) throw new Error('Invalid Slack app token')
    file.slack = { botToken, appToken }
  }
  writeIntegrationsFile(file)
}
