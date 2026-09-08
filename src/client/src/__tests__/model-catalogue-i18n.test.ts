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
  it('lists GPT-6 Astra right after Auto as the newest frontier model', () => {
    const ids = CODEX_MODELS.map((m) => m.id)
    expect(ids[0]).toBe('auto')
    expect(ids[1]).toBe('gpt-6-astra')
    expect(CODEX_MODELS[1]).toMatchObject({
      id: 'gpt-6-astra',
      label: 'GPT-6 Astra',
      i18nLabelKey: 'model.gpt6astra',
      i18nDescriptionKey: 'model.gpt6astraDescription',
    })
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
