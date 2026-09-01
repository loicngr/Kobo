// Garde de la correction de la paire accent / accent-fg. DESIGN.md prescrivait
// #6c63ff avec du texte blanc : 4.32:1, sous le seuil AA de 4.5:1, sur le bouton
// principal du produit. Ce test recalcule les ratios depuis les jetons plutôt
// que de vérifier une constante, pour que toute future dérive soit détectée.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const tokens = readFileSync(join(process.cwd(), 'src/css/design-tokens.scss'), 'utf-8')

function token(name: string): string {
  const match = tokens.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))
  if (!match?.[1]) throw new Error(`token --${name} not found in design-tokens.scss`)
  return match[1]
}

/** WCAG 2.1 relative luminance, sRGB. */
function luminance(hex: string): number {
  const channels = [1, 3, 5]
    .map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
}

function ratio(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)]
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

describe('design system contrast', () => {
  const accent = () => token('kobo-accent')
  const accentHover = () => token('kobo-accent-hover')
  const accentFg = () => token('kobo-accent-fg')
  const bg = () => token('kobo-bg')
  const surface = () => token('kobo-surface')

  it('clears AA for the prescribed accent-fg on accent — the primary CTA', () => {
    expect(ratio(accentFg(), accent())).toBeGreaterThanOrEqual(4.5)
  })

  it('keeps the accent identifiable as a UI component on both dark grounds', () => {
    // WCAG 1.4.11: 3:1 for non-text UI components (active border, focus ring).
    // 4.5:1 on BOTH sides is mathematically impossible — white-on-accent needs
    // Y <= 0.1833 while accent-as-text needs Y >= 0.2270. Hence the 3:1 rule
    // here, and the ban on using the accent as a text colour.
    expect(ratio(accent(), bg())).toBeGreaterThanOrEqual(3)
    expect(ratio(accent(), surface())).toBeGreaterThanOrEqual(3)
  })

  it('keeps the hover state readable and darker than the resting state', () => {
    expect(ratio(accentFg(), accentHover())).toBeGreaterThanOrEqual(4.5)
    expect(luminance(accentHover())).toBeLessThan(luminance(accent()))
  })

  it('uses a text token, not the filled-button accent, for primary outline controls', () => {
    const globalStyles = readFileSync(join(process.cwd(), 'src/css/app.scss'), 'utf-8')

    expect(globalStyles).toMatch(/\.q-btn--outline\.text-primary[\s\S]*?color:\s*var\(--kobo-text-2\)/)
  })

  it('clears AA for every text token on every ground', () => {
    for (const text of ['kobo-text', 'kobo-text-2', 'kobo-text-3']) {
      for (const ground of ['kobo-bg', 'kobo-bg-deep', 'kobo-surface', 'kobo-surface-2', 'kobo-hover']) {
        expect(ratio(token(text), token(ground)), `${text} on ${ground}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('clears AA for the dark ink used on every semantic fill', () => {
    for (const semantic of ['kobo-danger', 'kobo-success', 'kobo-warning']) {
      expect(ratio(token('kobo-bg'), token(semantic)), semantic).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('documents the measured ratios in DESIGN.md', () => {
    const design = readFileSync(join(process.cwd(), '../../DESIGN.md'), 'utf-8')
    expect(design).not.toMatch(/#6c63ff/)
    expect(design).toMatch(new RegExp(accent(), 'i'))
    // The palette block must carry the numbers, so the next reader cannot
    // reintroduce a sub-AA pairing without seeing the constraint.
    expect(design).toMatch(/4,5:1|4\.5:1/)
  })
})
