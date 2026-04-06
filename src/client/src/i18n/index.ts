// src/client/src/i18n/index.ts
import { createI18n } from 'vue-i18n'
import type { WritableComputedRef } from 'vue'
import en from './en'
import fr from './fr'

export type Locale = 'en' | 'fr'
export type MessageSchema = typeof en

const LOCALE_KEY = 'kobo-locale'

function detectLocale(): Locale {
  const saved = localStorage.getItem(LOCALE_KEY) as Locale | null
  if (saved === 'en' || saved === 'fr') return saved
  return navigator.language.startsWith('fr') ? 'fr' : 'en'
}

export const i18n = createI18n<[MessageSchema], Locale>({
  legacy: false,
  locale: detectLocale(),
  fallbackLocale: 'en',
  messages: { en, fr },
})

export function setLocale(locale: Locale): void {
  ;(i18n.global.locale as unknown as WritableComputedRef<Locale>).value = locale
  localStorage.setItem(LOCALE_KEY, locale)
}
