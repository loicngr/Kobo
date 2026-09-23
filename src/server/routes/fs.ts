import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

/** Hono sub-router for local filesystem browsing (project folder picker). */
const app = new Hono()

interface DirEntry {
  name: string
  path: string
}

// GET /api/fs/list-dirs?path=<dir> — list the immediate subdirectories of a
// directory. Defaults to the user's home directory when `path` is omitted.
// Local single-user dev tool: the user browses their own filesystem.
app.get('/list-dirs', (c) => {
  try {
    const requested = c.req.query('path')
    const target = path.resolve(requested?.trim() ? requested : os.homedir())

    let stat: fs.Stats
    try {
      stat = fs.statSync(target)
    } catch {
      return c.json({ error: `Directory not found: ${target}` }, 404)
    }
    if (!stat.isDirectory()) {
      return c.json({ error: `Not a directory: ${target}` }, 400)
    }

    let dirents: fs.Dirent[]
    try {
      dirents = fs.readdirSync(target, { withFileTypes: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: `Cannot read directory: ${message}` }, 403)
    }

    // Directories only, hidden ones excluded, sorted case-insensitively.
    const entries: DirEntry[] = dirents
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => ({ name: d.name, path: path.join(target, d.name) }))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))

    const parent = path.dirname(target)
    return c.json({
      path: target,
      parent: parent === target ? null : parent,
      entries,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

export default app
