import os from 'node:os'
import path from 'node:path'
import { WORKTREES_PATH } from '../../shared/consts.js'

const BRACED_HOME = '$' + '{HOME}'
const USERPROFILE = '%' + 'USERPROFILE' + '%'
const HOME_ALIASES = ['~', '$HOME', BRACED_HOME, USERPROFILE] as const

type HomeAlias = (typeof HOME_ALIASES)[number]

interface ValidateWorktreesPathOptions {
  allowEmpty?: boolean
}

export class InvalidWorktreesPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidWorktreesPathError'
  }
}

/** Return the configured worktrees root, falling back to the default constant. */
export function normalizeWorktreesPath(value: unknown): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed || WORKTREES_PATH
}

function homeDir(alias: HomeAlias): string {
  if (alias === USERPROFILE) {
    return process.env.USERPROFILE || process.env.HOME || os.homedir()
  }
  return process.env.HOME || process.env.USERPROFILE || os.homedir()
}

function isWindowsStylePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('//')
}

function pathFlavor(...values: string[]): typeof path.posix | typeof path.win32 {
  return values.some(isWindowsStylePath) ? path.win32 : path
}

function branchPathSegments(branchName: string): string[] {
  return branchName.split(/[\\/]+/).filter(Boolean)
}

function parseHomeAlias(value: string): { alias: HomeAlias; rest: string } | null {
  for (const alias of HOME_ALIASES) {
    if (value === alias) return { alias, rest: '' }
    if (value.startsWith(`${alias}/`) || value.startsWith(`${alias}\\`)) {
      return { alias, rest: value.slice(alias.length + 1) }
    }
  }
  return null
}

function withoutHomeAlias(value: string): string {
  const parsed = parseHomeAlias(value)
  if (parsed) return parsed.rest
  return value
}

function hasParentTraversal(value: string): boolean {
  return withoutHomeAlias(value)
    .split(/[\\/]+/)
    .filter(Boolean)
    .includes('..')
}

function hasControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code < 32 || code === 127) return true
  }
  return false
}

/** Validate a user-supplied worktrees path and return its normalized persisted value. */
export function validateWorktreesPath(value: unknown, options: ValidateWorktreesPathOptions = {}): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed && options.allowEmpty === false) {
    throw new InvalidWorktreesPathError('Worktrees path is required')
  }
  const normalized = trimmed || WORKTREES_PATH

  if (hasControlCharacters(normalized)) {
    throw new InvalidWorktreesPathError('Worktrees path cannot contain control characters')
  }
  if (/^[A-Za-z]:(?![\\/])/.test(normalized)) {
    throw new InvalidWorktreesPathError('Windows drive paths must be absolute, for example C:\\kobo\\worktrees')
  }
  if (hasParentTraversal(normalized)) {
    throw new InvalidWorktreesPathError('Worktrees path cannot contain parent directory traversal (`..`)')
  }

  return normalized
}

/** Best-effort normalization for already persisted settings. Invalid values fall back to the default. */
export function sanitizeWorktreesPath(value: unknown): string {
  try {
    return validateWorktreesPath(value)
  } catch {
    return WORKTREES_PATH
  }
}

/** Expand user-friendly home aliases supported in settings.json. */
export function expandHomePath(value: string): string {
  const parsed = parseHomeAlias(value)
  if (!parsed) return value

  const home = homeDir(parsed.alias)
  if (!home) return value

  if (parsed.rest === '') return home
  const restSegments = parsed.rest.split(/[\\/]+/).filter(Boolean)
  return pathFlavor(home, value).join(home, ...restSegments)
}

/**
 * Resolve the worktrees root for a project.
 * Relative settings are project-relative; absolute settings are machine-wide.
 */
export function resolveWorktreesRoot(projectPath: string, configuredPath?: string | null): string {
  const expanded = expandHomePath(validateWorktreesPath(configuredPath))
  const flavor = pathFlavor(projectPath, expanded)
  return flavor.isAbsolute(expanded) ? flavor.normalize(expanded) : flavor.resolve(projectPath, expanded)
}

export function resolveGlobalWorktreesRoot(configuredPath: string): string | null {
  const expanded = expandHomePath(validateWorktreesPath(configuredPath, { allowEmpty: false }))
  const flavor = pathFlavor(expanded)
  return flavor.isAbsolute(expanded) ? flavor.normalize(expanded) : null
}

/** Resolve the full on-disk path for a workspace worktree. */
export function resolveWorkspaceWorktreePath(
  projectPath: string,
  workingBranch: string,
  configuredPath?: string | null,
  projectSlug?: string,
): string {
  const root = resolveWorktreesRoot(projectPath, configuredPath)
  const flavor = pathFlavor(projectPath, root)
  const slugSegment = projectSlug && projectSlug.length > 0 ? [projectSlug] : []
  return flavor.join(root, ...slugSegment, ...branchPathSegments(workingBranch))
}

/** Resolve a renamed worktree next to its current path when the current path still matches its branch. */
export function resolveSiblingWorkspaceWorktreePath(
  projectPath: string,
  worktreePath: string,
  currentBranch: string,
  nextBranch: string,
  projectSlug?: string,
): string {
  const flavor = pathFlavor(projectPath, worktreePath)
  const normalizedWorktreePath = flavor.normalize(worktreePath)
  const slugSegment = projectSlug && projectSlug.length > 0 ? [projectSlug] : []
  const currentSuffix = `${flavor.sep}${flavor.join(...slugSegment, ...branchPathSegments(currentBranch))}`
  const comparablePath = flavor === path.win32 ? normalizedWorktreePath.toLowerCase() : normalizedWorktreePath
  const comparableSuffix = flavor === path.win32 ? currentSuffix.toLowerCase() : currentSuffix
  const root = comparablePath.endsWith(comparableSuffix)
    ? normalizedWorktreePath.slice(0, -currentSuffix.length)
    : resolveWorktreesRoot(projectPath)
  return flavor.join(root, ...slugSegment, ...branchPathSegments(nextBranch))
}
