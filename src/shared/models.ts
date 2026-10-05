/**
 * Single source of truth for the Claude Code engine's model catalogue.
 *
 * Imported BOTH by the server (engine capabilities + validation) and by
 * the client (CreatePage / WorkspacePage selectors). No other file should
 * list these IDs — add a new variant here and both sides pick it up.
 *
 * The `AgentModel` interface is shared across engine catalogues. The Codex
 * engine has its own catalogue in `./codex-models.ts`.
 *
 * The `label` is a human-readable fallback for any consumer that doesn't
 * go through i18n (e.g. backend logs, `/api/engines` responses). The
 * `i18nLabelKey` / `i18nDescriptionKey` point at translation keys in
 * `src/client/src/i18n/<locale>.ts` for the frontend UI.
 */
export interface AgentModel {
  id: string
  label: string
  i18nLabelKey: string
  i18nDescriptionKey: string
}

/** @deprecated Use AgentModel instead */
export type ClaudeModel = AgentModel

export const CLAUDE_MODELS: readonly AgentModel[] = [
  {
    id: 'auto',
    label: 'Auto',
    i18nLabelKey: 'model.auto',
    i18nDescriptionKey: 'model.autoDescription',
  },
  {
    id: 'claude-fable-5-1',
    label: 'Fable 5.1',
    i18nLabelKey: 'model.fable51',
    i18nDescriptionKey: 'model.fable51Description',
  },
  {
    id: 'claude-mythos-5-1',
    label: 'Mythos 5.1 (Glasswing)',
    i18nLabelKey: 'model.mythos51',
    i18nDescriptionKey: 'model.mythos51Description',
  },
  {
    id: 'claude-mythos-5',
    label: 'Mythos 5 (Glasswing)',
    i18nLabelKey: 'model.mythos5',
    i18nDescriptionKey: 'model.mythos5Description',
  },
  {
    id: 'claude-opus-5-5',
    label: 'Opus 5.5',
    i18nLabelKey: 'model.opus55',
    i18nDescriptionKey: 'model.opus55Description',
  },
  {
    id: 'claude-sonnet-5-5',
    label: 'Sonnet 5.5',
    i18nLabelKey: 'model.sonnet55',
    i18nDescriptionKey: 'model.sonnet55Description',
  },
  {
    id: 'claude-haiku-4-5-20251001',
    label: 'Haiku 4.5',
    i18nLabelKey: 'model.haiku',
    i18nDescriptionKey: 'model.haikuDescription',
  },
  {
    id: 'claude-sonnet-5',
    label: 'Sonnet 5',
    i18nLabelKey: 'model.sonnet5',
    i18nDescriptionKey: 'model.sonnet5Description',
  },
  {
    id: 'claude-opus-5',
    label: 'Opus 5',
    i18nLabelKey: 'model.opus5',
    i18nDescriptionKey: 'model.opus5Description',
  },
  {
    id: 'claude-fable-5',
    label: 'Fable 5',
    i18nLabelKey: 'model.fable5',
    i18nDescriptionKey: 'model.fable5Description',
  },
  {
    id: 'claude-opus-4-8',
    label: 'Opus 4.8',
    i18nLabelKey: 'model.opus48',
    i18nDescriptionKey: 'model.opus48Description',
  },
  {
    id: 'claude-opus-4-7',
    label: 'Opus 4.7',
    i18nLabelKey: 'model.opus47Classic',
    i18nDescriptionKey: 'model.opus47ClassicDescription',
  },
  {
    id: 'claude-opus-4-6',
    label: 'Opus 4.6',
    i18nLabelKey: 'model.opus',
    i18nDescriptionKey: 'model.opusClassicDescription',
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6',
    i18nLabelKey: 'model.sonnet',
    i18nDescriptionKey: 'model.sonnetClassicDescription',
  },
] as const
