// Garde F95. Le zoom par pincement était bloqué (WCAG 1.4.4) et la racine du
// document ne déclarait aucune langue, sur une application qui en parle cinq.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyDocumentLocale } from '../i18n'

const html = readFileSync(join(process.cwd(), 'index.html'), 'utf-8')

describe('document locale and zoom', () => {
  it('never blocks pinch zoom', () => {
    expect(html).not.toMatch(/user-scalable\s*=\s*no/)
    expect(html).not.toMatch(/maximum-scale/)
    expect(html).not.toMatch(/minimum-scale/)
  })

  it('still declares a responsive viewport', () => {
    expect(html).toMatch(/width=device-width/)
    expect(html).toMatch(/initial-scale=1/)
  })

  it('declares a language on the root element', () => {
    expect(html).toMatch(/<html\s+lang="[a-z]{2}"/)
  })

  it('mirrors the active locale onto the document', () => {
    applyDocumentLocale('de')
    expect(document.documentElement.lang).toBe('de')
    applyDocumentLocale('fr')
    expect(document.documentElement.lang).toBe('fr')
  })
})
