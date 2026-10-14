import type { PostToolUseHookInput } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createProgressReportingHook } from '../server/services/agent/engines/claude-code/progress-reporting-hook.js'

const context = { signal: new AbortController().signal }
const record = { id: 'bar-1', status: 'running', dismissed: false, sequence: 0 }
function input(tool: string, agent?: string, response?: unknown): PostToolUseHookInput {
  return {
    hook_event_name: 'PostToolUse',
    session_id: 'session-1',
    transcript_path: '',
    cwd: '/repo',
    tool_name: tool,
    tool_input: {},
    tool_response: response,
    tool_use_id: 'tool-1',
    ...(agent ? { agent_id: agent } : {}),
  }
}
const tool = (name: string) => `mcp__kobo-tasks__${name}_progress_bar`
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})
afterEach(() => vi.useRealTimers())

it('reminds the creator using its returned id and next sequence without inventing progress', async () => {
  const hook = createProgressReportingHook()
  const output = await hook(input(tool('create'), 'child', { structuredContent: record }), undefined, context)
  expect(output).toMatchObject({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: expect.stringContaining('bar-1') },
  })
  expect(output).toMatchObject({ hookSpecificOutput: { additionalContext: expect.stringContaining('"sequence":1') } })
  expect(JSON.stringify(output)).toContain('finish_progress_bar')
})
it('only reminds the producing subagent after work without reports, bounded by time and action count', async () => {
  const hook = createProgressReportingHook()
  await hook(
    input(tool('create'), 'child', { content: [{ type: 'text', text: JSON.stringify(record) }] }),
    undefined,
    context,
  )
  vi.advanceTimersByTime(60_000)
  for (let i = 0; i < 12; i++) expect(await hook(input('Bash', 'other'), undefined, context)).toEqual({})
  for (let i = 0; i < 7; i++) expect(await hook(input('Bash', 'child'), undefined, context)).toEqual({})
  expect(JSON.stringify(await hook(input('Bash', 'child'), undefined, context))).toContain('bar-1')
  for (let i = 0; i < 12; i++) expect(await hook(input('Read', 'child'), undefined, context)).toEqual({})
})
it('clears reminders on completion or dismissal and ignores errors/foreign tools', async () => {
  const hook = createProgressReportingHook()
  expect(await hook(input('mcp__other__create_progress_bar', undefined, record), undefined, context)).toEqual({})
  expect(
    await hook(input(tool('create'), undefined, { isError: true, structuredContent: record }), undefined, context),
  ).toEqual({})
  await hook(input(tool('create'), undefined, record), undefined, context)
  await hook(input(tool('finish'), undefined, { ...record, sequence: 1, status: 'succeeded' }), undefined, context)
  await hook(input(tool('create'), 'child', { ...record, dismissed: true }), undefined, context)
  vi.advanceTimersByTime(60_000)
  for (let i = 0; i < 10; i++) {
    expect(await hook(input('Bash'), undefined, context)).toEqual({})
    expect(await hook(input('Bash', 'child'), undefined, context)).toEqual({})
  }
})
it('uses the latest sequence and does not treat repeated create responses as new progress', async () => {
  const hook = createProgressReportingHook()
  await hook(input(tool('create'), undefined, record), undefined, context)
  await hook(input(tool('update'), undefined, { ...record, sequence: 4 }), undefined, context)
  vi.advanceTimersByTime(60_000)
  expect(await hook(input(tool('create'), undefined, record), undefined, context)).toEqual({})
  let output: Awaited<ReturnType<typeof hook>> = {}
  for (let i = 0; i < 8; i++) output = await hook(input('Read'), undefined, context)
  expect(output).toMatchObject({ hookSpecificOutput: { additionalContext: expect.stringContaining('"sequence":5') } })
})

it('hands reminders to the subagent that takes over updates, without notifying the parent twice', async () => {
  const hook = createProgressReportingHook()
  await hook(input(tool('create'), undefined, record), undefined, context)
  await hook(input(tool('update'), 'child', { ...record, sequence: 1 }), undefined, context)
  vi.advanceTimersByTime(60_000)
  for (let i = 0; i < 8; i++) expect(await hook(input('Bash'), undefined, context)).toEqual({})
  let output: Awaited<ReturnType<typeof hook>> = {}
  for (let i = 0; i < 8; i++) output = await hook(input('Bash', 'child'), undefined, context)
  expect(output).toMatchObject({ hookSpecificOutput: { additionalContext: expect.stringContaining('"sequence":2') } })
})

it.each([{ response: [{ type: 'text', text: JSON.stringify(record) }] }, { response: JSON.stringify(record) }])(
  'accepts SDK progress response shape %#',
  async ({ response }) => {
    const hook = createProgressReportingHook()
    const output = await hook(input(tool('create'), 'child', response), undefined, context)
    expect(output).toMatchObject({ hookSpecificOutput: { additionalContext: expect.stringContaining('bar-1') } })
  },
)
it.each([
  'not JSON',
  'x'.repeat(20_000),
  { content: [{ type: 'text', text: 'not JSON' }] },
  { ...record, id: 'malicious instruction' },
])('ignores malformed response %#', async (response) => {
  expect(await createProgressReportingHook()(input(tool('create'), undefined, response), undefined, context)).toEqual(
    {},
  )
})

it.each(['succeeded', 'dismissed'])('never revives a %s reporter from delayed creation output', async (terminal) => {
  const hook = createProgressReportingHook()
  await hook(input(tool('create'), 'child', record), undefined, context)
  await hook(
    input(tool('finish'), 'child', {
      ...record,
      sequence: 1,
      status: terminal === 'dismissed' ? 'running' : terminal,
      dismissed: terminal === 'dismissed',
    }),
    undefined,
    context,
  )
  expect(await hook(input(tool('create'), 'child', record), undefined, context)).toEqual({})
  vi.advanceTimersByTime(60_000)
  for (let i = 0; i < 8; i++) expect(await hook(input('Bash', 'child'), undefined, context)).toEqual({})
})
