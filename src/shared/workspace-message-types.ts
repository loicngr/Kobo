export type MessageSource =
  | { kind: 'mcp'; clientName: string; transport: 'http' | 'stdio' }
  | { kind: 'slack'; userName: string; userId: string; channelId: string; threadTs: string }

function cleanLabel(value: unknown, fallback: string): string {
  return (
    (typeof value === 'string'
      ? Array.from(
          value
            .replace(/[\p{Cc}\s]+/gu, ' ')
            .replace(/\p{Cs}/gu, '�')
            .trim(),
        )
          .slice(0, 100)
          .join('')
      : '') || fallback
  )
}

export function normalizeClientName(value: unknown): string {
  return cleanLabel(value, 'External MCP client')
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/** Tolerant decoder for historical/untrusted payloads. Labels are not identities. */
export function parseMessageSource(value: unknown): MessageSource | undefined {
  if (!value || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  if (source.kind === 'slack') {
    const { userId, channelId, threadTs } = source
    if (!nonEmpty(userId) || !nonEmpty(channelId) || !nonEmpty(threadTs)) return undefined
    return { kind: 'slack', userName: cleanLabel(source.userName, 'Slack user'), userId, channelId, threadTs }
  }
  if (source.kind !== 'mcp' || (source.transport !== 'http' && source.transport !== 'stdio')) return undefined
  return { kind: 'mcp', clientName: normalizeClientName(source.clientName), transport: source.transport }
}
