#!/usr/bin/env bash
set -Eeuo pipefail

INSTANCE="${1:?instance name is required}"
MODE="${2:-headless}"
ENV_FILE="/etc/zako-browser/${INSTANCE}.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE" >&2
  exit 1
fi

source "$ENV_FILE"

if [[ "$MODE" != "headless" && "$MODE" != "headed" ]]; then
  echo "Invalid browser mode: $MODE" >&2
  exit 1
fi

if [[ "$MODE" == "headed" ]]; then
  export DISPLAY=":${DISPLAY_NUMBER}"
fi

mkdir -p "$PROFILE_DIR" "$RUNTIME_DIR"
chmod 700 "$PROFILE_DIR" "$RUNTIME_DIR"

cleanup() {
  local code=$?
  trap - EXIT INT TERM
  for pid in "${WEBSOCKIFY_PID:-}" "${VNC_PID:-}" "${FLUXBOX_PID:-}" "${CHROMIUM_PID:-}" "${XVFB_PID:-}"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  exit "$code"
}

trap cleanup EXIT INT TERM

if [[ "$MODE" == "headed" ]]; then
  rm -f "/tmp/.X${DISPLAY_NUMBER}-lock" "/tmp/.X11-unix/X${DISPLAY_NUMBER}"

  Xvfb "$DISPLAY" -screen 0 "${SCREEN_GEOMETRY:-1440x960x24}" -nolisten tcp -ac &
  XVFB_PID=$!

  sleep 1

  fluxbox -display "$DISPLAY" >/dev/null 2>&1 &
  FLUXBOX_PID=$!

  x11vnc \
    -display "$DISPLAY" \
    -rfbport "$VNC_PORT" \
    -rfbauth "$VNC_PASSWORD_FILE" \
    -forever \
    -shared \
    -localhost \
    -noxrecord \
    -noxfixes \
    -noxdamage \
    >/dev/null 2>&1 &
  VNC_PID=$!

  websockify --web=/usr/share/novnc/ "${NOVNC_BIND}:${NOVNC_PORT}" "127.0.0.1:${VNC_PORT}" >/dev/null 2>&1 &
  WEBSOCKIFY_PID=$!
fi

CHROMIUM_ARGS=(
  --no-sandbox
  --disable-gpu
  --disable-dev-shm-usage
  --no-first-run
  --no-default-browser-check
  --password-store=basic
  --user-data-dir="$PROFILE_DIR"
  --remote-debugging-address=127.0.0.1
  --remote-debugging-port="$REMOTE_DEBUGGING_PORT"
  --window-size="${WINDOW_SIZE:-1440,960}"
  --window-position=0,0
  --new-window "${START_URL:-about:blank}"
)

if [[ "$MODE" == "headless" ]]; then
  CHROMIUM_ARGS+=(--headless=new)
fi

/usr/bin/chromium "${CHROMIUM_ARGS[@]}" >/dev/null 2>&1 &
CHROMIUM_PID=$!

if [[ "$MODE" == "headed" ]]; then
  wait -n "$XVFB_PID" "$FLUXBOX_PID" "$VNC_PID" "$WEBSOCKIFY_PID" "$CHROMIUM_PID"
else
  wait "$CHROMIUM_PID"
fi
