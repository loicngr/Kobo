import { MEMORY_MCP_RESPONSE_HARD_MAX_TOKENS, MEMORY_MCP_RESPONSE_MAX_TOKENS } from '../../shared/memory.js'

export const MEMORY_OUTPUT_FRAMING_HEADROOM_BYTES = 96
export const MEMORY_OUTPUT_HARD_BYTES = 12_000
const MAX_EXCERPT_CODE_POINTS = 180

export interface BoundedMemoryOutput {
  data: Record<string, unknown>
  serializedEnvelope: string
  payloadBytes: number
  estimatedTokens: number
  truncated: boolean
}

export interface MemoryBodyFragment {
  text?: string
  offset: number
  totalCodePoints: number
  truncated: boolean
  nextCursor?: string
  alreadyDelivered?: boolean
}

/** Stable code-point offsets avoid splitting surrogate pairs in CJK/emoji text. */
export function sliceMemoryBodyFragment(input: {
  body: string
  revision: number
  cursor?: string
  alreadyDelivered?: boolean
  repeat?: boolean
}): MemoryBodyFragment {
  const points = [...input.body]
  let offset = 0
  if (input.cursor !== undefined) {
    const match = /^(\d+)\.(\d+)$/.exec(input.cursor)
    if (!match) throw new TypeError('Invalid memory fragment cursor')
    if (Number(match[1]) !== input.revision)
      throw new TypeError('Memory changed; restart reading at the latest revision')
    offset = Number(match[2])
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > points.length)
      throw new TypeError('Invalid memory fragment offset')
  }
  if (input.alreadyDelivered && !input.repeat) {
    return { offset, totalCodePoints: points.length, truncated: offset < points.length, alreadyDelivered: true }
  }
  const end = Math.min(points.length, offset + 40)
  return {
    text: points.slice(offset, end).join(''),
    offset,
    totalCodePoints: points.length,
    truncated: end < points.length,
    ...(end < points.length ? { nextCursor: `${input.revision}.${end}` } : {}),
  }
}

export function estimateMemoryTokens(serializedPayload: string): number {
  return Buffer.byteLength(serializedPayload, 'utf8') + MEMORY_OUTPUT_FRAMING_HEADROOM_BYTES
}

function clipUnicode(value: string, maxCodePoints: number): { value: string; truncated: boolean } {
  const points = [...value]
  if (points.length <= maxCodePoints) return { value, truncated: false }
  return { value: `${points.slice(0, maxCodePoints).join('')}…`, truncated: true }
}

function compactValue(value: unknown): { value: unknown; truncated: boolean } {
  if (Array.isArray(value)) {
    const mapped = value.slice(0, 100).map(compactValue)
    return {
      value: mapped.map((item) => item.value),
      truncated: value.length > mapped.length || mapped.some((item) => item.truncated),
    }
  }
  if (!value || typeof value !== 'object') {
    if (typeof value !== 'string') return { value, truncated: false }
    const clipped = clipUnicode(value, MAX_EXCERPT_CODE_POINTS)
    return { value: clipped.value, truncated: clipped.truncated }
  }
  let truncated = false
  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (key === 'body' || key === 'text' || key === 'excerpt') {
      if (typeof child === 'string') {
        const clipped = clipUnicode(child, MAX_EXCERPT_CODE_POINTS)
        result[key] = clipped.value
        truncated ||= clipped.truncated
        continue
      }
    }
    const nested = compactValue(child)
    result[key] = nested.value
    truncated ||= nested.truncated
  }
  return { value: result, truncated }
}

function envelope(data: Record<string, unknown>, transport: 'internal' | 'external'): string {
  // Internal results incur one REST JSON copy and one downstream MCP text-only
  // copy. External Streamable HTTP duplicates data in text and structuredContent.
  if (transport === 'internal') {
    const rest = JSON.stringify(data)
    return JSON.stringify({ rest, content: [{ type: 'text', text: rest }] })
  }
  return JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  })
}

function withinLimits(serialized: string, targetTokens: number): boolean {
  return (
    Buffer.byteLength(serialized, 'utf8') <= MEMORY_OUTPUT_HARD_BYTES &&
    estimateMemoryTokens(serialized) <= Math.min(targetTokens, MEMORY_MCP_RESPONSE_HARD_MAX_TOKENS)
  )
}

/**
 * Makes a bounded final memory result. Item pages retain compact IDs/metadata;
 * large body-like strings become labeled excerpts. It never emits a prefix
 * that could look like a complete memory directive.
 */
export function prepareMemoryToolEnvelope(
  input: unknown,
  options: { targetTokens?: number; transport?: 'internal' | 'external'; pageOffset?: number } = {},
): BoundedMemoryOutput {
  const transport = options.transport ?? 'external'
  const targetTokens = Math.max(
    128,
    Math.min(options.targetTokens ?? MEMORY_MCP_RESPONSE_MAX_TOKENS, MEMORY_MCP_RESPONSE_HARD_MAX_TOKENS),
  )
  const original =
    input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : { result: input }
  const compacted = compactValue(original)
  let data: Record<string, unknown> = {
    ...(compacted.value as Record<string, unknown>),
    ...(compacted.truncated ? { truncated: true } : {}),
  }
  let serialized = envelope(data, transport)
  let truncated = compacted.truncated

  if (!withinLimits(serialized, targetTokens)) {
    const rawEntry = data.entry
    const entry =
      rawEntry && typeof rawEntry === 'object' && !Array.isArray(rawEntry)
        ? (rawEntry as Record<string, unknown>)
        : undefined
    if (
      entry &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      typeof entry.body === 'string' &&
      typeof entry.offset === 'number'
    ) {
      // Long titles/keys must not make valid body fragments inaccessible.
      const compactEntry = { ...entry }
      delete compactEntry.title
      delete compactEntry.key
      data = { ...data, entry: compactEntry, truncated: true }
      truncated = true
      serialized = envelope(data, transport)
      // UTF-8/JSON framing can still make forty code points too large. Shorten
      // only with an exact continuation so no body characters are skipped.
      if (typeof compactEntry.revision === 'number') {
        let bodyPoints = [...entry.body]
        while (bodyPoints.length > 1 && !withinLimits(serialized, targetTokens)) {
          bodyPoints = bodyPoints.slice(0, Math.floor(bodyPoints.length / 2))
          compactEntry.body = bodyPoints.join('')
          compactEntry.truncated = true
          compactEntry.nextCursor = `${compactEntry.revision}.${entry.offset + bodyPoints.length}`
          serialized = envelope(data, transport)
        }
      }
    }
  }

  if (!withinLimits(serialized, targetTokens)) {
    truncated = true
    let items = Array.isArray(data.items) ? data.items : undefined
    if (items) {
      const originalItemCount = items.length
      const previousOmitted = typeof data.omittedCount === 'number' ? data.omittedCount : 0
      const originalNextCursor = data.nextCursor
      let kept = items.length
      let identityOnly = false
      if (kept > 0) {
        const slimItems = items.map((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return item
          const compact = { ...(item as Record<string, unknown>) }
          delete compact.excerpt
          delete compact.excerptPartial
          delete compact.createdAt
          delete compact.updatedAt
          delete compact.actor
          return compact
        })
        items = slimItems
        data = { ...data, items: slimItems, truncated: true }
        serialized = envelope(data, transport)
      }
      while (kept > 0 && !withinLimits(serialized, targetTokens)) {
        const first: unknown = items[0]
        if (
          kept === 1 &&
          !identityOnly &&
          first &&
          typeof first === 'object' &&
          'id' in first &&
          typeof first.id === 'string' &&
          'scopeId' in first &&
          typeof first.scopeId === 'string' &&
          'revision' in first &&
          typeof first.revision === 'number'
        ) {
          // Even the largest allowed title/key must remain discoverable. Keep
          // enough identity for read_memory instead of returning an empty page.
          items = [
            { id: first.id, scopeId: first.scopeId, revision: first.revision, metadataOmitted: true },
            ...items.slice(1),
          ]
          identityOnly = true
        } else {
          kept = Math.floor(kept / 2)
        }
        const keptItems = items.slice(0, kept)
        let nextCursor = originalNextCursor
        if (keptItems.length > 0 && kept < originalItemCount) {
          const last = keptItems.at(-1)
          const lastId = last && typeof last === 'object' ? (last as Record<string, unknown>).id : undefined
          if (typeof lastId === 'number') nextCursor = String(lastId)
          else {
            const offset =
              options.pageOffset ??
              (/^\d+$/.test(String(originalNextCursor ?? ''))
                ? Math.max(0, Number(originalNextCursor) - items.length)
                : 0)
            nextCursor = String(offset + kept)
          }
        }
        data = {
          ...data,
          items: keptItems,
          ...(nextCursor === undefined ? {} : { nextCursor }),
          omittedCount: previousOmitted + originalItemCount - kept,
          truncated: true,
        }
        serialized = envelope(data, transport)
      }
    }
  }

  if (!withinLimits(serialized, targetTokens)) {
    data = {
      truncated: true,
      budgetExhausted: true,
      message: 'Résultat mémoire trop volumineux; réduis la page ou lis la note par fragments.',
    }
    serialized = envelope(data, transport)
  }
  const payloadBytes = Buffer.byteLength(serialized, 'utf8')
  const estimatedTokens = estimateMemoryTokens(serialized)
  if (!withinLimits(serialized, targetTokens)) throw new Error('Unable to construct a bounded memory result')
  return { data, serializedEnvelope: serialized, payloadBytes, estimatedTokens, truncated }
}
