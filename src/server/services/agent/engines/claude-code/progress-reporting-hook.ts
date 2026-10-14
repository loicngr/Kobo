import type { HookCallback } from '@anthropic-ai/claude-agent-sdk'
import { PROGRESS_MAX_RETAINED, PROGRESS_MAX_RUNNING } from '../../../../../shared/progress-bars.js'

interface Reporter {
  producer: string
  sequence: number
  actions: number
  remindedAt: number
}
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}
function progressResponse(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    if (value.length > 16_384) return null
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  const result = object(value)
  if (result?.isError === true) return null
  if (result && object(result.structuredContent)) return object(result.structuredContent)
  const blocks = Array.isArray(value) ? value : result?.content
  if (Array.isArray(blocks)) {
    for (const entry of blocks.slice(0, 4)) {
      const item = object(entry)
      if (item?.type !== 'text' || typeof item.text !== 'string' || item.text.length > 16_384) continue
      try {
        return object(JSON.parse(item.text))
      } catch {
        /* Not a JSON progress response. */
      }
    }
    return null
  }
  return result
}

/** Per-launch advisory only: no timers, tool calls, writes or stop-blocking loops. */
export function createProgressReportingHook(): HookCallback {
  const bars = new Map<string, Reporter>()
  const retired = new Set<string>()
  const reminder = (entries: Array<[string, Reporter]>) => ({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse' as const,
      additionalContext: `Kōbō progress reporting: keep these existing activities current at actual milestones. Next update arguments: ${entries.map(([id, state]) => JSON.stringify({ progress_id: id, sequence: state.sequence + 1 })).join('; ')}. Add step and measured current/total when known; otherwise report step only. Call update_progress_bar after meaningful work, and finish_progress_bar with the known outcome before your final report. Do not invent progress, poll, repeat unchanged updates, recreate dismissed bars or finish background work that is still running.`,
    },
  })
  return async (input) => {
    if (input.hook_event_name !== 'PostToolUse' || retired.size >= PROGRESS_MAX_RETAINED) return {}
    const producer = JSON.stringify([input.session_id, input.agent_id ?? null])
    const tool = input.tool_name
    if (/^mcp__kobo-tasks__(create|update|finish)_progress_bar$/.test(tool)) {
      const bar = progressResponse(input.tool_response)
      if (
        !bar ||
        typeof bar.id !== 'string' ||
        !/^[\w-]{1,200}$/.test(bar.id) ||
        !Number.isSafeInteger(bar.sequence) ||
        (bar.sequence as number) < 0 ||
        !['running', 'succeeded', 'failed', 'interrupted'].includes(bar.status as string)
      )
        return {}
      if (retired.has(bar.id)) return {}
      const existing = bars.get(bar.id)
      if (existing && (bar.sequence as number) < existing.sequence) return {}
      if (bar.dismissed === true || bar.status !== 'running') {
        bars.delete(bar.id)
        // Parallel hook results may arrive after completion; never resurrect a reporter.
        retired.add(bar.id)
        return {}
      }
      // A retry is not progress. A real update may hand reporting to a delegate.
      if (existing && (bar.sequence as number) <= existing.sequence) return {}
      if (!existing && !tool.endsWith('create_progress_bar')) return {}
      if (!existing && bars.size >= PROGRESS_MAX_RUNNING) return {}
      const state = { producer, sequence: bar.sequence as number, actions: 0, remindedAt: Date.now() }
      bars.set(bar.id, state)
      return existing ? {} : reminder([[bar.id, state]])
    }
    if (tool.startsWith('mcp__kobo-tasks__') && tool.endsWith('progress_bars')) return {}
    const due: Array<[string, Reporter]> = []
    for (const [id, state] of bars) {
      if (state.producer !== producer) continue
      state.actions++
      if (state.actions >= 8 && Date.now() - state.remindedAt >= 60_000 && due.length < 3) {
        state.actions = 0
        state.remindedAt = Date.now()
        due.push([id, state])
      }
    }
    return due.length ? reminder(due) : {}
  }
}
