export const WHIP_MESSAGE_DELAY_MS = 300
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

  async function dispatchCrack(): Promise<void> {
    if (dependencies.isAgentRunning(target.workspaceId)) {
      try {
        await dependencies.interruptAgent(target.workspaceId)
      } catch {
        // The interrupted turn may already have ended. Message dispatch can
        // still resume the captured session through Kōbō's WebSocket path.
      }
      await dependencies.wait(WHIP_MESSAGE_DELAY_MS)
    }

    const rawIndex = Math.floor(dependencies.random() * phrases.length)
    const phraseIndex = Math.max(0, Math.min(phrases.length - 1, rawIndex))
    const phrase = phrases[phraseIndex]
    if (!phrase || dependencies.sendMessage(target.workspaceId, phrase, target.sessionId)) return

    const now = dependencies.now()
    if (now - lastErrorAt < WHIP_ERROR_COOLDOWN_MS) return
    lastErrorAt = now
    dependencies.onError()
  }

  return {
    enqueue() {
      if (disposed) return Promise.resolve()
      const current = tail.then(dispatchCrack)
      tail = current.catch(() => undefined)
      return current
    },
    dispose() {
      disposed = true
    },
  }
}
