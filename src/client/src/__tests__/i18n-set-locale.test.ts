import { describe, expect, it } from 'vitest'
import i18n, { _setLocaleLoaderForTest, setLocale } from '../i18n'
import en from '../i18n/en'

function deferred() {
  let resolve: () => void = () => {}
  const promise = new Promise<{ default: typeof en }>((r) => {
    resolve = () => r({ default: en })
  })
  return { promise, resolve }
}

describe('setLocale', () => {
  it('lets the last request win, not the last chunk to arrive', async () => {
    // fr → de in quick succession, with the French chunk landing AFTER the
    // German one. Whichever resolved last used to win, leaving the UI in
    // French with 'de' saved.
    const fr = deferred()
    const de = deferred()
    _setLocaleLoaderForTest('fr', () => fr.promise)
    _setLocaleLoaderForTest('de', () => de.promise)

    const first = setLocale('fr')
    const second = setLocale('de')
    de.resolve()
    await second
    fr.resolve()
    await first

    expect((i18n.global.locale as unknown as { value: string }).value).toBe('de')
    expect(document.documentElement.lang).toBe('de')
  })

  it('surfaces a chunk that fails to load instead of swallowing it', async () => {
    _setLocaleLoaderForTest('it', () => Promise.reject(new Error('chunk 404')))

    await expect(setLocale('it')).rejects.toThrow('chunk 404')
  })
})
