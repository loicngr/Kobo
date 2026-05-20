// src/server/services/forge/none.ts
import { type ForgeProvider, ForgeUnavailableError } from './types.js'

/**
 * Provider for projects with no supported forge. Read operations return
 * `null` (no PR is a valid state); write operations throw so the route
 * layer surfaces a clear message instead of attempting a CLI call.
 */
export const noneProvider: ForgeProvider = {
  id: 'none',
  capabilities: { canCreatePr: false, canChangePrBase: false, requestTermShort: 'PR' },
  async isAvailable() {
    return { available: false }
  },
  async getPrStatus() {
    return null
  },
  async createPr() {
    throw new ForgeUnavailableError('This project has no supported forge configured')
  },
  async changePrBase() {
    throw new ForgeUnavailableError('This project has no supported forge configured')
  },
}
