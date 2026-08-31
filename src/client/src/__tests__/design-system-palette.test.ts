// Garde F93. La palette de Quasar n'avait jamais été alignée : $accent restait
// sur un violet interdit par DESIGN.md et les sémantiques sur les valeurs par
// défaut, ce qui faisait s'afficher 105 notifications d'erreur hors palette.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const CLIENT_ROOT = process.cwd()
const read = (p: string) => readFileSync(join(CLIENT_ROOT, p), 'utf-8')

// Source of truth: DESIGN.md § CSS Variables, mirrored in design-tokens.scss.
// --kobo-accent was rebranded to #665fdd in Task 2 (was #6c63ff); this test
// asserts against the current token value, not the pre-Task-2 one.
const TOKENS = {
  accent: '#665fdd',
  danger: '#f87171',
  success: '#34d399',
  warning: '#fbbf24',
  surface: '#222244',
}

function collectVueFiles(dir = join(CLIENT_ROOT, 'src'), out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) collectVueFiles(full, out)
    else if (full.endsWith('.vue')) out.push(full)
  }
  return out
}

describe('design system palette', () => {
  it('aligns the SCSS brand variables on the design tokens', () => {
    const scss = read('src/css/quasar.variables.scss')
    expect(scss).toMatch(new RegExp(`\\$primary:\\s*${TOKENS.accent}`))
    expect(scss).toMatch(new RegExp(`\\$negative:\\s*${TOKENS.danger}`))
    expect(scss).toMatch(new RegExp(`\\$positive:\\s*${TOKENS.success}`))
    expect(scss).toMatch(new RegExp(`\\$warning:\\s*${TOKENS.warning}`))
    expect(scss).not.toMatch(/#9c27b0|#c10015|#21ba45|#f2c037|#31ccec|#26a69a/)
  })

  it('aligns the runtime brand config on the same values', () => {
    const conf = read('quasar.config.ts')
    expect(conf).not.toMatch(/#9c27b0|#c10015|#21ba45|#f2c037|#31ccec|#26a69a/)
    expect(conf).toMatch(new RegExp(`negative:\\s*'${TOKENS.danger}'`))
    expect(conf).toMatch(/boot:\s*\[[^\]]*'notify-theme'/)
  })

  it('registers notification types with a foreground that clears AA', () => {
    const boot = read('src/boot/notify-theme.ts')
    for (const type of ['negative', 'positive', 'warning', 'info']) {
      expect(boot).toMatch(new RegExp(`registerType\\('${type}'`))
    }
    // White on --kobo-danger measures 2.77:1. The dark ink measures 6.17:1.
    expect(boot).not.toMatch(/textColor:\s*'white'/)
    expect(boot).toMatch(/textColor:\s*'kobo-ink'/)
  })

  it('leaves no competing accent hue in the components', () => {
    // Only the per-project colour palette may keep Material hues: it is user
    // content mirrored by the backend (src/shared/project-colors.ts).
    const files = collectVueFiles()
    const offenders = files.filter((f) => /\b(indigo|deep-purple|purple)-[0-9]/.test(readFileSync(f, 'utf-8')))
    expect(offenders).toEqual([])
  })
})
