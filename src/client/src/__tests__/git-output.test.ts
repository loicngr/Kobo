import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { needsScrollableOutput } from '../utils/git-output'

describe('needsScrollableOutput', () => {
  it('keeps a short one-line failure in a toast', () => {
    expect(needsScrollableOutput('fatal: not a git repository')).toBe(false)
  })

  it('sends multi-line git output to a scrollable dialog', () => {
    const conflict = [
      'CONFLICT (content): Merge conflict in src/a.ts',
      'CONFLICT (content): Merge conflict in src/b.ts',
      'Automatic merge failed; fix conflicts and then commit the result.',
    ].join('\n')
    expect(needsScrollableOutput(conflict)).toBe(true)
  })

  it('sends a long single line to a scrollable dialog too', () => {
    expect(needsScrollableOutput('x'.repeat(201))).toBe(true)
  })

  it('treats an empty message as inline', () => {
    expect(needsScrollableOutput('')).toBe(false)
    expect(needsScrollableOutput('   ')).toBe(false)
  })
})

// The old file content used to stay on screen under the NEW file's name,
// because disposeEditor() ran AFTER the request. Ordering is the whole fix,
// so lock it as source-level invariant — the component itself is not unit
// tested (type-check + manual smoke, per the project's testing discipline).
describe('DiffViewer load ordering', () => {
  const source = readFileSync(join(process.cwd(), 'src/components/DiffViewer.vue'), 'utf-8')

  it('disposes the editor before requesting the new file', () => {
    // `indexOf('disposeEditor()')` alone would match the FUNCTION DECLARATION
    // (`function disposeEditor() {`), which always precedes every call site in
    // source order regardless of the bug — so it can't tell a fixed file from
    // a broken one. Skip past the declaration to find the first CALL site.
    const definitionIdx = source.indexOf('function disposeEditor()')
    expect(definitionIdx).toBeGreaterThan(-1)
    const disposeCallIdx = source.indexOf('disposeEditor()', definitionIdx + 'function disposeEditor()'.length)
    const fetchIdx = source.indexOf('/diff-file?')
    expect(disposeCallIdx).toBeGreaterThan(-1)
    expect(fetchIdx).toBeGreaterThan(-1)
    expect(disposeCallIdx).toBeLessThan(fetchIdx)
  })

  it('records a load failure in a reactive state instead of only the console', () => {
    expect(source).toMatch(/fileLoadError\s*(\.value)?\s*=/)
  })
})
