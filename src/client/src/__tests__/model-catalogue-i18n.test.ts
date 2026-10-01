// Every model surfaced in the create-workspace selector carries i18n keys
// for its label and description. This test pins the catalogue contents and
// makes sure a model can't be added without its five translations.
import { describe, expect, it } from 'vitest'
import { CODEX_MODELS } from '../../../shared/codex-models'
import { CLAUDE_MODELS } from '../../../shared/models'
import de from '../i18n/de'
import en from '../i18n/en'
import es from '../i18n/es'
import fr from '../i18n/fr'
import itLocale from '../i18n/it'

const locales = { en, fr, de, es, it: itLocale } as const

describe('Codex model catalogue', () => {
  it('lists the current GPT-6 models in the CLI order', () => {
    const ids = CODEX_MODELS.map((m) => m.id)
    expect(ids[0]).toBe('auto')
    expect(ids.slice(1, 5)).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'])
  })
})

describe('Claude model catalogue', () => {
  it('offers the current Opus and Sonnet versions while retaining older pinned models', () => {
    const ids = CLAUDE_MODELS.map((m) => m.id)
    expect(ids).toContain('claude-opus-5-5')
    expect(ids).toContain('claude-sonnet-5-5')
    expect(ids).toContain('claude-opus-5')
    expect(ids).toContain('claude-sonnet-5')
  })
})

describe('model i18n keys', () => {
  const models = [...CLAUDE_MODELS, ...CODEX_MODELS]

  it.each(Object.entries(locales))('locale %s translates every model label and description', (_name, messages) => {
    const dictionary = messages as Record<string, string>
    const missing = models.flatMap((m) => [m.i18nLabelKey, m.i18nDescriptionKey]).filter((key) => !dictionary[key])
    expect(missing).toEqual([])
  })
})
