// Vérifie que le serveur installe ses filets de dernier recours.
// On n'importe PAS `index.ts` : son chargement démarre un vrai serveur HTTP.
// On lit donc la source et on vérifie la présence des gestionnaires. C'est un
// garde-fou contre une régression par suppression, pas un test de comportement
// — le comportement est couvert par la vérification manuelle de l'étape 5.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('process safety net', () => {
  const source = readFileSync(join(process.cwd(), 'src/server/index.ts'), 'utf-8')

  it('installs an uncaughtException handler', () => {
    expect(source).toMatch(/process\.on\(\s*'uncaughtException'/)
  })

  it('installs an unhandledRejection handler', () => {
    expect(source).toMatch(/process\.on\(\s*'unhandledRejection'/)
  })

  it('installs a SIGHUP handler', () => {
    expect(source).toMatch(/process\.on\(\s*'SIGHUP'/)
  })

  it('keeps stdout and stderr EPIPE from killing the process', () => {
    expect(source).toMatch(/process\.stdout\.on\(\s*'error'/)
    expect(source).toMatch(/process\.stderr\.on\(\s*'error'/)
  })

  // A crash that exits 0 lies to whatever supervises this process (systemd,
  // pm2, Docker): no restart, no alert, because "0" means "clean shutdown".
  // The two crash handlers below must pass a non-zero exit code through to
  // `gracefulShutdown`, while the normal signal handlers keep exiting 0.
  it('passes a non-zero exit code from the uncaughtException handler', () => {
    const handlerBlock = source.slice(source.indexOf("process.on('uncaughtException'"))
    const call = handlerBlock.match(/gracefulShutdown\(([^)]*)\)/)
    expect(call).not.toBeNull()
    expect(call?.[1]).toMatch(/,\s*1\s*$/)
  })

  it('passes a non-zero exit code from the unhandledRejection handler', () => {
    const handlerBlock = source.slice(source.indexOf("process.on('unhandledRejection'"))
    const call = handlerBlock.match(/gracefulShutdown\(([^)]*)\)/)
    expect(call).not.toBeNull()
    expect(call?.[1]).toMatch(/,\s*1\s*$/)
  })

  it('keeps normal signal handlers (SIGTERM, SIGINT, SIGHUP) exiting with code 0', () => {
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
      const handlerBlock = source.slice(source.indexOf(`process.on('${signal}'`))
      const call = handlerBlock.match(/gracefulShutdown\(([^)]*)\)/)
      expect(call).not.toBeNull()
      // No second argument (defaults to 0) — never a non-zero exit code.
      expect(call?.[1]).not.toMatch(/,/)
    }
  })

  it('declares gracefulShutdown with an exitCode parameter defaulting to 0', () => {
    expect(source).toMatch(/function gracefulShutdown\(signal: string, exitCode\s*=\s*0\)/)
  })
})
