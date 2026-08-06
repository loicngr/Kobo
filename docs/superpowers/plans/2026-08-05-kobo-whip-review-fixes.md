# Kōbō Whip Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve every confirmed PR #23 review finding while preserving the approved opt-in whip, shortcut, sound, volume, and six-second toast behavior.

**Architecture:** Keep the existing interrupt REST endpoint and chat WebSocket path, but add an expected-session/auto-loop option to interruption so the server validates and prepares the active controller synchronously. Derive the target from the sole running session, bound crack dispatch to one active plus one pending action, and isolate small UI decisions in pure helpers so they receive real TDD coverage.

**Tech Stack:** TypeScript, Hono, Vue 3, Pinia, Quasar 2, vue-i18n, Vitest, Node 24.

## Global Constraints

- The whip remains disabled by default and has no toolbar button.
- The default shortcut remains `mod+shift+x`; single-key shortcuts remain valid.
- The independent whip volume remains `0..1`, default `1`, and master `audioNotifications` still mutes it.
- Every formerly sticky toast remains fixed at six seconds.
- All new visible copy is translated in `en`, `fr`, `de`, `es`, and `it`.
- No SQLite schema change and no dependency addition.
- Follow strict red-green TDD: each production change starts with a focused test that fails for the intended reason.
- Do not push without explicit user authorization.

---

### Task 1: Await the asynchronous agent-message contract in all route fallbacks

**Files:**
- Modify: `src/server/services/agent/orchestrator.ts:1077-1086`
- Modify: `src/server/routes/workspaces.ts:3523-3545,3635-3657,3964-3984,4088-4111,4181-4202`
- Modify: `src/__tests__/routes-workspaces.test.ts`
- Modify: `src/__tests__/routes-workspaces-review.test.ts`

**Interfaces:**
- Consumes: `SessionController.sendMessage(content: string): Promise<void>`
- Produces: `orchestrator.sendMessage(workspaceId, content, expectedSessionId?): Promise<void>` and route handlers that await rejection before selecting their existing fallback.

- [ ] **Step 1: Convert the existing synchronous-failure route tests into asynchronous rejection tests**

Change the existing `open-pr`, `start-review`, and `start-ci-fix` fallback fixtures from synchronous throws to rejected Promises:

```ts
vi.mocked(agentManager.sendMessage).mockRejectedValueOnce(new Error('turn is closing'))
```

Keep their existing response and `startAgent` assertions. In `start-review`, retain the assertion that a failed fallback produces no ghost `user:message`.

Add focused cases for the two uncovered endpoints:

```ts
it('resumes the agent when commit-with-agent steering rejects asynchronously', async () => {
  vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
  vi.mocked(gitOps.getWorkingTreeStatus).mockReturnValue({ staged: 0, modified: 1, untracked: 0 })
  vi.mocked(agentManager.sendMessage).mockRejectedValueOnce(new Error('turn is closing'))

  const res = await app.request('/api/workspaces/ws-1/git/commit-with-agent', { method: 'POST' })

  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ ok: true, messageSent: true })
  expect(agentManager.startAgent).toHaveBeenCalledOnce()
})

it('resumes the agent when resolve-with-agent steering rejects asynchronously', async () => {
  vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
  vi.mocked(agentManager.sendMessage).mockRejectedValueOnce(new Error('turn is closing'))

  const res = await app.request('/api/workspaces/ws-1/git/resolve-with-agent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operation: 'merge', files: ['src/conflicted.ts'] }),
  })

  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ ok: true, messageSent: true })
  expect(agentManager.startAgent).toHaveBeenCalledOnce()
})
```

- [ ] **Step 2: Run the route tests and verify RED**

Run:

```bash
source /Users/enzovella/.nvm/nvm.sh && nvm use 24 >/dev/null
npx vitest run src/__tests__/routes-workspaces.test.ts src/__tests__/routes-workspaces-review.test.ts
```

Expected: the asynchronous rejection cases fail because the handlers return before the rejected Promise reaches their `catch` blocks.

- [ ] **Step 3: Make the orchestrator contract explicit and await all five call sites**

Change the orchestrator signature and forwarding:

```ts
export async function sendMessage(
  workspaceId: string,
  content: string,
  expectedSessionId?: string,
): Promise<void> {
  const ctrl = controllers.get(workspaceId)
  if (!ctrl) throw new Error(`No agent running for workspace '${workspaceId}'`)
  if (expectedSessionId && ctrl.agentSessionId !== expectedSessionId) {
    throw new Error(`Session '${expectedSessionId}' is not active for workspace '${workspaceId}'`)
  }
  wakeupService.cancel(workspaceId, 'user-message')
  await ctrl.sendMessage(content)
}
```

At each affected route call site, change only the dispatch statement:

```ts
await agentManager.sendMessage(workspace.id, prompt)
```

Use `rendered` instead of `prompt` in the three template routes that already use that variable.

- [ ] **Step 4: Run the route and orchestrator tests and verify GREEN**

Run:

```bash
npx vitest run src/__tests__/routes-workspaces.test.ts src/__tests__/routes-workspaces-review.test.ts src/__tests__/agent/orchestrator.test.ts src/__tests__/agent/session-controller.test.ts
```

Expected: all selected files pass with no unhandled rejection.

- [ ] **Step 5: Commit the asynchronous contract fix**

```bash
git add src/server/services/agent/orchestrator.ts src/server/routes/workspaces.ts src/__tests__/routes-workspaces.test.ts src/__tests__/routes-workspaces-review.test.ts
git commit -m "fix(agent): await message dispatch failures"
```

---

### Task 2: Validate the active session and stop auto-loop before whip restart

**Files:**
- Modify: `src/server/services/agent/orchestrator.ts:1015-1031`
- Modify: `src/server/routes/workspaces.ts:4319-4335`
- Modify: `src/__tests__/agent/orchestrator.test.ts:527-570`
- Modify: `src/__tests__/routes-workspaces.test.ts`
- Modify: `src/client/src/stores/workspace.ts:703-716`
- Create: `src/client/src/utils/whip-session.ts`
- Create: `src/client/src/__tests__/whip-session.test.ts`
- Modify: `src/client/src/pages/WorkspacePage.vue:166-170,788-799`
- Modify: `src/client/src/components/WorkspaceWhipControl.vue:68-77`
- Modify: `src/client/src/__tests__/WorkspaceWhipControl.test.ts:246-275`

**Interfaces:**
- Produces: `InterruptAgentOptions { expectedSessionId?: string; disableAutoLoop?: boolean }`.
- Produces: `interruptAgent(workspaceId, options?): void`, with exact controller-session validation and optional auto-loop disable after an accepted interrupt.
- Produces: `getWhipRunningSessionId(sessions): string | null`, returning an id only when exactly one session is running.
- Consumes: the captured running session id for REST interruption and WebSocket message dispatch.

- [ ] **Step 1: Add orchestrator tests for session matching and auto-loop ordering**

Extend the existing `Orchestrator — interruptAgent` block with a fake engine whose `interrupt()` can throw and with a workspace whose auto-loop row is enabled. Add these behaviors:

```ts
expect(() => interruptAgent(ws.id, { expectedSessionId: 'stale-session', disableAutoLoop: true })).toThrow(
  /not active/,
)
expect(interruptCalls).toBe(0)
expect(autoLoopService.getStatus(ws.id).auto_loop).toBe(true)

interruptAgent(ws.id, { expectedSessionId: agentSessionId, disableAutoLoop: true })
expect(interruptCalls).toBe(1)
expect(autoLoopService.getStatus(ws.id).auto_loop).toBe(false)
```

Add a separate case where the fake engine throws from `interrupt()` and assert auto-loop remains enabled.

- [ ] **Step 2: Add interrupt-route contract tests**

Add `interruptAgent` to the orchestrator mock in `routes-workspaces.test.ts`, then add:

```ts
it('forwards whip session safety options to interruptAgent', async () => {
  vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
  const res = await app.request('/api/workspaces/ws-1/interrupt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedSessionId: 'session-running', disableAutoLoop: true }),
  })
  expect(res.status).toBe(200)
  expect(agentManager.interruptAgent).toHaveBeenCalledWith('ws-1', {
    expectedSessionId: 'session-running',
    disableAutoLoop: true,
  })
})
```

Also assert that non-string `expectedSessionId` and non-boolean `disableAutoLoop` return HTTP 400, while an empty body still calls `interruptAgent('ws-1', {})` successfully.

- [ ] **Step 3: Add frontend RED tests for running-session selection and safe interrupt payload**

Create `whip-session.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { getWhipRunningSessionId } from '../utils/whip-session'

describe('getWhipRunningSessionId', () => {
  it('returns the sole running session instead of a historical selection', () => {
    expect(
      getWhipRunningSessionId([
        { id: 'historical', status: 'done' },
        { id: 'active', status: 'running' },
      ]),
    ).toBe('active')
  })

  it.each([[], [{ id: 'a', status: 'running' }, { id: 'b', status: 'running' }]])(
    'refuses an absent or ambiguous running session: %j',
    (sessions) => expect(getWhipRunningSessionId(sessions)).toBeNull(),
  )
})
```

Update the coordinator-wiring test to require:

```ts
expect(interrupt).toHaveBeenCalledWith('ws-1', {
  expectedSessionId: 'session-1',
  disableAutoLoop: true,
})
```

- [ ] **Step 4: Run all new session-safety tests and verify RED**

Run:

```bash
npx vitest run src/__tests__/agent/orchestrator.test.ts src/__tests__/routes-workspaces.test.ts
(cd src/client && npx vitest run src/__tests__/whip-session.test.ts src/__tests__/WorkspaceWhipControl.test.ts)
```

Expected: missing option contracts, missing helper, and old one-argument client interruption fail for the intended reasons.

- [ ] **Step 5: Implement the atomic interruption option and route validation**

Add to the orchestrator:

```ts
export interface InterruptAgentOptions {
  expectedSessionId?: string
  disableAutoLoop?: boolean
}

export function interruptAgent(workspaceId: string, options: InterruptAgentOptions = {}): void {
  const ctrl = controllers.get(workspaceId)
  if (!ctrl) throw new Error(`No agent running for workspace '${workspaceId}'`)
  if (options.expectedSessionId && ctrl.agentSessionId !== options.expectedSessionId) {
    throw new Error(`Session '${options.expectedSessionId}' is not active for workspace '${workspaceId}'`)
  }
  try {
    ctrl.interrupt()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to interrupt agent for workspace '${workspaceId}': ${message}`)
  }
  if (options.disableAutoLoop && autoLoopService.getStatus(workspaceId).auto_loop) {
    autoLoopService.disable(workspaceId, 'user-action')
  }
}
```

Make the Hono route asynchronous, parse an empty body as `{}`, reject malformed supplied values with 400, and forward the normalized options.

- [ ] **Step 6: Implement running-session targeting and the safe client payload**

Create the pure helper:

```ts
export interface WhipSessionCandidate {
  id: string
  status: string
}

export function getWhipRunningSessionId(sessions: readonly WhipSessionCandidate[]): string | null {
  const running = sessions.filter((session) => session.status === 'running')
  return running.length === 1 ? running[0]!.id : null
}
```

In `WorkspacePage.vue`, derive:

```ts
const whipRunningSessionId = computed(() => getWhipRunningSessionId(store.sessions))
```

Pass `whipRunningSessionId` as `session-id` and `whipRunningSessionId !== null` as `running`. In the workspace store, accept optional interruption options and serialize them as JSON. In `WorkspaceWhipControl`, pass the captured session id and `disableAutoLoop: true` to the store.

- [ ] **Step 7: Run backend and frontend session-safety tests and verify GREEN**

Run the same commands from Step 4. Expected: all pass, including stale-session rejection without interruption or auto-loop mutation.

- [ ] **Step 8: Commit the session-safe whip contract**

```bash
git add src/server/services/agent/orchestrator.ts src/server/routes/workspaces.ts src/__tests__/agent/orchestrator.test.ts src/__tests__/routes-workspaces.test.ts src/client/src/stores/workspace.ts src/client/src/utils/whip-session.ts src/client/src/__tests__/whip-session.test.ts src/client/src/pages/WorkspacePage.vue src/client/src/components/WorkspaceWhipControl.vue src/client/src/__tests__/WorkspaceWhipControl.test.ts
git commit -m "fix(whip): target the active agent session"
```

---

### Task 3: Bound and cancel crack dispatch work

**Files:**
- Modify: `src/client/src/utils/whip-crack.ts`
- Modify: `src/client/src/__tests__/whip-crack.test.ts`

**Interfaces:**
- Preserves: `WhipCrackCoordinator.enqueue(): Promise<void>` and `dispose(): void`.
- Changes: a maximum of two accepted queue slots (one active and one pending); later cracks coalesce onto the current tail.
- Changes: `dispatchCrack()` checks disposal before work and after every `await` boundary.

- [ ] **Step 1: Add RED tests for coalescence and disposal during an await**

Add a deferred interruption test that enqueues three cracks before releasing the first interruption:

```ts
let releaseFirstInterrupt!: () => void
const firstInterrupt = new Promise<void>((resolve) => {
  releaseFirstInterrupt = resolve
})
const sendMessage = vi.fn(() => true)
let interruptCalls = 0
const coordinator = createWhipCrackCoordinator(target, ['Go'], {
  ...dependencies,
  interruptAgent: async () => {
    interruptCalls += 1
    if (interruptCalls === 1) await firstInterrupt
  },
  sendMessage,
})

const first = coordinator.enqueue()
const second = coordinator.enqueue()
const coalesced = coordinator.enqueue()
releaseFirstInterrupt()
await Promise.all([first, second, coalesced])
expect(sendMessage).toHaveBeenCalledTimes(2)
```

Add a disposal test that disposes while `wait(WHIP_MESSAGE_DELAY_MS)` is pending, releases it, and asserts no polling wait, no message, and no second queued interruption occurs.

- [ ] **Step 2: Run the coordinator test and verify RED**

Run:

```bash
(cd src/client && npx vitest run src/__tests__/whip-crack.test.ts)
```

Expected: the current unbounded tail dispatches three messages and the disposed active action still sends.

- [ ] **Step 3: Implement a two-slot queue with disposal checkpoints**

Keep the Promise tail, add a queued count, and coalesce when two slots are occupied:

```ts
let queued = 0

function enqueue(): Promise<void> {
  if (disposed) return Promise.resolve()
  if (queued >= 2) return tail
  queued += 1
  const current = tail.then(dispatchCrack)
  tail = current.catch(() => undefined).finally(() => {
    queued = Math.max(0, queued - 1)
  })
  return current
}
```

At the beginning of `dispatchCrack` and immediately after `interruptAgent` and every `wait`, return when `disposed`. In `dispose()`, set `disposed = true`; queued work then enters `dispatchCrack` and exits without a side effect.

- [ ] **Step 4: Run the coordinator and control tests and verify GREEN**

```bash
(cd src/client && npx vitest run src/__tests__/whip-crack.test.ts src/__tests__/WorkspaceWhipControl.test.ts)
```

- [ ] **Step 5: Commit the bounded queue**

```bash
git add src/client/src/utils/whip-crack.ts src/client/src/__tests__/whip-crack.test.ts
git commit -m "fix(whip): bound pending crack dispatches"
```

---

### Task 4: Make the overlay and shortcut recorder accessible

**Files:**
- Modify: `src/client/src/components/WhipOverlay.vue`
- Modify: `src/client/src/components/WhipShortcutRecorder.vue`
- Modify: `src/client/src/__tests__/WhipOverlay.test.ts`
- Modify: `src/client/src/__tests__/WhipShortcutRecorder.test.ts`
- Modify: `src/client/src/i18n/en.ts`
- Modify: `src/client/src/i18n/fr.ts`
- Modify: `src/client/src/i18n/de.ts`
- Modify: `src/client/src/i18n/es.ts`
- Modify: `src/client/src/i18n/it.ts`
- Modify: `src/client/src/__tests__/i18n.test.ts`

**Interfaces:**
- Produces: a focused modal wrapper labelled by `whip.overlayLabel` and described by `whip.overlayInstructions`.
- Produces: keyboard crack on non-repeated `Enter`/`Space`, sharing one `emitCrack()` audio/event function.
- Produces: recorder `aria-label`, `aria-pressed`, and polite status text.

- [ ] **Step 1: Add overlay RED tests for semantics, keyboard control, and focus lifecycle**

Mount the real component with a focusable button already focused. Assert:

```ts
const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
expect(dialog.getAttribute('aria-modal')).toBe('true')
expect(dialog.getAttribute('aria-label')).toBe('Interactive whip')
expect(dialog.getAttribute('aria-describedby')).toBe('whip-overlay-instructions')
expect(document.activeElement).toBe(dialog)
expect(document.querySelector('canvas')?.getAttribute('aria-hidden')).toBe('true')

dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
expect(playWhipCrack).toHaveBeenCalledOnce()
expect(wrapper.emitted('crack')).toHaveLength(1)

wrapper.unmount()
expect(document.activeElement).toBe(previousButton)
```

Add a `Space` case and prove `repeat: true` and a second key within the physics crack cooldown do not emit another crack.

- [ ] **Step 2: Add shortcut-recorder RED tests for its accessible state**

Assert the initial button label contains the setting name and formatted shortcut, then click it and assert:

```ts
expect(button.attributes('aria-pressed')).toBe('true')
expect(wrapper.get('[role="status"]').text()).toBe('Press a shortcut…')
```

- [ ] **Step 3: Run component tests and verify RED**

```bash
(cd src/client && npx vitest run src/__tests__/WhipOverlay.test.ts src/__tests__/WhipShortcutRecorder.test.ts)
```

Expected: no dialog wrapper, focus transfer, keyboard crack, recorder label, or live state exists yet.

- [ ] **Step 4: Implement the modal wrapper and unified crack emission**

Replace the canvas-only Teleport with:

```vue
<Teleport to="body">
  <div
    ref="overlayRef"
    class="whip-overlay"
    role="dialog"
    aria-modal="true"
    :aria-label="t('whip.overlayLabel')"
    aria-describedby="whip-overlay-instructions"
    tabindex="-1"
    @keydown="handleKeydown"
  >
    <span id="whip-overlay-instructions" class="q-sr-only">
      {{ t('whip.overlayInstructions') }}
    </span>
    <canvas ref="canvasRef" class="whip-canvas" aria-hidden="true" />
  </div>
</Teleport>
```

Use `useI18n()`, store the prior focused HTMLElement, focus `overlayRef` after canvas setup, and restore prior focus on unmount when `isConnected`. Extract:

```ts
function emitCrack(): void {
  playWhipCrack({ enabled: props.soundEnabled, volume: props.soundVolume })
  emit('crack')
}
```

Call it from physics and from non-repeated `Enter`/`Space`, using `WHIP_CONFIG.crackCooldownMs` to rate-limit keyboard activation. Keep Escape close behavior.

- [ ] **Step 5: Implement recorder semantics and all five translations**

Add a computed accessible label using new keys:

```ts
const accessibleLabel = computed(() =>
  recording.value
    ? t('settings.whipShortcutRecordingLabel')
    : t('settings.whipShortcutButtonLabel', { shortcut: displayValue.value }),
)
```

Bind it as `aria-label`, bind `aria-pressed`, and add a `role="status" aria-live="polite"` element containing the recording message only while recording.

Add translations for:

```ts
'whip.overlayLabel'
'whip.overlayInstructions'
'settings.whipShortcutButtonLabel'
'settings.whipShortcutRecordingLabel'
```

Preserve placeholders such as `{shortcut}` in every locale.

- [ ] **Step 6: Run component and i18n tests and verify GREEN**

```bash
(cd src/client && npx vitest run src/__tests__/WhipOverlay.test.ts src/__tests__/WhipShortcutRecorder.test.ts src/__tests__/i18n.test.ts)
```

- [ ] **Step 7: Commit accessibility fixes**

```bash
git add src/client/src/components/WhipOverlay.vue src/client/src/components/WhipShortcutRecorder.vue src/client/src/__tests__/WhipOverlay.test.ts src/client/src/__tests__/WhipShortcutRecorder.test.ts src/client/src/i18n/en.ts src/client/src/i18n/fr.ts src/client/src/i18n/de.ts src/client/src/i18n/es.ts src/client/src/i18n/it.ts src/client/src/__tests__/i18n.test.ts
git commit -m "fix(whip): add accessible keyboard controls"
```

---

### Task 5: Persist repaired settings and explain master audio

**Files:**
- Modify: `src/server/services/settings-service.ts:1342-1380`
- Modify: `src/__tests__/settings-service.test.ts:2324-2368`
- Create: `src/client/src/utils/whip-settings.ts`
- Create: `src/client/src/__tests__/whip-settings.test.ts`
- Modify: `src/client/src/pages/SettingsPage.vue:246-267`
- Modify: `src/client/src/i18n/en.ts`
- Modify: `src/client/src/i18n/fr.ts`
- Modify: `src/client/src/i18n/de.ts`
- Modify: `src/client/src/i18n/es.ts`
- Modify: `src/client/src/i18n/it.ts`
- Modify: `src/client/src/__tests__/i18n.test.ts`
- Modify: `CONFIGURATION.md:120-150`

**Interfaces:**
- Changes: `readSettings()` rewrites current-schema files when known-field normalization altered their global object.
- Produces: `getWhipVolumeAvailability(audioNotifications): { disabled: boolean; hintKey: 'settings.whipVolumeMasterAudioDisabled' | null }`.
- Preserves: saved `whipVolume` while master audio is off.

- [ ] **Step 1: Add a disk-level RED test for durable repairs**

```ts
it('persists normalized whip values from a malformed current-schema file', () => {
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      global: { whipEnabled: 'true', whipShortcut: 'mod+w', whipVolume: 2 },
      projects: [],
    }),
  )

  const loaded = getSettings()
  expect(loaded.global).toMatchObject({
    whipEnabled: false,
    whipShortcut: 'mod+shift+x',
    whipVolume: 1,
  })

  const persisted = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  expect(persisted.global).toMatchObject({
    whipEnabled: false,
    whipShortcut: 'mod+shift+x',
    whipVolume: 1,
  })
})
```

- [ ] **Step 2: Add a RED test for master-audio presentation**

Create `whip-settings.test.ts`:

```ts
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
```

- [ ] **Step 3: Run both focused tests and verify RED**

```bash
npx vitest run src/__tests__/settings-service.test.ts -t "persists normalized whip values"
(cd src/client && npx vitest run src/__tests__/whip-settings.test.ts)
```

Expected: the disk retains malformed values and the presentation helper is missing.

- [ ] **Step 4: Persist known-field normalization changes**

Before `runSettingsMigrations`, capture the raw global object:

```ts
const globalBeforeMigrations = JSON.stringify((parsed as { global?: unknown }).global ?? null)
const migrated = runSettingsMigrations(parsed as Record<string, unknown>)
const normalizedGlobalFields = JSON.stringify(migrated.global) !== globalBeforeMigrations
```

Include `normalizedGlobalFields` in the existing write condition:

```ts
if (migrated.schemaVersion !== originalVersion || restoredGlobalFields || normalizedGlobalFields) {
  writeSettings(migrated)
}
```

- [ ] **Step 5: Implement the master-audio presentation helper and UI binding**

Create:

```ts
export function getWhipVolumeAvailability(audioNotifications: boolean): {
  disabled: boolean
  hintKey: 'settings.whipVolumeMasterAudioDisabled' | null
} {
  return audioNotifications
    ? { disabled: false, hintKey: null }
    : { disabled: true, hintKey: 'settings.whipVolumeMasterAudioDisabled' }
}
```

In `SettingsPage.vue`, compute it from `globalAudioNotifications`, bind `:disable` on the slider, and render the translated hint beneath the volume row only when `hintKey` is non-null. Add `settings.whipVolumeMasterAudioDisabled` to all five locale files.

- [ ] **Step 6: Document the persisted contract**

Add three rows beside the audio settings in `CONFIGURATION.md`:

```markdown
| `whipEnabled` | `boolean` | Enable the interactive whip. Default `false`. |
| `whipShortcut` | `string` | Portable whip shortcut. Default `mod+shift+x`. |
| `whipVolume` | `number` | Independent whip volume from `0` to `1`. Default `1`; master `audioNotifications` still mutes playback. |
```

- [ ] **Step 7: Run settings and i18n tests and verify GREEN**

```bash
npx vitest run src/__tests__/settings-service.test.ts
(cd src/client && npx vitest run src/__tests__/whip-settings.test.ts src/__tests__/i18n.test.ts)
```

- [ ] **Step 8: Commit settings and documentation fixes**

```bash
git add src/server/services/settings-service.ts src/__tests__/settings-service.test.ts src/client/src/utils/whip-settings.ts src/client/src/__tests__/whip-settings.test.ts src/client/src/pages/SettingsPage.vue src/client/src/i18n/en.ts src/client/src/i18n/fr.ts src/client/src/i18n/de.ts src/client/src/i18n/es.ts src/client/src/i18n/it.ts src/client/src/__tests__/i18n.test.ts CONFIGURATION.md
git commit -m "fix(whip): persist and explain audio settings"
```

---

### Task 6: Full verification, documentation audit, and PR readiness

**Files:**
- Modify only if a focused verification failure proves a feature-specific defect.

**Interfaces:**
- Verifies every contract produced by Tasks 1-5 and confirms no unrelated change entered the branch.

- [ ] **Step 1: Run focused regression suites together**

```bash
source /Users/enzovella/.nvm/nvm.sh && nvm use 24 >/dev/null
npx vitest run src/__tests__/agent/orchestrator.test.ts src/__tests__/agent/session-controller.test.ts src/__tests__/routes-workspaces.test.ts src/__tests__/routes-workspaces-review.test.ts src/__tests__/settings-service.test.ts src/__tests__/codex/engine.test.ts
(cd src/client && npx vitest run src/__tests__/whip-session.test.ts src/__tests__/whip-settings.test.ts src/__tests__/whip-crack.test.ts src/__tests__/whip-audio.test.ts src/__tests__/whip-physics.test.ts src/__tests__/whip-shortcut.test.ts src/__tests__/WorkspaceWhipControl.test.ts src/__tests__/WhipOverlay.test.ts src/__tests__/WhipShortcutRecorder.test.ts src/__tests__/notification-sounds.test.ts src/__tests__/i18n.test.ts)
```

- [ ] **Step 2: Run all project quality gates under Node 24**

```bash
npm test
(cd src/client && npm test)
npx tsc --noEmit
npm run lint
npm run build
npm audit --audit-level=high
```

Expected: zero failing tests, zero TypeScript or lint errors, successful production build, and no high-severity audit finding.

- [ ] **Step 3: Audit requirements and diff hygiene**

```bash
git diff --check upstream/develop...HEAD
git status --short
git diff --stat upstream/develop...HEAD
rg -n "timeout:\s*0" src/client/src --glob '!**/__tests__/**'
```

Expected: no whitespace errors, clean worktree, no application `timeout: 0`, and only PR-scope files in the diff.

- [ ] **Step 4: Run the required pre-landing review skills**

Invoke `superpowers:verification-before-completion`, then `superpowers:requesting-code-review`. If the project-specific `docs:post-dev` skill is available, run it before `superpowers:finishing-a-development-branch`; otherwise record that it is unavailable and verify `CONFIGURATION.md` manually.

- [ ] **Step 5: Handle a verification failure through a new explicit TDD task**

If Step 1-4 fails, stop before editing production code. Record the exact failing
command and add a new task to this plan naming the affected production and test
files, the failing assertion, the minimal implementation, its focused rerun,
and its exact `git add` list. If every command passes, do not create an empty
commit.

- [ ] **Step 6: Report readiness without pushing**

Report commit SHAs, verification counts, any remaining concern, and the exact push command that would update PR #23. Ask for explicit authorization before running that push.

---

### Task 7: Preserve the recoverable stopped-agent race and restore lint

**Files:**
- Modify: `src/server/services/agent/orchestrator.ts`
- Modify: `src/server/routes/workspaces.ts`
- Modify: `src/client/src/stores/workspace.ts`
- Modify: `src/client/src/utils/whip-crack.ts`
- Modify: `src/__tests__/agent/orchestrator.test.ts`
- Modify: `src/__tests__/routes-workspaces.test.ts`
- Modify: `src/client/src/__tests__/workspace-store.test.ts`
- Modify: `src/client/src/__tests__/whip-crack.test.ts`

**Interfaces:**
- Produces a stable interrupt error discriminator across orchestrator, REST, and the workspace store: `no_agent_running | session_not_active | interrupt_failed`.
- Preserves the captured-session WebSocket resume only for `no_agent_running`.
- Keeps stale-session and engine/unknown interruption failures blocking and rate-limited.
- Restores Biome cleanliness without changing behavior.

- [ ] **Step 1: Add RED tests for stable interruption error codes**

In the orchestrator tests, assert that missing-controller, stale-session, and engine-interrupt failures expose their exact distinct codes. In the route tests, assert the code is serialized in the JSON error body. In the workspace-store tests, assert the rejected `WorkspaceActionError` preserves the server code instead of collapsing it to an untyped `Error`.

- [ ] **Step 2: Add RED coordinator tests for the recoverable race**

Use structural errors with a `code` field, not message parsing. Assert:

- `no_agent_running` waits the normal message delay, then sends exactly one message to the captured workspace/session;
- `session_not_active` sends no message and reports one rate-limited error;
- `interrupt_failed` and an untagged error send no message and remain rate-limited;
- disposal during the recoverable delay still prevents message dispatch.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
source /Users/enzovella/.nvm/nvm.sh && nvm use 24 >/dev/null
npx vitest run src/__tests__/agent/orchestrator.test.ts src/__tests__/routes-workspaces.test.ts
(cd src/client && npx vitest run src/__tests__/workspace-store.test.ts src/__tests__/whip-crack.test.ts)
```

Expected: the server exposes only human messages, the store discards codes, and the coordinator blocks the recoverable already-stopped race.

- [ ] **Step 4: Implement the minimal typed error path**

Add a typed orchestrator error carrying the three stable codes. Serialize it from the interrupt route, using conflict status for missing/stale controllers and server-error status for engine interruption. Reuse the existing client `WorkspaceActionError` so the store preserves the response code. In the coordinator, inspect only the structural `code`; continue after `WHIP_MESSAGE_DELAY_MS` only for `no_agent_running`, with a disposal checkpoint after the wait. Keep all other rejections on the existing rate-limited early-return path. Never parse error text.

- [ ] **Step 5: Format the affected test and verify GREEN**

Apply Biome formatting only to `src/client/src/__tests__/whip-crack.test.ts`, then run:

```bash
npx vitest run src/__tests__/agent/orchestrator.test.ts src/__tests__/routes-workspaces.test.ts
(cd src/client && npx vitest run src/__tests__/workspace-store.test.ts src/__tests__/whip-crack.test.ts)
npx biome check src/client/src/__tests__/whip-crack.test.ts
npm run lint
```

- [ ] **Step 6: Commit the verified recovery contract**

```bash
git add src/server/services/agent/orchestrator.ts src/server/routes/workspaces.ts src/client/src/stores/workspace.ts src/client/src/utils/whip-crack.ts src/__tests__/agent/orchestrator.test.ts src/__tests__/routes-workspaces.test.ts src/client/src/__tests__/workspace-store.test.ts src/client/src/__tests__/whip-crack.test.ts
git commit -m "fix(whip): preserve stopped-agent recovery"
```

After this task, rerun Task 6 from Step 1 on the new HEAD before making any readiness claim.

---

### Task 8: Keep Whip eligibility live and consume only valid shortcuts

**Files:**
- Modify: `src/client/src/stores/workspace.ts`
- Modify: `src/client/src/pages/WorkspacePage.vue`
- Modify: `src/client/src/utils/whip-session.ts`
- Modify: `src/client/src/components/WorkspaceWhipControl.vue`
- Modify: `src/server/services/settings-service.ts`
- Modify: `src/client/src/__tests__/workspace-store.test.ts`
- Modify: `src/client/src/__tests__/whip-session.test.ts`
- Modify: `src/client/src/__tests__/WorkspaceWhipControl.test.ts`
- Modify: `src/__tests__/settings-service.test.ts`
- Modify: `src/client/src/__tests__/whip-shortcut.test.ts`

**Interfaces:**
- Changes `getWhipRunningSessionId` to select the sole running session for an explicit workspace id.
- Requires both a live busy workspace status and a workspace-matching running session before enabling Whip.
- Consumes an eligible Whip shortcut exclusively before toggling the overlay.
- Normalizes modifier-only final keys identically on the server and client.

- [ ] **Step 1: Add RED tests for workspace/session freshness**

Add pure helper cases proving that a running session from another workspace is ignored and that only one running session for the requested workspace is returned. Add a store test proving `selectWorkspace(newId)` clears the previous `sessions` synchronously before the replacement fetch resolves.

In `WorkspacePage.vue`, the final implementation must pass `null` whenever the selected workspace is not in a busy live status, even if a stale session row still says `running`. This makes the existing `WorkspaceWhipControl` prop watchers close the overlay on `session:ended` and on workspace changes.

- [ ] **Step 2: Add RED tests for exclusive shortcut consumption**

In `WorkspaceWhipControl.test.ts`, register a competing global keydown handler and prove a valid eligible Whip shortcut does not reach it, while an ineligible/disabled/non-matching event still propagates. Add a single-key `space` case proving a consumed close does not reach a simulated overlay/global handler or emit a stray crack.

- [ ] **Step 3: Add RED server/client modifier-key validation tests**

Extend the server invalid-shortcut migration/update cases with `control`, `mod+control`, `ctrl`, `mod+ctrl`, `meta`, `alt`, `shift`, and `mod` as final keys. Extend client matching tests to prove those persisted forms never match. Expected normalization remains `mod+shift+x`.

- [ ] **Step 4: Run focused tests and verify RED**

```bash
source /Users/enzovella/.nvm/nvm.sh && nvm use 24 >/dev/null
npx vitest run src/__tests__/settings-service.test.ts -t "shortcut"
(cd src/client && npx vitest run src/__tests__/workspace-store.test.ts src/__tests__/whip-session.test.ts src/__tests__/WorkspaceWhipControl.test.ts src/__tests__/whip-shortcut.test.ts)
```

- [ ] **Step 5: Implement the minimal eligibility and shortcut fixes**

Clear `sessions` synchronously in `selectWorkspace`. Make `getWhipRunningSessionId(workspaceId, sessions)` filter by `session.workspaceId` before requiring exactly one `running` result. In `WorkspacePage.vue`, return a Whip session id only when `selectedWs` exists and `isBusyStatus(selectedWs.status)` is true.

After an eligible shortcut passes every guard, call `event.preventDefault()` and `event.stopImmediatePropagation()` before toggling. Do not consume disabled, repeated, unmatched, or ineligible events.

Make server validation reject `control` as a final key in addition to the canonical modifiers it already rejects; keep the frontend parser aligned and covered. Never accept or persist a modifier-only shortcut.

- [ ] **Step 6: Verify GREEN and quality gates**

Run the focused commands from Step 4, then:

```bash
npm run lint
npx tsc --noEmit
npm test
(cd src/client && npm test)
```

- [ ] **Step 7: Commit the final interaction fixes**

```bash
git add src/client/src/stores/workspace.ts src/client/src/pages/WorkspacePage.vue src/client/src/utils/whip-session.ts src/client/src/components/WorkspaceWhipControl.vue src/server/services/settings-service.ts src/client/src/__tests__/workspace-store.test.ts src/client/src/__tests__/whip-session.test.ts src/client/src/__tests__/WorkspaceWhipControl.test.ts src/__tests__/settings-service.test.ts src/client/src/__tests__/whip-shortcut.test.ts
git commit -m "fix(whip): keep session and shortcut state coherent"
```

After this task, rerun Task 6 and the final whole-branch review on the new HEAD.

### Task 9: Make fallback delivery and slow Whip interruption lifecycle-safe

**Files:**
- Modify: `src/server/services/agent/orchestrator.ts`
- Modify: `src/server/routes/workspaces.ts`
- Modify: `src/client/src/components/WorkspaceWhipControl.vue`
- Modify: `src/__tests__/agent/orchestrator.test.ts`
- Modify: `src/__tests__/routes-workspaces.test.ts`
- Modify: `src/__tests__/routes-workspaces-review.test.ts`
- Modify: `src/client/src/__tests__/WorkspaceWhipControl.test.ts`

**Interfaces:**
- Produces `sendMessageForFallback(workspaceId, content): Promise<'sent' | 'stopped'>`.
- Defers a fallback decision until the rejecting controller is removed or replaced; a replacement controller receives the message, while `stopped` authorizes a new resume.
- Keeps an accepted Whip crack alive until its coordinator promise settles, even when live workspace status becomes stopped; explicit close, disable, workspace change, and unmount still cancel immediately.

- [ ] **Step 1: Add RED orchestrator tests for controller turnover**

Use a real registered `SessionController` whose engine `sendMessage()` rejects while the controller remains in the map. Assert the fallback promise does not resolve immediately. Emit the real `session:ended` event and assert it resolves as `stopped`. Add a replacement-controller case: once the first controller ends and a replacement is registered, the message is steered to the replacement and the result is `sent`. Add a bounded timeout case so a permanently live rejecting controller never hangs the request or authorizes `startAgent`.

- [ ] **Step 2: Convert the five route fallback tests to the turnover contract**

Mock `sendMessageForFallback` as `stopped` to require one resume, and as `sent` to require no resume. Keep every endpoint's existing response assertions and the no-ghost-`user:message` review assertion. The route helper must call `startAgent` only after the orchestrator returns `stopped`; a timeout/replacement send failure returns the endpoint's existing clean error instead of attempting a concurrent start.

- [ ] **Step 3: Add a RED slow-interruption control test**

Make the mocked coordinator `enqueue()` return a deferred Promise. Open Whip, emit a crack, switch `running` to false, and advance fake time beyond the former 1 s grace. Assert the overlay and coordinator remain alive. Resolve the accepted crack and assert the overlay closes and disposal then occurs. Also retain tests proving explicit shortcut close, setting disable, workspace/session change, and unmount dispose immediately.

- [ ] **Step 4: Run focused tests and verify RED**

```bash
source /Users/enzovella/.nvm/nvm.sh && nvm use 24 >/dev/null
npx vitest run src/__tests__/agent/orchestrator.test.ts src/__tests__/routes-workspaces.test.ts src/__tests__/routes-workspaces-review.test.ts
(cd src/client && npx vitest run src/__tests__/WorkspaceWhipControl.test.ts)
```

- [ ] **Step 5: Implement minimal turnover delivery and crack-lifetime tracking**

In the orchestrator, capture the controller used for the first send. On rejection, wait with a short bounded poll until `controllers.get(workspaceId) !== captured`. If removed, return `stopped`. If replaced, send once to the replacement and return `sent`; never start a controller inside this function. Throw a descriptive timeout if the rejecting controller remains registered.

In routes, centralize the shared prompt delivery: use the new result, and call `startAgent(..., resume=true)` only for `stopped`. Update all five fallbacks to await that helper.

In the control, replace the fixed one-second grace timer with per-coordinator pending-action tracking. When `running` becomes false, close immediately only if no accepted action is pending; otherwise mark close-on-settle. A `finally` tied to the same coordinator closes after the last accepted action settles. Explicit `deactivate()` still disposes immediately and stale Promise callbacks must not mutate a replacement coordinator.

- [ ] **Step 6: Verify GREEN and quality gates**

Run Step 4, then `npm run lint`, `npx tsc --noEmit`, `npm test`, and client `npm test` under Node 24.

- [ ] **Step 7: Commit the lifecycle fixes**

```bash
git add src/server/services/agent/orchestrator.ts src/server/routes/workspaces.ts src/client/src/components/WorkspaceWhipControl.vue src/__tests__/agent/orchestrator.test.ts src/__tests__/routes-workspaces.test.ts src/__tests__/routes-workspaces-review.test.ts src/client/src/__tests__/WorkspaceWhipControl.test.ts
git commit -m "fix(whip): coordinate fallback and crack lifecycles"
```

After this task, rerun Task 6 and the final whole-branch review on the new HEAD.

---

### Task 10: Prevent persisted ghost prompts on Git action delivery failure

**Files:**
- Modify: `src/server/routes/workspaces.ts`
- Modify: `src/__tests__/routes-workspaces.test.ts`

**Interfaces:**
- `deliverAgentPrompt(...)` remains the single lifecycle-safe delivery helper and returns the actual recipient `agentSessionId`.
- `commit-with-agent`, `resolve-with-agent`, and `open-pr` persist `user:message` only after successful delivery.
- Existing HTTP status and `messageSent` response contracts remain unchanged on delivery failure.

- [x] **Step 1: Add RED route tests for non-persistence on failure**

Update the three replacement-rejection tests to require `wsService.emit` not to be called. Add success assertions that the event is emitted once with the `agentSessionId` returned by the lifecycle-safe sender, and stopped/start fallback assertions that it uses the newly started session id.

- [x] **Step 2: Verify RED**

Run:

```bash
source /Users/enzovella/.nvm/nvm.sh && nvm use 24 >/dev/null
npx vitest run src/__tests__/routes-workspaces.test.ts --maxWorkers=1
```

Expected: the three rejection cases expose the currently persisted ghost event, while the new session-attribution assertions fail where the routes ignore the delivery result.

- [x] **Step 3: Emit only after successful delivery**

Remove each pre-delivery `wsService.emit`. Await `deliverAgentPrompt`, capture its `agentSessionId`, set `messageSent = true`, then emit exactly once with the delivered prompt and that session id. On rejection, preserve each route's current response/status and do not emit.

- [x] **Step 4: Verify GREEN and regressions**

Run the Task 10 targeted file, then the Task 6 focused/full gates on the new HEAD.

- [x] **Step 5: Commit and request a fresh scoped review**

```bash
git add src/server/routes/workspaces.ts src/__tests__/routes-workspaces.test.ts docs/superpowers/plans/2026-08-05-kobo-whip-review-fixes.md
git commit -m "fix(agent): persist only delivered action prompts"
```

After approval, rerun Task 6 and the final whole-branch review on the new HEAD.

---

### Task 11: Ignore superseded session termination effects in the client

**Files:**
- Modify: `src/client/src/stores/workspace.ts`
- Modify: `src/client/src/stores/websocket.ts`
- Modify: `src/client/src/__tests__/websocket-dispatch.test.ts`

**Interfaces:**
- Track the latest active agent-session id per workspace from `session:started` events.
- Always append a superseded `session:ended` to history and clear state owned specifically by that old session.
- Apply workspace status, compacting, queued-message, subagent, refresh, notification, and Whip-affecting side effects only when the ended session is current (or the event has no usable session identity for legacy compatibility).

- [x] **Step 1: Add a RED A → B → late A termination test**

Dispatch `session:started(A)`, then `session:started(B)`, leave a B subagent and compacting indicator active, and dispatch `session:ended(A)`. Require the A event to remain in the stream while workspace status stays executing, B remains active, B subagents/compacting remain untouched, and no workspace refresh/notification occurs. Then end B and require the normal lifecycle effects.

- [x] **Step 2: Verify RED**

```bash
source /Users/enzovella/.nvm/nvm.sh && nvm use 24 >/dev/null
(cd src/client && npx vitest run src/__tests__/websocket-dispatch.test.ts --maxWorkers=1)
```

- [x] **Step 3: Track active session identity and gate global effects**

Add transient per-workspace active-session state/actions in the workspace store. Update it on every `session:started`, including replay. For `session:ended`, perform session-local cleanup first, then return early when another session owns the workspace. Move the workspace-level compacting/status/queue/subagent/fetch/notification effects behind that identity check and clear the active id only for the current termination.

- [x] **Step 4: Verify GREEN and lifecycle regressions**

Run the targeted WebSocket dispatch tests, workspace store tests, Whip session/control tests, then the full Task 6 gates.

- [x] **Step 5: Commit and request scoped/final reviews**

```bash
git add src/client/src/stores/workspace.ts src/client/src/stores/websocket.ts src/client/src/__tests__/websocket-dispatch.test.ts docs/superpowers/plans/2026-08-05-kobo-whip-review-fixes.md
git commit -m "fix(client): ignore superseded session termination"
```

After approval, rerun Task 6 and the final whole-branch review on the new HEAD.
