import type { AgentModel } from './models.js'

/**
 * Codex model catalogue — kept in sync with the official roster published at
 * developers.openai.com/codex/models. The Codex CLI accepts arbitrary strings
 * in `--model`, so power users can still pin a model not listed here by
 * editing the workspace `model` field directly. This list reflects the
 * recommended set surfaced in the create-workspace selector.
 *
 * Auth caveat: `gpt-5.5` is currently only reachable when authenticated via
 * ChatGPT (Plus/Pro/Team/Enterprise). API-key auth is limited to `gpt-5.4`
 * and below.
 */
export const CODEX_MODELS: readonly AgentModel[] = [
  {
    id: 'auto',
    label: 'Auto',
    i18nLabelKey: 'model.auto',
    i18nDescriptionKey: 'model.autoDescription',
  },
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    i18nLabelKey: 'model.gpt55',
    i18nDescriptionKey: 'model.gpt55Description',
  },
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    i18nLabelKey: 'model.gpt54',
    i18nDescriptionKey: 'model.gpt54Description',
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 mini',
    i18nLabelKey: 'model.gpt54mini',
    i18nDescriptionKey: 'model.gpt54miniDescription',
  },
  {
    id: 'gpt-5.3-codex',
    label: 'GPT-5.3 Codex',
    i18nLabelKey: 'model.gpt53codex',
    i18nDescriptionKey: 'model.gpt53codexDescription',
  },
] as const
