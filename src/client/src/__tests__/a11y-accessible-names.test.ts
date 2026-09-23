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

  // Extracts every `<q-btn ...>` OPENING TAG that carries an `icon=`/`:icon=`
  // attribute AND has no visible `label`/`:label` attribute of its own — i.e.
  // the icon is the only affordance a sighted user sees, so a screen reader
  // needs :aria-label to get a name at all. A labelled icon+text button is
  // intentionally excluded: its visible text is already an accessible name.
  //
  // Classification runs on the opening tag ONLY (icon, label, and :aria-label
  // all live there): a quote-aware matcher stops at the tag's own closing `>`,
  // so a labelled descendant inside a paired q-btn (e.g. a q-input in its
  // q-menu) can never reclassify the outer button as "has visible label".
  // `(?!-)` intentionally excludes `<q-btn-dropdown>`/`<q-btn-toggle>`,
  // matching the q-tab test's idiom above.
  function iconOnlyButtons(source: string): string[] {
    const tags = source.match(/<q-btn(?!-)\b(?:[^>"']|"[^"]*"|'[^']*')*>/g) ?? []
    return tags.filter((t) => /\bicon=/.test(t) && !/(?<!aria-)\blabel="/.test(t))
  }

  it('labels every icon-only button of the git panel', () => {
    const source = read('src/components/GitPanel.vue')
    const buttons = iconOnlyButtons(source)
    expect(buttons.length).toBeGreaterThanOrEqual(3)
    for (const button of buttons) expect(button, button).toMatch(/:aria-label="/)
  })

  it('labels every icon-only button of the diff viewer', () => {
    const source = read('src/components/DiffViewer.vue')
    const buttons = iconOnlyButtons(source)
    expect(buttons.length).toBeGreaterThanOrEqual(5)
    for (const button of buttons) expect(button, button).toMatch(/:aria-label="/)
  })

  it('labels every icon-only button of the workspace card', () => {
    const source = read('src/components/WorkspaceCard.vue')
    const buttons = iconOnlyButtons(source)
    for (const button of buttons) expect(button, button).toMatch(/:aria-label="/)
  })

  it('labels every icon-only button of the PR panel', () => {
    const source = read('src/components/PrPanel.vue')
    const buttons = iconOnlyButtons(source)
    for (const button of buttons) expect(button, button).toMatch(/:aria-label="/)
  })
})
