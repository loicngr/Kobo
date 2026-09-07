import { describe, expect, it } from 'vitest'
import { buildComparisonCsv, csvCell } from '../utils/comparison-csv'

describe('csvCell', () => {
  it('leaves plain values alone and quotes anything a spreadsheet would misread', () => {
    expect(csvCell('opus')).toBe('opus')
    expect(csvCell(42)).toBe('42')
    expect(csvCell('a, b')).toBe('"a, b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('two\nlines')).toBe('"two\nlines"')
    expect(csvCell(null)).toBe('')
  })
})

describe('buildComparisonCsv', () => {
  const member = {
    workspace: {
      name: 'task (Codex)',
      engine: 'codex',
      model: 'gpt',
      status: 'idle',
      workingBranch: 'feature/x-codex',
    },
    gitStats: { commitCount: 3, filesChanged: 5, insertions: 40, deletions: 2 },
    tasks: { done: 2, total: 5 },
    activity: {
      sessions: 2,
      durationMs: 65_000,
      userMessages: 1,
      injectedPrompts: 3,
      agentMessages: 7,
      questions: 1,
      toolCalls: 12,
      errors: 0,
      inputTokens: 1000,
      outputTokens: 100,
    },
  }

  it('writes one header row and one row per member, in the panel order', () => {
    const csv = buildComparisonCsv([member, { ...member, workspace: { ...member.workspace, name: 'task (Claude)' } }])
    const lines = csv.replace(/^﻿/, '').split('\r\n')

    expect(lines).toHaveLength(3)
    expect(lines[0]?.startsWith('workspace,engine,model,status,branch,tasks_done,tasks_total,commits')).toBe(true)
    expect(lines[1]?.startsWith('task (Codex),codex,gpt,idle,feature/x-codex,2,5,3,5,40,2,')).toBe(true)
    expect(lines[2]?.startsWith('task (Claude),')).toBe(true)
  })

  it('leaves git columns empty, not zero, when nothing was measured', () => {
    const csv = buildComparisonCsv([{ ...member, gitStats: null }])
    const row = csv.split('\r\n')[1] ?? ''

    expect(row).toContain(',2,5,,,,,')
  })

  it('starts with a UTF-8 BOM so Excel reads accents and the engine names correctly', () => {
    expect(buildComparisonCsv([member]).charCodeAt(0)).toBe(0xfeff)
  })

  it('exports the duration in seconds, a number a spreadsheet can sum', () => {
    const row = buildComparisonCsv([member]).split('\r\n')[1] ?? ''
    expect(row.endsWith(',2,65')).toBe(true)
  })
})
