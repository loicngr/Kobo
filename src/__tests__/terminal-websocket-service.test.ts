import { EventEmitter } from 'node:events'
import type { IPty } from 'node-pty'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'

vi.mock('../server/services/terminal-service.js', () => ({ createTerminal: vi.fn(), getTerminal: vi.fn() }))
vi.mock('../server/services/workspace-service.js', () => ({ getWorkspace: vi.fn() }))

import { createTerminal, getTerminal } from '../server/services/terminal-service.js'
import { handleTerminalConnection } from '../server/services/terminal-websocket-service.js'
import { getWorkspace } from '../server/services/workspace-service.js'
import { reserveWorkspaceLifecycle } from '../server/utils/workspace-lifecycle-guard.js'

class Socket extends EventEmitter {
  readyState = 1
  bufferedAmount = 0
  send = vi.fn()
  ping = vi.fn()
  close = vi.fn(() => {
    this.readyState = 3
    this.emit('close')
  })
  terminate = vi.fn(() => {
    this.readyState = 3
    this.emit('close')
  })
}
let socket: Socket
let output: (data: string) => void
let disposeData: ReturnType<typeof vi.fn>
let disposeExit: ReturnType<typeof vi.fn>
let terminal: IPty

beforeEach(() => {
  vi.clearAllMocks()
  socket = new Socket()
  disposeData = vi.fn()
  disposeExit = vi.fn()
  terminal = {
    kill: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    onData: (callback: (data: string) => void) => {
      output = callback
      return { dispose: disposeData }
    },
    onExit: () => ({ dispose: disposeExit }),
  } as unknown as IPty
  vi.mocked(getWorkspace).mockReturnValue({
    id: 'ws',
    worktreePath: '/tmp',
    archivedAt: null,
    worktreePurgedAt: null,
  } as never)
  vi.mocked(getTerminal).mockReturnValue(terminal)
  vi.mocked(createTerminal).mockReturnValue(terminal)
})
afterEach(() => {
  socket.emit('close')
  vi.useRealTimers()
})

function connect() {
  handleTerminalConnection(socket as unknown as WebSocket, 'ws')
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'create' })), false)
}

describe('terminal WebSocket transport', () => {
  it('preserves binary terminal output and disposes listeners on disconnect', () => {
    connect()
    output('hello\r\n')
    expect(socket.send).toHaveBeenCalledWith(Buffer.from('hello\r\n'), { binary: true }, expect.any(Function))
    socket.emit('close')
    expect(disposeData).toHaveBeenCalledOnce()
    expect(disposeExit).toHaveBeenCalledOnce()
    expect(terminal.kill).not.toHaveBeenCalled()
  })
  it('disconnects a slow client before adding a frame over the queue budget', () => {
    connect()
    socket.send.mockClear()
    socket.bufferedAmount = 1024 * 1024 - 2
    output('abcd')
    expect(socket.send).not.toHaveBeenCalled()
    expect(socket.terminate).toHaveBeenCalledOnce()
    expect(disposeData).toHaveBeenCalledOnce()
    expect(terminal.kill).not.toHaveBeenCalled()
  })
  it('handles asynchronous send failures and detaches from the shared terminal', () => {
    connect()
    socket.send.mockImplementation((_data, _options, callback) => callback(new Error('connection reset')))
    output('text')
    expect(socket.terminate).toHaveBeenCalledOnce()
    expect(disposeData).toHaveBeenCalledOnce()
  })
  it('requires a heartbeat response and stops pinging after disconnect', async () => {
    vi.useFakeTimers()
    connect()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(socket.ping).toHaveBeenCalledOnce()
    socket.emit('pong')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(socket.terminate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(socket.terminate).toHaveBeenCalledOnce()
    const pings = socket.ping.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(socket.ping).toHaveBeenCalledTimes(pings)
  })
  it('does not create a terminal after server shutdown begins on an existing socket', () => {
    let shuttingDown = false
    handleTerminalConnection(socket as unknown as WebSocket, 'ws', () => shuttingDown)
    shuttingDown = true
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'create' })), false)
    expect(createTerminal).not.toHaveBeenCalled()
  })
  it('does not create a terminal while the socket is closing', () => {
    handleTerminalConnection(socket as unknown as WebSocket, 'ws')
    socket.readyState = 2
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'create' })), false)
    expect(createTerminal).not.toHaveBeenCalled()
  })
  it('rejects a lifecycle operation even when a terminal already exists', () => {
    const reservation = reserveWorkspaceLifecycle('ws')
    try {
      connect()
      socket.emit('message', Buffer.from('touch file'), true)
      expect(terminal.write).not.toHaveBeenCalled()
      expect(createTerminal).not.toHaveBeenCalled()
      expect(socket.send.mock.calls.some(([data]) => String(data).includes('error'))).toBe(true)
    } finally {
      reservation.release()
    }
  })
  it.each(['archivedAt', 'worktreePurgedAt'])('rejects %s workspaces with an existing terminal', (field) => {
    vi.mocked(getWorkspace).mockReturnValue({ worktreePath: '/tmp', [field]: 'today' } as never)
    connect()
    expect(socket.send.mock.calls.some(([data]) => String(data).includes('ready'))).toBe(false)
  })
})
