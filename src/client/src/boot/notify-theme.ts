import { Notify } from 'quasar'
import { defineBoot } from '#q-app'

/**
 * Kōbō's semantic tokens are LIGHT (--kobo-danger is #f87171), while Quasar
 * paints notification text in white by default. White on #f87171 measures
 * 2.77:1 — far below AA. A dark ink on the same fill measures 6.17:1, so every
 * filled type carries `kobo-ink` instead.
 *
 * `info` is the exception: --kobo-accent filled with --kobo-accent-fg white
 * measures only 4.32:1, below the 4.5:1 threshold for normal text. It therefore
 * stays on the neutral surface (13.84:1) rather than shipping a pairing that
 * DESIGN.md documents but that does not clear AA.
 */
export default defineBoot(() => {
  Notify.registerType('negative', {
    color: 'kobo-danger',
    textColor: 'kobo-ink',
    icon: 'error',
    position: 'top',
  })
  Notify.registerType('positive', {
    color: 'kobo-success',
    textColor: 'kobo-ink',
    icon: 'check_circle',
    position: 'top',
  })
  Notify.registerType('warning', {
    color: 'kobo-warning',
    textColor: 'kobo-ink',
    icon: 'warning',
    position: 'top',
  })
  Notify.registerType('info', {
    color: 'kobo-surface',
    textColor: 'kobo-1',
    icon: 'info',
    position: 'top',
  })
})
