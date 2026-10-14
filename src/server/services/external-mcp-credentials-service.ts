import { createHash, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { EXTERNAL_MEMORY_TOOL_DEFINITIONS } from '../../shared/memory-tools.js'
import { PROGRESS_BAR_TOOLS } from '../../shared/progress-bar-tools.js'
import { WORKSPACE_CREATION_TOOLS } from '../../shared/workspace-creation-tools.js'
import { EXTERNAL_MCP_TOOLS } from '../../shared/workspace-dialogue-tools.js'
import { WORKSPACE_GROUP_MESSAGE_TOOLS } from '../../shared/workspace-group-message-tools.js'
import { WORKSPACE_LIFECYCLE_TOOLS } from '../../shared/workspace-lifecycle-tools.js'
import { ensureKoboHome, getKoboHome } from '../utils/paths.js'

export const EXTERNAL_TOOL_CATALOGUE = [
  ...EXTERNAL_MCP_TOOLS,
  ...WORKSPACE_CREATION_TOOLS,
  ...WORKSPACE_LIFECYCLE_TOOLS,
  ...WORKSPACE_GROUP_MESSAGE_TOOLS,
  ...EXTERNAL_MEMORY_TOOL_DEFINITIONS,
  ...PROGRESS_BAR_TOOLS,
]
export interface ExternalMcpPrincipal {
  id: string
  name: string
  tools: string[]
  allWorkspaces: boolean
  workspaceIds: string[]
  createdAt: string
  expiresAt: string | null
}
interface StoredCredential extends ExternalMcpPrincipal {
  hash: string
}
const MAX_KEYS = 100
const filename = () => path.join(getKoboHome(), 'mcp-credentials.json')
function load(): StoredCredential[] {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(filename(), 'utf8'))
    if (!Array.isArray(data) || data.length > MAX_KEYS) throw new Error('Invalid MCP credential store')
    return data as StoredCredential[]
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
function save(keys: StoredCredential[]): void {
  ensureKoboHome()
  const tmp = `${filename()}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(keys), { mode: 0o600, flag: 'wx' })
    fs.renameSync(tmp, filename())
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
  }
}
function publicCredential({ hash: _hash, ...credential }: StoredCredential): ExternalMcpPrincipal {
  return credential
}
export function listExternalMcpCredentials(): ExternalMcpPrincipal[] {
  return load().map(publicCredential)
}
export function createExternalMcpCredential(input: unknown): { token: string; credential: ExternalMcpPrincipal } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid credential request')
  const args = input as Record<string, unknown>
  if (Object.keys(args).some((key) => !['name', 'tools', 'allWorkspaces', 'workspaceIds', 'expiresAt'].includes(key)))
    throw new Error('Unknown credential field')
  if (typeof args.name !== 'string' || !args.name.trim() || args.name.length > 120)
    throw new Error('Name must contain 1–120 characters')
  if (args.allWorkspaces !== undefined && typeof args.allWorkspaces !== 'boolean')
    throw new Error('Invalid workspace scope')
  const allWorkspaces = args.allWorkspaces === true
  const workspaceIds = args.workspaceIds ?? []
  if (
    !Array.isArray(workspaceIds) ||
    workspaceIds.length > 200 ||
    workspaceIds.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) ||
    (!allWorkspaces && workspaceIds.length === 0) ||
    (allWorkspaces && workspaceIds.length > 0)
  )
    throw new Error('Select workspace IDs or explicitly grant all workspaces')
  const tools =
    args.tools ??
    EXTERNAL_TOOL_CATALOGUE.filter((tool) => tool.annotations?.readOnlyHint === true).map((tool) => tool.name)
  if (
    !Array.isArray(tools) ||
    !tools.length ||
    tools.length > EXTERNAL_TOOL_CATALOGUE.length ||
    tools.some((name) => !EXTERNAL_TOOL_CATALOGUE.some((tool) => tool.name === name))
  )
    throw new Error('Invalid tool grant')
  let expiresAt: string | null = null
  if (args.expiresAt !== undefined && args.expiresAt !== null) {
    const time = typeof args.expiresAt === 'string' ? Date.parse(args.expiresAt) : NaN
    if (!Number.isFinite(time) || time <= Date.now() || time > Date.now() + 366 * 86400000)
      throw new Error('Expiry must be within the next 366 days')
    expiresAt = new Date(time).toISOString()
  }
  const keys = load()
  if (keys.length >= MAX_KEYS) throw new Error('Revoke an existing MCP key before creating another')
  const token = `kobo_mcp_${randomBytes(32).toString('base64url')}`
  const key: StoredCredential = {
    id: randomUUID(),
    name: args.name.trim(),
    tools: [...new Set(tools as string[])],
    allWorkspaces,
    workspaceIds: [...new Set(workspaceIds as string[])],
    createdAt: new Date().toISOString(),
    expiresAt,
    hash: createHash('sha256').update(token).digest('hex'),
  }
  save([...keys, key])
  return { token, credential: publicCredential(key) }
}
export function revokeExternalMcpCredential(id: string): void {
  save(load().filter((key) => key.id !== id))
}
export function authenticateExternalMcpToken(token: string): ExternalMcpPrincipal | null {
  if (!/^kobo_mcp_[A-Za-z0-9_-]{43}$/.test(token)) return null
  const hash = createHash('sha256').update(token).digest('hex')
  const key = load().find((candidate) => candidate.hash === hash)
  return key && (!key.expiresAt || Date.parse(key.expiresAt) > Date.now()) ? publicCredential(key) : null
}
