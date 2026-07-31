# PR State Notification Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the compact PR/CI sound rows with seven independent notification cards matching the existing notification, question, and workspace-creation cards.

**Architecture:** Extend each PR sound preference with an `Enabled` boolean and a `Volume` number in the versioned global settings model. Keep the data-driven `PrNotificationSoundSettings.vue` component, but render complete cards and emit one settings object containing sound, enabled, and volume values. WebSocket dispatch reads the three values for the matching event and queues audio only when enabled.

**Tech Stack:** Node.js 20+, TypeScript, Vitest, Vue 3, Pinia, Quasar, Vue I18n.

## Global Constraints

- Add no dependency and no SQLite migration.
- Append settings migration version 45; do not edit versions 1 through 44.
- Every event defaults to `sound: inherit`, `enabled: true`, and `volume: 1` on a fresh install.
- Migration converts legacy `sound: none` to `sound: inherit` plus `enabled: false`; other values become enabled.
- Migration seeds each event volume from the valid global notification volume, otherwise `1`.
- Remove `No sound` from the PR card selectors; the toggle is the only mute control.
- Each card has a localized title, description, toggle, selector, preview button, and volume slider.
- Browser notifications remain active when one event's audio is disabled.
- Do not stage or modify the user's existing `package-lock.json` change.
- Do not push without explicit user confirmation.

## File Structure

- `src/server/services/settings-service.ts`: types, migration v45, defaults, allowlist, and volume validation.
- `src/__tests__/settings-service.test.ts`: migration/default/update regression tests.
- `src/client/src/stores/settings.ts`: frontend global-settings type and defaults.
- `src/client/src/utils/notification-sounds.ts`: typed event-to-sound/enabled/volume key metadata.
- `src/client/src/components/PrNotificationSoundSettings.vue`: seven complete data-driven cards.
- `src/client/src/pages/SettingsPage.vue`: hydrate, dirty-check, and save all twenty-one values.
- `src/client/src/stores/websocket.ts`: event-specific enablement and volume dispatch.
- `src/client/src/__tests__/settings-store.test.ts`: frontend defaults.
- `src/client/src/__tests__/pr-notification-dispatch.test.ts`: mute and volume dispatch.
- `src/client/src/__tests__/PrNotificationSoundSettings.test.ts`: rendered card behavior.
- `src/client/src/i18n/{en,fr,de,es,it}.ts`: seven card descriptions.
- `CONFIGURATION.md`: document the fourteen new settings.

---

### Task 1: Persist enablement and volume for all seven events

**Interfaces:**

- Produce fields `audioPr{Event}Enabled: boolean` and `audioPr{Event}Volume: number` alongside each existing `audioPr{Event}Sound`.
- Produce migration v45 with legacy `none` conversion and volume inheritance.

- [ ] **Step 1: Write failing backend tests**

Add table-driven assertions to `src/__tests__/settings-service.test.ts` using these literal suffixes:

```ts
const PR_AUDIO_EVENTS = [
  'CiFailed', 'CiRecovered', 'ChangesRequested', 'Approved',
  'MergeConflict', 'ReadyToMerge', 'Merged',
] as const
```

Assert fresh defaults, v44 migration of `none`, preservation of a selected sound, inheritance of `audioNotificationVolume: 0.35`, update allowlisting, and clamping invalid volumes.

- [ ] **Step 2: Verify RED**

Run `npx vitest run src/__tests__/settings-service.test.ts --config vitest.config.ts --root .`.

Expected: FAIL because schema version 45 and the fourteen fields do not exist.

- [ ] **Step 3: Implement migration and validation**

Add the fourteen fields to `GlobalSettings`, append migration 45, add fresh defaults and allowlist entries, and include the seven volume keys in the existing finite-number clamping loop.

- [ ] **Step 4: Verify GREEN and commit**

Run the focused backend test and `npx tsc --noEmit`; then commit only the settings service and its test with `feat(settings): add per-event pr audio controls`.

---

### Task 2: Dispatch PR audio using each event's toggle and volume

**Interfaces:**

- Produce typed metadata mapping every PR sound key to its sibling enabled and volume keys.
- Consume that metadata in WebSocket dispatch.

- [ ] **Step 1: Write failing frontend tests**

Extend `pr-notification-dispatch.test.ts` so a disabled CI-failure event still sends its browser notification but does not create audio, and an approved event with volume `0.35` queues its selected sound at exactly `0.35`. Extend `settings-store.test.ts` to assert seven enabled `true` and seven volume `1` defaults.

- [ ] **Step 2: Verify RED**

Run `cd src/client && npx vitest run src/__tests__/pr-notification-dispatch.test.ts src/__tests__/settings-store.test.ts`.

Expected: FAIL because dispatch still treats `none` as mute and uses the general volume.

- [ ] **Step 3: Implement typed metadata and dispatch**

Add frontend store fields/defaults. Replace the sound-only event map with entries shaped as:

```ts
{
  soundKey: 'audioPrCiFailedSound',
  enabledKey: 'audioPrCiFailedEnabled',
  volumeKey: 'audioPrCiFailedVolume',
}
```

Pass `null` when disabled and the event volume when enabled, leaving browser notification delivery unchanged.

- [ ] **Step 4: Verify GREEN and commit**

Run both focused tests and commit only the store, metadata, WebSocket code, and tests with `feat(notifications): apply per-event pr audio controls`.

---

### Task 3: Render and persist seven full notification cards

**Interfaces:**

- `PrNotificationSoundSettings` consumes and emits the twenty-one flat fields.
- Each card uses the existing `notification-sound-card q-pa-md rounded-borders` class and Quasar control pattern.

- [ ] **Step 1: Write the failing component test**

Create `PrNotificationSoundSettings.test.ts` with Vue Test Utils and Quasar. Mount the real component with seven event models and assert:

```ts
expect(wrapper.findAll('.notification-sound-card')).toHaveLength(7)
expect(wrapper.findAllComponents(QToggle)).toHaveLength(7)
expect(wrapper.findAllComponents(QSelect)).toHaveLength(7)
expect(wrapper.findAllComponents(QSlider)).toHaveLength(7)
expect(wrapper.text()).not.toContain('No sound')
```

Toggle the first card and move its slider; assert the emitted object changes only `audioPrCiFailedEnabled` and `audioPrCiFailedVolume`. Click preview and assert playback receives the first card's own volume.

- [ ] **Step 2: Verify RED**

Run `cd src/client && npx vitest run src/__tests__/PrNotificationSoundSettings.test.ts`.

Expected: FAIL because the compact component has no cards, toggles, descriptions, or sliders.

- [ ] **Step 3: Implement the cards and persistence**

Change the component's row metadata to include sound, enabled, volume, title, and description keys. Render seven cards in `notification-sounds-grid`, remove `NO_NOTIFICATION_SOUND` from options, and emit immutable updates. Add seven description translations in all five locales. Extend `SettingsPage.vue` hydration, dirty snapshot, and save payload with the fourteen fields; stop disabling the PR component from the general audio toggle.

- [ ] **Step 4: Verify GREEN and commit**

Run the component test plus existing notification and settings tests. Commit the component, page, translations, and tests with `feat(settings): render pr sounds as notification cards`.

---

### Task 4: Documentation and final verification

- [ ] Update `CONFIGURATION.md` with every enabled and volume key and migration semantics.
- [ ] Run backend tests, client tests, backend type-check, lint, production build, and `git diff --check`.
- [ ] Use `/browse` to verify seven cards, independent disabling, independent volume, preview, persistence after reload, and absence of `No sound`.
- [ ] Invoke `docs:post-dev` if available, then `superpowers:verification-before-completion` and `superpowers:finishing-a-development-branch`.
- [ ] Do not push; report the local commits and request confirmation before any push.
