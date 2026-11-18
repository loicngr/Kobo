import type Database from 'better-sqlite3'

/**
 * Idempotent: runs from initSchema after the Slack helpers and as migration v65. Adds the nullable JSON
 * column `workspaces.notification_prefs` (NULL = default, nothing muted). Appended rather than part of
 * `CREATE TABLE workspaces` so fresh and upgraded databases keep the same column order.
 */
export function initWorkspaceNotificationPrefsSchema(db: Database.Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'").get()) return
  const columns = db.prepare('PRAGMA table_info(workspaces)').all() as Array<{ name: string }>
  if (!columns.some((column) => column.name === 'notification_prefs'))
    db.exec('ALTER TABLE workspaces ADD COLUMN notification_prefs TEXT')
}
