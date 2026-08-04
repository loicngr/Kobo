import { describe, expect, it, vi } from 'vitest'
import { playWhipCrack } from '../utils/whip-audio'

function createFakeAudio() {
  const players: Array<{ volume: number; play: ReturnType<typeof vi.fn> }> = []
  const createAudio = vi.fn((_source: string) => {
    const player = {
      volume: 0,
      play: vi.fn(async () => undefined),
    }
    players.push(player)
    return player as unknown as HTMLAudioElement
  })

  return { createAudio, players }
}

describe('whip audio', () => {
  it.each([
    { enabled: false, volume: 1 },
    { enabled: true, volume: 0 },
  ])('does not create a player for $enabled/$volume', ({ enabled, volume }) => {
    const { createAudio } = createFakeAudio()

    playWhipCrack({ enabled, volume, createAudio })

    expect(createAudio).not.toHaveBeenCalled()
  })

  it('plays one recorded crack per call with clamped volume', () => {
    const { createAudio, players } = createFakeAudio()

    playWhipCrack({ enabled: true, volume: 2, createAudio })
    playWhipCrack({ enabled: true, volume: 0.4, createAudio })

    expect(createAudio).toHaveBeenCalledTimes(2)
    expect(createAudio).toHaveBeenNthCalledWith(1, expect.stringContaining('fouet-ahh.mp3'))
    expect(createAudio).toHaveBeenNthCalledWith(2, expect.stringContaining('fouet-ahh.mp3'))
    expect(players.map(({ volume }) => volume)).toEqual([1, 0.4])
    expect(players[0]?.play).toHaveBeenCalledOnce()
    expect(players[1]?.play).toHaveBeenCalledOnce()
  })

  it('ignores playback rejection', async () => {
    const createAudio = vi.fn(
      () =>
        ({
          volume: 0,
          play: vi.fn(async () => {
            throw new Error('playback blocked')
          }),
        }) as unknown as HTMLAudioElement,
    )

    expect(() => playWhipCrack({ enabled: true, volume: 1, createAudio })).not.toThrow()
    await Promise.resolve()
  })
})
