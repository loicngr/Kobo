import type { AgentModel } from './models.js'

/** Static fallback only; contextual native ACP discovery supplies explicit aliases. */
export const MISTRAL_MODELS: readonly AgentModel[] = [
  {
    id: 'auto',
    label: 'Auto',
    i18nLabelKey: 'model.auto',
    i18nDescriptionKey: 'model.mistralAutoDescription',
  },
] as const
