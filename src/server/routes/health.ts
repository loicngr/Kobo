import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { Hono } from 'hono'
import { getDb } from '../db/index.js'
import { SCHEMA_VERSION } from '../db/migrations.js'
import { getGlobalSettings, getProjectSettings, SETTINGS_SCHEMA_VERSION } from '../services/settings-service.js'
import { getDbPath, getKoboHome } from '../utils/paths.js'
import { slugifyProjectName } from '../utils/project-slug.js'
import { resolveWorkspaceWorktreePath } from '../utils/worktree-paths.js'

const app = new Hono()

interface WorktreeCheck {
  workspaceId: string
  name: string
  path: string
  exists: boolean
}

interface HealthReport {
  koboHome: string
  db: {
    path: string
    sizeBytes: number | null
    schemaVersion: number
    currentSchemaVersion: number
  }
  settings: {
    schemaVersion: number
  }
  claudeCli: {
    available: boolean
    version: string | null
  }
  workspaces: {
    total: number
    archived: number
    worktreesMissing: WorktreeCheck[]
  }
  agentSessions: {
    orphaned: number
  }
  integrations: {
    notion: { configured: boolean }
    sentry: { configured: boolean }
    editor: { configured: boolean }
  }
}

function checkClaudeCli(): { available: boolean; version: string | null } {
  try {
    const r = spawnSync('claude', ['--version'], { encoding: 'utf-8' })
    if (r.error || r.status !== 0) return { available: false, version: null }
    return { available: true, version: (r.stdout ?? '').trim() || null }
  } catch {
    return { available: false, version: null }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function safeFileSize(p: string): number | null {
  try {
    return fs.statSync(p).size
  } catch {
    return null
  }
}

// GET /api/health/report — detailed health diagnostics for the Health panel.
app.get('/report', (c) => {
  const db = getDb()
  const dbPath = getDbPath()
  const home = getKoboHome()

  // DB schema version
  const row = db.prepare('SELECT MAX(version) as v FROM schema_migrations').get() as { v: number | null }
  const dbSchemaVersion = row?.v ?? 0

  // Workspaces + worktrees on-disk check
  const workspaces = db
    .prepare('SELECT id, name, project_path, working_branch, worktree_path, archived_at FROM workspaces')
    .all() as Array<{
    id: string
    name: string
    project_path: string
    working_branch: string
    worktree_path: string | null
    archived_at: string | null
  }>

  const healthGlobalSettings = getGlobalSettings()
  const worktreesMissing: WorktreeCheck[] = []
  for (const ws of workspaces) {
    if (ws.archived_at) continue
    const wsProjectSettings = getProjectSettings(ws.project_path)
    const wsProjectSlug = healthGlobalSettings.worktreesPrefixByProject
      ? slugifyProjectName(wsProjectSettings?.displayName ?? '', ws.project_path)
      : undefined
    const wtPath =
      ws.worktree_path ??
      resolveWorkspaceWorktreePath(
        ws.project_path,
        ws.working_branch,
        healthGlobalSettings.worktreesPath,
        wsProjectSlug,
      )
    if (!fs.existsSync(wtPath)) {
      worktreesMissing.push({ workspaceId: ws.id, name: ws.name, path: wtPath, exists: false })
    }
  }

  // Orphan agent sessions — marked running but PID no longer alive
  const runningSessions = db
    .prepare("SELECT pid FROM agent_sessions WHERE status = 'running' AND pid IS NOT NULL")
    .all() as Array<{ pid: number | null }>
  let orphaned = 0
  for (const s of runningSessions) {
    if (s.pid && !isProcessAlive(s.pid)) orphaned++
  }

  const settingsRow = db.prepare('SELECT COUNT(*) as n FROM workspaces').get() as { n: number }
  const archivedRow = db.prepare('SELECT COUNT(*) as n FROM workspaces WHERE archived_at IS NOT NULL').get() as {
    n: number
  }

  const report: HealthReport = {
    koboHome: home,
    db: {
      path: dbPath,
      sizeBytes: safeFileSize(dbPath),
      schemaVersion: dbSchemaVersion,
      currentSchemaVersion: SCHEMA_VERSION,
    },
    settings: { schemaVersion: SETTINGS_SCHEMA_VERSION },
    claudeCli: checkClaudeCli(),
    workspaces: {
      total: settingsRow.n,
      archived: archivedRow.n,
      worktreesMissing,
    },
    agentSessions: { orphaned },
    integrations: {
      notion: { configured: Boolean(healthGlobalSettings.notionMcpKey) },
      sentry: { configured: Boolean(healthGlobalSettings.sentryMcpKey) },
      editor: { configured: Boolean(healthGlobalSettings.editorCommand) },
    },
  }

  return c.json(report)
})

export default app
