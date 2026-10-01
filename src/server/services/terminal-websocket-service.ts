import type { IPty } from 'node-pty'
import type WebSocket from 'ws'
import { assertWorkspaceLifecycleAvailable, isWorkspaceLifecycleBusy } from '../utils/workspace-lifecycle-guard.js'
import { createTerminal, getTerminal } from './terminal-service.js'
import { getWorkspace } from './workspace-service.js'

const MAX_BUFFERED_BYTES = 1024 * 1024
const HEARTBEAT_INTERVAL_MS = 30_000

/** Each client owns its subscriptions and output budget, never the shared PTY. */
export function handleTerminalConnection(ws: WebSocket, workspaceId: string, isShuttingDown = () => false): void {
  let currentPty: IPty | null = null
  let dataDisposable: { dispose(): void } | null = null
  let exitDisposable: { dispose(): void } | null = null
  let disposed = false
  let alive = true

  function detachTerminal(): void {
    dataDisposable?.dispose()
    exitDisposable?.dispose()
    dataDisposable = null
    exitDisposable = null
    currentPty = null
  }
  function dispose(): void {
    if (disposed) return
    disposed = true
    clearInterval(heartbeat)
    detachTerminal()
  }
  function disconnect(): void {
    if (disposed) return
    dispose()
    ws.terminate()
  }
  function send(data: string | Buffer): boolean {
    if (disposed || ws.readyState !== 1) return false
    if (ws.bufferedAmount + Buffer.byteLength(data) > MAX_BUFFERED_BYTES) {
      disconnect()
      return false
    }
    try {
      ws.send(data, { binary: Buffer.isBuffer(data) }, (error) => {
        if (error) disconnect()
      })
      return true
    } catch {
      disconnect()
      return false
    }
  }
  function sendError(error: unknown): void {
    send(JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : String(error) }))
  }

  const heartbeat = setInterval(() => {
    if (ws.readyState !== 1 || !alive) {
      disconnect()
      return
    }
    alive = false
    try {
      ws.ping()
    } catch {
      disconnect()
    }
  }, HEARTBEAT_INTERVAL_MS)
  heartbeat.unref?.()
  ws.on('pong', () => {
    alive = true
  })
  ws.on('close', dispose)
  ws.on('error', disconnect)

  ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
    if (disposed || ws.readyState !== 1 || isShuttingDown()) return
    if (isBinary) {
      if (currentPty && getTerminal(workspaceId) === currentPty && !isWorkspaceLifecycleBusy(workspaceId)) {
        try {
          currentPty.write(data.toString())
        } catch (error) {
          sendError(error)
        }
      }
      return
    }
    let message: unknown
    try {
      message = JSON.parse(data.toString())
    } catch {
      return
    }
    if (!message || typeof message !== 'object' || !('type' in message)) return

    if (message.type === 'create') {
      try {
        assertWorkspaceLifecycleAvailable(workspaceId)
        const workspace = getWorkspace(workspaceId)
        if (!workspace) throw new Error('Workspace not found')
        if (workspace.archivedAt) throw new Error('Workspace is archived')
        if (workspace.worktreePurgedAt) throw new Error('Workspace worktree is purged')
        detachTerminal()
        const terminal = createTerminal(workspaceId, workspace.worktreePath)
        currentPty = terminal
        dataDisposable = terminal.onData((output) => {
          send(Buffer.from(output))
        })
        exitDisposable = terminal.onExit(({ exitCode }) => {
          if (send(JSON.stringify({ type: 'exited', code: exitCode }))) ws.close()
          dispose()
        })
        send(JSON.stringify({ type: 'ready' }))
      } catch (error) {
        sendError(error)
      }
      return
    }
    if (
      message.type === 'resize' &&
      'cols' in message &&
      'rows' in message &&
      typeof message.cols === 'number' &&
      typeof message.rows === 'number' &&
      Number.isFinite(message.cols) &&
      Number.isFinite(message.rows) &&
      currentPty &&
      getTerminal(workspaceId) === currentPty &&
      !isWorkspaceLifecycleBusy(workspaceId)
    ) {
      try {
        currentPty.resize(
          Math.max(1, Math.min(1000, Math.floor(message.cols))),
          Math.max(1, Math.min(1000, Math.floor(message.rows))),
        )
      } catch (error) {
        sendError(error)
      }
    }
  })
}
