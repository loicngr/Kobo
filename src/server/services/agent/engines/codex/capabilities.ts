import { CODEX_MODELS } from '../../../../../shared/codex-models.js'
import type { EngineCapabilities } from '../types.js'

export const CODEX_CAPABILITIES: EngineCapabilities = {
  models: CODEX_MODELS.map((m) => ({ id: m.id, label: m.label })),
  effortLevels: [
    { id: 'auto', label: 'Auto' },
    { id: 'minimal', label: 'Minimal' },
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
    { id: 'xhigh', label: 'Extra High' },
  ],
  permissionModes: ['plan', 'bypass', 'strict', 'interactive'],
  supportsResume: true,
  supportsMcp: true,
  supportsSkills: false,
  supportsSubagents: true,
  supportsQuotaStatus: true,
}
