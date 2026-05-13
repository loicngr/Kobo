import {
  callMcpTool,
  initializeMcp,
  readClaudeMcpEntry,
  spawnMcpProcess,
  unwrapMcpResult,
} from '../utils/mcp-client.js'
import { getGlobalSettings } from './settings-service.js'

// ─── parseSentryUrl ───────────────────────────────────────────────────────────

/**
 * Parse a Sentry issue URL and extract the numeric issue ID.
 * Accepts variations with trailing slash, query string, fragment, and
 * self-hosted /organizations/<org>/issues/<id>/ paths.
 */
export function parseSentryUrl(url: string): string {
  const match = url.match(/\/issues\/(\d+)/)
  if (!match) {
    throw new Error(`Could not extract issue ID from Sentry URL: ${url}`)
  }
  return match[1]
}

// ─── readSentryMcpConfig ──────────────────────────────────────────────────────

export interface SentryMcpConfig {
  command: string
  args: string[]
  env: Record<string, string>
}

const SENTRY_CONFIG_ERROR =
  "Sentry MCP server not configured in ~/.claude.json — add an enabled 'sentry' entry under mcpServers"

/**
 * Return the first enabled (`disabled !== true`) MCP server entry from
 * `~/.claude.json` whose key contains "sentry" (case-insensitive). The full
 * `entry.env` is merged onto `process.env` so the spawned process has every
 * configured variable available (SENTRY_ACCESS_TOKEN, SENTRY_HOST, etc.).
 *
 * Throws with a clear setup message when no enabled Sentry entry exists.
 */
export function readSentryMcpConfig(preferredKey?: string): SentryMcpConfig {
  const normalizedPreferred = preferredKey?.trim()
  const match = normalizedPreferred
    ? readClaudeMcpEntry((k) => k === normalizedPreferred)
    : readClaudeMcpEntry((k) => /sentry/i.test(k))
  if (!match) {
    throw new Error(SENTRY_CONFIG_ERROR)
  }
  const { entry } = match
  return {
    command: entry.command ?? 'npx',
    args: entry.args ?? [],
    env: {
      ...(process.env as Record<string, string>),
      ...(entry.env ?? {}),
    },
  }
}

// ─── parseSentryResponse ──────────────────────────────────────────────────────

export interface SentryIssueContent {
  /** Canonical Sentry short-ID (e.g. "ACME-API-3"); used for commit auto-close and MCP tool calls. */
  issueId: string
  /** Numeric ID from the URL (e.g. "112081702"); kept as a cross-reference. */
  issueNumericId: string
  title: string
  culprit: string
  url: string
  platform: string
  firstSeen: string
  lastSeen: string
  occurrences: number
  tags: Record<string, string>
  offendingSpans: string[]
  extraContext: string
  assignee: string
}

function matchField(md: string, label: string): string {
  const re = new RegExp(`^\\*\\*${label}\\*\\*:\\s*(.+)$`, 'm')
  const m = md.match(re)
  return m ? m[1].trim() : ''
}

function matchSection(md: string, heading: string): string {
  // No 'm' flag: $ anchors to end of full string, not each line.
  // Stops at the next heading of any level (#, ##, ### …) or end of string,
  // so trailing top-level sections like "# Using this information" appended
  // by the Sentry MCP response are NOT swallowed into a previous ### section.
  const re = new RegExp(`###\\s+${heading}[\\r\\n]+((?:.|\\n)*?)(?=\\n#+\\s|$)`)
  const m = md.match(re)
  return m ? m[1].trim() : ''
}

function parseTagsBlock(block: string): Record<string, string> {
  const tags: Record<string, string> = {}
  const lines = block.split('\n')
  for (const line of lines) {
    const m = line.match(/^\*\*([^*]+)\*\*:\s*(.+)$/)
    if (m) {
      tags[m[1].trim()] = m[2].trim()
    }
  }
  return tags
}

function parseOffendingSpans(md: string): string[] {
  const re = /\*\*Offending Spans:\*\*\s*\n([\s\S]*?)(?=\n\n|\n###|\n\*\*|$)/
  const m = md.match(re)
  if (!m) return []
  return m[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

/** Parse the markdown response from `get_sentry_resource` into a structured object. */
export function parseSentryResponse(markdown: string, numericId: string): SentryIssueContent {
  // Short-ID comes from the first heading: "# Issue ACME-API-3 in org"
  const issueIdMatch = markdown.match(/^# Issue\s+(\S+)/m)
  const issueId = issueIdMatch ? issueIdMatch[1] : ''

  const occurrencesRaw = matchField(markdown, 'Occurrences')
  const occurrences = occurrencesRaw ? parseInt(occurrencesRaw, 10) || 0 : 0

  const tagsBlock = matchSection(markdown, 'Tags')
  const tags = tagsBlock ? parseTagsBlock(tagsBlock) : {}

  const extraData = matchSection(markdown, 'Extra Data')
  const additionalContext = matchSection(markdown, 'Additional Context')
  const extraContext = [extraData, additionalContext].filter((s) => s.length > 0).join('\n\n')

  const rawAssignee =
    matchField(markdown, 'Assigned To') || matchField(markdown, 'Assignee') || matchField(markdown, 'Assigned')
  const assignee = /^(unassigned|none|-|n\/a)$/i.test(rawAssignee.trim()) ? '' : rawAssignee.trim()

  return {
    issueId,
    issueNumericId: numericId,
    title: matchField(markdown, 'Description'),
    culprit: matchField(markdown, 'Location'),
    url: matchField(markdown, 'URL'),
    platform: matchField(markdown, 'Platform'),
    firstSeen: matchField(markdown, 'First Seen'),
    lastSeen: matchField(markdown, 'Last Seen'),
    occurrences,
    tags,
    offendingSpans: parseOffendingSpans(markdown),
    extraContext,
    assignee,
  }
}

// ─── extractSentryIssue ───────────────────────────────────────────────────────

/**
 * Extract a Sentry issue's full context via the user's configured Sentry MCP server.
 */
export async function extractSentryIssue(url: string): Promise<SentryIssueContent> {
  const numericId = parseSentryUrl(url)
  const global = getGlobalSettings()
  const config = readSentryMcpConfig(global.sentryMcpKey)

  const mcpProcess = spawnMcpProcess(config.command, config.args, config.env)

  try {
    // Give the process a moment to start; reject if it errors immediately.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => resolve(), 1000)
      mcpProcess.on('error', (err: Error) => {
        clearTimeout(timeout)
        reject(new Error(`Failed to start Sentry MCP server: ${err.message}`))
      })
    })

    await initializeMcp(mcpProcess)

    const raw = await callMcpTool(mcpProcess, 'get_sentry_resource', { url })
    const markdown = unwrapMcpResult(raw)

    if (typeof markdown !== 'string') {
      throw new Error('Unexpected non-string response from get_sentry_resource')
    }

    return parseSentryResponse(markdown, numericId)
  } finally {
    mcpProcess.stdin?.end()
    mcpProcess.kill()
  }
}

function extractSentryUserId(whoamiResult: unknown): string | null {
  if (typeof whoamiResult === 'string') {
    const match = whoamiResult.match(/User\s*ID(?:\s*is)?\s*[:=]?\s*(\d+)/i)
    return match ? match[1] : null
  }
  if (!whoamiResult || typeof whoamiResult !== 'object') return null
  const r = whoamiResult as Record<string, unknown>
  if (typeof r.id === 'string' && r.id.length > 0) return r.id
  if (typeof r.id === 'number') return String(r.id)
  for (const key of ['user', 'data', 'me']) {
    const nested = r[key]
    if (nested && typeof nested === 'object') {
      const inner = nested as Record<string, unknown>
      if (typeof inner.id === 'string' && inner.id.length > 0) return inner.id
      if (typeof inner.id === 'number') return String(inner.id)
    }
  }
  return null
}

export async function assignSentryIssueToSelf(issueUrl: string): Promise<{
  assigned: boolean
  reason: string
}> {
  let config: SentryMcpConfig
  try {
    const global = getGlobalSettings()
    config = readSentryMcpConfig(global.sentryMcpKey)
  } catch (err) {
    return { assigned: false, reason: err instanceof Error ? err.message : String(err) }
  }

  const mcpProcess = spawnMcpProcess(config.command, config.args, config.env)
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => resolve(), 1000)
      mcpProcess.on('error', (err: Error) => {
        clearTimeout(timeout)
        reject(new Error(`Failed to start Sentry MCP server: ${err.message}`))
      })
    })

    await initializeMcp(mcpProcess)

    const whoamiRaw = await callMcpTool(mcpProcess, 'whoami', {})
    const whoami = unwrapMcpResult(whoamiRaw)
    const userId = extractSentryUserId(whoami)
    if (!userId) {
      return { assigned: false, reason: 'whoami did not return a user id' }
    }

    await callMcpTool(mcpProcess, 'update_issue', {
      issueUrl,
      assignedTo: `user:${userId}`,
    })
    return { assigned: true, reason: `assigned to user:${userId}` }
  } catch (err) {
    return { assigned: false, reason: err instanceof Error ? err.message : String(err) }
  } finally {
    mcpProcess.stdin?.end()
    mcpProcess.kill()
  }
}
