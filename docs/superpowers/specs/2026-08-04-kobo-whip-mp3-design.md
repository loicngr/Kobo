# Kōbō Whip MP3 Sound Design

## Goal

Replace the synthesized whip crack with the user-provided
`fouet-ahh.mp3` recording while preserving Kōbō's audio preferences and
support for repeated cracks.

## Asset

- Source file: `/Users/enzovella/Desktop/leWebFrancais/fouet-ahh.mp3`
- Repository destination:
  `src/client/src/assets/audio/fouet-ahh.mp3`
- The file is an MPEG Layer III recording, 44.1 kHz stereo, 128 kbps, and
  approximately 19 KB.
- Vite imports the file so production builds receive a fingerprinted URL.

## Playback

`playWhipCrack` keeps its existing public API. When sound is enabled, it creates
an `HTMLAudioElement` from the imported asset URL, clamps and applies the
configured volume, and starts playback. A distinct element is used per crack so
rapid cracks may overlap.

The MP3 fully replaces the oscillator-based Web Audio synthesis. There is no
synthesized fallback. A rejected `play()` promise is swallowed because browser
autoplay policy or a transient audio-device failure must not interrupt the whip
interaction or message dispatch.

When audio notifications are disabled, no audio element is created.

## Testing

Component behavior remains unchanged. Unit tests for `playWhipCrack` verify:

- disabled audio creates no player;
- the imported MP3 URL is used;
- volume is clamped to the supported range;
- each crack creates and starts a separate player;
- rejected playback does not surface as an unhandled failure.

The client build verifies that Vite bundles and fingerprints the MP3 asset.

## Non-goals

- editing or normalizing the supplied recording;
- retaining the synthesized crack as a fallback;
- adding a user-selectable sound library;
- changing the existing audio settings UI.
