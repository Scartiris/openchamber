#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKTREE_BASE="${PIGEON_WORKTREE_BASE:-$HOME/worktrees}"
cmd="${1:-help}"
slug="${2:-}"
base="${3:-custom}"

git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "not a git repository: $ROOT" >&2; exit 1; }
case "$cmd" in
  new)
    [[ "$slug" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "slug must use lowercase letters, digits, and hyphens" >&2; exit 1; }
    dest="$WORKTREE_BASE/$slug"
    [[ ! -e "$dest" ]] || { echo "already exists: $dest" >&2; exit 1; }
    mkdir -p "$WORKTREE_BASE"
    branch="feat/$slug"
    git -C "$ROOT" fetch origin "$base" --quiet
    if git -C "$ROOT" show-ref --verify --quiet "refs/heads/$branch"; then
      git -C "$ROOT" worktree add "$dest" "$branch"
    else
      git -C "$ROOT" worktree add -b "$branch" "$dest" "origin/$base"
    fi
    echo "created $dest on $branch"
    ;;
  ls|list) git -C "$ROOT" worktree list ;;
  rm|remove)
    [[ -n "$slug" ]] || { echo "usage: $0 rm <slug>" >&2; exit 1; }
    dest="$WORKTREE_BASE/$slug"
    git -C "$dest" diff --quiet && git -C "$dest" diff --cached --quiet || { echo "worktree has uncommitted changes: $dest" >&2; exit 1; }
    git -C "$ROOT" worktree remove "$dest"
    ;;
  clean|prune) git -C "$ROOT" worktree prune -v ;;
  *)
    cat <<'USAGE'
Usage: pigeon-worktree.sh new <slug> [base] | ls | rm <slug> | clean

Keep the custom checkout clean. Make each change in a feature worktree, verify
it there, merge it into custom, and push custom to trigger the GHCR workflow.
USAGE
    ;;
esac
