# Kōbō Whip MP3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the synthesized whip crack with the supplied `fouet-ahh.mp3` recording.

**Architecture:** Store the recording as a Vite-managed client asset and keep `playWhipCrack` as the single playback boundary. Each accepted crack creates its own `HTMLAudioElement`, which preserves overlapping playback while continuing to honor Kōbō's enabled and volume preferences.

**Tech Stack:** Vue 3 client, TypeScript, Vite asset imports, HTML Audio, Vitest.

## Global Constraints

- The MP3 fully replaces the synthesized oscillator sound; there is no synthesized fallback.
- Source asset: `/Users/enzovella/Desktop/leWebFrancais/fouet-ahh.mp3`.
- Repository asset: `src/client/src/assets/audio/fouet-ahh.mp3`.
- Keep the existing `playWhipCrack(options: WhipAudioOptions): void` public API.
- Audio-disabled and zero-volume calls must create no player.
- Rapid cracks must use distinct players so playback may overlap.
- Playback failures must not interrupt whip interaction or message dispatch.
- Do not add dependencies or change the settings UI.

---

### Task 1: Replace synthesized playback with the recorded MP3

**Files:**
- Create: `src/client/src/assets/audio/fouet-ahh.mp3`
- Modify: `src/client/src/utils/whip-audio.ts`
- Test: `src/client/src/__tests__/whip-audio.test.ts`

**Interfaces:**
- Consumes: the existing `WhipAudioOptions.enabled` and `WhipAudioOptions.volume` values from `WhipOverlay.vue`.
- Produces: `playWhipCrack(options: WhipAudioOptions): void`, with an optional test seam `createAudio?: (source: string) => HTMLAudioElement`.

- [ ] **Step 1: Replace the oscillator assertions with failing recorded-audio tests**

Replace `createFakeAudioContext` and the synthesis test in
`src/client/src/__tests__/whip-audio.test.ts` with a player factory and these
behaviors:

```ts
function createFakeAudio() {
  const players: Array<{ volume: number; play: ReturnType<typeof vi.fn> }> = []
  const createAudio = vi.fn((_source: string) => {
    const player = { volume: 0, play: vi.fn(async () => undefined) }
    players.push(player)
    return player as unknown as HTMLAudioElement
  })
  return { createAudio, players }
}

it('does not create a player when sound is disabled or silent', () => {
  const { createAudio } = createFakeAudio()

  playWhipCrack({ enabled: false, volume: 1, createAudio })
  playWhipCrack({ enabled: true, volume: 0, createAudio })

  expect(createAudio).not.toHaveBeenCalled()
})

it('plays the recorded asset at clamped volume with a new player per crack', () => {
  const { createAudio, players } = createFakeAudio()

  playWhipCrack({ enabled: true, volume: 2, createAudio })
  playWhipCrack({ enabled: true, volume: 0.4, createAudio })

  expect(createAudio).toHaveBeenCalledTimes(2)
  expect(createAudio.mock.calls[0]?.[0]).toContain('fouet-ahh.mp3')
  expect(players[0]?.volume).toBe(1)
  expect(players[1]?.volume).toBe(0.4)
  expect(players[0]?.play).toHaveBeenCalledOnce()
  expect(players[1]?.play).toHaveBeenCalledOnce()
})

it('swallows rejected playback', async () => {
  const createAudio = vi.fn(() => ({
    volume: 0,
    play: vi.fn(async () => Promise.reject(new Error('blocked'))),
  }) as unknown as HTMLAudioElement)

  expect(() => playWhipCrack({ enabled: true, volume: 1, createAudio })).not.toThrow()
  await Promise.resolve()
})
```

- [ ] **Step 2: Run the focused test and confirm the red state**

Run:

```bash
cd src/client
npx vitest run src/__tests__/whip-audio.test.ts
```

Expected: FAIL because `createAudio` is not used and no recorded player starts.

- [ ] **Step 3: Copy the approved recording into the Vite asset tree**

Run from the repository root:

```bash
mkdir -p src/client/src/assets/audio
cp /Users/enzovella/Desktop/leWebFrancais/fouet-ahh.mp3 \
  src/client/src/assets/audio/fouet-ahh.mp3
```

Verify the copy is byte-identical:

```bash
shasum -a 256 \
  /Users/enzovella/Desktop/leWebFrancais/fouet-ahh.mp3 \
  src/client/src/assets/audio/fouet-ahh.mp3
```

Expected: both SHA-256 values are identical.

- [ ] **Step 4: Implement minimal HTML Audio playback**

Replace `src/client/src/utils/whip-audio.ts` with:

```ts
import whipSoundUrl from 'src/assets/audio/fouet-ahh.mp3'

export interface WhipAudioOptions {
  enabled: boolean
  volume: number
  createAudio?: (source: string) => HTMLAudioElement
}

export function playWhipCrack(options: WhipAudioOptions): void {
  const volume = Math.max(0, Math.min(1, options.volume))
  if (!options.enabled || volume === 0) return

  try {
    const audio = options.createAudio?.(whipSoundUrl) ?? new Audio(whipSoundUrl)
    audio.volume = volume
    void audio.play().catch(() => undefined)
  } catch {
    // Browsers can reject audio construction or playback.
  }
}
```

- [ ] **Step 5: Run focused tests and confirm the green state**

Run:

```bash
cd src/client
npx vitest run src/__tests__/whip-audio.test.ts \
  src/__tests__/WhipOverlay.test.ts \
  src/__tests__/WorkspaceWhipControl.test.ts
```

Expected: all three files pass, including recorded playback, overlay crack
dispatch, and workspace preference wiring.

- [ ] **Step 6: Verify formatting, the client suite, and production bundling**

Run from the repository root:

```bash
npx biome check src/client/src/utils/whip-audio.ts \
  src/client/src/__tests__/whip-audio.test.ts
cd src/client
npm test
npx quasar build
```

Expected: Biome exits 0, all client tests pass, and the Quasar build succeeds
with a fingerprinted `fouet-ahh` MP3 in `dist/spa/assets/`.

- [ ] **Step 7: Commit the recorded sound replacement**

Run from the repository root:

```bash
git add src/client/src/assets/audio/fouet-ahh.mp3 \
  src/client/src/utils/whip-audio.ts \
  src/client/src/__tests__/whip-audio.test.ts
git commit -m "feat(whip): use recorded crack sound"
```

---

## Final Verification

Run from the repository root:

```bash
git status --short
git diff --check origin/develop...HEAD
npx tsc --noEmit
npx vitest run --config vitest.config.ts --root . --testTimeout=15000
```

Expected: the worktree is clean, the diff has no whitespace errors, backend
TypeScript passes, and all root tests pass with the repository's known
load-sensitive tests given the verified 15-second budget.
