# Kōbō Whip Design

## Goal

Add an OpenWhip-inspired interaction directly to Kōbō. While an agent is
running, the user can activate a full-window whip from the workspace header,
move it with the pointer, and crack it repeatedly. Every detected crack softly
interrupts the selected agent and then sends it a playful localized prompt
containing the literal word `tocard`.

The implementation reproduces the experience without copying OpenWhip source
code or audio assets. OpenWhip declares MIT in `package.json`, but its repository
does not include a license file, so Kōbō will use an original Vue/TypeScript
implementation and synthesized audio.

## User Experience

- Show a compact, translated **Whip** button in the workspace header only when
  the selected workspace has a running agent and is not archived.
- Activating the button displays a transparent Canvas above the entire Kōbō
  application, including drawers, panels, and chat.
- The whip handle follows the pointer. The rest of the rope responds with a
  lightweight Verlet simulation, tapered stiffness, gravity, and screen-edge
  collisions.
- A fast enough tip movement produces a visible and audible crack and dispatches
  the agent action described below.
- The user may crack the whip multiple times during one activation. A 250 ms
  cooldown filters accidental duplicate detections without limiting deliberate
  repeated cracks. Detection is disabled for the first 350 ms after activation.
- Clicking while the whip is active drops it. It falls off-screen and the
  overlay closes.
- Pressing Escape, toggling the header button, changing workspace, or leaving
  the workspace page closes the overlay immediately.
- The active button has a distinct state so the user can tell that the overlay
  is engaged.
- The whip is drawn as a dark tapered rope with a light outline so it stays
  visible across Kōbō's dark interface.

## Agent Action

The workspace and session identifiers are captured when the whip is activated.
This prevents a subsequent selection change from targeting another workspace.

For every accepted crack:

1. Play the synthesized crack sound if Kōbō audio notifications are enabled,
   using the configured notification volume.
2. If the captured workspace still has an active agent, call Kōbō's existing
   soft-interrupt endpoint.
3. Wait 300 ms so the engine can settle the interrupted turn.
4. Select one of five random phrases for the active locale. Every phrase must
   contain the exact French word `tocard`, including English, German, Spanish,
   and Italian.
5. Send the phrase through the existing `chat:message` WebSocket path with the
   captured session id. If the interrupt ended the active process, the backend's
   existing recovery path resumes that session.

Crack actions are serialized in detection order. An interruption error caused
by an agent that has already stopped does not prevent the message from being
sent. A missing WebSocket prevents dispatch and produces a rate-limited error
notification instead of one toast per failed crack.

The first implementation does not add persistence, settings, database columns,
backend routes, or third-party dependencies.

## Components and Boundaries

### `WhipOverlay.vue`

Owns the Canvas lifecycle, pointer input, animation frame, rendering, drop
animation, Escape handling, and sound trigger. It emits `crack` and `closed`
events and has no knowledge of workspaces, sessions, stores, HTTP, or WebSocket.

The overlay is teleported to `body` and uses a z-index above Kōbō dialogs. It
cleans up event listeners, animation frames, and audio nodes when unmounted.

### Whip physics module

A pure TypeScript module owns points, Verlet integration, constraints, tapering,
edge collisions, and crack detection. Time, bounds, and configuration are
explicit inputs. The module has no DOM or Canvas dependency, making deterministic
unit tests possible.

### Crack coordinator

A focused composable or utility owns the asynchronous side effects: serialize
cracks, interrupt when applicable, wait, choose the localized phrase, dispatch
it to the captured session, and rate-limit errors. It receives its dependencies
as functions so the sequence is unit-testable without mounting `WorkspacePage`.

### `WorkspacePage.vue`

Adds the header button, captures workspace/session context on activation, mounts
the overlay, forwards crack events to the coordinator, and closes the overlay on
workspace or route lifecycle changes. Existing workspace and WebSocket stores
remain the source of truth.

### Internationalization

Add button, tooltip, error, and phrase keys to all five locale files:
`en.ts`, `fr.ts`, `de.ts`, `es.ts`, and `it.ts`. Technical behavior remains the
same in every locale, and `tocard` is intentionally not translated.

## Error Handling and Safety

- Do not display or activate the whip when no agent is running.
- Treat "agent already stopped" during interruption as recoverable and continue
  with message dispatch.
- If the selected session no longer exists, let the existing WebSocket rejection
  path report the failure and do not redirect the message to another session.
- If the WebSocket is disconnected, do not attempt an HTTP fallback that could
  target stale state.
- Prevent error-toast storms by showing at most one dispatch error every five
  seconds during an overlay session.
- Close the overlay on workspace changes before any new crack can be accepted.
- Do not use OS-level keyboard automation, global overlays, Electron, `xdotool`,
  AppleScript, or Win32 FFI.

## Testing

### Unit tests

- Physics initialization creates a tapered rope with the requested point count.
- Integration keeps the handle pinned, applies gravity, and respects distance
  constraints within tolerance.
- Crack detection ignores the spawn grace period, rejects speeds below the
  threshold, applies cooldown, and accepts deliberate later cracks.
- The coordinator interrupts before sending, still sends after a recoverable
  interruption failure, serializes multiple cracks, preserves the captured
  workspace/session ids, and handles a disconnected WebSocket.
- All localized whip phrases contain the literal word `tocard`.

### Project checks

- Run focused Vitest files during TDD.
- Run client tests, frontend and backend type-checks, lint, and the full root
  Vitest suite.
- The baseline full suite currently has one unrelated timeout in
  `routes-health.test.ts`; record whether it reproduces after implementation.

### Manual QA

Use Kōbō in development and the `/qa` browser workflow to verify activation,
pointer response, several consecutive cracks, sound preference/volume, agent
interruption and message delivery, click-to-drop, Escape, toggle-off, and cleanup
when switching workspaces.

## Out of Scope

- Custom whip phrases or dedicated whip settings.
- Usage statistics or a crack counter.
- OS-wide overlays or control of terminals outside Kōbō.
- Reuse or redistribution of OpenWhip code, sounds, or icons.
- Mobile/touch-specific whip gestures beyond preventing broken layout.
