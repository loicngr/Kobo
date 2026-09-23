import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWhipCrackCoordinator, WHIP_AGENT_STOP_POLL_MS, WHIP_MESSAGE_DELAY_MS } from '../utils/whip-crack'

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
          throw Object.assign(new Error('Session is not active'), { code: 'session_not_active' })
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

  it('waits once, then sends to the captured session when the agent already stopped', async () => {
    const wait = vi.fn(async () => undefined)
    const sendMessage = vi.fn(() => true)
    const onError = vi.fn()
    const coordinator = createWhipCrackCoordinator(
      { workspaceId: 'ws-captured', sessionId: 'session-captured' },
      ['Faster, tocard!'],
      {
        isAgentRunning: () => true,
        interruptAgent: async () => {
          throw Object.assign(new Error('No agent running'), { code: 'no_agent_running' })
        },
        sendMessage,
        wait,
        random: () => 0,
        now: () => 1_000,
        onError,
      },
    )

    await coordinator.enqueue()

    expect(wait).toHaveBeenCalledOnce()
    expect(wait).toHaveBeenCalledWith(WHIP_MESSAGE_DELAY_MS)
    expect(sendMessage).toHaveBeenCalledOnce()
    expect(sendMessage).toHaveBeenCalledWith('ws-captured', 'Faster, tocard!', 'session-captured')
    expect(onError).not.toHaveBeenCalled()
  })

  it.each([
    ['session_not_active', 'Session is not active'],
    ['interrupt_failed', 'Engine interruption failed'],
    [undefined, 'Unknown interruption failure'],
  ])('blocks %s interruption failures and rate-limits the error', async (code, message) => {
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
          const error = new Error(message)
          if (code !== undefined) Object.assign(error, { code })
          throw error
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

    expect(wait).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledOnce()
  })

  it('does not send when disposed during the recoverable stopped-agent delay', async () => {
    let releaseDelay!: () => void
    let delayStarted!: () => void
    const delay = new Promise<void>((resolve) => {
      releaseDelay = resolve
    })
    const delayHasStarted = new Promise<void>((resolve) => {
      delayStarted = resolve
    })
    const wait = vi.fn(async () => {
      delayStarted()
      await delay
    })
    const sendMessage = vi.fn(() => true)
    const coordinator = createWhipCrackCoordinator(
      { workspaceId: 'ws-1', sessionId: 'session-1' },
      ['Faster, tocard!'],
      {
        isAgentRunning: () => true,
        interruptAgent: async () => {
          throw Object.assign(new Error('No agent running'), { code: 'no_agent_running' })
        },
        sendMessage,
        wait,
        random: () => 0,
        now: () => 1_000,
        onError: vi.fn(),
      },
    )

    const active = coordinator.enqueue()
    const firstOutcome = await Promise.race([
      delayHasStarted.then(() => 'delay-started'),
      active.then(() => 'dispatch-completed'),
    ])
    expect(firstOutcome).toBe('delay-started')
    coordinator.dispose()
    releaseDelay()
    await active

    expect(wait).toHaveBeenCalledWith(WHIP_MESSAGE_DELAY_MS)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('bounds polling when an interrupted agent stays marked as running', async () => {
    const wait = vi.fn(async (_milliseconds: number) => undefined)
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
        throw Object.assign(new Error('Session is not active'), { code: 'session_not_active' })
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

  it('coalesces cracks beyond one active and one pending dispatch', async () => {
    let releaseFirstInterrupt!: () => void
    let firstInterruptStarted!: () => void
    const firstInterrupt = new Promise<void>((resolve) => {
      releaseFirstInterrupt = resolve
    })
    const interruptStarted = new Promise<void>((resolve) => {
      firstInterruptStarted = resolve
    })
    const sendMessage = vi.fn(() => true)
    let interruptCalls = 0
    let running = true
    const coordinator = createWhipCrackCoordinator({ workspaceId: 'ws-1', sessionId: 'session-1' }, ['Go, tocard!'], {
      isAgentRunning: () => running,
      interruptAgent: async () => {
        interruptCalls += 1
        if (interruptCalls === 1) {
          firstInterruptStarted()
          await firstInterrupt
        }
      },
      sendMessage,
      wait: async () => {
        running = false
      },
      random: () => 0,
      now: () => 1_000,
      onError: vi.fn(),
    })

    const first = coordinator.enqueue()
    await interruptStarted
    const second = coordinator.enqueue()
    const coalesced = coordinator.enqueue()
    releaseFirstInterrupt()
    await Promise.all([first, second, coalesced])

    expect(sendMessage).toHaveBeenCalledTimes(2)
  })

  it('accepts a new pending crack after the active crack promise settles', async () => {
    let releaseSecondInterrupt!: () => void
    let secondInterruptStarted!: () => void
    const secondInterrupt = new Promise<void>((resolve) => {
      releaseSecondInterrupt = () => {
        running = false
        resolve()
      }
    })
    const secondInterruptHasStarted = new Promise<void>((resolve) => {
      secondInterruptStarted = resolve
    })
    let running = false
    let sent = 0
    const coordinator = createWhipCrackCoordinator({ workspaceId: 'ws-1', sessionId: 'session-1' }, ['Go, tocard!'], {
      isAgentRunning: () => running,
      interruptAgent: async () => {
        secondInterruptStarted()
        await secondInterrupt
      },
      sendMessage: () => {
        sent += 1
        running = true
        return true
      },
      wait: async () => undefined,
      random: () => 0,
      now: () => 1_000,
      onError: vi.fn(),
    })

    const first = coordinator.enqueue()
    const pending = coordinator.enqueue()
    await first
    const newlyAccepted = coordinator.enqueue()
    await secondInterruptHasStarted
    releaseSecondInterrupt()
    await Promise.all([first, pending, newlyAccepted])

    expect(sent).toBe(3)
  })

  it('cancels active and pending cracks when disposed during the message delay', async () => {
    let releaseMessageDelay!: () => void
    let messageDelayStarted!: () => void
    const messageDelay = new Promise<void>((resolve) => {
      releaseMessageDelay = resolve
    })
    const messageDelayHasStarted = new Promise<void>((resolve) => {
      messageDelayStarted = resolve
    })
    const wait = vi.fn((milliseconds: number) => {
      if (milliseconds === WHIP_MESSAGE_DELAY_MS) {
        messageDelayStarted()
        return messageDelay
      }
      return Promise.resolve()
    })
    const interruptAgent = vi.fn(async () => undefined)
    const sendMessage = vi.fn(() => true)
    const coordinator = createWhipCrackCoordinator({ workspaceId: 'ws-1', sessionId: 'session-1' }, ['Go, tocard!'], {
      isAgentRunning: () => true,
      interruptAgent,
      sendMessage,
      wait,
      random: () => 0,
      now: () => 1_000,
      onError: vi.fn(),
    })

    const active = coordinator.enqueue()
    const pending = coordinator.enqueue()
    await messageDelayHasStarted
    coordinator.dispose()
    releaseMessageDelay()
    await Promise.all([active, pending])

    expect(interruptAgent).toHaveBeenCalledTimes(1)
    expect(wait).toHaveBeenCalledTimes(1)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('cancels active and pending cracks when disposed during interruption', async () => {
    let releaseInterrupt!: () => void
    let interruptStarted!: () => void
    const interrupted = new Promise<void>((resolve) => {
      releaseInterrupt = resolve
    })
    const interruptionHasStarted = new Promise<void>((resolve) => {
      interruptStarted = resolve
    })
    const interruptAgent = vi.fn(async () => {
      interruptStarted()
      await interrupted
    })
    const wait = vi.fn(async () => undefined)
    const sendMessage = vi.fn(() => true)
    const coordinator = createWhipCrackCoordinator({ workspaceId: 'ws-1', sessionId: 'session-1' }, ['Go, tocard!'], {
      isAgentRunning: () => true,
      interruptAgent,
      sendMessage,
      wait,
      random: () => 0,
      now: () => 1_000,
      onError: vi.fn(),
    })

    const active = coordinator.enqueue()
    const pending = coordinator.enqueue()
    await interruptionHasStarted
    coordinator.dispose()
    releaseInterrupt()
    await Promise.all([active, pending])

    expect(interruptAgent).toHaveBeenCalledTimes(1)
    expect(wait).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('cancels active and pending cracks when disposed during polling', async () => {
    let releasePollingWait!: () => void
    let pollingWaitStarted!: () => void
    const pollingWait = new Promise<void>((resolve) => {
      releasePollingWait = resolve
    })
    const pollingHasStarted = new Promise<void>((resolve) => {
      pollingWaitStarted = resolve
    })
    const wait = vi.fn((milliseconds: number) => {
      if (milliseconds === WHIP_AGENT_STOP_POLL_MS) {
        pollingWaitStarted()
        return pollingWait
      }
      return Promise.resolve()
    })
    const interruptAgent = vi.fn(async () => undefined)
    const sendMessage = vi.fn(() => true)
    const coordinator = createWhipCrackCoordinator({ workspaceId: 'ws-1', sessionId: 'session-1' }, ['Go, tocard!'], {
      isAgentRunning: () => true,
      interruptAgent,
      sendMessage,
      wait,
      random: () => 0,
      now: () => 1_000,
      onError: vi.fn(),
    })

    const active = coordinator.enqueue()
    const pending = coordinator.enqueue()
    await pollingHasStarted
    coordinator.dispose()
    releasePollingWait()
    await Promise.all([active, pending])

    expect(interruptAgent).toHaveBeenCalledTimes(1)
    expect(wait.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      WHIP_MESSAGE_DELAY_MS,
      WHIP_AGENT_STOP_POLL_MS,
    ])
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('suppresses interruption errors after disposal and settles pending work', async () => {
    let rejectInterrupt!: () => void
    let interruptStarted!: () => void
    const interrupted = new Promise<void>((_resolve, reject) => {
      rejectInterrupt = () => reject(new Error('No agent running'))
    })
    const interruptionHasStarted = new Promise<void>((resolve) => {
      interruptStarted = resolve
    })
    const interruptAgent = vi.fn(async () => {
      interruptStarted()
      await interrupted
    })
    const wait = vi.fn(async () => undefined)
    const sendMessage = vi.fn(() => true)
    const onError = vi.fn()
    const coordinator = createWhipCrackCoordinator({ workspaceId: 'ws-1', sessionId: 'session-1' }, ['Go, tocard!'], {
      isAgentRunning: () => true,
      interruptAgent,
      sendMessage,
      wait,
      random: () => 0,
      now: () => 1_000,
      onError,
    })

    const active = coordinator.enqueue()
    const pending = coordinator.enqueue()
    await interruptionHasStarted
    coordinator.dispose()
    rejectInterrupt()
    await Promise.all([active, pending])

    expect(interruptAgent).toHaveBeenCalledTimes(1)
    expect(wait).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
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
