import { CLAUDE_MODELS } from '../../../shared/models'

/**
 * Frontend-facing model catalogue — derived from the shared definition.
 * Keeps the same shape as before (value + i18nLabelKey + i18nDescriptionKey)
 * so existing callers don't break, but the source of truth lives in
 * `src/shared/models.ts`. Add new models there.
 */
export const MODEL_OPTION_DEFS = CLAUDE_MODELS.map((m) => ({
  value: m.id,
  i18nLabelKey: m.i18nLabelKey,
  i18nDescriptionKey: m.i18nDescriptionKey,
}))
