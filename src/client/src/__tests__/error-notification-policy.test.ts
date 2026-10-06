// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { ERROR_NOTIFICATION_DEFAULTS } from '../utils/notification-timeout'

describe('error notification policy', () => {
  it('keeps errors visible with an explicit close button', () => {
    expect(ERROR_NOTIFICATION_DEFAULTS).toEqual({ timeout: 0, closeBtn: true })
    const boot = readFileSync(new URL('../boot/notify-theme.ts', import.meta.url), 'utf8')
    expect(boot).toMatch(/registerType\('negative',\s*\{\s*\.\.\.ERROR_NOTIFICATION_DEFAULTS/)
  })

  it('does not override persistent errors with a finite timeout at call sites', () => {
    const violations: string[] = []
    function visitDirectory(directory: string) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') visitDirectory(file)
          continue
        }
        if (!/\.(ts|vue)$/.test(file)) continue
        const raw = readFileSync(file, 'utf8')
        const text = file.endsWith('.vue') ? (/<script\b[^>]*>([\s\S]*?)<\/script>/.exec(raw)?.[1] ?? '') : raw
        const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
        function visit(node: ts.Node) {
          if (ts.isObjectLiteralExpression(node)) {
            const property = (name: string) =>
              node.properties.find(
                (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(source) === name,
              )
            const type = property('type')?.initializer
            const timeout = property('timeout')?.initializer
            if (
              type &&
              ts.isStringLiteral(type) &&
              type.text === 'negative' &&
              timeout &&
              timeout.getText(source) !== '0'
            ) {
              violations.push(path.relative(directory, file))
            }
          }
          ts.forEachChild(node, visit)
        }
        visit(source)
      }
    }
    visitDirectory(fileURLToPath(new URL('..', import.meta.url)))
    expect(violations).toEqual([])
  })
})
