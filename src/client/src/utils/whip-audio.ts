export interface WhipAudioOptions {
  enabled: boolean
  volume: number
  createAudioContext?: () => AudioContext
}

export function playWhipCrack(options: WhipAudioOptions): void {
  const volume = Math.max(0, Math.min(1, options.volume))
  if (!options.enabled || volume === 0) return

  try {
    const context = options.createAudioContext?.() ?? new AudioContext()
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    const startAt = context.currentTime
    const sweepEndsAt = startAt + 0.09

    oscillator.type = 'square'
    oscillator.frequency.setValueAtTime(1_800, startAt)
    oscillator.frequency.exponentialRampToValueAtTime(120, sweepEndsAt)
    gain.gain.setValueAtTime(volume, startAt)
    gain.gain.exponentialRampToValueAtTime(0.0001, sweepEndsAt)
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.onended = () => {
      void context.close().catch(() => undefined)
    }
    oscillator.start(startAt)
    oscillator.stop(startAt + 0.1)
  } catch {
    // Browsers can reject audio context construction or playback.
  }
}
