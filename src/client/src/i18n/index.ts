import { createI18n } from 'vue-i18n'
import de from './de'
import en from './en'
import es from './es'
import fr from './fr'
import it from './it'

export type MessageSchema = typeof en

const STORAGE_KEY = 'kobo:locale'
const SUPPORTED_LOCALES = ['en', 'fr', 'de', 'es', 'it'] as const
type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

function isSupportedLocale(value: string): value is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value)
}

function detectLocale(): SupportedLocale {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored && isSupportedLocale(stored)) {
    return stored
  }

  const browserLang = navigator.language.split('-')[0]
  if (browserLang && isSupportedLocale(browserLang)) {
    localStorage.setItem(STORAGE_KEY, browserLang)
    return browserLang
  }

  localStorage.setItem(STORAGE_KEY, 'en')
  return 'en'
}

const i18n = createI18n<[MessageSchema], SupportedLocale>({
  legacy: false,
  locale: detectLocale(),
  fallbackLocale: 'en',
  messages: {
    en,
    fr,
    de,
    es,
    it,
  },
})

export default i18n
