# Whip keyboard shortcut design

## Goal

Replace the workspace whip button with a configurable global keyboard shortcut. The shortcut opens and closes the existing interactive whip overlay without changing its physics, sound, crack dispatch, cooldown, or agent-session behavior.

## User-visible behavior

- The whip remains an opt-in feature controlled by `global.whipEnabled` and disabled by default.
- When the feature is enabled, the workspace toolbar no longer shows a Whip button.
- Pressing the configured shortcut opens the whip overlay when the selected workspace has a running agent and a live session id.
- Pressing the shortcut again closes an already-open overlay, including during the existing soft-interrupt grace period when the agent may briefly report as stopped.
- Repeated `keydown` events generated while holding the keys are ignored.
- The shortcut remains active while an input, textarea, contenteditable element, or code editor has focus.
- A shortcut made from a single non-modifier key is allowed. When it matches, its normal browser or editor action is prevented.
- If the feature is disabled or the workspace is ineligible, Kōbō does not consume the keyboard event.
- Disabling the feature while the overlay is open keeps the existing behavior: the overlay closes and its coordinator and timers are disposed.

## Setting and persistence

Add `global.whipShortcut: string` to backend and frontend settings types.

The canonical default is:

```text
mod+shift+x
```

`mod` maps to Meta/Command on macOS and Control on Windows and Linux. The persisted representation is lowercase and uses `+`-separated canonical tokens in modifier order, followed by exactly one non-modifier key.

Add append-only settings migration v52. Existing settings receive `mod+shift+x`. Fresh installations expose the same default. Loading or updating a malformed value normalizes it back to the default, so a corrupt settings file cannot leave the feature without a usable shortcut.

## Shortcut utility

Create a focused frontend utility responsible for:

1. Capturing and normalizing a `KeyboardEvent` into the persisted representation.
2. Matching a runtime `KeyboardEvent` against a persisted shortcut.
3. Formatting the shortcut for display as `⌘⇧X` on macOS and `Ctrl+Shift+X` on Windows and Linux.
4. Rejecting modifier-only input and known browser-close shortcuts.

Supported modifiers are `mod`, `ctrl`, `meta`, `alt`, and `shift`. During capture, the platform's primary modifier is persisted as `mod`; an explicitly used non-primary Control or Meta key keeps its `ctrl` or `meta` token. The final key is derived consistently from `event.key`, normalized to lowercase for matching, while the formatter renders a readable uppercase label where appropriate.

The following combinations are explicitly reserved and rejected:

- `mod+w`
- `mod+shift+w`

`Escape` cancels shortcut capture rather than becoming a shortcut. Modifier-only key presses keep capture active. Other single non-modifier keys are accepted as requested.

## Settings UI

In Settings → General, keep the existing Enable whip toggle and add a shortcut recorder beside it.

- Clicking the recorder enters capture mode.
- The next valid key combination replaces the local draft value.
- `Escape` exits capture mode without changing the value.
- A reset action restores `mod+shift+x`.
- Reserved combinations show a translated validation message and keep capture active.
- The shortcut participates in the existing dirty-state snapshot, hydration, save, and cancel flows.
- All new labels, hints, capture instructions, reset text, and validation messages are translated in `en`, `fr`, `de`, `es`, and `it`.

## Workspace integration

`WorkspaceWhipControl.vue` remains the owner of activation, coordinator creation, crack queuing, shutdown, and eligibility checks. Its button markup is removed and it registers a `window` `keydown` listener for the lifetime of the component.

On a non-repeated matching event:

1. Re-evaluate `whipEnabled`; if disabled, return without calling `preventDefault()`.
2. If the overlay is already active, call `preventDefault()` and deactivate it regardless of the transient running state.
3. If the overlay is closed, require both `running` and `sessionId`; otherwise return without calling `preventDefault()`.
4. For an eligible closed overlay, call `preventDefault()` and activate it.

The listener is removed during unmount. Existing watchers continue to close the overlay when the workspace, session, running state, or feature toggle changes.

## Error handling

- Invalid persisted or submitted shortcuts fall back to the default on the backend.
- Reserved shortcuts are blocked before save in the UI and cannot be matched by the runtime utility.
- An ineligible workspace is a no-op, not an error and not a notification.
- Existing crack dispatch and notification error handling remain unchanged.

## Testing

### Backend

- Fresh settings default to `mod+shift+x`.
- Migration v51 → v52 preserves unrelated values and adds the default.
- Valid custom shortcuts persist.
- Malformed stored and submitted values normalize to the default.

### Frontend utility

- Normalization and matching cover modifier combinations and single keys.
- `mod` maps correctly on macOS and Windows/Linux.
- Formatting produces platform-appropriate labels.
- Modifier-only, `Escape`, and reserved close-window combinations are rejected or cancelled as specified.

### Components and store

- No Whip button is rendered.
- A valid shortcut opens and closes the overlay.
- The shortcut works while a text input is focused.
- Repeated keydown events are ignored.
- Ineligible or disabled workspaces do not consume matching events.
- The listener is removed on unmount.
- The settings store fallback and Settings page save/hydration/dirty flows include `whipShortcut`.
- All five locale files contain compilable messages.

### Manual smoke test

- Enable the feature and confirm the default shortcut opens and closes the overlay.
- Record a custom modifier combination and a single-key shortcut, save, reload, and confirm both behaviors.
- Confirm the shortcut works from chat input and the editor.
- Confirm disabling the feature closes the overlay and stops shortcut interception.
- Confirm the reserved close-window shortcuts cannot be saved.

## Delivery

Implementation stays on `feature/kobo-whip`. After automated checks, manual smoke testing, and code review, a push to the existing remote branch updates PR #23. A new push still requires explicit user confirmation.
