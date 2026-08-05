export const WHIP_MESSAGE_DELAY_MS = 300
export const WHIP_AGENT_STOP_POLL_MS = 50
export const WHIP_AGENT_STOP_TIMEOUT_MS = 16_000
export const WHIP_ERROR_COOLDOWN_MS = 5_000

export interface WhipTarget {
  workspaceId: string
  sessionId: string
}

export interface WhipCrackDependencies {
  isAgentRunning(workspaceId: string): boolean
  interruptAgent(workspaceId: string): Promise<void>
  sendMessage(workspaceId: string, message: string, sessionId: string): boolean
  wait(ms: number): Promise<void>
  random(): number
  now(): number
  onError(): void
}

export interface WhipCrackCoordinator {
  enqueue(): Promise<void>
  dispose(): void
}

export function createWhipCrackCoordinator(
  target: Readonly<WhipTarget>,
  phrases: readonly string[],
  dependencies: WhipCrackDependencies,
): WhipCrackCoordinator {
  let disposed = false
  let lastErrorAt = Number.NEGATIVE_INFINITY
  let tail = Promise.resolve()
  let queued = 0

  function reportError(): void {
    const now = dependencies.now()
    if (now - lastErrorAt < WHIP_ERROR_COOLDOWN_MS) return
    lastErrorAt = now
    dependencies.onError()
  }

  async function dispatchCrack(): Promise<void> {
    if (disposed) return

    if (dependencies.isAgentRunning(target.workspaceId)) {
      try {
        await dependencies.interruptAgent(target.workspaceId)
      } catch {
        if (disposed) return
        reportError()
        return
      }
      if (disposed) return
      await dependencies.wait(WHIP_MESSAGE_DELAY_MS)
      if (disposed) return
      let waited = WHIP_MESSAGE_DELAY_MS
      while (dependencies.isAgentRunning(target.workspaceId) && waited < WHIP_AGENT_STOP_TIMEOUT_MS) {
        await dependencies.wait(WHIP_AGENT_STOP_POLL_MS)
        if (disposed) return
        waited += WHIP_AGENT_STOP_POLL_MS
      }
    }

    const rawIndex = Math.floor(dependencies.random() * phrases.length)
    const phraseIndex = Math.max(0, Math.min(phrases.length - 1, rawIndex))
    const phrase = phrases[phraseIndex]
    if (!phrase || dependencies.sendMessage(target.workspaceId, phrase, target.sessionId)) return

    reportError()
  }

  return {
    enqueue() {
      if (disposed) return Promise.resolve()
      if (queued >= 2) return tail
      queued += 1
      const current = tail.then(dispatchCrack).finally(() => {
        queued = Math.max(0, queued - 1)
      })
      tail = current.catch(() => undefined)
      return current
    },
    dispose() {
      disposed = true
    },
  }
}
