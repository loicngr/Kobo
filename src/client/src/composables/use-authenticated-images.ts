import { acquireAuthenticatedImage, type ImageLease } from 'src/services/authenticated-images'
import { onScopeDispose, type Ref, ref, watch } from 'vue'

/** Hydrate only recognized workspace images AFTER markdown sanitization. */
export function useAuthenticatedImages(sanitizedHtml: Ref<string>, errorLabel: () => string): Ref<string> {
  const html = ref('')
  const tokenVersion = ref(0)
  const refresh = () => {
    tokenVersion.value++
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key === 'kobo:network-token' || event.key === null) refresh()
  }
  window.addEventListener('kobo:auth-token-changed', refresh)
  window.addEventListener('storage', onStorage)
  onScopeDispose(() => {
    window.removeEventListener('kobo:auth-token-changed', refresh)
    window.removeEventListener('storage', onStorage)
  })
  watch(
    [sanitizedHtml, tokenVersion],
    ([source], _previous, onCleanup) => {
      let active = true
      const leases: ImageLease[] = []
      // Template contents stay inert until authenticated URLs have been installed.
      const template = document.createElement('template')
      template.innerHTML = source
      for (const img of template.content.querySelectorAll('img')) {
        const path = img.getAttribute('src') ?? ''
        // Never trust user-supplied data attributes, even on unrelated images.
        img.removeAttribute('data-kobo-image-url')
        if (!/^\/api\/workspaces\/[^/]+\/images\/file\?path=/.test(path)) continue
        img.removeAttribute('src')
        const lease = acquireAuthenticatedImage(path)
        leases.push(lease)
        void lease.ready
          .then((url) => {
            if (!active) return
            img.setAttribute('src', url)
            img.setAttribute('data-kobo-image-url', path)
            html.value = template.innerHTML
          })
          .catch(() => {
            if (!active) return
            img.setAttribute('title', errorLabel())
            html.value = template.innerHTML
          })
      }
      html.value = template.innerHTML
      onCleanup(() => {
        active = false
        for (const lease of leases) lease.release()
      })
    },
    { immediate: true },
  )
  return html
}
