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

  it('routes workspace memory only through its launch capability before the global dialogue bridge', () => {
    const memoryDispatch = source.indexOf('if (isMemoryToolName(name))')
    const globalBridge = source.indexOf('callWorkspaceDialogueTool(')
    expect(memoryDispatch).toBeGreaterThan(-1)
    expect(globalBridge).toBeGreaterThan(memoryDispatch)
    expect(source).toContain('KOBO_MEMORY_SESSION_TOKEN')
    expect(source).toContain('if (!process.env.KOBO_MEMORY_SESSION_TOKEN)')
    expect(source).toContain('if (!workspaceId)')
  })

  it('exposes external memory only in global stdio, not the workspace-bound catalogue', () => {
    const globalToolsStart = source.indexOf('const GLOBAL_TOOLS')
    const globalToolsEnd = source.indexOf('/**\n * Tool names callable', globalToolsStart)
    expect(source.slice(globalToolsStart, globalToolsEnd)).toContain('EXTERNAL_MEMORY_TOOL_DEFINITIONS')
    expect(source).toContain('...MEMORY_TOOL_DEFINITIONS')
    expect(source).toContain('GLOBAL_TOOLS.filter((tool) => !isMemoryToolName(tool.name))')
  })
})
