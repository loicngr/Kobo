import type Database from 'better-sqlite3'

/** Idempotent: runs from initSchema on fresh installs and as migration v62. */
export function initSlackSchema(db: Database.Database): void {
  // Some legacy migration fixtures run the registry on a database without `workspaces`.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'").get()) {
    const columns = db.prepare('PRAGMA table_info(workspaces)').all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === 'slack_channel_id'))
      db.exec('ALTER TABLE workspaces ADD COLUMN slack_channel_id TEXT')
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_slack_channel
      ON workspaces(slack_channel_id) WHERE slack_channel_id IS NOT NULL`)
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS slack_messages (
      channel_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT,
      user_name TEXT,
      text TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
      state TEXT NOT NULL,
      files TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (channel_id, ts)
    );
    CREATE INDEX IF NOT EXISTS idx_slack_messages_workspace ON slack_messages(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_slack_messages_thread ON slack_messages(channel_id, thread_ts, ts);
  `)
}

/**
 * Idempotent: runs from initSchema after initSlackSchema and as migration v63. A bot message with
 * buttons stores its labels (`buttons`, JSON) and `buttons_multiple`; `answered_at` is the
 * single-answer compare-and-set flag. A click row sets `click_of` to the clicked message's ts.
 */
export function initSlackButtonsSchema(db: Database.Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'slack_messages'").get()) return
  const columns = new Set(
    (db.prepare('PRAGMA table_info(slack_messages)').all() as Array<{ name: string }>).map((c) => c.name),
  )
  const added: Array<[string, string]> = [
    ['buttons', 'TEXT'],
    ['buttons_multiple', 'INTEGER NOT NULL DEFAULT 0'],
    ['answered_at', 'TEXT'],
    ['click_of', 'TEXT'],
  ]
  for (const [name, type] of added)
    if (!columns.has(name)) db.exec(`ALTER TABLE slack_messages ADD COLUMN ${name} ${type}`)
}

/**
 * Idempotent: runs from initSchema after initSlackButtonsSchema and as migration v64. One
 * `slack_questions` row per mirrored pending input (question, permission notice or secret notice).
 * `question_index` and `state` are the compare-and-set keys of an answer; `answers` holds the JSON
 * answers collected so far; `message_ts`/`message_text` describe the question message on screen.
 */
export function initSlackQuestionsSchema(db: Database.Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'").get()) return
  const columns = db.prepare('PRAGMA table_info(workspaces)').all() as Array<{ name: string }>
  if (!columns.some((column) => column.name === 'slack_question_mirror'))
    db.exec(`ALTER TABLE workspaces ADD COLUMN slack_question_mirror TEXT NOT NULL DEFAULT 'never'
      CHECK (slack_question_mirror IN ('never', 'slack-conversation', 'always'))`)
  db.exec(`
    CREATE TABLE IF NOT EXISTS slack_questions (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('question', 'permission', 'secret')),
      channel_id TEXT NOT NULL,
      thread_ts TEXT,
      message_ts TEXT,
      message_text TEXT NOT NULL DEFAULT '',
      question_index INTEGER NOT NULL DEFAULT 0,
      answers TEXT NOT NULL DEFAULT '[]',
      state TEXT NOT NULL CHECK (state IN ('posting', 'open', 'submitting', 'answered', 'closed', 'notified')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, session_id, tool_call_id)
    );
    CREATE INDEX IF NOT EXISTS idx_slack_questions_message ON slack_questions(channel_id, message_ts);
    CREATE INDEX IF NOT EXISTS idx_slack_questions_state ON slack_questions(state);
  `)
}
