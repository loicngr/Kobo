import { describe, expect, it } from 'vitest'
import de from '../i18n/de'
import en from '../i18n/en'
import es from '../i18n/es'
import fr from '../i18n/fr'
import itLocale from '../i18n/it'

const locales = { en, fr, de, es, it: itLocale }
const accessibilityKeys = [
  'whip.overlayLabel',
  'whip.overlayInstructions',
  'settings.whipShortcutButtonLabel',
  'settings.whipShortcutRecordingLabel',
] as const

describe('whip accessibility translations', () => {
  it.each(Object.entries(locales))('provides every accessible label in %s', (_locale, messages) => {
    const dictionary = messages as Record<string, string>

    for (const key of accessibilityKeys) {
      expect(dictionary[key]).toBeTruthy()
    }
    expect(dictionary['settings.whipShortcutButtonLabel']).toContain('{shortcut}')
  })
})
