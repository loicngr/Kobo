import { describe, expect, it } from 'vitest'
import { getWhipVolumeAvailability } from '../utils/whip-settings'

describe('getWhipVolumeAvailability', () => {
  it('disables whip volume and exposes a hint when master audio is off', () => {
    expect(getWhipVolumeAvailability(false)).toEqual({
      disabled: true,
      hintKey: 'settings.whipVolumeMasterAudioDisabled',
    })
  })

  it('enables whip volume without a warning when master audio is on', () => {
    expect(getWhipVolumeAvailability(true)).toEqual({ disabled: false, hintKey: null })
  })
})
