import { isMemoryToolName, validateMemoryToolArguments } from '../shared/memory-tools.js'

export type MemoryFetch = typeof fetch

export function isMemoryOutputSuppressed(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'memoryOutputSuppressed' in value &&
    value.memoryOutputSuppressed === true
  )
}

export async function callMemoryTool(input: {
  backendUrl: string
  name: string
  args: unknown
  capability?: string
  networkToken?: string
  fetcher?: MemoryFetch
  timeoutMs?: number
}): Promise<unknown> {
  if (!isMemoryToolName(input.name)) throw new TypeError('Unknown memory tool')
  if (!input.capability) throw new Error('Memory capability is unavailable for this process')
  const args = validateMemoryToolArguments(input.name, input.args)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Kobo-Memory-Session': input.capability,
  }
  if (input.networkToken) headers['X-Kobo-Token'] = input.networkToken
  const timeoutMs = input.timeoutMs ?? 30_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('Memory request timeout must be positive')
  const signal = AbortSignal.timeout(timeoutMs)
  const response = await (input.fetcher ?? fetch)(
    `${input.backendUrl.replace(/\/$/, '')}/api/memory/agent/${input.name}`,
    { method: 'POST', headers, body: JSON.stringify(args), signal },
  )
  const raw = await response.text()
  let payload: unknown
  try {
    payload = raw ? JSON.parse(raw) : null
  } catch {
    payload = { error: 'Backend returned invalid JSON' }
  }
  if (!response.ok) {
    const detail =
      payload && typeof payload === 'object' && 'error' in payload ? String(payload.error) : response.statusText
    throw new Error(`Memory backend returned ${response.status}: ${detail}`)
  }
  return payload
}
