/**
 * CSV for the engine comparison table.
 *
 * Kept away from the component so the escaping — the part spreadsheets punish
 * you for getting wrong — has a unit test. Comma-separated, CRLF, every cell
 * quoted only when it needs to be, UTF-8 BOM so Excel does not mangle accents.
 */

export interface ComparisonCsvMember {
  workspace: { name: string; engine: string; model: string; status: string; workingBranch: string }
  gitStats: { commitCount: number; filesChanged: number; insertions: number; deletions: number } | null
  tasks: { done: number; total: number }
  activity: {
    sessions: number
    durationMs: number
    userMessages: number
    injectedPrompts: number
    agentMessages: number
    questions: number
    toolCalls: number
    errors: number
    inputTokens: number
    outputTokens: number
  }
}

const HEADER = [
  'workspace',
  'engine',
  'model',
  'status',
  'branch',
  'tasks_done',
  'tasks_total',
  'commits',
  'files_changed',
  'insertions',
  'deletions',
  'agent_messages',
  'user_messages',
  'injected_prompts',
  'questions',
  'tool_calls',
  'errors',
  'input_tokens',
  'output_tokens',
  'sessions',
  'duration_seconds',
]

export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function buildComparisonCsv(members: ComparisonCsvMember[]): string {
  const rows = members.map((m) => {
    const g = m.gitStats
    const a = m.activity
    return [
      m.workspace.name,
      m.workspace.engine,
      m.workspace.model,
      m.workspace.status,
      m.workspace.workingBranch,
      m.tasks.done,
      m.tasks.total,
      // Empty, not zero, when nothing was measured: a different claim.
      g?.commitCount ?? null,
      g?.filesChanged ?? null,
      g?.insertions ?? null,
      g?.deletions ?? null,
      a.agentMessages,
      a.userMessages,
      a.injectedPrompts,
      a.questions,
      a.toolCalls,
      a.errors,
      a.inputTokens,
      a.outputTokens,
      a.sessions,
      Math.round(a.durationMs / 1000),
    ]
      .map(csvCell)
      .join(',')
  })
  return `﻿${[HEADER.join(','), ...rows].join('\r\n')}`
}
