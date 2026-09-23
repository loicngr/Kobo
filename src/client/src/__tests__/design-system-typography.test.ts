// Garde F91. Le jeton de police existait déjà mais n'était consommé par
// AUCUNE règle CSS : l'interface rendait en Roboto, interdite par DESIGN.md.
// Ce test verrouille les quatre maillons de la chaîne : les fichiers vendorés,
// leur déclaration @font-face locale, la liaison vers la variable Quasar, et
// l'absence de la police concurrente.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const CLIENT_ROOT = process.cwd()
const read = (p: string) => readFileSync(join(CLIENT_ROOT, p), 'utf-8')

describe('design system typography', () => {
  it('vendors the Geist woff2 files and their licence', () => {
    for (const file of [
      'public/fonts/Geist-Variable.woff2',
      'public/fonts/GeistMono-Variable.woff2',
      'public/fonts/GEIST-LICENSE.txt',
    ]) {
      expect(existsSync(join(CLIENT_ROOT, file)), `${file} is missing`).toBe(true)
    }
    // Un woff2 variable de Geist pèse ~70 Ko : un fichier quasi vide voudrait
    // dire que l'extraction a échoué et que la police ne chargera pas.
    expect(statSync(join(CLIENT_ROOT, 'public/fonts/Geist-Variable.woff2')).size).toBeGreaterThan(20_000)
    expect(statSync(join(CLIENT_ROOT, 'public/fonts/GeistMono-Variable.woff2')).size).toBeGreaterThan(20_000)
  })

  it('declares both faces locally and never through Google Fonts', () => {
    const css = read('src/css/fonts.scss')
    expect(css).toMatch(/font-family:\s*'Geist'/)
    expect(css).toMatch(/font-family:\s*'Geist Mono'/)
    expect(css).toMatch(/url\('\/fonts\/Geist-Variable\.woff2'\)/)
    expect(css).toMatch(/url\('\/fonts\/GeistMono-Variable\.woff2'\)/)
    expect(css).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/)
    expect(read('src/css/app.scss')).toMatch(/@import\s+'fonts'/)
  })

  it('binds the sans token to the rule that actually paints the document', () => {
    expect(read('src/css/quasar.variables.scss')).toMatch(/\$typography-font-family\s*:\s*var\(--kobo-font-sans\)/)
  })

  it('no longer ships the competing Roboto extra', () => {
    expect(read('quasar.config.ts')).not.toMatch(/roboto-font/)
  })
})
