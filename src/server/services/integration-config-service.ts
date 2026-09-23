import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ensureKoboHome, getKoboHome } from '../utils/paths.js'

export type IntegrationId = 'notion' | 'sentry'
export interface IntegrationConfig {
  command: string
  args: string[]
  env: Record<string, string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validate(value: unknown): IntegrationConfig {
  if (
    !isRecord(value) ||
    typeof value.command !== 'string' ||
    !value.command.trim() ||
    value.command.length > 4096 ||
    value.command.includes('\0') ||
    !Array.isArray(value.args) ||
    value.args.length > 100 ||
    value.args.some((arg) => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0')) ||
    !isRecord(value.env) ||
    Object.keys(value.env).length > 100 ||
    Object.entries(value.env).some(
      ([key, val]) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof val !== 'string' || val.length > 8192 || val.includes('\0'),
    )
  )
    throw new Error('Invalid integration configuration')
  return { command: value.command.trim(), args: value.args as string[], env: value.env as Record<string, string> }
}

function readConnections(): Partial<Record<IntegrationId, IntegrationConfig>> {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(getKoboHome(), 'integrations.json'), 'utf8'))
    if (!isRecord(raw)) throw new Error('Invalid configuration')
    const result: Partial<Record<IntegrationId, IntegrationConfig>> = {}
    for (const key of ['notion', 'sentry'] as const) if (raw[key] != null) result[key] = validate(raw[key])
    return result
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error('Cannot read integration configuration')
  }
}

/** Private connection material is never part of settings exports or GET responses. */
export function getIntegrationConfig(integration: IntegrationId): IntegrationConfig | null {
  return readConnections()[integration] ?? null
}

export function getIntegrationStatus(integration: IntegrationId): { configured: boolean } {
  return { configured: getIntegrationConfig(integration) !== null }
}

/** Local single-user configuration: commands are explicit user-authorized executable configuration. */
export function saveIntegrationConfig(integration: IntegrationId, value: unknown): void {
  const entry = value === null ? null : validate(value)
  const connections = readConnections()
  if (entry) connections[integration] = entry
  else delete connections[integration]
  const home = ensureKoboHome()
  const temporary = path.join(home, `integrations-${randomUUID()}.tmp`)
  try {
    fs.writeFileSync(temporary, JSON.stringify(connections, null, 2), { mode: 0o600, flag: 'wx' })
    fs.renameSync(temporary, path.join(home, 'integrations.json'))
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}
