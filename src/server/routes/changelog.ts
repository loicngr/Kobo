import fs from 'node:fs'
import { Hono } from 'hono'
import { refreshUpdateCheck } from '../services/update-check-service.js'
import { type ChangelogEntry, parseChangelog } from '../utils/changelog.js'
import { getChangelogPath } from '../utils/paths.js'

export { _clearLatestVersionCache } from '../services/update-check-service.js'

export { parseChangelog } from '../utils/changelog.js'

/** Hono sub-router for the in-app "What's new" dialog. */
const app = new Hono()

// GET /api/changelog — current app version + parsed CHANGELOG.md sections,
// powering the "What's new" dialog shown after an update, plus the latest
// version published to npm so the UI can offer to upgrade.
app.get('/', async (c) => {
  try {
    let versions: ChangelogEntry[] = []
    try {
      versions = parseChangelog(fs.readFileSync(getChangelogPath(), 'utf-8'))
    } catch {
      // No CHANGELOG.md shipped (or unreadable) — degrade to an empty list.
    }
    return c.json({ ...(await refreshUpdateCheck()), versions })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

export default app
