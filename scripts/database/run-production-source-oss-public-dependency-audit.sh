#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

REPO=/www/wwwroot/xingxingzaishan
APP_NAME=xingxingzaishan
NODE=/usr/local/bin/node
AUDIT_CLI=/root/production-source-oss-public-dependency-audit.js
RUNTIME_CONFIG_CHECK="$REPO/scripts/acceptance/validate-running-production-config.js"
EXPECTED_COMMIT=5970420f7b61c7551ceb07099f0aa93e613e05d3
EXPECTED_TREE=dd5a574b4c78af7c162a3c5feb817b8f9b5703a6
EXPECTED_DATABASE=xingxing_clean_baseline_20260812_staging
LOCK_FILE=/run/lock/xingxingzaishan-source-oss-public-dependency-audit.lock

fail() {
  printf 'PRODUCTION_SOURCE_OSS_PUBLIC_DEPENDENCY_AUDIT_RUNNER=FAIL\n'
  printf 'ERROR_CODE=%s\n' "$1"
  printf 'PRODUCTION_DATABASE_WRITE=NONE\n'
  printf 'JSON_WRITE=NONE\n'
  printf 'OSS_MUTATION=NONE\n'
  printf 'APPLICATION_RESTART=NO\n'
  printf 'CONFIGURATION_WRITE=NONE\n'
  printf 'SECRET_VALUES_PRINTED=NO\n'
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

[ "$#" = 1 ] || fail ARGUMENT_INVALID
[ "$1" = --check ] || fail ARGUMENT_INVALID
[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
for command in curl flock git pm2 stat; do
  command -v "$command" >/dev/null 2>&1 || fail "${command^^}_REQUIRED"
done
[ -x "$NODE" ] || fail NODE_REQUIRED
[ -f "$AUDIT_CLI" ] || fail AUDIT_CLI_MISSING
[ ! -L "$AUDIT_CLI" ] || fail AUDIT_CLI_UNSAFE
[ "$(stat -c '%U:%G' "$AUDIT_CLI")" = root:root ] || fail AUDIT_CLI_OWNER_INVALID
[ "$(stat -c '%a' "$AUDIT_CLI")" = 700 ] || fail AUDIT_CLI_MODE_INVALID
[ -f "$RUNTIME_CONFIG_CHECK" ] || fail RUNTIME_CONFIG_CHECK_MISSING
[ ! -L "$RUNTIME_CONFIG_CHECK" ] || fail RUNTIME_CONFIG_CHECK_UNSAFE
[ -d "$REPO/.git" ] || fail REPOSITORY_INVALID

cd "$REPO"
assert_clean_worktree
[ "$(git rev-parse HEAD)" = "$EXPECTED_COMMIT" ] || fail ACTIVE_COMMIT_MISMATCH
[ "$(git rev-parse HEAD^{tree})" = "$EXPECTED_TREE" ] || fail ACTIVE_TREE_MISMATCH

exec 9>"$LOCK_FILE"
flock -n 9 || fail AUDIT_ALREADY_RUNNING

APP_PID_BEFORE="$(pm2 pid "$APP_NAME" | awk '$1 != "0" { print $1 }')"
[[ "$APP_PID_BEFORE" =~ ^[0-9]+$ ]] || fail APP_SINGLE_PID_REQUIRED
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
[ "$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 10 \
  http://127.0.0.1:3000/api/health/ready)" = 200 ] || fail CURRENT_READINESS_FAILED

printf 'ACTIVE_COMMIT=%s\n' "$EXPECTED_COMMIT"
printf 'ACTIVE_TREE=%s\n' "$EXPECTED_TREE"
printf 'APP_PID_BEFORE=%s\n' "$APP_PID_BEFORE"
printf 'CURRENT_READINESS=PASS_200_READY\n'

"$NODE" "$AUDIT_CLI" \
  --check \
  --repository="$REPO" \
  --app-pid="$APP_PID_BEFORE" \
  --process-started-at-ms="$PM2_STARTED_AT_MS" \
  || fail AUDIT_FAILED

APP_PID_AFTER="$(pm2 pid "$APP_NAME" | awk '$1 != "0" { print $1 }')"
[ "$APP_PID_AFTER" = "$APP_PID_BEFORE" ] || fail APP_PID_CHANGED
[ "$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 10 \
  http://127.0.0.1:3000/api/health/ready)" = 200 ] || fail READINESS_CHANGED

printf 'APP_PID_AFTER=%s\n' "$APP_PID_AFTER"
printf 'APP_HTTP_AFTER=200\n'
printf 'PRODUCTION_DATABASE_WRITE=NONE\n'
printf 'JSON_WRITE=NONE\n'
printf 'OSS_REQUESTS=SOURCE_GET_BUCKET_INFO_ONLY\n'
printf 'DESTINATION_OSS_REQUESTS=NONE\n'
printf 'APPLICATION_RESTART=NO\n'
printf 'CONFIGURATION_WRITE=NONE\n'
printf 'SECRET_VALUES_PRINTED=NO\n'
printf 'PRODUCTION_SOURCE_OSS_PUBLIC_DEPENDENCY_AUDIT_RUNNER=PASS\n'
