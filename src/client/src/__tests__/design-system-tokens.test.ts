// Gardes F92 / F94. Motifs interdits : les classes de gris de Quasar (que
// DESIGN.md interdit nommément) et les couleurs hexadécimales en dur. Ce sont
// des tests de non-régression : ils empêchent la réintroduction d'un motif
// éliminé, ce qu'aucun test de rendu ne ferait aussi sûrement.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const CLIENT_ROOT = process.cwd()

function collectVueFiles(dir = join(CLIENT_ROOT, 'src'), out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) collectVueFiles(full, out)
    else if (full.endsWith('.vue')) out.push(full)
  }
  return out
}

function offenders(pattern: RegExp): string[] {
  const found: string[] = []
  for (const file of collectVueFiles()) {
    const hits = readFileSync(file, 'utf-8').match(pattern)
    if (hits) found.push(`${relative(CLIENT_ROOT, file)} → ${hits.length}× ${[...new Set(hits)].join(', ')}`)
  }
  return found
}

describe('design system tokens', () => {
  it('uses no Quasar grey class', () => {
    expect(offenders(/\b(?:text|bg)-grey(?:-[0-9]+)?\b/g)).toEqual([])
  })

  it('uses no Quasar grey colour prop', () => {
    expect(offenders(/color="grey(?:-[0-9]+)?"/g)).toEqual([])
  })

  it('uses no Quasar grey literal in a dynamic binding', () => {
    expect(offenders(/'grey(?:-[0-9]+)?'/g)).toEqual([])
  })

  it('hardcodes no hex colour in a component', () => {
    // The negative lookahead keeps Vue's `#default` slot shorthand out of the
    // match — without it, `#defa` reads as a 4-digit hex.
    const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-zA-Z])/g
    expect(offenders(HEX)).toEqual([])
  })

  it('hardcodes no hex colour in the global stylesheet', () => {
    // design-tokens.scss and quasar.variables.scss are the two files that are
    // ALLOWED to carry raw values — they are the source of truth. app.scss is
    // not: it must consume tokens like every other stylesheet.
    const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-zA-Z])/g
    const app = readFileSync(join(CLIENT_ROOT, 'src/css/app.scss'), 'utf-8')
    expect(app.match(HEX) ?? []).toEqual([])
  })
})
