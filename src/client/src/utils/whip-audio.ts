import whipSoundUrl from 'src/assets/audio/fouet-ahh.mp3'

export interface WhipAudioOptions {
  enabled: boolean
  volume: number
  createAudio?: (source: string) => HTMLAudioElement
}

export function playWhipCrack(options: WhipAudioOptions): void {
  const volume = Math.max(0, Math.min(1, options.volume))
  if (!options.enabled || volume === 0) return

  try {
    const audio = options.createAudio?.(whipSoundUrl) ?? new Audio(whipSoundUrl)
    audio.volume = volume
    void audio.play().catch(() => undefined)
  } catch {
    // Browsers can reject audio construction or playback.
  }
}
