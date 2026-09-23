export interface MessageSource {
  kind: 'mcp'
  clientName: string
  transport: 'http' | 'stdio'
}

export function normalizeClientName(value: unknown): string {
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
      : '') || 'External MCP client'
  )
}

/** Tolerant decoder for historical/untrusted payloads. Labels are not identities. */
export function parseMessageSource(value: unknown): MessageSource | undefined {
  if (!value || typeof value !== 'object') return undefined
  const source = value as Partial<MessageSource>
  if (source.kind !== 'mcp' || (source.transport !== 'http' && source.transport !== 'stdio')) return undefined
  return { kind: 'mcp', clientName: normalizeClientName(source.clientName), transport: source.transport }
}
