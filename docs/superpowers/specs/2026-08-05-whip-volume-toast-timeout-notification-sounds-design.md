# Whip volume, toast timeout, and notification sounds design

## Goal

Extend the existing whip pull request with three focused audio and notification improvements:

1. Give the whip its own persisted volume control.
2. Make every currently sticky Quasar toast expire after six seconds.
3. Add `yaaa.mp3` and `mais-laisse-moi-dormir-zebi.mp3` to every notification sound selector.

The implementation must preserve the existing whip interaction, notification-specific volumes, and finite toast durations.

## Whip volume

Add `global.whipVolume: number` to backend and frontend settings. Its default is `1`, displayed as 100%, for both fresh installations and upgrades from settings schema v52.

Settings migration v53 adds the value without changing any existing audio setting. Loading or submitting an invalid value falls back to `1`; valid submitted numbers are clamped to the inclusive range `0..1`, matching the existing audio-volume settings.

Settings → General shows a dedicated slider when the whip feature is enabled. The slider uses the existing volume-control conventions: range `0..1`, step `0.05`, and a percentage label. It participates in the existing settings hydration, dirty-state snapshot, save, and cancel flows.

`WorkspaceWhipControl.vue` continues to use `global.audioNotifications` as the master audio enable switch. It passes `global.whipVolume`, rather than `global.audioNotificationVolume`, to `WhipOverlay`. This separates loudness without introducing a second enable toggle or changing whip physics and dispatch behavior.

## Toast timeout

Add a client-side constant for the fixed sticky-toast replacement duration:

```ts
export const DEFAULT_TOAST_TIMEOUT_MS = 6_000
```

Replace every application toast currently declared with `timeout: 0` by this constant. The duration is not exposed in Settings and cannot be configured. Existing finite durations such as 1.2, 3, 4, 5, or 6 seconds remain unchanged.

This intentionally changes actionable sticky toasts as well as informational sticky toasts: they remain actionable during their six-second lifetime, then disappear automatically. Future intentional sticky toasts must not reintroduce `timeout: 0` as part of this feature.

## Notification sound catalogue

Copy these source files into `src/client/public/sounds/` using their existing filenames:

- `/Users/enzovella/Desktop/leWebFrancais/yaaa.mp3`
- `/Users/enzovella/Desktop/leWebFrancais/mais-laisse-moi-dormir-zebi.mp3`

Register both ids in `NOTIFICATION_SOUNDS`. Because every general and event-specific selector is derived from this shared catalogue, the sounds become available for general, question, workspace-created, agent-error, and PR notification selections without separate per-selector logic.

Add translated label keys for both sounds in English, French, German, Spanish, and Italian. The spoken filenames are proper sound names and may remain recognizable across locales; surrounding UI text continues to use i18n.

The audio files are bundled static assets. Missing or unknown ids retain the existing fallback and inheritance behavior.

## Data flow and ownership

- `settings-service.ts` owns the persisted `whipVolume` default, migration, validation, and update normalization.
- The frontend settings store owns the client fallback.
- `SettingsPage.vue` owns the draft slider value and save/hydration integration.
- `WorkspaceWhipControl.vue` reads the independent value and passes it to the existing overlay.
- `notification-sounds.ts` remains the single catalogue used by every selector and preview action.
- A focused timeout utility exports the six-second constant used by all formerly sticky toast call sites.

No SQLite schema or new dependency is required.

## Error handling

- Invalid, non-finite, or out-of-range persisted `whipVolume` values normalize to `1` during migration/load.
- Submitted values are converted to numbers and clamped to `0..1`, matching existing volume settings.
- Notification sound lookup keeps the existing safe fallback for unknown ids.
- Browser audio playback failures retain the existing best-effort behavior.

## Testing

### Backend settings

- Fresh settings default `whipVolume` to `1`.
- Migration v52 → v53 preserves unrelated settings and adds `whipVolume: 1`.
- Valid values persist, submitted out-of-range values clamp, and malformed values fall back to `1`.

### Frontend settings and whip

- The settings store fallback includes `whipVolume: 1`.
- Settings hydration, dirty-state, save, and cancel include the new value.
- The slider is visible only while the whip feature is enabled and displays the percentage.
- `WorkspaceWhipControl` passes `whipVolume` to the overlay independently of `audioNotificationVolume`.

### Toasts

- Existing tests that assert sticky `timeout: 0` are updated to assert `DEFAULT_TOAST_TIMEOUT_MS`.
- Focused component/store tests cover each formerly sticky notification path where practical.
- A repository check confirms no application `timeout: 0` remains under `src/client/src`.

### Sound catalogue

- Catalogue tests include both filenames and verify they are known ids with correct URLs.
- All five locale files compile with the new label keys.
- A build confirms both MP3 files are copied into the production output.

## Manual smoke test

1. Enable the whip, set its volume below the general notification volume, save, reload, and confirm the distinction persists.
2. Crack the whip and confirm its loudness follows only the whip slider while the global audio toggle remains the master switch.
3. Preview each new sound from the general selector and at least one event-specific selector.
4. Trigger representative toasts that were previously sticky and confirm they disappear after approximately six seconds while their actions remain usable before dismissal.

## Delivery

The work stays on `feature/kobo-whip` and updates PR #23. Automated verification, manual smoke testing, and code review happen before delivery. A new `git push` still requires explicit user confirmation.
