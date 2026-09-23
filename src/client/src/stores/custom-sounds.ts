import { defineStore } from 'pinia'
import { ApiError, apiFetch } from 'src/utils/api'
import {
  customSoundApiUrl,
  isKnownSoundId,
  setCustomSoundUrl,
  setKnownCustomSoundIds,
} from 'src/utils/notification-sounds'

/**
 * An `<audio>` element is not routed through the wrapped `window.fetch`, so it
 * sends no `X-Kobo-Token` and the API URL answers 401 over LAN access or behind
 * a reverse proxy. Fetching the bytes here and handing out a blob URL is the
 * same fix `services/authenticated-images.ts` applies to workspace images.
 */
const blobUrls = new Map<string, string>()

function release(reference: string): void {
  const url = blobUrls.get(reference)
  if (url) URL.revokeObjectURL(url)
  blobUrls.delete(reference)
}

async function preload(reference: string): Promise<void> {
  if (blobUrls.has(reference)) return
  try {
    const response = await fetch(customSoundApiUrl(reference))
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const url = URL.createObjectURL(await response.blob())
    // The catalogue may have changed while the bytes were downloading: the
    // sound may have been deleted, or another preload may have won the race.
    if (blobUrls.has(reference) || !isKnownSoundId(reference)) {
      URL.revokeObjectURL(url)
      return
    }
    blobUrls.set(reference, url)
    setCustomSoundUrl(reference, url)
  } catch (error) {
    // The API URL stays in place: it still works on plain loopback.
    console.error('[custom-sounds store] preload failed:', error)
  }
}

/** One sound imported by the user, as returned by `/api/sounds`. */
export interface CustomSound {
  id: string
  name: string
  extension: string
  size: number
  createdAt: string
  reference: string
}

interface CustomSoundsState {
  sounds: CustomSound[]
  loaded: boolean
  busy: boolean
}

export const useCustomSoundsStore = defineStore('customSounds', {
  state: (): CustomSoundsState => ({ sounds: [], loaded: false, busy: false }),

  getters: {
    /** Select options, using the imported filename as the visible label. */
    options: (state) => state.sounds.map((sound) => ({ label: sound.name, value: sound.reference })),
  },

  actions: {
    /** Keeps the resolver in sync so a deleted sound stops resolving at once. */
    apply(sounds: CustomSound[]) {
      this.sounds = sounds
      setKnownCustomSoundIds(sounds.map((sound) => sound.reference))
      for (const reference of blobUrls.keys()) {
        if (!sounds.some((sound) => sound.reference === reference)) release(reference)
      }
      for (const sound of sounds) void preload(sound.reference)
    },

    async fetchSounds(): Promise<void> {
      if (this.busy) return
      this.busy = true
      try {
        this.apply((await apiFetch<{ sounds: CustomSound[] }>('/api/sounds')).sounds)
        this.loaded = true
      } catch (error) {
        console.error('[custom-sounds store] fetchSounds failed:', error)
      } finally {
        this.busy = false
      }
    },

    /** Rejects with an `ApiError` whose `code` the caller translates. */
    async uploadSound(file: File): Promise<CustomSound> {
      const body = new FormData()
      body.append('sound', file)
      this.busy = true
      try {
        // No deadline: a 2 MiB upload over a slow LAN link must not be cut off.
        const sound = await apiFetch<CustomSound>('/api/sounds', { method: 'POST', body, timeoutMs: 0 })
        this.apply([...this.sounds, sound])
        return sound
      } finally {
        this.busy = false
      }
    },

    async removeSound(id: string): Promise<void> {
      this.busy = true
      try {
        await apiFetch<null>(`/api/sounds/${encodeURIComponent(id)}`, { method: 'DELETE' })
      } catch (error) {
        // A 404 means it is already gone: dropping it matches the server. Any
        // other failure leaves the file on disk, still counting against the
        // limit, so the list must keep showing it beside the error message.
        if (!(error instanceof ApiError) || error.status !== 404) throw error
      } finally {
        this.busy = false
      }
      this.apply(this.sounds.filter((sound) => sound.id !== id))
    },
  },
})
