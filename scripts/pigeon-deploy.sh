#!/usr/bin/env bash
set -euo pipefail

if [[ -f /.dockerenv || -f /run/.containerenv ]]; then
  echo "refusing to switch OpenChamber from inside a container; run this on the host" >&2
  exit 2
fi

COMPOSE_DIR="${PIGEON_COMPOSE_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
COMPOSE_FILE="$COMPOSE_DIR/docker-compose.pigeon.yaml"
ENV_FILE="${PIGEON_ENV_FILE:-/root/.config/openchamber/openchamber.env}"
HISTORY_FILE="$COMPOSE_DIR/.deploy-history"
SERVICE="${PIGEON_SERVICE:-openchamber-container.service}"
IMAGE_BASE="ghcr.io/scartiris/openchamber"
HEALTH_TIMEOUT="${PIGEON_HEALTH_TIMEOUT:-90}"
COMPOSE_ARGS=(--env-file "$ENV_FILE" -f "$COMPOSE_DIR/docker-compose.yml" -f "$COMPOSE_FILE")

die() { echo "error: $*" >&2; exit 1; }
test -f "$COMPOSE_FILE" || die "compose override not found: $COMPOSE_FILE"
test -r "$ENV_FILE" || die "environment file not readable: $ENV_FILE"

current_image() { sed -nE 's/^[[:space:]]*image:[[:space:]]*//p' "$COMPOSE_FILE" | head -n 1; }
last_history_image() { tail -n 1 "$HISTORY_FILE" 2>/dev/null | awk '{print $2}'; }
record_history() {
  local image="$1"
  [[ -n "$image" && "$(last_history_image)" != "$image" ]] || return 0
  printf '%s %s\n' "$(date -Is)" "$image" >> "$HISTORY_FILE"
  tail -n 20 "$HISTORY_FILE" > "$HISTORY_FILE.tmp" && mv "$HISTORY_FILE.tmp" "$HISTORY_FILE"
}
validate_image() {
  [[ "$1" =~ ^(ghcr\.io/scartiris/openchamber|pigeon-openchamber):[A-Za-z0-9._-]+$ ]] || die "unsupported image reference: $1"
}
set_image() {
  local image="$1"
  sed -i -E "0,/^[[:space:]]*image:/s|^([[:space:]]*image:).*|\\1 $image|" "$COMPOSE_FILE"
  if grep -q '^[[:space:]]*pull_policy:' "$COMPOSE_FILE"; then
    sed -i -E 's/^([[:space:]]*pull_policy:).*/\1 never/' "$COMPOSE_FILE"
  else
    sed -i "/^[[:space:]]*image:/a\\    pull_policy: never" "$COMPOSE_FILE"
  fi
}
wait_healthy() {
  local i url
  for i in $(seq 1 "$HEALTH_TIMEOUT"); do
    if systemctl is-active --quiet "$SERVICE"; then
      for url in http://127.0.0.1:3000/health http://127.0.0.1:3210/health http://127.0.0.1:3001/health http://127.0.0.1:5244/ping; do
        curl -fsS --max-time 3 "$url" >/dev/null 2>&1 || break
      done
      [[ "$url" == "http://127.0.0.1:5244/ping" ]] && return 0
    fi
    sleep 1
  done
  return 1
}
rollback_file() {
  local backup="$1"
  cp -p "$backup" "$COMPOSE_FILE"
  systemctl restart "$SERVICE" || true
}

cmd="${1:-status}"
arg="${2:-}"
case "$cmd" in
  status)
    echo "configured image: $(current_image)"
    systemctl is-active "$SERVICE" || true
    docker inspect openchamber --format 'running={{.State.Running}} image={{.Config.Image}} started={{.State.StartedAt}}' 2>/dev/null || true
    tail -n 5 "$HISTORY_FILE" 2>/dev/null || true
    ;;
  pull)
    tag="${arg:-custom}"
    image="$tag"
    [[ "$image" == ghcr.io/* ]] || image="$IMAGE_BASE:$image"
    validate_image "$image"
    docker pull "$image"
    ;;
  switch)
    [[ -n "$arg" ]] || die "usage: $0 switch <tag-or-image>"
    image="$arg"
    [[ "$image" == *:* ]] || image="$IMAGE_BASE:$image"
    validate_image "$image"
    previous="$(current_image)"
    backup="$COMPOSE_FILE.bak.$(date +%Y%m%d-%H%M%S)"
    cp -p "$COMPOSE_FILE" "$backup"
    if [[ "$image" == ghcr.io/* ]]; then docker pull "$image"; else docker image inspect "$image" >/dev/null; fi
    set_image "$image"
    if ! systemctl restart "$SERVICE" || ! wait_healthy; then
      echo "switch failed; restoring $previous" >&2
      rollback_file "$backup"
      exit 1
    fi
    record_history "$previous"
    record_history "$image"
    echo "switched to $image"
    ;;
  rollback)
    current="$(current_image)"
    target="$(tac "$HISTORY_FILE" 2>/dev/null | awk -v current="$current" '$2 != current {print $2; exit}')"
    [[ -n "$target" ]] || die "no rollback target recorded"
    exec "$0" switch "$target"
    ;;
  *) die "usage: $0 {status|pull [tag]|switch <tag-or-image>|rollback}" ;;
esac
