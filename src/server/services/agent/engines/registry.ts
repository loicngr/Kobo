import { createClaudeCodeEngine } from './claude-code/engine.js'
import type { AgentEngine } from './types.js'

const ENGINES: Record<string, AgentEngine> = {
  'claude-code': createClaudeCodeEngine(),
}

export function listEngines(): AgentEngine[] {
  return Object.values(ENGINES)
}

export function resolveEngine(id: string): AgentEngine {
  const engine = ENGINES[id]
  if (!engine) throw new Error(`Unknown agent engine '${id}'`)
  return engine
}

/**
 * Test-only seam. Replaces or adds an engine at runtime. Do not use in
 * production — the static `ENGINES` map is the source of truth; this helper
 * exists only so unit tests can inject fakes without wiring a DI container.
 */
export function _registerEngineForTest(engine: AgentEngine): void {
  ENGINES[engine.id] = engine
}
