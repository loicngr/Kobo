export function getWhipVolumeAvailability(audioNotifications: boolean): {
  disabled: boolean
  hintKey: 'settings.whipVolumeMasterAudioDisabled' | null
} {
  return audioNotifications
    ? { disabled: false, hintKey: null }
    : { disabled: true, hintKey: 'settings.whipVolumeMasterAudioDisabled' }
}
