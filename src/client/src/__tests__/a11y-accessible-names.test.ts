// Garde F97. Une infobulle n'est PAS un nom accessible : q-tooltip rend un
// nœud détaché, sans aria-describedby ni aria-labelledby, donc invisible pour
// l'arbre d'accessibilité tant que le survol n'a pas eu lieu. Ce test verrouille
// la présence de vrais aria-label sur les surfaces les plus utilisées.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const CLIENT_ROOT = process.cwd()
const read = (p: string) => readFileSync(join(CLIENT_ROOT, p), 'utf-8')

describe('accessible names', () => {
  it('labels every tab of the right drawer', () => {
    const source = read('src/layouts/MainLayout.vue')
    // Negative lookahead excludes `<q-tab-panel(s)`, which also matches
    // `\b` after "tab" since `-` is a non-word character.
    const tabs = source.match(/<q-tab(?!-)\b[\s\S]*?(?:\/>|<\/q-tab>)/g) ?? []
    expect(tabs).toHaveLength(8)
    for (const tab of tabs) {
      expect(tab, tab).toMatch(/:aria-label="/)
    }
  })

  it('labels every icon-only button of the workspace list header', () => {
    const source = read('src/components/WorkspaceList.vue')
    const header = source.slice(0, source.indexOf('<!-- Scrollable groups -->'))
    const buttons = header.match(/<q-btn\b[\s\S]*?(?:\/>|<\/q-btn>)/g) ?? []
    expect(buttons.length).toBeGreaterThanOrEqual(7)
    for (const button of buttons) {
      expect(button, button).toMatch(/:aria-label="/)
    }
  })

  it('makes the collapsible group headers operable and self-describing', () => {
    const source = read('src/components/WorkspaceList.vue')
    const headers = source.match(/class="wl-group-header[\s\S]{0,400}?>/g) ?? []
    expect(headers).toHaveLength(4)
    for (const header of headers) {
      // `role="group"` (not `role="button"`) — the header sits directly inside
      // a `role="listbox"` container, and ARIA only allows `option`/`group`
      // children there. Keyboard operability is preserved via the existing
      // tabindex + keydown handlers, not native button semantics.
      expect(header, header).toMatch(/role="group"/)
      expect(header, header).toMatch(/tabindex="0"/)
      expect(header, header).toMatch(/:aria-expanded="/)
      expect(header, header).toMatch(/aria-labelledby="/)
      expect(header, header).toMatch(/@keydown\.enter/)
      expect(header, header).toMatch(/@keydown\.space/)
    }
  })

  it('labels the activity feed navigation buttons', () => {
    const source = read('src/components/ActivityFeed.vue')
    const cluster = source.slice(source.indexOf('activity-feed-nav-cluster'))
    const buttons = cluster.match(/<q-btn\b[\s\S]*?\/>/g) ?? []
    expect(buttons).toHaveLength(2)
    for (const button of buttons) expect(button, button).toMatch(/:aria-label="/)
  })
})
