#!/bin/sh
# Real Go + Vite environment, with state isolated from normal development.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
WORK="$ROOT/.test-env"
DATA="$WORK/data"
LOCK="$WORK/run.lock"
API_PORT=8180
WEB_PORT=5180
RESET=0

usage() {
  cat <<'EOF'
Usage: sh scripts/test-env.sh [options]

  --reset-db         Clear the test database AND its backups before starting
  --api-port PORT    Backend port (default: 8180)
  --web-port PORT    Frontend port (default: 5180)
  -h, --help         Show this help

State and logs: <repo>/.test-env/ (never uses server/data or ./data).
Both services bind to 127.0.0.1. API mocking is always disabled.
Keep this command running; Ctrl-C stops both services. Data persists by default.
In a second terminal: pnpm e2e:api
Requires Node 22+, pnpm (package.json version), Go (server/go.mod), and curl.
EOF
}

die() { printf 'test-env: %s\n' "$*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --reset-db) RESET=1; shift ;;
    --api-port|--web-port)
      [ "$#" -ge 2 ] || die "$1 requires a port"
      if [ "$1" = --api-port ]; then API_PORT=$2; else WEB_PORT=$2; fi
      shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

for tool in node pnpm go curl; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
done

# Validate before creating files, installing dependencies, or resetting state.
node --input-type=module - "$API_PORT" "$WEB_PORT" <<'NODE'
const ports = process.argv.slice(2);
if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error('test-env: Node 22+ is required');
  process.exit(1);
}
if (ports.some(p => !/^[1-9]\d{0,4}$/.test(p) || Number(p) > 65535) || ports[0] === ports[1]) {
  console.error('test-env: use two distinct ports between 1 and 65535 (no leading zeros)');
  process.exit(1);
}
NODE

# A fixed directory keeps --reset-db away from deployment PONTIS_DATA_DIR.
# Refuse symlinks so an accidental link cannot redirect startup or deletion.
for entry in "$WORK" "$DATA" "$DATA/pontis.db" "$DATA/pontis.db-wal" "$DATA/pontis.db-shm"; do
  [ ! -L "$entry" ] || die "refusing symlink: $entry"
done
mkdir -p "$WORK"
if ! mkdir "$LOCK" 2>/dev/null; then
  die "test environment is locked: $LOCK. Stop the existing launcher first. After an unclean exit, check the *.pid files there and remove the lock only once those processes have stopped."
fi

PREP_PID=
API_PID=
WEB_PID=
cleanup() {
  result=$?
  trap - 0
  trap '' INT TERM HUP
  # Direct children, not go run / pnpm dev wrappers: these are the service PIDs.
  for pid in $PREP_PID $API_PID $WEB_PID; do kill -TERM "$pid" 2>/dev/null || :; done
  remaining=8
  while [ "$remaining" -gt 0 ]; do
    alive=0
    for pid in $PREP_PID $API_PID $WEB_PID; do
      if kill -0 "$pid" 2>/dev/null; then alive=1; fi
    done
    [ "$alive" -eq 1 ] || break
    sleep 1
    remaining=$((remaining - 1))
  done
  for pid in $PREP_PID $API_PID $WEB_PID; do
    kill -KILL "$pid" 2>/dev/null || :
    wait "$pid" 2>/dev/null || :
  done
  rm -f "$LOCK/launcher.pid" "$LOCK/api.pid" "$LOCK/web.pid"
  rmdir "$LOCK"
  exit "$result"
}
trap cleanup 0
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
printf '%s\n' "$$" > "$LOCK/launcher.pid"

# Fail before reset if either requested port is already occupied. Vite also
# uses strictPort, so it cannot silently move the frontend to a different URL.
node --input-type=module - "$API_PORT" "$WEB_PORT" <<'NODE'
import net from 'node:net';
for (const port of process.argv.slice(2).map(Number)) {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  } catch (error) {
    console.error(`test-env: cannot bind 127.0.0.1:${port}: ${error.code}`);
    process.exit(1);
  }
}
NODE

cd "$ROOT"
if [ ! -f "$ROOT/web/node_modules/vite/bin/vite.js" ]; then
  printf 'Installing workspace dependencies...\n'
  env NODE_ENV=development pnpm install --frozen-lockfile --prod=false &
  PREP_PID=$!
  wait "$PREP_PID"
  PREP_PID=
fi
[ -f "$ROOT/web/node_modules/vite/bin/vite.js" ] || die 'Vite is missing after dependency installation'

printf 'Building the current backend...\n'
(cd "$ROOT/server" && exec go build -o "$WORK/pontis" ./cmd/server) &
PREP_PID=$!
wait "$PREP_PID"
PREP_PID=

if [ "$RESET" -eq 1 ]; then
  printf 'Resetting test database and backups: %s\n' "$DATA"
  rm -rf "$DATA"
fi
mkdir -p "$DATA"

API_URL="http://127.0.0.1:$API_PORT"
WEB_URL="http://127.0.0.1:$WEB_PORT"
# Explicit overrides and an empty TOML prevent local deployment config/env
# from changing the database, cookie origin, or listener of this environment.
env PONTIS_LISTEN="127.0.0.1:$API_PORT" PONTIS_DATA_DIR="$DATA" \
  PONTIS_PUBLIC_URL="$WEB_URL" PONTIS_TRUSTED_PROXIES= \
  PONTIS_LINK_CHECK_ALLOW_CIDRS= PONTIS_LOG_LEVEL=info PONTIS_SHUTDOWN_TIMEOUT=5s \
  "$WORK/pontis" -config /dev/null > "$WORK/api.log" 2>&1 &
API_PID=$!
printf '%s\n' "$API_PID" > "$LOCK/api.pid"

service_failed() {
  printf '\nBackend log:\n' >&2
  tail -n 30 "$WORK/api.log" >&2
  if [ -n "$WEB_PID" ]; then
    printf '\nFrontend log:\n' >&2
    tail -n 30 "$WORK/web.log" >&2
  fi
  die "$*"
}

check_processes() {
  kill -0 "$API_PID" 2>/dev/null || service_failed 'backend exited'
  if [ -n "$WEB_PID" ]; then
    kill -0 "$WEB_PID" 2>/dev/null || service_failed 'frontend exited'
  fi
}

wait_http() {
  attempts=0
  while [ "$attempts" -lt 30 ]; do
    check_processes
    if curl --noproxy '*' --fail --silent --max-time 2 "$1" >/dev/null; then return; fi
    attempts=$((attempts + 1))
    sleep 1
  done
  service_failed "timed out waiting for $1"
}

wait_http "$API_URL/healthz"
(
  cd "$ROOT/web"
  exec env NODE_ENV=development VITE_API_MOCK=off PONTIS_API_URL="$API_URL" \
    node "$ROOT/web/node_modules/vite/bin/vite.js" \
    --host 127.0.0.1 --port "$WEB_PORT" --strictPort --mode test
) > "$WORK/web.log" 2>&1 &
WEB_PID=$!
printf '%s\n' "$WEB_PID" > "$LOCK/web.pid"

wait_http "$WEB_URL/"
wait_http "$WEB_URL/api/v1/meta"
check_processes
printf '\nTest environment ready (real HTTP API, VITE_API_MOCK=off).\n'
printf '  Frontend: %s\n  Backend:  %s\n  Data:     %s\n  Logs:     %s/{api,web}.log\n' \
  "$WEB_URL" "$API_URL" "$DATA" "$WORK"
printf '\nRun API E2E in another terminal:\n  PONTIS_E2E_API_URL=%s PONTIS_E2E_WEB_URL=%s pnpm e2e:api\n' "$API_URL" "$WEB_URL"
printf '\nCtrl-C stops both services; data is retained.\n'

# POSIX sh has no wait -n; also detect an unexpected exit of either service.
while :; do
  check_processes
  sleep 1
done
