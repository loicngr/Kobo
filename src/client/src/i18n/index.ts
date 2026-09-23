import { createI18n } from 'vue-i18n'
import en from './en'

export type MessageSchema = typeof en

const STORAGE_KEY = 'kobo:locale'
const SUPPORTED_LOCALES = ['en', 'fr', 'de', 'es', 'it'] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

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

export const initialLocale: SupportedLocale = detectLocale()

const i18n = createI18n<[MessageSchema], SupportedLocale>({
  legacy: false,
  locale: initialLocale,
  fallbackLocale: 'en',
  // Only English is bundled eagerly — it is the fallback, so it must be there
  // before the first render. The other four are ~450 kB of the entry chunk that
  // any given user never reads; `setLocale` registers theirs on demand.
  //
  // The cast is what lets the generic keep describing all five: the missing
  // ones are filled in at runtime, before anything reads them.
  messages: { en } as Record<SupportedLocale, MessageSchema>,
})

const loadedLocales = new Set<SupportedLocale>(['en'])

// One literal `import()` per locale rather than `import(\`./${locale}.ts\`)`:
// Vite only splits chunks it can see statically, and the template form was
// warning on every start about an import it could not analyse. This table is
// what guarantees `fr-*.js` and friends exist as separate files.
const LOCALE_LOADERS: Record<Exclude<SupportedLocale, 'en'>, () => Promise<{ default: MessageSchema }>> = {
  fr: () => import('./fr'),
  de: () => import('./de'),
  es: () => import('./es'),
  it: () => import('./it'),
}

/** @internal test-only — swap a loader so ordering can be exercised without real chunks. */
export function _setLocaleLoaderForTest(
  locale: Exclude<SupportedLocale, 'en'>,
  loader: () => Promise<{ default: MessageSchema }>,
): void {
  LOCALE_LOADERS[locale] = loader
  loadedLocales.delete(locale)
}

/** Monotonic ticket: only the most recent setLocale call may apply its result. */
let localeRequest = 0

/**
 * Switch the active locale, fetching its messages the first time.
 *
 * Awaiting matters: assigning `locale` before the messages are registered would
 * flash every key as its own name.
 */
export async function setLocale(locale: SupportedLocale): Promise<void> {
  const ticket = ++localeRequest
  if (!loadedLocales.has(locale) && locale !== 'en') {
    const messages = await LOCALE_LOADERS[locale]()
    i18n.global.setLocaleMessage(locale, messages.default)
    loadedLocales.add(locale)
  }
  // fr → de in quick succession: whichever chunk lands LAST used to win, so
  // the UI could end in French with 'de' saved. The last REQUEST wins.
  if (ticket !== localeRequest) return
  ;(i18n.global.locale as unknown as { value: SupportedLocale }).value = locale
  applyDocumentLocale(locale)
}

/**
 * Mirror the active locale onto `<html lang>`. The static attribute in
 * index.html only covers the very first paint; a screen reader needs the real
 * language or it will read French copy with an English voice.
 */
export function applyDocumentLocale(locale: string): void {
  if (typeof document === 'undefined') return
  document.documentElement.lang = locale
}

applyDocumentLocale(initialLocale)

export default i18n
