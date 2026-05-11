/**
 * Per-engine reasoning effort catalogues. Mirrors what each engine declares
 * in its backend `capabilities.effortLevels` (see
 * `src/server/services/agent/engines/{claude-code,codex}/capabilities.ts`).
 *
 * The frontend uses these constants for UI rendering (selectors in CreatePage
 * and WorkspacePage) without having to call `/api/engines`. Labels and
 * descriptions come from i18n: `reasoning.<id>` / `reasoning.<id>Description`.
 *
 * Keep this list in sync with the backend capabilities — both sides need to
 * agree on which effort ids are valid for a given engine. The id `'auto'` is
 * a Kōbō sentinel: the options-builder drops the effort field so the engine
 * picks its default.
 */
export interface EffortDef {
  value: string
  i18nLabelKey: string
  i18nDescriptionKey: string
}

function effort(value: string): EffortDef {
  return {
    value,
    i18nLabelKey: `reasoning.${value}`,
    i18nDescriptionKey: `reasoning.${value}Description`,
  }
}

/** Claude Code: full list including `xhigh` and `max` (SDK accepts arbitrary strings). */
export const CLAUDE_EFFORT_OPTION_DEFS: readonly EffortDef[] = [
  effort('auto'),
  effort('low'),
  effort('medium'),
  effort('high'),
  effort('xhigh'),
  effort('max'),
]

/** Codex: maps to the SDK `ModelReasoningEffort` union (`minimal..xhigh`). */
export const CODEX_EFFORT_OPTION_DEFS: readonly EffortDef[] = [
  effort('auto'),
  effort('minimal'),
  effort('low'),
  effort('medium'),
  effort('high'),
  effort('xhigh'),
]

/** Lookup by engine id. Unknown engines fall back to Claude's list. */
export const EFFORT_OPTION_DEFS_BY_ENGINE: Record<string, readonly EffortDef[]> = {
  'claude-code': CLAUDE_EFFORT_OPTION_DEFS,
  codex: CODEX_EFFORT_OPTION_DEFS,
}
