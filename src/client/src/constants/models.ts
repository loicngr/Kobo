import { CODEX_MODELS } from '../../../shared/codex-models'
import type { AgentModel } from '../../../shared/models'
import { CLAUDE_MODELS } from '../../../shared/models'

/**
 * Frontend-facing model catalogues — derived from the shared definitions.
 * Each engine has its own list. Keys carry i18n labels/descriptions; the
 * source of truth lives in `src/shared/{models,codex-models}.ts`.
 */
function toDefs(models: readonly AgentModel[]) {
  return models.map((m) => ({
    value: m.id,
    i18nLabelKey: m.i18nLabelKey,
    i18nDescriptionKey: m.i18nDescriptionKey,
  }))
}

export const MODEL_OPTION_DEFS = toDefs(CLAUDE_MODELS)
export const CODEX_MODEL_OPTION_DEFS = toDefs(CODEX_MODELS)

/** Lookup table by engine id — kept here so CreatePage doesn't hardcode the mapping. */
export const MODEL_OPTION_DEFS_BY_ENGINE: Record<string, ReturnType<typeof toDefs>> = {
  'claude-code': MODEL_OPTION_DEFS,
  codex: CODEX_MODEL_OPTION_DEFS,
}
