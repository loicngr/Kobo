import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

interface SpawnHelperTarget {
  platform?: NodeJS.Platform
  arch?: string
  /** node-pty package directory; resolved from this module when omitted. */
  root?: string
}

function nodePtyRoot(): string {
  return path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json'))
}

/**
 * node-pty 1.1.0 publishes its macOS `spawn-helper` prebuilds without the
 * execute bit, so every spawn fails with `posix_spawnp failed` (a blank
 * terminal in Kōbō). Restore the bit at runtime rather than in an install
 * script, which `--ignore-scripts` installs would skip.
 *
 * Returns the helper it made executable, or `null` when there is nothing to do.
 * Throws when the helper cannot be changed (e.g. a root-owned global install).
 */
export function ensureSpawnHelperExecutable({
  platform = process.platform,
  arch = process.arch,
  root,
}: SpawnHelperTarget = {}): string | null {
  if (platform !== 'darwin') return null
  const helper = path.join(root ?? nodePtyRoot(), 'prebuilds', `darwin-${arch}`, 'spawn-helper')
  let mode: number
  try {
    mode = fs.statSync(helper).mode
  } catch {
    return null // Built from source: node-gyp output is already executable.
  }
  if ((mode & 0o111) !== 0) return null
  fs.chmodSync(helper, (mode & 0o777) | 0o111)
  return helper
}
