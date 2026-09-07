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
    const heading = line.match(/^##\s+v?(\d+\.\d+\.\d+[\w./-]*)\s*$/)
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

/**
 * Latest version published to npm, looked up at most once a day.
 *
 * "What's new" tells the user what changed once they have upgraded; nothing
 * told them an upgrade existed. A self-hosted install would silently rot.
 *
 * Best-effort by construction: no network, a registry hiccup or an air-gapped
 * machine all resolve to null, and the client simply shows nothing.
 */
const REGISTRY_URL = 'https://registry.npmjs.org/@loicngr/kobo/latest'
const LATEST_TTL_MS = 24 * 60 * 60 * 1000
let latestCache: { version: string | null; fetchedAt: number } | null = null
/** The lookup in progress, so two loads racing on a cold cache share one request. */
let inFlight: Promise<string | null> | null = null

async function fetchLatestVersion(): Promise<string | null> {
  if (latestCache && Date.now() - latestCache.fetchedAt < LATEST_TTL_MS) return latestCache.version
  if (inFlight) return inFlight
  inFlight = lookupLatestVersion().finally(() => {
    inFlight = null
  })
  return inFlight
}

async function lookupLatestVersion(): Promise<string | null> {
  let version: string | null = null
  try {
    const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(5_000) })
    if (res.ok) {
      const body = (await res.json()) as { version?: unknown }
      if (typeof body.version === 'string') version = body.version
    }
  } catch {
    // Offline, blocked, or the registry is down. Not worth a log line on a
    // path that runs on every app load.
  }
  // Cache the failure too: a machine with no network must not retry per load.
  latestCache = { version, fetchedAt: Date.now() }
  return version
}

/** @internal test-only — drop the cached registry lookup. */
export function _clearLatestVersionCache(): void {
  latestCache = null
  inFlight = null
}

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
    return c.json({ currentVersion: getPackageVersion(), latestVersion: await fetchLatestVersion(), versions })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

export default app
