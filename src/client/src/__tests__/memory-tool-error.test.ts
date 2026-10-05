import { describe, expect, it } from 'vitest'
import { isUnexplainedMemoryError } from '../utils/memory-tool-error'

describe('memory tool error fallback', () => {
  it.each([undefined, null, '', [], 'Unknown error', [{ type: 'text', text: 'Unknown error' }]])(
    'explains empty memory errors without inventing a cause: %j',
    (output) => expect(isUnexplainedMemoryError('mcp__kobo-tasks__remember', { isError: true, output })).toBe(true),
  )
  it('preserves actual errors, successful output and unrelated tools', () => {
    expect(isUnexplainedMemoryError('mcp__kobo-tasks__remember', { isError: true, output: 'Invalid generation' })).toBe(
      false,
    )
    expect(isUnexplainedMemoryError('mcp__kobo-tasks__remember', { isError: false, output: [] })).toBe(false)
    expect(isUnexplainedMemoryError('mcp__other__remember', { isError: true, output: [] })).toBe(false)
    expect(isUnexplainedMemoryError('Bash', { isError: true, output: 'Unknown error' })).toBe(false)
    expect(isUnexplainedMemoryError('remember')).toBe(false)
  })
})
