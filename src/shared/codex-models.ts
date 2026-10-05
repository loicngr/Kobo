import type { AgentModel } from './models.js'

/**
 * Codex model catalogue — kept in sync with the official roster published at
 * developers.openai.com/codex/models. The Codex CLI accepts arbitrary strings
 * in `--model`, so power users can still pin a model not listed here by
 * editing the workspace `model` field directly. This list reflects the
 * recommended set surfaced in the create-workspace selector.
 *
 * Availability can vary by account and authentication method. The CLI owns
 * the actual model resolution; the catalogue only offers named choices.
 */
export const CODEX_MODELS: readonly AgentModel[] = [
  {
    id: 'auto',
    label: 'Auto',
    i18nLabelKey: 'model.auto',
    i18nDescriptionKey: 'model.autoDescription',
  },
  {
    id: 'gpt-6.1-sol',
    label: 'GPT-6.1 Sol',
    i18nLabelKey: 'model.gpt61sol',
    i18nDescriptionKey: 'model.gpt61solDescription',
  },
  {
    id: 'gpt-6-astra',
    label: 'GPT-6 Astra',
    i18nLabelKey: 'model.gpt6astra',
    i18nDescriptionKey: 'model.gpt6astraDescription',
  },
  {
    id: 'gpt-6-sol',
    label: 'GPT-6 Sol',
    i18nLabelKey: 'model.gpt6sol',
    i18nDescriptionKey: 'model.gpt6solDescription',
  },
  {
    id: 'gpt-6-luna',
    label: 'GPT-6 Luna',
    i18nLabelKey: 'model.gpt6luna',
    i18nDescriptionKey: 'model.gpt6lunaDescription',
  },
  {
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    i18nLabelKey: 'model.gpt56sol',
    i18nDescriptionKey: 'model.gpt56solDescription',
  },
  {
    id: 'gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    i18nLabelKey: 'model.gpt56terra',
    i18nDescriptionKey: 'model.gpt56terraDescription',
  },
  {
    id: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    i18nLabelKey: 'model.gpt56luna',
    i18nDescriptionKey: 'model.gpt56lunaDescription',
  },
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    i18nLabelKey: 'model.gpt55',
    i18nDescriptionKey: 'model.gpt55Description',
  },
] as const
