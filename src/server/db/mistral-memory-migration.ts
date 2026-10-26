import type Database from 'better-sqlite3'

/** Rebuild only engine CHECK constraints; the migration runner owns the transaction. */
export function migrateMistralMemoryEngine(db: Database.Database): void {
  // Parents precede children so replacement FKs never point at tables being dropped.
  const tables = [
    'memory_entries',
    'memory_budget_contexts',
    'memory_proposals',
    'memory_operations',
    'memory_contexts',
  ]
  const definitions = tables.map((name) => ({
    name,
    sql: (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as { sql: string })
      .sql,
  }))
  if (definitions.every(({ sql }) => sql.includes("'mistral-vibe'"))) return

  const indexes = tables.flatMap(
    (name) =>
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL")
        .all(name) as Array<{ sql: string }>,
  )
  const sequence = db
    .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'memory_operations'")
    .safeIntegers()
    .get() as { seq: bigint } | undefined
  for (const { name, sql } of definitions) {
    let replacement = sql.replaceAll("'claude-code', 'codex'", "'claude-code', 'codex', 'mistral-vibe'")
    for (const table of tables)
      replacement = replacement.replaceAll(new RegExp(`\\b${table}\\b`, 'g'), `${table}_mistral`)
    db.exec(replacement)
    db.exec(`INSERT INTO ${name}_mistral SELECT * FROM ${name}`)
  }
  for (const name of [...tables].reverse()) db.exec(`DROP TABLE ${name}`)
  for (const name of tables) db.exec(`ALTER TABLE ${name}_mistral RENAME TO ${name}`)
  for (const { sql } of indexes) db.exec(sql)
  if (sequence) db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'memory_operations'").run(sequence.seq)
}
