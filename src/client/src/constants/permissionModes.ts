/**
 * Per-engine permission mode catalogues. Mirrors backend
 * `capabilities.permissionModes` (see
 * `src/server/services/agent/engines/{claude-code,codex}/capabilities.ts`).
 *
 * Codex does not expose a `canUseTool` equivalent so `'interactive'` is
 * intentionally absent — selecting it would park the workspace in
 * `awaiting-user` forever.
 */
export type AgentPermissionMode = 'plan' | 'bypass' | 'strict' | 'interactive'

export const CLAUDE_PERMISSION_MODES: readonly AgentPermissionMode[] = ['plan', 'bypass', 'strict', 'interactive']

// 'interactive' re-enabled after migrating to the app-server protocol —
// `item/tool/requestUserInput` lets Codex ask the user questions and Kōbō
// can answer them via `resolvePendingUserInput`.
export const CODEX_PERMISSION_MODES: readonly AgentPermissionMode[] = ['plan', 'bypass', 'strict', 'interactive']

/** Lookup by engine id. Unknown engines fall back to Claude's full list. */
export const PERMISSION_MODES_BY_ENGINE: Record<string, readonly AgentPermissionMode[]> = {
  'claude-code': CLAUDE_PERMISSION_MODES,
  codex: CODEX_PERMISSION_MODES,
}
