import type { AgentEvent } from './engines/types.js'

export interface StreamingBatcher {
  push(event: AgentEvent): void
  close(): void
}

/** Coalesces token deltas before they reach WebSocket persistence. */
export function createStreamingBatcher(
  emit: (event: AgentEvent) => void,
  options: { windowMs?: number } = {},
): StreamingBatcher {
  const windowMs = options.windowMs ?? 40
  const pending = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> }>()

  const flush = (messageId: string): void => {
    const entry = pending.get(messageId)
    if (!entry) return
    clearTimeout(entry.timer)
    pending.delete(messageId)
    emit({ kind: 'message:text', messageId, text: entry.text, streaming: true })
  }

  return {
    push(event) {
      if (event.kind === 'message:text' && event.streaming) {
        const entry = pending.get(event.messageId)
        if (entry) {
          entry.text += event.text
          return
        }
        const timer = setTimeout(() => flush(event.messageId), windowMs)
        timer.unref?.()
        pending.set(event.messageId, { text: event.text, timer })
        return
      }
      if (event.kind === 'message:end') flush(event.messageId)
      emit(event)
    },
    close() {
      for (const messageId of [...pending.keys()]) flush(messageId)
    },
  }
}
