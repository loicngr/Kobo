import type { QVueGlobals } from 'quasar'

/** Copies text to the clipboard and shows a toast. Catches the non-secure-context
 * case (plain HTTP on a remote LAN device, where navigator.clipboard is undefined). */
export async function copyToClipboard($q: QVueGlobals, t: (key: string) => string, text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    $q.notify({ type: 'positive', message: t('common.copied'), position: 'top', timeout: 1200 })
  } catch {
    $q.notify({ type: 'negative', message: t('common.copyFailed'), position: 'top' })
  }
}
