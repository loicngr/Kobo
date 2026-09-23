// The project ships five locales and the rule is absolute: every user-visible
// string goes through $t() with a key present in ALL of them. Nothing enforced
// that until now — i18n.test.ts checks five accessibility keys and
// i18n-message-compile.test.ts never compares locales against each other.
import { describe, expect, it } from 'vitest'
import de from '../i18n/de'
import en from '../i18n/en'
import es from '../i18n/es'
import fr from '../i18n/fr'
import itLocale from '../i18n/it'

const reference = en as Record<string, string>
const others = { fr, de, es, it: itLocale } as const

describe('i18n locale parity', () => {
  it.each(Object.entries(others))('locale %s has exactly the keys of en', (_name, messages) => {
    const dictionary = messages as Record<string, string>
    const missing = Object.keys(reference).filter((k) => !(k in dictionary))
    const extra = Object.keys(dictionary).filter((k) => !(k in reference))
    expect({ missing, extra }).toEqual({ missing: [], extra: [] })
  })

  it.each(Object.entries({ en, ...others }))('locale %s has no empty message', (_name, messages) => {
    const dictionary = messages as Record<string, string>
    const empty = Object.entries(dictionary)
      .filter(([, value]) => typeof value !== 'string' || value.trim().length === 0)
      .map(([key]) => key)
    expect(empty).toEqual([])
  })
})
