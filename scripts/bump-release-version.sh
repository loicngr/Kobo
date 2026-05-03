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

if [ -n "$(git status --porcelain -- package.json package-lock.json)" ]; then
  echo "package.json or package-lock.json already has changes. Commit or stash them before bumping." >&2
  exit 1
fi

new_version="$(npm version "$version" --no-git-tag-version)"
git add package.json package-lock.json

echo "Bumped to $new_version"
echo "Staged: package.json package-lock.json"

printf "Commit version bump now? [y/N] "
read -r commit_answer
case "$commit_answer" in
  y|Y|yes|YES)
    git commit -m "chore(release): $new_version" -- package.json package-lock.json
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
