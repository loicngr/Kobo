// Assertions on the source, on the model of the plan-0 process-safety-net
// test. These three behaviours live inside Vue components, which this project
// does not unit-test; a source assertion is a regression guard against silent
// re-introduction, not a behavioural test.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// vitest runs with cwd = src/client
const readClient = (relative: string) => readFileSync(join(process.cwd(), relative), 'utf-8')
const readRepo = (relative: string) => readFileSync(join(process.cwd(), '../..', relative), 'utf-8')

describe('idle cost of an open tab', () => {
  it('does not pad the activity-feed chunk with an artificial timer', () => {
    const source = readClient('src/pages/WorkspacePage.vue')
    expect(source).not.toMatch(/setTimeout\(resolve, 500\)/)
    expect(source).toMatch(/defineAsyncComponent\(\(\) => import\('src\/components\/ActivityFeed\.vue'\)\)/)
  })

  it('skips the bulk workspace poll while the tab is hidden, and refreshes on return', () => {
    const source = readClient('src/components/WorkspaceList.vue')
    expect(source).toMatch(/document\.visibilityState === 'hidden'/)
    expect(source).toMatch(/addEventListener\('visibilitychange'/)
    expect(source).toMatch(/removeEventListener\('visibilitychange'/)
  })

  it('slows the voice-model poll down and stops swallowing its failures', () => {
    const source = readClient('src/pages/SettingsPage.vue')
    expect(source).toMatch(/VOICE_MODELS_POLL_MS = 2500/)
    expect(source).not.toMatch(/}, 800\)/)
    expect(source).not.toMatch(/fetchVoiceModels\(\)\.catch\(\(\) => \{\}\)/)
  })

  it('documents the interval the client actually uses', () => {
    const agents = readRepo('AGENTS.md')
    expect(agents).not.toMatch(/polls this endpoint every 30 s/)
    expect(agents).toMatch(/polls this endpoint every 15 s/)
  })
})
