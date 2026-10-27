import type Database from 'better-sqlite3'

export function initParallelReviewSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS parallel_reviews (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    review_session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    original_session_id TEXT NOT NULL,
    original_configuration TEXT NOT NULL,
    return_to_session INTEGER NOT NULL,
    phase TEXT NOT NULL DEFAULT 'reviewing',
    return_prompt TEXT,
    last_error TEXT
  )`)
}

export function migrateParallelReviews(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(agent_sessions)').all() as { name: string }[]
  if (columns.length && !columns.some((column) => column.name === 'role'))
    db.exec("ALTER TABLE agent_sessions ADD COLUMN role TEXT NOT NULL DEFAULT 'primary'")
  initParallelReviewSchema(db)
}
