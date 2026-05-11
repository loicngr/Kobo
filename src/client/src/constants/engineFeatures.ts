/**
 * Per-engine boolean capability flags. Mirrors the backend
 * `EngineCapabilities` `supports*` fields (see
 * `src/server/services/agent/engines/{claude-code,codex}/capabilities.ts`).
 *
 * Used by frontend components to gate UI affordances without needing to
 * fetch `/api/engines` (which WorkspacePage and the main layout don't do).
 * Keep these constants in sync with backend capabilities — both sides must
 * agree on what each engine can surface.
 *
 * Unknown engine ids fall back to the Claude defaults (most permissive).
 */

export const SUPPORTS_SUBAGENTS_BY_ENGINE: Record<string, boolean> = {
  'claude-code': true,
  // Migrated from `@openai/codex-sdk` to `codex app-server` JSON-RPC: the
  // protocol exposes sub-agent items as part of the standard event stream,
  // so Kōbō can render them like Claude's Task tool subagents.
  codex: true,
}

export function supportsSubagents(engineId: string | undefined): boolean {
  if (!engineId) return true // unknown → don't hide UI affordances
  return SUPPORTS_SUBAGENTS_BY_ENGINE[engineId] ?? true
}

export const SUPPORTS_QUOTA_STATUS_BY_ENGINE: Record<string, boolean> = {
  'claude-code': true,
  // App-server emits `thread/tokenUsage/updated` with structured per-turn and
  // total token counts → QuotaFooter can render real data.
  codex: true,
}

export function supportsQuotaStatus(engineId: string | undefined): boolean {
  if (!engineId) return true
  return SUPPORTS_QUOTA_STATUS_BY_ENGINE[engineId] ?? true
}
