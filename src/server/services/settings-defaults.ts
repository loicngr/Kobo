/**
 * Bash equivalent of the built-in change-source-branch cherry-pick. Seeded
 * into `global.changeSourceBranchScript` by settings migration v33; served to
 * the client via `GET /api/settings/defaults` for the Settings "Reset to Kōbō
 * default" button. Clearing the textarea disables the feature (empty script
 * → menu item hidden).
 */
export const DEFAULT_CHANGE_SOURCE_BRANCH_SCRIPT = `#!/usr/bin/env bash
# Kōbō default change-source-branch script — edit at will.
# Replaces the built-in cherry-pick when this field is non-empty.
#
# Env vars Kōbō exports for you:
#   KOBO_NEW_BASE        new source branch chosen in the dialog
#   KOBO_OLD_BASE        workspace's previous source branch
#   KOBO_WORKING_BRANCH  workspace's working branch
#   KOBO_WORKTREE_PATH   absolute path of the worktree (also cwd)
#   KOBO_PROJECT_PATH    absolute path of the main project repo
#   KOBO_PROJECT_NAME    project directory name (basename of KOBO_PROJECT_PATH)
#   KOBO_WORKSPACE_ID    Kōbō workspace id (stable across renames)
#   KOBO_WORKSPACE_NAME  workspace display name
#   KOBO_FORGE           resolved forge: github / gitlab / none
#   KOBO_PR_NUMBER       PR/MR number on the resolved forge (empty if none open)
set -euo pipefail

# Safety limit — refuse and ask for a manual rebase above this many commits.
MAX_PROPER_COMMITS=50

git fetch origin

# Commits proper to the working branch (in neither base).
COMMITS=$(git log --reverse --format=%H "$KOBO_WORKING_BRANCH" \\
  --not "origin/$KOBO_NEW_BASE" "origin/$KOBO_OLD_BASE" || true)
COUNT=$(printf '%s\\n' "$COMMITS" | grep -c '^[0-9a-f]' || true)

# Backup branch so you can always recover: \`git reset --hard kobo-backup/…\`.
git branch "kobo-backup/\${KOBO_WORKING_BRANCH}-$(date +%s)" "$KOBO_WORKING_BRANCH"

if [ "$COUNT" -eq 0 ]; then
  git reset --hard "origin/$KOBO_NEW_BASE"
elif [ "$COUNT" -gt "$MAX_PROPER_COMMITS" ]; then
  echo "Too many proper commits ($COUNT > $MAX_PROPER_COMMITS) — rebase manually" >&2
  exit 1
else
  git reset --hard "origin/$KOBO_NEW_BASE"
  printf '%s\\n' "$COMMITS" | xargs git cherry-pick
fi

# Re-target the PR / MR. Probe the CLI first so a missing tool degrades
# gracefully under \`set -e\`.
case "\${KOBO_FORGE:-none}" in
  github)
    if command -v gh >/dev/null 2>&1; then
      gh pr edit --base "$KOBO_NEW_BASE" 2>/dev/null || true
    else
      echo "warn: 'gh' CLI not installed — skipping PR base update" >&2
    fi
    ;;
  gitlab)
    if command -v glab >/dev/null 2>&1; then
      glab mr update --target-branch "$KOBO_NEW_BASE" 2>/dev/null || true
    else
      echo "warn: 'glab' CLI not installed — skipping MR base update" >&2
    fi
    ;;
  *) : ;;
esac

# Force-push if the branch is tracked upstream.
if git rev-parse --abbrev-ref "@{upstream}" >/dev/null 2>&1; then
  git push --force-with-lease origin "$KOBO_WORKING_BRANCH"
fi
`

/** Payload returned by `GET /api/settings/defaults`. */
export interface SettingsDefaults {
  changeSourceBranchScript: string
}

export function getSettingsDefaults(): SettingsDefaults {
  return {
    changeSourceBranchScript: DEFAULT_CHANGE_SOURCE_BRANCH_SCRIPT,
  }
}
