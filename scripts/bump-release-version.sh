#!/usr/bin/env sh
set -eu

version="${1:-patch}"

case "$version" in
  patch|minor|major|prepatch|preminor|premajor|prerelease|[0-9]*.[0-9]*.[0-9]*)
    ;;
  *)
    echo "Usage: $0 [patch|minor|major|prepatch|preminor|premajor|prerelease|x.y.z]" >&2
    exit 2
    ;;
esac

if ! command -v git >/dev/null 2>&1; then
  echo "git is required" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required" >&2
  exit 1
fi

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if [ -n "$(git status --porcelain -- package.json package-lock.json CHANGELOG.md)" ]; then
  echo "package.json, package-lock.json or CHANGELOG.md already has changes. Commit or stash them before bumping." >&2
  exit 1
fi

new_version="$(npm version "$version" --no-git-tag-version)"
git add package.json package-lock.json

echo "Bumped to $new_version"

# --- Changelog -------------------------------------------------------------
# Pre-fill a new section in CHANGELOG.md from the Conventional Commits made
# since the last release tag, then let the user curate the wording. The
# in-app "What's new" dialog renders this file, so the final entry should
# read as user-facing prose, not raw commit subjects.
version_number="${new_version#v}"
changelog_file="$repo_root/CHANGELOG.md"
staged_files="package.json package-lock.json"

if [ -f "$changelog_file" ]; then
  last_tag="$(git describe --tags --abbrev=0 2>/dev/null || true)"
  if [ -n "$last_tag" ]; then
    commit_range="$last_tag..HEAD"
    echo "Collecting commits since $last_tag"
  else
    commit_range="HEAD"
    echo "No previous tag found — collecting all commits"
  fi

  section_tmp="$(mktemp)"
  {
    printf '## %s\n\n' "$version_number"
    commits="$(git log "$commit_range" --no-merges --pretty=format:'%s' \
      | grep -v '^chore(release)' || true)"
    if [ -n "$commits" ]; then
      printf '%s\n' "$commits" | sed 's/^/- /'
    else
      printf '%s\n' '- '
    fi
    printf '\n'
  } > "$section_tmp"

  # Insert the new section above the topmost existing one (newest first).
  changelog_tmp="$(mktemp)"
  awk -v sf="$section_tmp" '
    !inserted && /^## / {
      while ((getline line < sf) > 0) print line
      close(sf)
      inserted = 1
    }
    { print }
    END {
      if (!inserted) {
        while ((getline line < sf) > 0) print line
        close(sf)
      }
    }
  ' "$changelog_file" > "$changelog_tmp"
  mv "$changelog_tmp" "$changelog_file"
  rm -f "$section_tmp"

  echo "Added a '## $version_number' section to CHANGELOG.md (pre-filled from commits)."
  printf "Open CHANGELOG.md in \$EDITOR to curate it now? [Y/n] "
  read -r edit_answer
  case "$edit_answer" in
    n|N|no|NO)
      echo "Skipped — edit CHANGELOG.md manually before pushing if needed."
      ;;
    *)
      "${EDITOR:-vi}" "$changelog_file"
      ;;
  esac

  git add "$changelog_file"
  staged_files="$staged_files CHANGELOG.md"
else
  echo "No CHANGELOG.md found — skipping changelog step." >&2
fi
# ---------------------------------------------------------------------------

echo "Staged: $staged_files"

printf "Commit version bump now? [y/N] "
read -r commit_answer
case "$commit_answer" in
  y|Y|yes|YES)
    git commit -m "chore(release): $new_version" -- $staged_files
    ;;
  *)
    echo "Commit skipped"
    exit 0
    ;;
esac

printf "Push current branch now? [y/N] "
read -r push_answer
case "$push_answer" in
  y|Y|yes|YES)
    branch="$(git branch --show-current)"
    if [ -z "$branch" ]; then
      echo "Cannot push from a detached HEAD" >&2
      exit 1
    fi

    if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
      git push
    else
      git push -u origin "$branch"
    fi
    ;;
  *)
    echo "Push skipped"
    ;;
esac
