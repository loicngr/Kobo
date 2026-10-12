import { isProgressBarTool } from '../shared/progress-bar-tools.js'
export async function callProgressBarTool(input: {
  backendUrl: string
  name: string
  args: unknown
  capability?: string
  networkToken?: string
  fetcher?: typeof fetch
}) {
  if (!isProgressBarTool(input.name)) throw new TypeError('Unknown progress tool')
  if (!input.capability) throw new Error('Progress capability is unavailable for this process')
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Kobo-Progress-Session': input.capability,
  }
  if (input.networkToken) headers['X-Kobo-Token'] = input.networkToken
  const response = await (input.fetcher ?? fetch)(
    `${input.backendUrl.replace(/\/$/, '')}/api/progress-bars/agent/${input.name}`,
    { method: 'POST', headers, body: JSON.stringify(input.args), signal: AbortSignal.timeout(30_000) },
  )
  const data = (await response.json()) as Record<string, unknown>
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    structuredContent: data,
    ...(!response.ok ? { isError: true } : {}),
  }
}
