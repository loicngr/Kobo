/** Tracks only acknowledged sends; legacy queued messages are independent. */
export class ChatDeliveryTracker {
  private pending = new Map<string, { workspaceId: string; finish: (error?: Error) => void }>()

  wait(workspaceId: string, clientMessageId: string, timeoutMessage: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(timeoutMessage)), 30_000)
      const finish = (error?: Error) => {
        clearTimeout(timer)
        this.pending.delete(clientMessageId)
        if (error) reject(error)
        else resolve()
      }
      this.pending.set(clientMessageId, { workspaceId, finish })
    })
  }

  settle(workspaceId: string, clientMessageId: string, error?: Error): void {
    const pending = this.pending.get(clientMessageId)
    if (pending?.workspaceId === workspaceId) pending.finish(error)
  }

  disconnect(message: string): void {
    for (const pending of this.pending.values()) pending.finish(new Error(message))
  }
}
