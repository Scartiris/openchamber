#!/usr/bin/env bash
# pigeon-deploy.sh — one-command pull / switch / rollback for pigeon
# Must run on HOST ( /root/projects/openchamber ), not inside container.
# Requires: docker compose (v2), ghcr.io login if image is private.
#
# Usage:
#   ./scripts/pigeon-deploy.sh status
#   ./scripts/pigeon-deploy.sh pull [tag]          # pull ghcr.io/scartiris/openchamber:<tag> (default :custom)
#   ./scripts/pigeon-deploy.sh switch <tag>        # update compose + up -d to <tag> (e.g. 1.20.107 or custom-abc123)
#   ./scripts/pigeon-deploy.sh rollback            # revert to previous tag recorded in .deploy-history
#   ./scripts/pigeon-deploy.sh login               # ghcr login helper (uses $GHCR_TOKEN or $GITHUB_TOKEN)
set -euo pipefail

COMPOSE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="$COMPOSE_DIR/docker-compose.pigeon.yaml"
HISTORY_FILE="$COMPOSE_DIR/.deploy-history"
IMAGE_BASE="ghcr.io/scartiris/openchamber"
HEALTH_URL="http://127.0.0.1:3000/health"
HEALTH_TIMEOUT=60

# compose files: base + pigeon override
COMPOSE_ARGS=(-f "$COMPOSE_DIR/docker-compose.yml" -f "$COMPOSE_FILE")

current_tag() {
  grep -E '^\s*image:' "$COMPOSE_FILE" | sed -E 's/.*image:\s*//' | head -n1
}

record_history() {
  local tag="$1"
  echo "$(date -Is) $tag" >> "$HISTORY_FILE"
  # keep last 20
  tail -n 20 "$HISTORY_FILE" > "$HISTORY_FILE.tmp" && mv "$HISTORY_FILE.tmp" "$HISTORY_FILE"
}

cmd="${1:-status}"
arg="${2:-}"

case "$cmd" in
  status)
    echo "compose: $COMPOSE_FILE"
    echo "current image: $(current_tag)"
    echo "history (last 5):"
    tail -n 5 "$HISTORY_FILE" 2>/dev/null || echo "  (no history)"
    echo
    docker ps --filter name=openchamber --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' 2>/dev/null || true
    echo
    docker images "$IMAGE_BASE" --format 'table {{.Repository}}:{{.Tag}}\t{{.Size}}\t{{.CreatedSince}}' 2>/dev/null | head -10 || true
    ;;
  login)
    token="${GHCR_TOKEN:-${GITHUB_TOKEN:-}}"
    if [[ -z "$token" ]]; then
      echo "set GHCR_TOKEN (or GITHUB_TOKEN) to a PAT with read:packages"
      echo "  export GHCR_TOKEN=ghp_xxx"
      echo "  echo \$GHCR_TOKEN | docker login ghcr.io -u Scartiris --password-stdin"
      exit 1
    fi
    echo "$token" | docker login ghcr.io -u Scartiris --password-stdin
    echo "logged in to ghcr.io"
    ;;
  pull)
    tag="${arg:-custom}"
    # allow bare tag or full image
    if [[ "$tag" == *"/"* ]]; then image="$tag"; else image="$IMAGE_BASE:$tag"; fi
    if [[ "$tag" == *":"* && "$tag" == *"/"* ]]; then image="$tag"; fi
    echo "pulling $image ..."
    # try login hint on 401
    if ! docker pull "$image"; then
      echo "pull failed — if image is private, run: ./scripts/pigeon-deploy.sh login"
      exit 1
    fi
    echo "pulled $image"
    ;;
  switch)
    tag="$arg"
    if [[ -z "$tag" ]]; then echo "usage: $0 switch <tag>   e.g. $0 switch 1.20.107"; exit 1; fi
    # normalize: allow 1.20.107 or custom-abc or full ghcr ref
    if [[ "$tag" == ghcr.io/* ]]; then image="$tag"
    elif [[ "$tag" == *":"* ]]; then image="$tag"  # already with colon
    else image="$IMAGE_BASE:$tag"; fi
    prev="$(current_tag)"
    echo "switching: $prev -> $image"
    # ensure image present (pull if needed)
    if ! docker image inspect "$image" >/dev/null 2>&1; then
      echo "image not present locally, pulling..."
      docker pull "$image" || { echo "pull failed; aborting"; exit 1; }
    fi
    # backup compose
    cp "$COMPOSE_FILE" "$COMPOSE_FILE.bak.$(date +%Y%m%d-%H%M%S)"
    # replace image line + ensure pull_policy is always for ghcr images
    sed -i "s|^\(\s*image:\s*\).*|\1$image|" "$COMPOSE_FILE"
    if grep -q 'ghcr.io' <<<"$image"; then
      if grep -q 'pull_policy' "$COMPOSE_FILE"; then
        sed -i 's/pull_policy:.*/pull_policy: always/' "$COMPOSE_FILE"
      else
        # insert after image line
        awk -v img="$image" '/image:/{print; print "    pull_policy: always"; next}1' "$COMPOSE_FILE" > "$COMPOSE_FILE.tmp" && mv "$COMPOSE_FILE.tmp" "$COMPOSE_FILE" || true
      fi
    fi
    echo "compose updated, restarting..."
    # compose up (host network/pid requires privileged — existing compose handles it)
    if ! docker compose "${COMPOSE_ARGS[@]}" up -d; then
      echo "compose up failed, restoring backup"
      # restore latest bak
      latest_bak="$(ls -t "$COMPOSE_FILE.bak."* 2>/dev/null | head -1 || true)"
      if [[ -n "$latest_bak" ]]; then cp "$latest_bak" "$COMPOSE_FILE"; fi
      exit 1
    fi
    echo "waiting for health ..."
    for i in $(seq 1 $HEALTH_TIMEOUT); do
      if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then echo "healthy after ${i}s"; break; fi
      if docker inspect --format='{{.State.Status}}' openchamber 2>/dev/null | grep -q "running"; then
        : # container running, keep waiting
        :
      else
        echo "container not running"; docker logs --tail 40 openchamber 2>/dev/null | tail -20; exit 1
      fi
      sleep 1
      if [[ $i -eq $HEALTH_TIMEOUT ]]; then
        echo "health check timed out after ${HEALTH_TIMEOUT}s — rolling back"
        # auto rollback
        if [[ -n "$prev" ]]; then
          sed -i "s|^\(\s*image:\s*\).*|\1$prev|" "$COMPOSE_FILE"
          docker compose "${COMPOSE_ARGS[@]}" up -d || true
        fi
        docker logs --tail 40 openchamber 2>/dev/null | tail -20 || true
        exit 1
      fi
    done
    record_history "$image"
    echo "switched to $image"
    docker ps --filter name=openchamber --format '{{.Image}} {{.Status}}'
    ;;
  rollback)
    if [[ ! -f "$HISTORY_FILE" ]] || [[ $(wc -l < "$HISTORY_FILE") -lt 2 ]]; then
      echo "no rollback target (history has <2 entries)"
      cat "$HISTORY_FILE" 2>/dev/null || echo "(no history)"
      exit 1
    fi
    current="$(current_tag)"
    # second-last entry
    prev="$(tail -n 2 "$HISTORY_FILE" | head -n 1 | awk '{print $2}')"
    if [[ -z "$prev" ]]; then echo "cannot parse history"; cat "$HISTORY_FILE"; exit 1; fi
    echo "rolling back: $current -> $prev"
    exec "$0" switch "$prev"
    ;;
  *)
    echo "unknown command: $cmd"
    echo "usage: $0 {status|pull [tag]|switch <tag>|rollback|login}"
    exit 1
    ;;
esac
