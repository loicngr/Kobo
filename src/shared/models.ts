/**
 * Single source of truth for the Claude Code model catalogue.
 *
 * Imported BOTH by the server (engine capabilities + validation) and by
 * the client (CreatePage / WorkspacePage selectors). No other file should
 * list these IDs — add a new variant here and both sides pick it up.
 *
 * The `label` is a human-readable fallback for any consumer that doesn't
 * go through i18n (e.g. backend logs, `/api/engines` responses). The
 * `i18nLabelKey` / `i18nDescriptionKey` point at translation keys in
 * `src/client/src/i18n/<locale>.ts` for the frontend UI.
 */
export interface ClaudeModel {
  id: string
  label: string
  i18nLabelKey: string
  i18nDescriptionKey: string
}

export const CLAUDE_MODELS: readonly ClaudeModel[] = [
  {
    id: 'auto',
    label: 'Auto',
    i18nLabelKey: 'model.auto',
    i18nDescriptionKey: 'model.autoDescription',
  },
  {
    id: 'claude-opus-4-7',
    label: 'Opus 4.7 (Classic)',
    i18nLabelKey: 'model.opus47Classic',
    i18nDescriptionKey: 'model.opus47ClassicDescription',
  },
  {
    id: 'claude-opus-4-7[1m]',
    label: 'Opus 4.7 (1M)',
    i18nLabelKey: 'model.opus471m',
    i18nDescriptionKey: 'model.opus471mDescription',
  },
  {
    id: 'claude-opus-4-6',
    label: 'Opus 4.6 (Classic)',
    i18nLabelKey: 'model.opusClassic',
    i18nDescriptionKey: 'model.opusClassicDescription',
  },
  {
    id: 'claude-opus-4-6[1m]',
    label: 'Opus 4.6 (1M)',
    i18nLabelKey: 'model.opus1m',
    i18nDescriptionKey: 'model.opus1mDescription',
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6 (Classic)',
    i18nLabelKey: 'model.sonnetClassic',
    i18nDescriptionKey: 'model.sonnetClassicDescription',
  },
  {
    id: 'claude-sonnet-4-6[1m]',
    label: 'Sonnet 4.6 (1M)',
    i18nLabelKey: 'model.sonnet1m',
    i18nDescriptionKey: 'model.sonnet1mDescription',
  },
  {
    id: 'claude-haiku-4-5-20251001',
    label: 'Haiku 4.5',
    i18nLabelKey: 'model.haiku',
    i18nDescriptionKey: 'model.haikuDescription',
  },
] as const
