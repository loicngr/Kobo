import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getProcess,
  getTrackedCount,
  killAll,
  registerProcess,
  unregisterProcess,
} from '../server/utils/process-tracker.js'

function makeFakeProcess(pid: number): ChildProcess {
  return {
    pid,
    kill: () => true,
    killed: false,
  } as unknown as ChildProcess
}

beforeEach(() => {
  // On teste les opérations de map directement
})

describe('registerProcess / getProcess / unregisterProcess', () => {
  it('enregistre un processus et le retrouve par id', () => {
    const proc = makeFakeProcess(1001)
    registerProcess('proc-1', proc)
    expect(getProcess('proc-1')).toBe(proc)
    unregisterProcess('proc-1')
  })

  it('retourne undefined pour un id inconnu', () => {
    expect(getProcess('unknown-id-xyz')).toBeUndefined()
  })

  it('supprime le processus après unregisterProcess', () => {
    const proc = makeFakeProcess(1002)
    registerProcess('proc-2', proc)
    unregisterProcess('proc-2')
    expect(getProcess('proc-2')).toBeUndefined()
  })

  it('peut enregistrer plusieurs processus', () => {
    const p1 = makeFakeProcess(2001)
    const p2 = makeFakeProcess(2002)
    const before = getTrackedCount()

    registerProcess('multi-1', p1)
    registerProcess('multi-2', p2)

    expect(getTrackedCount()).toBe(before + 2)

    unregisterProcess('multi-1')
    unregisterProcess('multi-2')
  })
})

describe('getTrackedCount()', () => {
  it('retourne le nombre de processus actuellement suivis', () => {
    const before = getTrackedCount()
    const proc = makeFakeProcess(3001)
    registerProcess('count-test', proc)
    expect(getTrackedCount()).toBe(before + 1)
    unregisterProcess('count-test')
    expect(getTrackedCount()).toBe(before)
  })
})

// ── Gap 3: killAll ────────────────────────────────────────────────────────────

describe('killAll()', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('envoie SIGTERM a tous les processus enregistres', () => {
    const killSpy1 = vi.fn()
    const killSpy2 = vi.fn()
    const p1 = { pid: 4001, kill: killSpy1, killed: false } as unknown as ChildProcess
    const p2 = { pid: 4002, kill: killSpy2, killed: false } as unknown as ChildProcess

    registerProcess('kill-1', p1)
    registerProcess('kill-2', p2)

    killAll()

    expect(killSpy1).toHaveBeenCalledWith('SIGTERM')
    expect(killSpy2).toHaveBeenCalledWith('SIGTERM')
  })

  it('envoie SIGKILL apres le timeout si le processus est toujours en vie', () => {
    const killSpy = vi.fn()
    const proc = { pid: 5001, kill: killSpy, killed: false } as unknown as ChildProcess

    registerProcess('kill-timeout', proc)

    killAll()

    expect(killSpy).toHaveBeenCalledWith('SIGTERM')
    expect(killSpy).not.toHaveBeenCalledWith('SIGKILL')

    // Advance past the 5s SIGKILL timeout
    vi.advanceTimersByTime(5000)

    expect(killSpy).toHaveBeenCalledWith('SIGKILL')
  })

  it('ne envoie pas SIGKILL si le processus est deja killed', () => {
    const killSpy = vi.fn()
    const proc = { pid: 5002, kill: killSpy, killed: false } as unknown as ChildProcess

    registerProcess('kill-already-dead', proc)

    killAll()

    // Simulate process dying after SIGTERM
    ;(proc as unknown as { killed: boolean }).killed = true

    vi.advanceTimersByTime(5000)

    // SIGKILL should NOT have been called because proc.killed is true
    expect(killSpy).not.toHaveBeenCalledWith('SIGKILL')
  })

  it('apres killAll le trackedCount est 0', () => {
    const p1 = { pid: 6001, kill: vi.fn(), killed: false } as unknown as ChildProcess
    const p2 = { pid: 6002, kill: vi.fn(), killed: false } as unknown as ChildProcess

    registerProcess('kill-count-1', p1)
    registerProcess('kill-count-2', p2)

    expect(getTrackedCount()).toBeGreaterThanOrEqual(2)

    killAll()

    expect(getTrackedCount()).toBe(0)
  })
})
