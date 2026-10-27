// Le serveur MCP est lancé UNE FOIS PAR WORKSPACE, sur le même fichier de
// base. `runMigrations` calcule l'ensemble des blocs appliqués avant de
// prendre le verrou : deux process concurrents peuvent donc rejouer le même
// bloc, et quatorze blocs ajoutent des colonnes sans garde. Le bootstrap MCP
// ne doit jamais migrer — le backend l'a déjà fait à son démarrage.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { createManagedMcpDispatcher } from '../mcp-server/managed-mcp-dispatcher.js'
import { EXTERNAL_MEMORY_TOOL_DEFINITIONS, isMemoryToolName, MEMORY_TOOL_DEFINITIONS } from '../shared/memory-tools.js'

describe('mcp tasks server bootstrap', () => {
  const source = readFileSync(join(process.cwd(), 'src/mcp-server/kobo-tasks-server.ts'), 'utf-8')

  it('never runs migrations', () => {
    expect(source).not.toMatch(/runMigrations\s*\(/)
  })

  it('does not import runMigrations', () => {
    expect(source).not.toMatch(/import[^\n]*runMigrations/)
  })

  it('routes workspace memory only through its launch capability before the global dialogue bridge', () => {
    const source = readFileSync(join(process.cwd(), 'src/mcp-server/managed-mcp-dispatcher.ts'), 'utf-8')
    const memoryDispatch = source.indexOf('if (isMemoryToolName(name))')
    const globalBridge = source.indexOf('WORKSPACE_DIALOGUE_TOOLS.some((tool) => tool.name === name)')
    expect(memoryDispatch).toBeGreaterThan(-1)
    expect(globalBridge).toBeGreaterThan(memoryDispatch)
    expect(source).toContain('KOBO_MEMORY_SESSION_TOKEN')
    expect(source).toContain('if (!env.KOBO_MEMORY_SESSION_TOKEN)')
    expect(source).toContain('if (!workspaceId)')
  })

  it('exposes external memory only in global stdio, not the workspace-bound catalogue', () => {
    const db = new Database(':memory:')
    try {
      const context = {
        db,
        backendUrl: 'http://kobo.internal',
        env: {},
        backendRequest: async () => null,
      }
      const globalTools = createManagedMcpDispatcher(context).availableTools()
      const managedTools = createManagedMcpDispatcher({ ...context, workspaceId: 'own' }).availableTools()
      expect(globalTools.filter((tool) => isMemoryToolName(tool.name))).toEqual(EXTERNAL_MEMORY_TOOL_DEFINITIONS)
      expect(managedTools.filter((tool) => isMemoryToolName(tool.name))).toEqual(MEMORY_TOOL_DEFINITIONS)
    } finally {
      db.close()
    }
  })
})
