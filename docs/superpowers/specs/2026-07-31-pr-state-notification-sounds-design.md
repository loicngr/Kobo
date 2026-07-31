# PR State Notification Sounds Design

Date: 2026-07-31
Status: Approved revision

## Context

Kōbō already supports browser notifications plus distinct notification,
agent-question, and workspace-creation cards with independent activation,
sound, and volume controls. Its catalogue contains seven bundled MP3 files.
The PR watcher already detects changes-requested and
ready-to-merge transitions, but only marks a workspace unread when CI first
fails. It does not emit dedicated events for CI recovery, merge conflicts, or a
successful merge.

Users need independent sound choices for important pull/merge request states,
while preserving the current behavior for existing installations. Twelve
additional, redistribution-approved MP3 files will also be added to the bundled
catalogue.

## Goals

- Let users select an independent sound for seven PR/MR and CI transitions.
- Give every transition its own audio enablement, sound, and volume settings.
- Offer `General sound` or any bundled sound for each transition.
- Preserve existing behavior by defaulting every new setting to
  `General sound`.
- Emit every real transition, including multiple transitions detected during
  the same watcher tick.
- Play simultaneous transition sounds sequentially so every configured sound is
  audible.
- Support GitHub and GitLab wherever the existing forge snapshots expose the
  required state.
- Add the twelve user-provided MP3 files to the existing sound catalogue.

## Non-goals

- Per-project sound overrides.
- Runtime upload or import of custom audio files.
- Sounds for CI pending, every new commit, or PR closed without merge.
- Extending GitLab's provider to expose approval decisions it does not currently
  return.
- Changing browser notification enablement or focus behavior.

## User Experience

Settings > Notifications gains seven cards below the existing general,
question, and workspace-creation sound cards:

1. CI failed
2. CI recovered
3. Changes requested
4. PR approved
5. Merge conflict
6. Ready to merge
7. PR merged

Each card follows the existing notification-card presentation and contains:

- a localized title and explanatory description;
- an independent `Enable audio` toggle;
- a select with `General sound` and all bundled sounds;
- a preview action, disabled while that card's audio is disabled;
- an independent volume slider.

Previewing `General sound` plays the currently selected global notification
sound at the card's own volume. Runtime playback is controlled by the card's
toggle, not by a `No sound` option. The seven cards do not depend on the general
notification-audio toggle because each owns its activation state.

All user-visible strings are translated in English, French, German, Spanish,
and Italian. Technical sound titles remain proper names across locales when a
translation would be misleading.

## Sound Catalogue

The existing seven sounds remain unchanged. The following files are copied into
`src/client/public/sounds/` and registered in `NOTIFICATION_SOUNDS`:

| Source file | Bundled file |
| --- | --- |
| `7emecompagnie03.mp3` | `7eme-compagnie-03.mp3` |
| `aller-ftg.mp3` | `aller-ftg.mp3` |
| `arrete-dmentir.mp3` | `arrete-de-mentir.mp3` |
| `arretez-denvoyer-les-messages-les-gens-sont-en-train-de-dormir.mp3` | `arretez-les-messages.mp3` |
| `bah-alors-on-est-nul.mp3` | `bah-alors-on-est-nul.mp3` |
| `gta-v-death-sound-effect-102.mp3` | `gta-v-death.mp3` |
| `nan-tu-degages.mp3` | `nan-tu-degages.mp3` |
| `nan-wallah-pardon.mp3` | `nan-wallah-pardon.mp3` |
| `ouais-cest-greg.mp3` | `ouais-cest-greg.mp3` |
| `pas-ca-zinedine-mp3cut.mp3` | `pas-ca-zinedine.mp3` |
| `ta-gueule_6iavH8Q.mp3` | `ta-gueule.mp3` |
| `tu-va-la-fermer-ta-geule.mp3` | `tu-vas-la-fermer.mp3` |

The catalogue will therefore contain nineteen sounds. Sound IDs remain static
public filenames so saved settings are stable across restarts and upgrades.

## Settings Model

Each of the seven events owns three explicit backend and frontend settings.
The sound fields remain:

| Field | Default |
| --- | --- |
| `audioPrCiFailedSound` | `inherit` |
| `audioPrCiRecoveredSound` | `inherit` |
| `audioPrChangesRequestedSound` | `inherit` |
| `audioPrApprovedSound` | `inherit` |
| `audioPrMergeConflictSound` | `inherit` |
| `audioPrReadyToMergeSound` | `inherit` |
| `audioPrMergedSound` | `inherit` |

The corresponding boolean fields are named `audioPrCiFailedEnabled` through
`audioPrMergedEnabled`; their fresh default is `true`. The corresponding volume
fields are named `audioPrCiFailedVolume` through `audioPrMergedVolume`; their
fresh default is `1`, and values are clamped to the inclusive `0..1` range.

Allowed sound values are:

- `inherit`: use `audioNotificationSound`;
- a known bundled sound ID: play that sound.

Unknown, missing, or malformed event-sound values resolve to `inherit`. This
keeps imported and older settings usable without allowing invalid filenames to
escape the static sound catalogue.

Settings migration v45 adds the enablement and volume fields. Existing `none`
sound selections migrate to `enabled: false` and `sound: inherit`; every other
selection migrates to `enabled: true`. Existing installations seed each event
volume from `audioNotificationVolume` to preserve audible loudness. Fresh
defaults, the backend update allowlist, frontend store types and defaults, form
hydration, dirty-state snapshots, save payloads, and configuration documentation
are updated together. No SQLite migration is required because these values live
in `settings.json`.

## PR Watcher Transitions

The watcher remains transition-based and keeps first sight silent. When there is
no previous snapshot, it only caches the current state.

For an open PR/MR with a previous snapshot, it emits:

| Event | Transition |
| --- | --- |
| `pr:ci-failed` | previous CI rollup is not `FAILURE`, current is `FAILURE` |
| `pr:ci-recovered` | previous CI rollup is `FAILURE`, current is `SUCCESS` |
| `pr:changes-requested` | previous review decision is not `CHANGES_REQUESTED`, current is `CHANGES_REQUESTED` |
| `pr:approved` | previous review decision is not `APPROVED`, current is `APPROVED` |
| `pr:merge-conflict` | previous mergeability is not `CONFLICTING`, current is `CONFLICTING` |
| `pr:ready-to-merge` | previous `readyToMerge` is false, current is true, and the workspace is not busy |

On an `OPEN` to `MERGED` transition, the watcher emits `pr:merged` before the
existing busy-workspace archive guard. The sound therefore fires even if the
agent is still working, while archive and purge behavior keeps its current
guard. Closing without merging remains silent.

These checks are independent rather than mutually exclusive. If CI recovery,
approval, and ready-to-merge occur in the same watcher tick, all applicable
events are emitted. CI failure, changes requested, merge conflict, and
ready-to-merge mark the workspace unread. CI recovery and approval do not.
Merged workspaces follow the existing archive flow instead of being marked
unread.

Review-decision events work on GitHub. GitLab continues to return a null review
decision, so those two events remain naturally unavailable there. CI,
mergeability, readiness, and merged-state events work on both providers when
their CLI data is available.

## Client Event Handling

Each PR event handler:

1. creates the existing style of localized Quasar toast;
2. sends the browser notification through `notify`;
3. stops before audio playback when that event's audio is disabled;
4. resolves the event-specific sound selection and volume;
5. refreshes the local PR snapshot when appropriate.

The sound override contract distinguishes two cases:

- `undefined`: inherit the general sound;
- a sound ID: play that exact bundled sound.

The existing question-sound override remains compatible.

## Sequential Audio Queue

Notification-triggered sounds use a FIFO queue. Every enabled transition adds
one queue item containing its resolved sound ID and event-specific volume
captured at enqueue time.

Only one queued sound plays at a time. Playback advances when the current audio
element emits `ended` or `error`, or when `play()` rejects (for example because
the browser blocks autoplay). A failed sound never blocks later items.

Settings preview remains an immediate, explicit user action and does not join
the notification queue. Disabling one event prevents only that event's new
items from being enqueued.

## Error Handling

- Unknown event-setting values inherit the general sound.
- Unknown general sound IDs continue to fall back to
  `DEFAULT_NOTIFICATION_SOUND`.
- Audio playback rejection is swallowed after advancing the queue.
- A missing or corrupt audio file cannot break WebSocket dispatch or settings.
- Forge polling errors remain isolated per workspace through the watcher's
  existing `try/catch`.
- No transition is emitted on first sight, preventing startup notification
  storms.

## Testing

### Backend

- Settings migration v45 converts legacy `none` selections into disabled cards
  and preserves the previous effective volume.
- Fresh settings expose the sound, enablement, and volume defaults.
- The global settings update allowlist accepts all twenty-one fields.
- PR watcher tests cover every transition.
- First sight and unchanged subsequent snapshots emit no transition events.
- Approval emits from any non-approved review state.
- CI recovery emits only for `FAILURE` to `SUCCESS`.
- Merge conflict emits only on entry into `CONFLICTING`.
- Multiple transitions in one tick all emit.
- `pr:merged` emits on `OPEN` to `MERGED` even when the workspace is busy, and
  precedes archive behavior when archiving is allowed.
- CI failure, changes requested, merge conflict, and ready-to-merge mark the
  workspace unread; positive recovery and approval transitions do not.

### Frontend

- Every card renders its title, description, toggle, selector, preview, and
  volume slider using the existing notification-card layout.
- Sound selection resolution covers `inherit`, a known sound, unknown values,
  and a changed general sound.
- Event enablement suppresses only audio, without suppressing browser
  notifications or other event sounds.
- Event-specific volume is captured when its sound is queued.
- The sound catalogue has unique IDs and label keys, and all nineteen asset
  files exist.
- WebSocket dispatch maps every PR event to the correct setting.
- Migration converts legacy `none` selections into disabled cards.
- The FIFO queue preserves order, advances on `ended`, and recovers from
  playback rejection or media error.
- Existing question and general notification behavior remains covered.

### Verification

- Run focused backend and frontend tests during TDD.
- Run the full root and client Vitest suites.
- Run backend and frontend TypeScript checks.
- Run lint and the production build.
- Manually smoke-test the Notifications settings section, previews, persistence,
  and at least one multi-transition queue scenario.

## Documentation

Update `CONFIGURATION.md` with the seven settings and their allowed values.
Update user-facing documentation or the changelog only where the repository's
release conventions require it. The PR description will call out that bundled
audio includes colloquial and explicit French language.
