import { WORKTREES_PATH } from '../../../shared/consts'

/**
 * Strip the current workspace's worktree prefix (and, as a fallback, its
 * project root) from a raw path or command string. Works both on a bare
 * path and inside a shell command where the prefix may appear multiple
 * times, possibly followed by a slash/backslash subpath or as a standalone directory.
 *
 * Examples (worktree = /home/foo/proj/.worktrees/feature/x):
 *   /home/foo/proj/.worktrees/feature/x/src/App.tsx  → src/App.tsx
 *   find /home/foo/proj/.worktrees/feature/x -name …  → find . -name …
 *   grep foo /home/foo/proj/src/App.tsx              → src/App.tsx (project fallback)
 *   /something/else/file.ts                          → /something/else/file.ts (unchanged)
 */
export function compactPath(
  raw: string,
  workspace: { projectPath: string; workingBranch: string; worktreePath?: string | null } | null | undefined,
): string {
  if (!raw || !workspace?.projectPath) return raw
  const worktree = workspace.worktreePath
  // Worktree prefix takes precedence over project root — always the more
  // specific (longest) match wins.
  if (worktree) {
    const out = stripPrefix(raw, worktree)
    if (out !== raw) return out
  }
  const legacyWorktree = `${workspace.projectPath}/${WORKTREES_PATH}/${workspace.workingBranch}`
  const legacyOut = stripPrefix(raw, legacyWorktree)
  if (legacyOut !== raw) return legacyOut
  const out = stripPrefix(raw, workspace.projectPath)
  return out
}

function stripPrefix(s: string, prefix: string): string {
  if (!prefix) return s
  const escaped = pathPrefixPattern(prefix)
  if (!escaped) return s
  return s
    .replace(new RegExp(`${escaped}[\\\\/]+`, 'g'), '')
    .replace(new RegExp(`${escaped}(?=\\s|$|["'\`])`, 'g'), '.')
}

function pathPrefixPattern(prefix: string): string {
  const trimmed = prefix.replace(/[\\/]+$/, '')
  if (!trimmed) return ''
  const leadingSeparator = /^[\\/]+/.test(trimmed) ? '[\\\\/]+' : ''
  const segments = trimmed
    .split(/[\\/]+/)
    .filter(Boolean)
    .map(escapeRegex)
  return `${leadingSeparator}${segments.join('[\\\\/]+')}`
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
