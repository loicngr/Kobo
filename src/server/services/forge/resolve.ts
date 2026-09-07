// src/server/services/forge/resolve.ts
import { execFileSync } from 'node:child_process'
import { getProjectSettings } from '../settings-service.js'
import type { ForgeId } from './types.js'

/** Classify a git remote URL into a forge id. Exported for testing. */
export function forgeFromRemoteUrl(url: string): ForgeId {
  const lower = url.toLowerCase()
  if (lower.includes('github.com')) return 'github'
  if (lower.includes('gitlab')) return 'gitlab'
  if (lower.includes('bitbucket')) return 'bitbucket-community'
  return 'none'
}

/** Read the `origin` remote URL, or '' when there is no remote. */
function readRemoteUrl(projectPath: string): string {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: projectPath,
      encoding: 'utf-8',
      // Without a bound, a git hanging on a network filesystem blocks the whole
      // event loop: this runs synchronously, and the pr-watcher calls it for
      // every workspace on every tick.
      timeout: 5_000,
    }).trim()
  } catch {
    return ''
  }
}

/**
 * Auto-detected forge per project path. The remote of a checkout does not
 * change while Kōbō runs, and resolving it costs a synchronous subprocess that
 * the pr-watcher would otherwise pay per workspace, per 30 s tick, twice.
 * Bounded by TTL so a remote that is added or repointed is picked up without a
 * restart, and only the `auto` path is cached — an explicit setting is already
 * free to read.
 */
const autoForgeCache = new Map<string, { forge: ForgeId; readAt: number }>()
const AUTO_FORGE_TTL_MS = 5 * 60_000

/** Drop the cached auto-detection. Exported for tests. */
export function _clearForgeCache(): void {
  autoForgeCache.clear()
}

/**
 * Resolve the forge for a project: the explicit per-project setting wins;
 * `auto` (the default) classifies the origin remote URL.
 */
export function resolveForge(projectPath: string): ForgeId {
  const setting = getProjectSettings(projectPath)?.forge ?? 'auto'
  if (setting === 'github' || setting === 'gitlab' || setting === 'bitbucket-community' || setting === 'none') {
    return setting
  }
  const cached = autoForgeCache.get(projectPath)
  if (cached && Date.now() - cached.readAt < AUTO_FORGE_TTL_MS) return cached.forge

  const remoteUrl = readRemoteUrl(projectPath)
  const forge = forgeFromRemoteUrl(remoteUrl)
  // A read that failed (git timing out on a network mount, a transient lock)
  // is not knowledge: caching it would disable PR actions for five minutes on
  // a project that has a perfectly good remote.
  if (remoteUrl) autoForgeCache.set(projectPath, { forge, readAt: Date.now() })
  return forge
}
