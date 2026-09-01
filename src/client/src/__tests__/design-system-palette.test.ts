// Garde F93. La palette de Quasar n'avait jamais été alignée : $accent restait
// sur un violet interdit par DESIGN.md et les sémantiques sur les valeurs par
// défaut, ce qui faisait s'afficher 105 notifications d'erreur hors palette.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const CLIENT_ROOT = process.cwd()
const read = (p: string) => readFileSync(join(CLIENT_ROOT, p), 'utf-8')

// The current visual comparison deliberately restores Quasar's previous brand
// palette. Keep SCSS and runtime configuration aligned so the comparison is
// reproducible, while design-tokens.scss remains the component token source.
const QUASAR_BRAND = {
  primary: '#6c63ff',
  secondary: '#26a69a',
  accentLegacy: '#9c27b0',
  positive: '#21ba45',
  negative: '#c10015',
  info: '#31ccec',
  warning: '#f2c037',
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
  it('keeps the SCSS comparison palette explicit', () => {
    const scss = read('src/css/quasar.variables.scss')
    expect(scss).toMatch(new RegExp(`\\$primary:\\s*${QUASAR_BRAND.primary}`))
    expect(scss).toMatch(new RegExp(`\\$secondary:\\s*${QUASAR_BRAND.secondary}`))
    expect(scss).toMatch(new RegExp(`\\$accent:\\s*${QUASAR_BRAND.accentLegacy}`))
    expect(scss).toMatch(new RegExp(`\\$negative:\\s*${QUASAR_BRAND.negative}`))
    expect(scss).toMatch(new RegExp(`\\$positive:\\s*${QUASAR_BRAND.positive}`))
    expect(scss).toMatch(new RegExp(`\\$warning:\\s*${QUASAR_BRAND.warning}`))
  })

  it('aligns the runtime brand config on the comparison palette', () => {
    const conf = read('quasar.config.ts')
    for (const value of Object.values(QUASAR_BRAND)) expect(conf).toContain(value)
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
