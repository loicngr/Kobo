import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const CLIENT_ROOT = process.cwd()
const read = (path: string) => readFileSync(join(CLIENT_ROOT, path), 'utf-8')

describe('workspace UI layout', () => {
  it('keeps the active-session model badge readable', () => {
    const source = read('src/pages/WorkspacePage.vue')

    expect(source).toMatch(/color="primary"\s+text-color="white"/)
  })

  it('moves the engine switch control to the tools drawer', () => {
    const tools = read('src/components/ToolsPanel.vue')
    const workspace = read('src/pages/WorkspacePage.vue')

    expect(tools).toContain('<EngineSwitchButton')
    expect(workspace).not.toContain("$t('workspacePage.switchEngine')")
  })

  it('does not render the last-agent-event label below the feed', () => {
    const source = read('src/pages/WorkspacePage.vue')

    expect(source).not.toContain('<AgentLivenessChip')
  })

  it('anchors the feed after the virtual list has painted', () => {
    const source = read('src/components/ActivityFeed.vue')
    const initialScroll = source.slice(
      source.indexOf('async function armInitialScroll'),
      source.indexOf('// Count of events'),
    )

    // Re-anchors frame by frame until the measured height stops changing:
    // virtual scroll only knows real turn heights once they have painted.
    expect(initialScroll).toContain('await nextFrame()')
    expect(initialScroll).toContain('stableFrames < SETTLE_STABLE_FRAMES')
  })
})
