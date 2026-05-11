import { CLAUDE_MODELS } from '../../../../../shared/models.js'
import type { EngineCapabilities } from '../types.js'

export const CLAUDE_CODE_CAPABILITIES: EngineCapabilities = {
  // Models come from the shared catalogue in `src/shared/models.ts` — the
  // ONE source of truth, consumed both by this file (for /api/engines and
  // for validation in POST /api/workspaces) and by the frontend selectors.
  models: CLAUDE_MODELS.map((m) => ({ id: m.id, label: m.label })),
  // Reasoning effort values passed verbatim via `options.extraArgs.effort` to
  // the Claude SDK. `auto` is a Kōbō sentinel meaning "let the SDK pick its
  // default" (we omit the arg).
  effortLevels: [
    { id: 'auto', label: 'Auto' },
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
    { id: 'xhigh', label: 'Extra High' },
    { id: 'max', label: 'Max' },
  ],
  permissionModes: ['plan', 'bypass', 'strict', 'interactive'],
  supportsResume: true,
  supportsMcp: true,
  supportsSkills: true,
  supportsSubagents: true,
  supportsQuotaStatus: true,
}
