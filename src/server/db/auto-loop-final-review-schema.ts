import type Database from 'better-sqlite3'

export function initAutoLoopFinalReviewSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS auto_loop_final_reviews (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    configuration TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    cycle INTEGER NOT NULL DEFAULT 0,
    findings_count INTEGER,
    reason TEXT,
    review_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
    original_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
    token TEXT,
    verdict TEXT,
    previous_findings TEXT,
    stagnant_cycles INTEGER NOT NULL DEFAULT 0,
    return_prompt TEXT,
    updated_at TEXT NOT NULL
  )`)
}
