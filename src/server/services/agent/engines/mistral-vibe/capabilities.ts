import { MISTRAL_MODELS } from '../../../../../shared/mistral-models.js'
import type { EngineCapabilities } from '../types.js'

export const MISTRAL_CAPABILITIES: EngineCapabilities = {
  models: MISTRAL_MODELS.map((model) => ({ id: model.id, label: model.label })),
  effortLevels: [{ id: 'auto', label: 'Auto' }],
  permissionModes: ['interactive', 'strict', 'bypass'],
  supportsResume: true,
  supportsMcp: true,
  supportsLiveSteering: false,
  supportsReadOnly: false,
  supportsSkills: false,
  supportsSubagents: false,
  supportsQuotaStatus: false,
}
