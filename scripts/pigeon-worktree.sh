#!/usr/bin/env bash
# pigeon-worktree.sh — git worktree helper for parallel feature work
# Each feature gets an isolated worktree + branch, avoiding collisions
# on the single ~/openchamber-fork checkout.
#
# Usage:
#   ./scripts/pigeon-worktree.sh new <slug> [base]   # create ~/worktrees/<slug> from <base> (default: custom)
#   ./scripts/pigeon-worktree.sh ls                  # list worktrees
#   ./scripts/pigeon-worktree.sh rm <slug>           # remove worktree (keeps branch)
#   ./scripts/pigeon-worktree.sh clean               # prune stale entries
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MAIN="$ROOT"
WT_BASE="$HOME/worktrees"

cmd="${1:-help}"
slug="${2:-}"
base="${3:-custom}"

case "$cmd" in
  new)
    if [[ -z "$slug" ]]; then echo "usage: $0 new <slug> [base-branch]"; exit 1; fi
    if [[ ! -d "$MAIN/.git" ]]; then echo "not a git repo: $MAIN"; exit 1; fi
    # ensure base exists
    git -C "$MAIN" fetch origin "$base" --quiet 2>/dev/null || true
    dest="$WT_BASE/$slug"
    if [[ -e "$dest" ]]; then echo "already exists: $dest"; exit 1; fi
    mkdir -p "$WT_BASE"
    branch="feat/$slug"
    # if branch already exists, reuse it
    if git -C "$MAIN" show-ref --verify --quiet "refs/heads/$branch"; then
      echo "branch $branch exists, checking out"
      git -C "$MAIN" worktree add "$dest" "$branch"
    else
      git -C "$MAIN" worktree add -b "$branch" "$dest" "$base"
    fi
    echo "created: $dest  (branch $branch from $base)"
    echo "  cd $dest"
    ;;
  ls|list)
    git -C "$MAIN" worktree list
    ;;
  rm|remove)
    if [[ -z "$slug" ]]; then echo "usage: $0 rm <slug>"; exit 1; fi
    dest="$WT_BASE/$slug"
    if [[ ! -d "$dest" ]]; then echo "not found: $dest"; git -C "$MAIN" worktree list; exit 1; fi
    # ensure no uncommitted changes
    if ! git -C "$dest" diff --quiet || ! git -C "$dest" diff --cached --quiet; then
      echo "worktree has uncommitted changes, aborting. commit or stash first."
      git -C "$dest" status -sb | head -20
      exit 1
    fi
    git -C "$MAIN" worktree remove "$dest"
    echo "removed worktree: $dest (branch preserved)"
    echo "  to delete branch: git branch -d feat/$slug"
    ;;
  clean|prune)
    git -C "$MAIN" worktree prune -v
    ;;
  help|*)
    cat <<'USAGE'
pigeon-worktree.sh — parallel worktree manager

  new <slug> [base]   create ~/worktrees/<slug> on branch feat/<slug> from <base> (default custom)
  ls                  list all worktrees
  rm <slug>           remove worktree (keeps branch, checks for dirty changes)
  clean               prune stale worktree entries

Rules:
  - ~/openchamber-fork stays on custom and stays clean; all edits happen in worktrees.
  - Merge back:  cd ~/openchamber-fork && git merge --no-ff feat/<slug> && git push origin custom
  - Push to custom triggers GHCR build (docker.yml); tag a version with scripts/bump-version.mjs first if needed.
USAGE
    ;;
esac
