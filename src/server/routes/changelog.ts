import fs from 'node:fs'
import { Hono } from 'hono'
import { getChangelogPath, getPackageVersion } from '../utils/paths.js'

/** Hono sub-router for the in-app "What's new" dialog. */
const app = new Hono()

interface ChangelogEntry {
  version: string
  notes: string
}

/**
 * Parse a Keep-a-Changelog markdown file into ordered version sections. Each
 * `## <version>` heading starts a new entry; everything until the next heading
 * is its notes. A leading `v` on the version is stripped.
 */
export function parseChangelog(markdown: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = []
  let current: { version: string; lines: string[] } | null = null

  for (const line of markdown.split('\n')) {
    const heading = line.match(/^##\s+v?(\d+\.\d+\.\d+[\w.-]*)\s*$/)
    if (heading) {
      if (current) entries.push({ version: current.version, notes: current.lines.join('\n').trim() })
      current = { version: heading[1], lines: [] }
    } else if (current) {
      current.lines.push(line)
    }
  }
  if (current) entries.push({ version: current.version, notes: current.lines.join('\n').trim() })
  return entries
}

// GET /api/changelog — current app version + parsed CHANGELOG.md sections,
// powering the "What's new" dialog shown after an update.
app.get('/', (c) => {
  try {
    let versions: ChangelogEntry[] = []
    try {
      versions = parseChangelog(fs.readFileSync(getChangelogPath(), 'utf-8'))
    } catch {
      // No CHANGELOG.md shipped (or unreadable) — degrade to an empty list.
    }
    return c.json({ currentVersion: getPackageVersion(), versions })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

export default app
