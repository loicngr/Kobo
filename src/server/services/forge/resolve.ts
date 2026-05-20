// src/server/services/forge/resolve.ts
import { execFileSync } from 'node:child_process'
import { getProjectSettings } from '../settings-service.js'
import type { ForgeId } from './types.js'

/** Classify a git remote URL into a forge id. Exported for testing. */
export function forgeFromRemoteUrl(url: string): ForgeId {
  const lower = url.toLowerCase()
  if (lower.includes('github.com')) return 'github'
  if (lower.includes('gitlab')) return 'gitlab'
  return 'none'
}

/** Read the `origin` remote URL, or '' when there is no remote. */
function readRemoteUrl(projectPath: string): string {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: projectPath,
      encoding: 'utf-8',
    }).trim()
  } catch {
    return ''
  }
}

/**
 * Resolve the forge for a project: the explicit per-project setting wins;
 * `auto` (the default) classifies the origin remote URL.
 */
export function resolveForge(projectPath: string): ForgeId {
  const setting = getProjectSettings(projectPath)?.forge ?? 'auto'
  if (setting === 'github' || setting === 'gitlab' || setting === 'none') return setting
  return forgeFromRemoteUrl(readRemoteUrl(projectPath))
}
