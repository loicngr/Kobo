# Kōbō Whip Review Fixes Design

## Context

PR #23 adds the opt-in keyboard-driven whip, independent whip volume,
finite notification toasts, and two general notification sounds. The final
review found integration defects at the agent-session boundary, an unbounded
client queue, accessibility gaps, and two settings/documentation gaps.

This design fixes those findings without changing the user-approved behavior:
the feature remains disabled by default, has no toolbar button, supports
multiple cracks, uses the configured shortcut and volume, and keeps the fixed
six-second toast timeout.

## Goals

- Never interrupt or resume a session other than the workspace's currently
  running session.
- Disable auto-loop as a user action before an interrupted session can trigger
  the next iteration.
- Propagate asynchronous agent-message failures through every route fallback.
- Bound and cancel crack work when the overlay closes or the feature is
  disabled.
- Make the overlay and shortcut recorder operable and understandable with
  assistive technology and a keyboard.
- Persist repairs of malformed current-schema whip settings.
- Explain the master-audio dependency in the settings UI and document the
  three persisted whip settings.

## Non-goals

- No SQLite schema change or migration.
- No change to the six-second notification timeout.
- No new notification sound, upload mechanism, or toolbar button.
- No redesign of the general workspace session selector or auto-loop engine.
- No dedicated all-in-one whip backend endpoint; the existing interrupt and
  chat-message paths remain the public boundaries.

## Session-safe interruption

`POST /api/workspaces/:id/interrupt` will remain backward compatible with an
empty body. It will additionally accept the optional JSON fields:

```ts
{
  expectedSessionId?: string
  disableAutoLoop?: boolean
}
```

The orchestrator interruption API will accept the same session expectation and
option. It will synchronously:

1. resolve the active controller for the workspace;
2. reject if no controller exists;
3. reject if `expectedSessionId` does not equal the controller's agent-session
   id;
4. invoke the engine interruption;
5. when interruption was accepted and `disableAutoLoop` is true, disable
   auto-loop with reason `user-action` before yielding back to the event loop.

This ordering avoids disabling auto-loop for a rejected stale request while
still preventing `session:ended` from spawning a new iteration.

The client store will pass both fields for whip interruptions. Existing stop
buttons and other callers may keep using the endpoint without a body.

## Active-session targeting

`WorkspacePage` will derive the whip target from the session whose status is
`running`, not from `selectedSessionId`. A historical session can continue to
be displayed while another session runs, but the whip is eligible only when a
single running session id is available. That id is captured when the overlay
opens and is used for both interruption validation and later message dispatch.

If the active session changes, the existing target watcher closes the overlay
and cancels its coordinator. The feature will never fall back to the selected
historical session.

## Asynchronous message contract

The orchestrator's `sendMessage` contract will explicitly return
`Promise<void>`. Each of the five route handlers that uses a running-agent
fallback will `await` it inside its existing `try/catch` before reporting
success. A rejected steering operation will therefore execute the same resume
fallback as a synchronous "no agent running" error and will not become an
unhandled rejection.

The WebSocket chat handler already awaits the contract and remains unchanged.

## Bounded, cancellable crack coordinator

The coordinator will allow one active dispatch and at most one pending
dispatch. Additional cracks while one pending dispatch already exists are
coalesced into that pending dispatch. This preserves repeated whipping without
allowing a stalled interruption to accumulate unbounded work.

`dispose()` will:

- reject no Promise and remain idempotent;
- prevent new work;
- clear the pending dispatch;
- cause the active dispatch to stop after its current awaited dependency
  returns, before any further polling, interruption, or message send.

An already-started HTTP interruption cannot be recalled, but closing the
overlay will prevent every subsequent client-side side effect.

## Accessibility

The teleported overlay will use a focusable full-screen wrapper with
`role="dialog"`, `aria-modal="true"`, and translated accessible instructions.
The canvas will be marked as presentation-only. On open, the wrapper receives
focus; on close, focus returns to the previously focused element when it still
exists.

In addition to pointer gestures:

- `Enter` and `Space` trigger a crack through the same audio/event path;
- the existing crack cooldown prevents keyboard repeat bursts;
- `Escape` closes the overlay.

The shortcut recorder button will expose a translated accessible label,
`aria-pressed` while recording, and a polite live status. All new user-visible
strings will be added to English, French, German, Spanish, and Italian locale
files.

## Settings repair and presentation

`readSettings()` will snapshot the raw global object before migrations and
normalization. It will persist the resulting settings whenever known-field
normalization changed that object, even when the file already declares schema
version 53. This makes malformed `whipEnabled`, `whipShortcut`, and
`whipVolume` repairs durable instead of memory-only.

The whip-volume slider remains visible when the whip is enabled. When master
`audioNotifications` is disabled, the slider is disabled and a translated hint
explains that notification audio must be enabled first. Re-enabling master
audio restores the previously saved whip volume.

`CONFIGURATION.md` will document:

- `whipEnabled`: boolean, default `false`;
- `whipShortcut`: portable shortcut string, default `mod+shift+x`;
- `whipVolume`: number from `0` to `1`, default `1`.

## Error handling

- A stale expected session produces a clear request failure and does not
  interrupt any controller or disable auto-loop.
- A failed engine interruption leaves auto-loop unchanged.
- A rejected asynchronous message enters the existing route resume/error
  response path.
- Disposing the overlay suppresses stale queued dispatches without surfacing a
  notification error.
- Malformed current-schema settings are normalized to the existing safe
  defaults and rewritten through the normal atomic settings writer.

## Testing strategy

Every production behavior change follows a red-green TDD cycle.

Backend tests will cover:

- asynchronous `sendMessage` rejection in each affected route fallback;
- expected-session success and mismatch for the interrupt route/orchestrator;
- auto-loop disabled only after an accepted whip interruption;
- current-version malformed whip settings repaired both in memory and on disk.

Frontend tests will cover:

- a historical selected session never becoming the whip target;
- active-session changes closing and cancelling the overlay;
- one-active/one-pending coalescence and disposal during each await boundary;
- keyboard crack, modal semantics, focus entry, and focus restoration;
- shortcut-recorder accessible name and recording state;
- disabled volume and master-audio hint behavior through testable settings
  state or an extracted pure presentation helper if mounting the page remains
  impractical.

Focused tests run after every fix, followed by client tests, backend tests,
TypeScript checking, lint, and the production build under Node 24.
