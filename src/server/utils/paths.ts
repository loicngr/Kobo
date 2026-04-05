import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Package root resolved from this file's location via pure path arithmetic
// (no filesystem calls, so this stays robust when tests mock `node:fs`).
// This file lives at `<root>/src/server/utils/paths.ts` in dev (tsx) and at
// `<root>/dist/server/utils/paths.js` in production (node) — both are exactly
// three directories deep from the package root.
//
// Do NOT move this file without updating the parent count. A unit test in
// src/__tests__/paths.test.ts verifies the result points at a directory that
// contains package.json.
const selfDir = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(selfDir, '..', '..', '..')

/**
 * Resolves a path inside the Kōbō package (e.g. compiled MCP server, built SPA).
 * Never use this for user data — those go through getKoboHome() / getDataDir().
 */
export function getPackageAssetPath(...parts: string[]): string {
  return path.join(packageRoot, ...parts)
}

/**
 * Resolves the Kōbō home directory for user data (DB, settings). Respects
 * KOBO_HOME when set, otherwise defaults to an XDG-compliant location under
 * ~/.config/kobo. The directory is NOT created here — callers are responsible
 * for mkdir before writing.
 *
 * Dev workflow: `npm run dev` sets KOBO_HOME=./data so local development uses
 * the repo-relative data/ directory and never touches the user's real home.
 */
export function getKoboHome(): string {
  if (process.env.KOBO_HOME) {
    return path.resolve(process.env.KOBO_HOME)
  }
  const xdgConfigHome = process.env.XDG_CONFIG_HOME
  if (xdgConfigHome) {
    return path.join(xdgConfigHome, 'kobo')
  }
  return path.join(os.homedir(), '.config', 'kobo')
}

/**
 * Same as getKoboHome(), but guarantees the directory exists on disk. Call this
 * before any filesystem write into the Kōbō home.
 */
export function ensureKoboHome(): string {
  const dir = getKoboHome()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return dir
}

/**
 * Absolute path to the SQLite database file under the Kōbō home.
 */
export function getDbPath(): string {
  return path.join(getKoboHome(), 'kobo.db')
}

/**
 * Absolute path to settings.json under the Kōbō home.
 */
export function getSettingsPath(): string {
  return path.join(getKoboHome(), 'settings.json')
}

/**
 * Absolute path to skills.json under the Kōbō home — cached list of Claude
 * Code slash commands discovered from system init events.
 */
export function getSkillsPath(): string {
  return path.join(getKoboHome(), 'skills.json')
}

/**
 * Absolute path to the compiled MCP server entry (shipped in the published
 * package as dist/mcp-server/kobo-tasks-server.js). Returns null if not
 * present — callers (agent-manager) then fall back to the TS source for dev.
 */
export function getCompiledMcpServerPath(): string | null {
  const compiled = getPackageAssetPath('dist', 'mcp-server', 'kobo-tasks-server.js')
  return fs.existsSync(compiled) ? compiled : null
}

/**
 * Absolute path to the MCP server TypeScript source (used in dev when the
 * compiled version is absent).
 */
export function getMcpServerSourcePath(): string {
  return getPackageAssetPath('src', 'mcp-server', 'kobo-tasks-server.ts')
}

/**
 * Absolute path to the built Quasar SPA (src/client/dist/spa). Returns null
 * if the SPA has not been built yet.
 */
export function getClientSpaPath(): string | null {
  const spa = getPackageAssetPath('src', 'client', 'dist', 'spa')
  return fs.existsSync(spa) ? spa : null
}
