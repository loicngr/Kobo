import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import de from '../i18n/de'
import en from '../i18n/en'
import es from '../i18n/es'
import fr from '../i18n/fr'
import itLocale from '../i18n/it'

// Guard against vue-i18n message-compilation errors that only surface at
// RUNTIME (not by tsc/lint/unit tests): unescaped `@` (linked-message syntax),
// stray `|` (plural separator), or `{...}` literals. Each such message throws
// when first resolved. We resolve EVERY key in EVERY locale here so a bad
// string fails the suite instead of breaking the UI in the browser.
const locales = { en, fr, de, es, it: itLocale } as const

describe('i18n message compilation', () => {
  for (const [locale, messages] of Object.entries(locales)) {
    it(`compiles every message in '${locale}'`, () => {
      const i18n = createI18n({ legacy: false, locale, messages: { [locale]: messages } })
      const t = i18n.global.t as (key: string) => string
      const failures: string[] = []
      for (const key of Object.keys(messages)) {
        try {
          t(key)
        } catch (err) {
          failures.push(`${key}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      expect(failures).toEqual([])
    })
  }

  it("renders the cron advanced hint with a literal @ (escaped via {'@'})", () => {
    const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
    expect((i18n.global.t as (k: string) => string)('schedule.advancedHint')).toContain('@hourly/@daily')
  })
})
