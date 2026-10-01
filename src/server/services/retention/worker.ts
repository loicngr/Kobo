import { parentPort, workerData } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { countPrunableWsEvents, pruneWsEventsInBatches, type RetentionConfig } from '../ws-events-retention-service.js'

const port = parentPort!
// The parent supplies the already-open database path, never a second home.
const db = new Database(workerData.dbPath)
db.pragma('journal_mode=WAL')
db.pragma('foreign_keys=ON')
db.pragma('busy_timeout=5000')
let stopped = false
let queue = Promise.resolve()

port.on(
  'message',
  (message: { id: number; config: RetentionConfig; nowMs: number; preview?: boolean; stop?: boolean }) => {
    if (message.stop) {
      stopped = true
      void queue.finally(() => {
        db.close()
        port.close()
      })
      return
    }
    queue = queue.then(async () => {
      if (stopped) return
      try {
        if (message.preview) {
          const total = (db.prepare('SELECT COUNT(*) AS count FROM ws_events').get() as { count: number }).count
          const deletable = countPrunableWsEvents(db, message.config, message.nowMs)
          port.postMessage({ id: message.id, result: { deletable, total } })
        } else {
          const result = await pruneWsEventsInBatches(db, message.config, message.nowMs, () => stopped)
          if (!stopped) port.postMessage({ id: message.id, result })
        }
      } catch (error) {
        port.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) })
      }
    })
  },
)
