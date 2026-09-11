import { type MessageSource, normalizeClientName } from '../../shared/workspace-message-types.js'

export function createMcpClientContext(
  name?: unknown,
  transport: 'http' | 'stdio' = 'http',
  encoding?: string,
): MessageSource {
  if (encoding === 'uri' && typeof name === 'string') {
    try {
      name = decodeURIComponent(name)
    } catch {
      name = undefined
    }
  }
  return { kind: 'mcp', clientName: normalizeClientName(name), transport }
}
