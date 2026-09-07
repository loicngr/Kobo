/**
 * Lifecycle hooks stream under `hook:<event>:<kind>`, one namespace per event
 * so two hooks running back to back never read as one. This decodes that type
 * so the websocket store can route it like a setup / cleanup / archive script.
 */
export type HookStreamKind = 'output' | 'complete' | 'error'

const KINDS: ReadonlySet<string> = new Set(['output', 'complete', 'error'])

export function parseHookEventType(type: string): { event: string; kind: HookStreamKind } | null {
  if (!type.startsWith('hook:')) return null
  const rest = type.slice('hook:'.length)
  const sep = rest.lastIndexOf(':')
  if (sep <= 0) return null
  const event = rest.slice(0, sep)
  const kind = rest.slice(sep + 1)
  if (!KINDS.has(kind)) return null
  return { event, kind: kind as HookStreamKind }
}

/** Activity-feed sender for a hook's lines: `hook:<event>`, distinct per event. */
export function hookSender(event: string): string {
  return `hook:${event}`
}

export function isHookSender(sender: string): boolean {
  return sender.startsWith('hook:')
}
