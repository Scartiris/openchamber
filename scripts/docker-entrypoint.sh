#!/usr/bin/env sh
set -eu

HOME="/home/openchamber"
OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-${HOME}/.config/opencode}"
export OPENCODE_CONFIG_DIR

SSH_DIR="${HOME}/.ssh"
SSH_PRIVATE_KEY_PATH="${SSH_DIR}/id_ed25519"
SSH_PUBLIC_KEY_PATH="${SSH_PRIVATE_KEY_PATH}.pub"
mkdir -p "${SSH_DIR}"
chmod 700 "${SSH_DIR}" 2>/dev/null || echo "[entrypoint] warning: cannot chmod SSH directory" >&2

if [ ! -f "${SSH_PRIVATE_KEY_PATH}" ] || [ ! -f "${SSH_PUBLIC_KEY_PATH}" ]; then
  if [ -w "${SSH_DIR}" ]; then
    ssh-keygen -t ed25519 -N "" -f "${SSH_PRIVATE_KEY_PATH}" >/dev/null 2>&1 || echo "[entrypoint] warning: SSH key generation failed" >&2
  else
    echo "[entrypoint] warning: SSH key missing and directory is not writable" >&2
  fi
fi
chmod 600 "${SSH_PRIVATE_KEY_PATH}" 2>/dev/null || true
chmod 644 "${SSH_PUBLIC_KEY_PATH}" 2>/dev/null || true

if [ -z "${OPENCHAMBER_UI_PASSWORD:-}" ] && [ -n "${UI_PASSWORD:-}" ]; then
  OPENCHAMBER_UI_PASSWORD="$UI_PASSWORD"
  export OPENCHAMBER_UI_PASSWORD
fi
if [ -n "${OPENCHAMBER_UI_PASSWORD:-}" ]; then
  echo "[entrypoint] UI password set, enabling authentication"
fi

if [ "${OH_MY_OPENCODE:-false}" = "true" ]; then
  OMO_CONFIG_FILE="${OPENCODE_CONFIG_DIR}/oh-my-opencode.json"
  if [ ! -f "${OMO_CONFIG_FILE}" ]; then
    npm install -g oh-my-opencode
    oh-my-opencode install --no-tui --claude=no --openai=no --gemini=no --copilot=no --opencode-zen=no --zai-coding-plan=no --kimi-for-coding=no --skip-auth
  fi
fi

OPENCHAMBER_HOST="${OPENCHAMBER_HOST:-0.0.0.0}"
export OPENCHAMBER_HOST

# [cloud-mount] 云盘挂载（rclone+openlist，幂等）——必须在 exec 主进程之前
# 后台派发；放在 "$@" 之后是死代码，compose 传参路径永远执行不到（2026-08-28 修复）。
# 首次启动时从两处历史位置引导 rclone 配置。
if [ -f "${HOME}/apps/cloud-mount.sh" ]; then
    if [ ! -f "${HOME}/.config/rclone/rclone.conf" ] && [ -f "${HOME}/.config/openchamber/rclone.conf" ]; then
        mkdir -p "${HOME}/.config/rclone" && cp "${HOME}/.config/openchamber/rclone.conf" "${HOME}/.config/rclone/rclone.conf"
    fi
    if [ ! -f "${HOME}/.config/rclone/rclone.conf" ] && [ -f "${HOME}/apps/rclone.conf.bak" ]; then
        mkdir -p "${HOME}/.config/rclone" && cp "${HOME}/.config/openchamber/rclone.conf" "${HOME}/.config/rclone/rclone.conf"
    fi
    setsid nohup bash "${HOME}/apps/cloud-mount.sh" >> "${HOME}/.config/openchamber/pigeon-data/cloud-mount.log" 2>&1 < /dev/null &
    echo "[entrypoint] cloud-mount dispatched"
fi

# Pigeon companion services keep both code and state in bind-mounted host data.
# A release image therefore remains reproducible and does not depend on a container layer.
if [ -f "${HOME}/.pigeon/server.js" ] && ! curl -fsS --max-time 2 http://127.0.0.1:3210/health >/dev/null 2>&1; then
  setsid nohup /usr/local/bin/bun "${HOME}/.pigeon/server.js" >> "${HOME}/.pigeon/server.log" 2>&1 < /dev/null &
  echo "[entrypoint] pigeon-memory started on :3210"
fi

if [ -f "${HOME}/node-mesh/server/index.ts" ] && ! curl -fsS --max-time 2 http://127.0.0.1:3001/health >/dev/null 2>&1; then
  mkdir -p "${HOME}/node-mesh/logs"
  setsid nohup /usr/local/bin/bun "${HOME}/node-mesh/server/index.ts" --port 3001 >> "${HOME}/node-mesh/logs/server.log" 2>&1 < /dev/null &
  echo "[entrypoint] node-mesh broker started on :3001"
fi

echo "[entrypoint] starting..."
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

set -- bun packages/web/bin/cli.js
if [ -n "${OPENCHAMBER_UI_PASSWORD:-}" ]; then
  set -- "$@" --ui-password "$OPENCHAMBER_UI_PASSWORD"
fi
"$@"
