import type { ChildProcess } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { stopMcpProcess } from '../server/utils/mcp-process.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})
it('closes the wrapper and force-cleans its group even after the wrapper exits', () => {
  vi.useFakeTimers()
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
  const child = { pid: 424242, stdin: { end: vi.fn() }, kill: vi.fn() } as unknown as ChildProcess
  stopMcpProcess(child)
  expect(child.stdin?.end).toHaveBeenCalled()
  expect(kill).toHaveBeenCalledWith(-424242, 'SIGTERM')
  vi.advanceTimersByTime(1000)
  expect(kill).toHaveBeenCalledWith(-424242, 'SIGKILL')
})
it('tolerates an already exited group and failed process handle', () => {
  vi.useFakeTimers()
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw new Error('gone')
  })
  const child = {
    pid: 424242,
    kill: vi.fn(() => {
      throw new Error('gone')
    }),
  } as unknown as ChildProcess
  expect(() => stopMcpProcess(child)).not.toThrow()
  expect(() => vi.advanceTimersByTime(1000)).not.toThrow()
})
