// Le serveur MCP est lancé UNE FOIS PAR WORKSPACE, sur le même fichier de
// base. `runMigrations` calcule l'ensemble des blocs appliqués avant de
// prendre le verrou : deux process concurrents peuvent donc rejouer le même
// bloc, et quatorze blocs ajoutent des colonnes sans garde. Le bootstrap MCP
// ne doit jamais migrer — le backend l'a déjà fait à son démarrage.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('mcp tasks server bootstrap', () => {
  const source = readFileSync(join(process.cwd(), 'src/mcp-server/kobo-tasks-server.ts'), 'utf-8')

  it('never runs migrations', () => {
    expect(source).not.toMatch(/runMigrations\s*\(/)
  })

  it('does not import runMigrations', () => {
    expect(source).not.toMatch(/import[^\n]*runMigrations/)
  })
})
