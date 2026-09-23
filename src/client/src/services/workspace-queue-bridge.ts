import { watch } from 'vue'

type QueueMap = Record<string, { content: string; sessionId: string }>
interface QueueStore {
  queuedMessages: QueueMap
  queueMessage(workspaceId: string, content: string, sessionId: string): void
  cancelQueuedMessage(workspaceId: string, sessionId: string | null | undefined): void
  flushQueuedMessage(workspaceId: string, sessionId: string): void
}
export interface WorkspaceQueueHost {
  queue: QueueStore['queueMessage']
  cancel: QueueStore['cancelQueuedMessage']
  flush: QueueStore['flushQueuedMessage']
  subscribe(listener: (queues: QueueMap) => void): () => void
}
export type QueueHostWindow = Window & { koboWorkspaceQueues?: WorkspaceQueueHost }
const attachedHosts = new WeakMap<QueueStore, WorkspaceQueueHost>()

export function getWorkspaceQueueHost(store: QueueStore): WorkspaceQueueHost | undefined {
  return attachedHosts.get(store)
}
function snapshot(queues: QueueMap): QueueMap {
  return Object.fromEntries(Object.entries(queues).map(([key, value]) => [key, { ...value }]))
}

/** The top-level app owns queues; panes mirror them and delegate all mutations. */
export function createWorkspaceQueueHost(store: QueueStore): WorkspaceQueueHost & { dispose(): void } {
  const listeners = new Set<(queues: QueueMap) => void>()
  const stop = watch(
    () => store.queuedMessages,
    () => {
      for (const listener of listeners) listener(snapshot(store.queuedMessages))
    },
    { deep: true, flush: 'sync' },
  )
  return {
    queue: (...args) => store.queueMessage(...args),
    cancel: (...args) => store.cancelQueuedMessage(...args),
    flush: (...args) => store.flushQueuedMessage(...args),
    subscribe(listener) {
      listeners.add(listener)
      listener(snapshot(store.queuedMessages))
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      stop()
      listeners.clear()
    },
  }
}
export function attachWorkspaceQueueHost(store: QueueStore, host: WorkspaceQueueHost): () => void {
  attachedHosts.set(store, host)
  const unsubscribe = host.subscribe((queues) => {
    store.queuedMessages = queues
  })
  return () => {
    unsubscribe()
    attachedHosts.delete(store)
  }
}
