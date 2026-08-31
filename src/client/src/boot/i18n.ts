import { defineBoot } from '#q-app'
import i18n, { applyDocumentLocale, initialLocale } from '../i18n'

export default defineBoot(({ app }) => {
  app.use(i18n)
  // Quasar's own Lang plugin sets `<html lang>` to its default pack ('en-US')
  // when `app.use(Quasar, ...)` runs — which happens before boot files, so it
  // would silently clobber the value the i18n module set at import time.
  // Re-apply here, after Quasar's install, so the real active locale wins.
  applyDocumentLocale(initialLocale)
})
