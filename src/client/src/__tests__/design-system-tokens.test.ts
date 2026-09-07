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

  it('keeps --kobo-accent-rgb in sync with --kobo-accent', () => {
    const tokens = readFileSync(join(CLIENT_ROOT, 'src/css/design-tokens.scss'), 'utf-8')
    const hexMatch = tokens.match(/--kobo-accent:\s*#([0-9a-fA-F]{6})/)
    const rgbMatch = tokens.match(/--kobo-accent-rgb:\s*([\d]+),\s*([\d]+),\s*([\d]+)/)
    expect(hexMatch, 'expected --kobo-accent to be defined as a 6-digit hex value').toBeTruthy()
    expect(rgbMatch, 'expected --kobo-accent-rgb to be defined as an r, g, b triplet').toBeTruthy()
    const hex = hexMatch![1]
    const expectedR = parseInt(hex.slice(0, 2), 16)
    const expectedG = parseInt(hex.slice(2, 4), 16)
    const expectedB = parseInt(hex.slice(4, 6), 16)
    expect([Number(rgbMatch![1]), Number(rgbMatch![2]), Number(rgbMatch![3])]).toEqual([
      expectedR,
      expectedG,
      expectedB,
    ])
  })
})

describe('design system token references', () => {
  const tokenSheet = readFileSync(join(CLIENT_ROOT, 'src/css/design-tokens.scss'), 'utf-8')
  const globalSheet = readFileSync(join(CLIENT_ROOT, 'src/css/app.scss'), 'utf-8')
  const definedTokens = new Set([...tokenSheet.matchAll(/--(kobo-[a-z0-9-]+)\s*:/g)].map((m) => m[1]))
  const colourClasses = new Set([...globalSheet.matchAll(/'(kobo-[a-z0-9-]+)':/g)].map((m) => m[1]))

  // A `var(--kobo-surface-1)` that does not exist is not an error anywhere:
  // the browser drops the declaration and the element silently keeps whatever
  // it inherited. Only a test can see it.
  it('references only CSS variables that design-tokens.scss defines', () => {
    const missing: string[] = []
    for (const file of [...collectVueFiles(), join(CLIENT_ROOT, 'src/css/app.scss')]) {
      const source = readFileSync(file, 'utf-8')
      for (const m of source.matchAll(/var\(--(kobo-[a-z0-9-]+)/g)) {
        if (!definedTokens.has(m[1]!)) missing.push(`${relative(CLIENT_ROOT, file)} → --${m[1]}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('uses only colour classes that the $kobo-colors map generates', () => {
    const missing: string[] = []
    for (const file of collectVueFiles()) {
      const source = readFileSync(file, 'utf-8')
      const used = [
        ...source.matchAll(/\b(?:text|bg)-(kobo-[a-z0-9-]+)/g),
        ...source.matchAll(/color="(kobo-[a-z0-9-]+)"/g),
        ...source.matchAll(/`(?:text|bg)-\$\{[^}]*\}`/g),
      ]
      for (const m of used) {
        const name = m[1]
        if (name && !colourClasses.has(name)) missing.push(`${relative(CLIENT_ROOT, file)} → ${name}`)
      }
      // A file that builds `text-${x}` / `bg-${x}` at runtime feeds it string
      // literals; those must be colour classes too. Elsewhere a 'kobo-…'
      // literal is something else (a Monaco theme name, say).
      if (/`(?:text|bg)-\$\{/.test(source)) {
        for (const m of source.matchAll(/'(kobo-[a-z0-9-]+)'/g)) {
          if (!colourClasses.has(m[1]!)) missing.push(`${relative(CLIENT_ROOT, file)} → '${m[1]}'`)
        }
      }
    }
    expect(missing).toEqual([])
  })
})
