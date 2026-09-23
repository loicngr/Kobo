// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { useAuthenticatedImages } from '../composables/use-authenticated-images'
import { acquireAuthenticatedImage, clearAuthenticatedImages } from '../services/authenticated-images'
import { renderChatMarkdown } from '../utils/render-chat-markdown'

const path = '/api/workspaces/a/images/file?path=images%2Fa.png'

afterEach(() => {
  clearAuthenticatedImages()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('authenticated workspace images', () => {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: () => 'blob:stub' })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: () => {} })
  it('shares one authenticated fetch and retains the blob for a lightbox after its preview releases', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => new Blob(['image']) }))
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:owned')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const preview = acquireAuthenticatedImage(path)
    const lightbox = acquireAuthenticatedImage(path)
    expect(await preview.ready).toBe('blob:owned')
    expect(await lightbox.ready).toBe('blob:owned')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(path, { signal: expect.any(AbortSignal) })
    preview.release()
    expect(revoke).not.toHaveBeenCalled()
    lightbox.release()
    lightbox.release()
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:owned')
  })

  it('does not publish a stale image after its consumer changes workspace', async () => {
    let resolveBlob!: (blob: Blob) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        blob: () =>
          new Promise<Blob>((resolve) => {
            resolveBlob = resolve
          }),
      })),
    )
    const create = vi.spyOn(URL, 'createObjectURL')
    const scope = effectScope()
    const source = ref(`<img src="${path}">`)
    const html = scope.run(() => useAuthenticatedImages(source, () => 'failed'))!
    expect(html.value).not.toContain('src=')
    await Promise.resolve()
    source.value = '<p>Workspace B</p>'
    await nextTick()
    resolveBlob(new Blob(['old']))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(html.value).toBe('<p>Workspace B</p>')
    expect(create).not.toHaveBeenCalled()
    scope.stop()
  })

  it('injects owned blob URLs only after sanitization and discards forged image attributes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, blob: async () => new Blob(['image']) })),
    )
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:owned')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const sanitized = renderChatMarkdown(
      `<img src="blob:untrusted"><img src="${path}"><img src="https://example.com/x" data-kobo-image-url="${path}">`,
    )
    expect(sanitized).not.toContain('src="blob:untrusted"')
    const scope = effectScope()
    const html = scope.run(() => useAuthenticatedImages(ref(sanitized), () => 'failed'))!
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(html.value).toContain('src="blob:owned"')
    expect(html.value.match(/data-kobo-image-url/g)).toHaveLength(1)
    scope.stop()
  })
})
