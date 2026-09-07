import { defineBoot } from '#q-app'
import i18n, { applyDocumentLocale, initialLocale, setLocale } from '../i18n'

export default defineBoot(async ({ app }) => {
  app.use(i18n)
  // Only English ships in the entry chunk. Anything else has to be fetched
  // BEFORE the first render, or that render falls back to English (and logs a
  // "key not found" line per string in dev) until the chunk lands. Quasar
  // waits for async boot files before mounting; the chunk is precached by the
  // PWA, so this costs one local read.
  if (initialLocale !== 'en') {
    try {
      await setLocale(initialLocale)
    } catch (err) {
      console.error('[i18n] could not load the saved locale, staying in English:', err)
    }
  }
  // Quasar's own Lang plugin sets `<html lang>` to its default pack ('en-US')
  // when `app.use(Quasar, ...)` runs — which happens before boot files, so it
  // would silently clobber the value the i18n module set at import time.
  // Re-apply here, after Quasar's install, so the real active locale wins.
  applyDocumentLocale(initialLocale)
})
