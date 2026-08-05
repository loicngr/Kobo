# Whip Feature Toggle Design

## Goal

Make the workspace whip an explicit opt-in feature. The whip must be disabled
for fresh installations and for existing installations after upgrade, and a
user must be able to enable or disable it from Kōbō's global settings.

## Scope

- Add one global boolean setting named `whipEnabled`.
- Default the setting to `false` for fresh and upgraded settings files.
- Add an "Enable whip" toggle to the General tab in Settings.
- Hide the whip control completely while the setting is disabled.
- Close and dispose an already-open whip overlay immediately when the setting
  becomes disabled.
- Preserve the existing whip sound and message behavior while enabled.

Per-project overrides, environment variables, and separate sound preferences
are out of scope.

## Architecture and Data Flow

### Settings persistence

`GlobalSettings` gains a required `whipEnabled: boolean` field in both the
backend and frontend settings types. `defaultSettings()` and the frontend
Pinia fallback state set it to `false`.

An append-only settings migration increments the settings schema version and
sets `global.whipEnabled = false` whenever the stored value is not a boolean.
The key is added to the global settings allowlist so the existing global
settings endpoint persists updates through the normal settings flow.

### Settings interface

The General tab displays a global toggle labelled "Enable whip" near the
other workspace interface controls. The page loads its local form ref from
`store.global.whipEnabled ?? false` and includes the value in both save paths
used by the page.

All user-visible labels and help text use vue-i18n keys and are translated in
English, French, German, Spanish, and Italian.

### Workspace control

`WorkspaceWhipControl` reads `settingsStore.global.whipEnabled`. Its button is
eligible for display only when the feature is enabled and the existing
running-session conditions are satisfied.

A watcher reacts to `whipEnabled` changing to `false` and calls the existing
`deactivate()` cleanup. This removes the overlay, disposes the coordinator,
and clears the soft-interrupt timer. Re-enabling the feature restores the
button when the workspace already satisfies its existing visibility rules;
it does not automatically open the overlay.

## Error Handling

No new network path is introduced. Settings save failures continue through
the Settings page's existing error handling. Missing or legacy values are
treated as `false`, so failure to load the new field cannot accidentally
enable the feature.

## Testing

- Backend settings tests verify fresh defaults and old-settings migration both
  produce `whipEnabled: false`, and that a saved boolean is preserved.
- Frontend settings tests verify the Pinia fallback defaults to `false` and
  accepts the persisted value.
- `WorkspaceWhipControl` tests verify the button is hidden by default, appears
  when enabled under the existing session conditions, and closes/disposes an
  active overlay when the setting is disabled.
- Existing whip coordinator and Codex lifecycle tests remain unchanged and
  must continue to pass.

## Acceptance Criteria

1. A user who has never changed the setting cannot see or activate the whip.
2. Enabling the global toggle makes the whip available on eligible running
   workspaces without restarting Kōbō.
3. Disabling the toggle hides the button and immediately closes an open whip.
4. The setting survives a page reload and a backend restart.
5. Existing installations migrate with the feature disabled.
