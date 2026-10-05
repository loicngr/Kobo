import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import type { MemoryContextState, MemoryEngineId } from '../../../shared/memory'
import de from '../i18n/de'
import en from '../i18n/en'
import es from '../i18n/es'
import fr from '../i18n/fr'
import itLocale from '../i18n/it'

const engines: Record<MemoryEngineId, string> = { 'claude-code': 'Claude Code', codex: 'Codex' }
const states: Record<MemoryContextState, true> = {
  prepared: true,
  submitted: true,
  initialized: true,
  failed: true,
  unknown: true,
}

describe('memory labels', () => {
  it.each(Object.entries({ en, fr, de, es, it: itLocale }))(
    'translates every engine and context state in %s',
    (locale, messages) => {
      const { t, te } = createI18n({ legacy: false, locale, messages: { [locale]: messages } }).global
      for (const [engine, label] of Object.entries(engines)) expect(t(`memory.engine.${engine}`)).toBe(label)
      for (const state of Object.keys(states)) expect(te(`memory.context.state.${state}`)).toBe(true)
      expect(te('memory.panel.openDialog')).toBe(true)
      expect(te('memory.panel.closeDialog')).toBe(true)
      for (const section of ['contexts', 'entries', 'proposals', 'operations'])
        expect(te(`memory.panel.${section}Hint`)).toBe(true)
    },
  )
})
