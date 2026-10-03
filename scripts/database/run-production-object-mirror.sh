#!/usr/bin/env bash
set -euo pipefail

REPO=/www/wwwroot/xingxingzaishan
APP_NAME=xingxingzaishan
NODE=/usr/local/bin/node
CLI="$REPO/scripts/database/production-object-mirror-cli.js"
RUNTIME_CONFIG_CHECK="$REPO/scripts/acceptance/validate-running-production-config.js"
SOURCE_OSS_ENV="$REPO/.env"
DESTINATION_OSS_ENV=/etc/xingxingzaishan/object-mirror.env
OUTPUT_ROOT=/root/xingxingzaishan-object-mirror
LOCAL_RUN_RETENTION_COUNT=31
LOCK_FILE=/run/lock/xingxingzaishan-object-mirror.lock
EXPECTED_DATABASE=xingxing_clean_baseline_20260812_staging
MODE=
APP_PID_BEFORE=

fail() {
  printf 'PRODUCTION_OBJECT_MIRROR_RUNNER=FAIL\nERROR_CODE=%s\n' "$1" >&2
  exit 1
}

assert_clean_worktree() {
  local state
  state="$(git status --porcelain=v1 --untracked-files=normal)"
  case "$state" in
    '') ;;
    '?? src/frontend/5QJLlAJPza.txt')
      [ -f "$REPO/src/frontend/5QJLlAJPza.txt" ] \
        || fail PUBLIC_VERIFICATION_FILE_INVALID
      [ ! -L "$REPO/src/frontend/5QJLlAJPza.txt" ] \
        || fail PUBLIC_VERIFICATION_FILE_INVALID
      ;;
    *) fail WORKTREE_NOT_CLEAN ;;
  esac
}

assert_root_private_regular_file() {
  local file="$1"
  [ -f "$file" ] || return 1
  [ ! -L "$file" ] || return 1
  [ "$(stat -c '%U:%G' "$file")" = root:root ] || return 1
  [ "$(stat -c '%a' "$file")" = 600 ] || return 1
}

prune_local_run_directories() {
  local current_directory="$1"
  local current_name
  local kept=0
  local name
  local candidate

  [[ "$LOCAL_RUN_RETENTION_COUNT" =~ ^[1-9][0-9]*$ ]] \
    || fail MIRROR_LOCAL_RETENTION_INVALID
  current_name="$(basename "$current_directory")"
  [[ "$current_name" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$ ]] \
    || fail MIRROR_LOCAL_RUN_DIRECTORY_INVALID
  [ "$current_directory" = "$OUTPUT_ROOT/$current_name" ] \
    || fail MIRROR_LOCAL_RUN_DIRECTORY_INVALID
  while IFS= read -r name; do
    [[ "$name" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$ ]] || continue
    candidate="$OUTPUT_ROOT/$name"
    [ -d "$candidate" ] || fail MIRROR_LOCAL_RUN_DIRECTORY_INVALID
    [ ! -L "$candidate" ] || fail MIRROR_LOCAL_RUN_DIRECTORY_INVALID
    [ "$(stat -c '%U:%G' "$candidate")" = root:root ] \
      || fail MIRROR_LOCAL_RUN_DIRECTORY_INVALID
    if [ "$candidate" = "$current_directory" ]; then
      kept=$((kept + 1))
      continue
    fi
    kept=$((kept + 1))
    if [ "$kept" -gt "$LOCAL_RUN_RETENTION_COUNT" ]; then
      rm -rf -- "$candidate" || fail MIRROR_LOCAL_RETENTION_CLEANUP_FAILED
    fi
  done < <(
    {
      printf '%s\n' "$current_name"
      find "$OUTPUT_ROOT" -mindepth 1 -maxdepth 1 -printf '%f\n' \
        | LC_ALL=C sort -r
    } | awk '!seen[$0]++'
  )
}

case "${1:-}" in
  --preflight) MODE=preflight ;;
  --authorize-mirror=YES) MODE=authorized ;;
  *) fail MIRROR_MODE_REQUIRED ;;
esac
[ "$#" = 1 ] || fail MIRROR_ARGUMENT_INVALID
[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED

for command in basename flock pm2 curl openssl git stat awk tr find sort rm; do
  command -v "$command" >/dev/null 2>&1 || fail "${command^^}_REQUIRED"
done
[ -x "$NODE" ] || fail NODE_REQUIRED
[ -f "$CLI" ] || fail MIRROR_CLI_MISSING
[ -f "$RUNTIME_CONFIG_CHECK" ] || fail RUNTIME_CONFIG_CHECK_MISSING

cd "$REPO"
assert_clean_worktree
GIT_COMMIT="$(git rev-parse HEAD)"
GIT_TREE="$(git rev-parse HEAD^{tree})"

exec 9>"$LOCK_FILE"
flock -n 9 || fail MIRROR_ALREADY_RUNNING

assert_root_private_regular_file "$SOURCE_OSS_ENV" || fail SOURCE_OSS_ENV_UNSAFE
assert_root_private_regular_file "$DESTINATION_OSS_ENV" || fail DESTINATION_OSS_ENV_UNSAFE

APP_PID_BEFORE="$(pm2 pid "$APP_NAME" | tail -n 1)"
[ -n "$APP_PID_BEFORE" ] || fail APP_PID_MISSING
[ "$APP_PID_BEFORE" != 0 ] || fail APP_NOT_ONLINE
[ -r "/proc/$APP_PID_BEFORE/environ" ] || fail APP_RUNTIME_UNREADABLE
PM2_STATE="$(pm2 jlist | "$NODE" -e '
const fs = require("node:fs");
const rows = JSON.parse(fs.readFileSync(0, "utf8"));
const apps = rows.filter((row) => row.name === "xingxingzaishan");
if (apps.length !== 1) process.exit(2);
const env = apps[0].pm2_env || {};
process.stdout.write([
  String(Number(apps[0].pid || 0)),
  String(env.status || "UNKNOWN"),
  String(Number(env.pm_uptime || 0))
].join("|"));
')" || fail PM2_STATE_INVALID
IFS='|' read -r PM2_PID PM2_STATUS PM2_STARTED_AT_MS <<< "$PM2_STATE"
[ "$PM2_PID" = "$APP_PID_BEFORE" ] || fail APP_PID_CHANGED
[ "$PM2_STATUS" = online ] || fail APP_NOT_ONLINE
[[ "$PM2_STARTED_AT_MS" =~ ^[0-9]+$ ]] || fail PM2_STATE_INVALID
[ "$PM2_STARTED_AT_MS" -gt 0 ] || fail PM2_STATE_INVALID
"$NODE" "$RUNTIME_CONFIG_CHECK" \
  "$APP_PID_BEFORE" "$REPO" "$EXPECTED_DATABASE" "$PM2_STARTED_AT_MS" \
  || fail RUNTIME_CONFIG_INVALID

APP_HTTP_BEFORE="$(
  curl -sS -o /dev/null -w '%{http_code}' \
    --connect-timeout 5 --max-time 10 \
    http://127.0.0.1:3000/
)"
[ "$APP_HTTP_BEFORE" = 200 ] || fail APP_HTTP_INVALID

printf 'GIT_COMMIT=%s\n' "$GIT_COMMIT"
printf 'GIT_TREE=%s\n' "$GIT_TREE"
printf 'APP_PID_BEFORE=%s\n' "$APP_PID_BEFORE"
printf 'CURRENT_READINESS=PASS_200_READY\n'

if [ "$MODE" = preflight ]; then
  "$NODE" "$CLI" \
    --preflight \
    --app-pid="$APP_PID_BEFORE" \
    --process-started-at-ms="$PM2_STARTED_AT_MS" \
    --source-oss-env="$SOURCE_OSS_ENV" \
    --destination-oss-env="$DESTINATION_OSS_ENV"
  printf 'DATABASE_WRITE=NONE\n'
  printf 'OSS_MUTATION=NONE\n'
  printf 'APPLICATION_RESTART=NO\n'
  printf 'SECRET_VALUES_PRINTED=NO\n'
  printf 'PRODUCTION_OBJECT_MIRROR_RUNNER_PREFLIGHT=PASS\n'
  exit 0
fi

mkdir -p -m 700 "$OUTPUT_ROOT"
[ ! -L "$OUTPUT_ROOT" ] || fail MIRROR_OUTPUT_ROOT_INVALID
[ "$(stat -c '%U:%G' "$OUTPUT_ROOT")" = root:root ] || fail MIRROR_OUTPUT_ROOT_INVALID
chmod 700 "$OUTPUT_ROOT"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4)"
[[ "$RUN_ID" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$ ]] || fail MIRROR_RUN_ID_INVALID
OUTPUT_DIRECTORY="$OUTPUT_ROOT/$RUN_ID"
mkdir -m 700 "$OUTPUT_DIRECTORY"

"$NODE" "$CLI" \
  --authorize-mirror=YES \
  --app-pid="$APP_PID_BEFORE" \
  --process-started-at-ms="$PM2_STARTED_AT_MS" \
  --run-id="$RUN_ID" \
  --output-directory="$OUTPUT_DIRECTORY" \
  --source-oss-env="$SOURCE_OSS_ENV" \
  --destination-oss-env="$DESTINATION_OSS_ENV"

prune_local_run_directories "$OUTPUT_DIRECTORY"

APP_PID_AFTER="$(pm2 pid "$APP_NAME" | tail -n 1)"
[ "$APP_PID_AFTER" = "$APP_PID_BEFORE" ] || fail APP_PID_CHANGED
APP_HTTP_AFTER="$(
  curl -sS -o /dev/null -w '%{http_code}' \
    --connect-timeout 5 --max-time 10 \
    http://127.0.0.1:3000/
)"
[ "$APP_HTTP_AFTER" = 200 ] || fail APP_HTTP_INVALID_AFTER_MIRROR
"$NODE" "$RUNTIME_CONFIG_CHECK" \
  "$APP_PID_AFTER" "$REPO" "$EXPECTED_DATABASE" "$PM2_STARTED_AT_MS" \
  || fail RUNTIME_CONFIG_CHANGED

printf 'MIRROR_OUTPUT_DIRECTORY=%s\n' "$OUTPUT_DIRECTORY"
printf 'MIRROR_LOCAL_RUN_RETENTION_COUNT=%s\n' "$LOCAL_RUN_RETENTION_COUNT"
printf 'APP_PID_AFTER=%s\n' "$APP_PID_AFTER"
printf 'APP_HTTP_AFTER=200\n'
printf 'DATABASE_WRITE=NONE\n'
printf 'OSS_REQUESTS=INDEPENDENT_OBJECT_MIRROR_AND_FULL_RESTORE_AUDIT\n'
printf 'BLOCKCHAIN_WRITE=NONE\n'
printf 'APPLICATION_RESTART=NO\n'
printf 'SECRET_VALUES_PRINTED=NO\n'
printf 'PRODUCTION_OBJECT_MIRROR_RUNNER=PASS\n'
