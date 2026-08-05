import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWhipCrackCoordinator } from '../utils/whip-crack'

describe('whip crack coordinator', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('interrupts before sending to the captured session', async () => {
    const calls: string[] = []
    let running = true
    const coordinator = createWhipCrackCoordinator(
      { workspaceId: 'ws-1', sessionId: 'session-1' },
      ['Faster, tocard!'],
      {
        isAgentRunning: () => running,
        interruptAgent: async () => {
          calls.push('interrupt')
        },
        sendMessage: (_workspaceId, message, sessionId) => {
          calls.push(`send:${message}:${sessionId}`)
          return true
        },
        wait: async (ms) => {
          calls.push(`wait:${ms}`)
          running = false
        },
        random: () => 0,
        now: () => 1_000,
        onError: vi.fn(),
      },
    )

    await coordinator.enqueue()

    expect(calls).toEqual(['interrupt', 'wait:300', 'send:Faster, tocard!:session-1'])
  })

  it('waits for the interrupted agent to stop before sending', async () => {
    const calls: string[] = []
    let running = true
    let waits = 0
    const coordinator = createWhipCrackCoordinator(
      { workspaceId: 'ws-1', sessionId: 'session-1' },
      ['Faster, tocard!'],
      {
        isAgentRunning: () => running,
        interruptAgent: async () => {
          calls.push('interrupt')
        },
        sendMessage: () => {
          calls.push('send')
          return true
        },
        wait: async (ms) => {
          calls.push(`wait:${ms}`)
          waits += 1
          if (waits === 2) running = false
        },
        random: () => 0,
        now: () => 1_000,
        onError: vi.fn(),
      },
    )

    await coordinator.enqueue()

    expect(calls).toEqual(['interrupt', 'wait:300', 'wait:50', 'send'])
  })

  it('abandons stale-session cracks and rate-limits interruption errors', async () => {
    const wait = vi.fn(async () => undefined)
    const sendMessage = vi.fn(() => true)
    const onError = vi.fn()
    let now = 1_000
    const coordinator = createWhipCrackCoordinator(
      { workspaceId: 'ws-1', sessionId: 'session-1' },
      ['Faster, tocard!'],
      {
        isAgentRunning: () => true,
        interruptAgent: async () => {
          throw new Error('No agent running')
        },
        sendMessage,
        wait,
        random: () => 0,
        now: () => now,
        onError,
      },
    )

    await coordinator.enqueue()
    now = 2_000
    await coordinator.enqueue()
    now = 6_100
    await coordinator.enqueue()

    expect(wait).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(2)
  })

  it('bounds polling when an interrupted agent stays marked as running', async () => {
    const wait = vi.fn(async () => undefined)
    const sendMessage = vi.fn(() => true)
    const coordinator = createWhipCrackCoordinator(
      { workspaceId: 'ws-1', sessionId: 'session-1' },
      ['Faster, tocard!'],
      {
        isAgentRunning: () => true,
        interruptAgent: async () => undefined,
        sendMessage,
        wait,
        random: () => 0,
        now: () => 1_000,
        onError: vi.fn(),
      },
    )

    await coordinator.enqueue()

    expect(wait).toHaveBeenCalledTimes(315)
    expect(wait.mock.calls.reduce((total, [milliseconds]) => total + milliseconds, 0)).toBe(16_000)
    expect(sendMessage).toHaveBeenCalledOnce()
  })

  it('serializes repeated rejected interruptions without sending', async () => {
    let releaseFirstInterrupt!: () => void
    const firstInterrupt = new Promise<void>((resolve) => {
      releaseFirstInterrupt = resolve
    })
    const sent: string[] = []
    let interrupts = 0
    const coordinator = createWhipCrackCoordinator({ workspaceId: 'ws-1', sessionId: 'session-1' }, ['Go, tocard!'], {
      isAgentRunning: () => true,
      interruptAgent: async () => {
        interrupts += 1
        if (interrupts === 1) await firstInterrupt
        throw new Error('No agent running')
      },
      sendMessage: (_workspaceId, message) => {
        sent.push(message)
        return true
      },
      wait: vi.fn(),
      random: () => 0,
      now: () => 1_000,
      onError: vi.fn(),
    })

    const first = coordinator.enqueue()
    const second = coordinator.enqueue()
    expect(sent).toEqual([])
    releaseFirstInterrupt()
    await Promise.all([first, second])

    expect(interrupts).toBe(2)
    expect(sent).toEqual([])
  })

  it('rate-limits WebSocket errors and refuses new work after dispose', async () => {
    const onError = vi.fn()
    let now = 1_000
    const coordinator = createWhipCrackCoordinator({ workspaceId: 'ws-1', sessionId: 'session-1' }, ['Go, tocard!'], {
      isAgentRunning: () => false,
      interruptAgent: vi.fn(),
      sendMessage: () => false,
      wait: vi.fn(),
      random: () => 0,
      now: () => now,
      onError,
    })

    await coordinator.enqueue()
    now = 2_000
    await coordinator.enqueue()
    expect(onError).toHaveBeenCalledTimes(1)
    now = 6_100
    await coordinator.enqueue()
    expect(onError).toHaveBeenCalledTimes(2)
    coordinator.dispose()
    await coordinator.enqueue()
    expect(onError).toHaveBeenCalledTimes(2)
  })
})
