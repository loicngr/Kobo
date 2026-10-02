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

  it('edits the workspace description from the Configure menu without a chat subheader', () => {
    const source = read('src/pages/WorkspacePage.vue')

    expect(source).toContain('workspace-description-input')
    expect(source).not.toContain('wp-subheader')
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

  it('shows the pinned latest-user preview at the top only after its card leaves the viewport', () => {
    const source = read('src/components/ActivityFeed.vue')

    expect(source).toContain('activity-feed-last-user')
    expect(source).toContain('top: 14px')
    expect(source).toContain('updateLatestUserTurnVisibility')
    expect(source).toContain('MAX_STICKY_USER_MESSAGE_LENGTH = 255')
    expect(source).toContain(['`', '$', '{content.slice(0, MAX_STICKY_USER_MESSAGE_LENGTH - 3)}', '...`'].join(''))
  })
})
