#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

REPO=/www/wwwroot/xingxingzaishan
APP_NAME=xingxingzaishan
NODE=/usr/local/bin/node
SWITCH_CLI=/root/production-source-oss-private-switch.js
AUDIT_RUNNER=/root/production-source-oss-public-dependency-audit.sh
RUNTIME_CONFIG_CHECK="$REPO/scripts/acceptance/validate-running-production-config.js"
EXPECTED_COMMIT=5970420f7b61c7551ceb07099f0aa93e613e05d3
EXPECTED_TREE=dd5a574b4c78af7c162a3c5feb817b8f9b5703a6
EXPECTED_DATABASE=xingxing_clean_baseline_20260812_staging
LOCK_FILE=/run/lock/xingxingzaishan-source-oss-private-switch.lock
MODE=
AUDIT_LOG=
SOURCE_BUCKET_ACL_CHANGED=NO

fail() {
  printf 'PRODUCTION_SOURCE_OSS_PRIVATE_SWITCH_RUNNER=FAIL\n'
  printf 'ERROR_CODE=%s\n' "$1"
  printf 'SOURCE_BUCKET_ACL_CHANGED=%s\n' "$SOURCE_BUCKET_ACL_CHANGED"
  if [ "$SOURCE_BUCKET_ACL_CHANGED" = NO ]; then
    printf 'OSS_MUTATION=NONE\n'
  else
    printf 'OSS_MUTATION=SOURCE_BUCKET_ACL_ONLY\n'
  fi
  printf 'DATABASE_WRITE=NONE\n'
  printf 'JSON_WRITE=NONE\n'
  printf 'APPLICATION_RESTART=NO\n'
  printf 'SECRET_VALUES_PRINTED=NO\n'
  exit 1
}

cleanup() {
  local status=$?
  if [ -n "$AUDIT_LOG" ] && [ -e "$AUDIT_LOG" ]; then
    rm -f -- "$AUDIT_LOG"
  fi
  exit "$status"
}
trap cleanup EXIT

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

assert_audit_marker() {
  grep -Fqx "$1" "$AUDIT_LOG" || fail "$2"
}

run_dependency_audit() {
  AUDIT_LOG="$(mktemp /root/.source-oss-private-switch-audit.XXXXXX)" \
    || fail AUDIT_LOG_CREATE_FAILED
  /usr/bin/bash "$AUDIT_RUNNER" --check > "$AUDIT_LOG" 2>&1 \
    || fail SOURCE_OSS_DEPENDENCY_AUDIT_FAILED
}

clear_audit_log() {
  rm -f -- "$AUDIT_LOG"
  AUDIT_LOG=
}

case "${1:-}" in
  --preflight)
    [ "$#" = 1 ] || fail ARGUMENT_INVALID
    MODE=preflight
    ;;
  --authorize-private=YES)
    [ "$#" = 2 ] || fail ARGUMENT_INVALID
    [ "${2:-}" = --miniapp-release-confirmed=YES ] || fail MINIAPP_RELEASE_CONFIRMATION_REQUIRED
    MODE=private
    ;;
  --authorize-rollback-public-read=YES)
    [ "$#" = 1 ] || fail ARGUMENT_INVALID
    MODE=public-read
    ;;
  *) fail MODE_REQUIRED ;;
esac

[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
for command in curl flock git grep mktemp pm2 stat; do
  command -v "$command" >/dev/null 2>&1 || fail "${command^^}_REQUIRED"
done
[ -x "$NODE" ] || fail NODE_REQUIRED
for artifact in "$SWITCH_CLI" "$AUDIT_RUNNER"; do
  [ -f "$artifact" ] || fail REQUIRED_ARTIFACT_MISSING
  [ ! -L "$artifact" ] || fail REQUIRED_ARTIFACT_UNSAFE
  [ "$(stat -c '%U:%G' "$artifact")" = root:root ] || fail REQUIRED_ARTIFACT_OWNER_INVALID
  [ "$(stat -c '%a' "$artifact")" = 700 ] || fail REQUIRED_ARTIFACT_MODE_INVALID
done
[ -f "$RUNTIME_CONFIG_CHECK" ] || fail RUNTIME_CONFIG_CHECK_MISSING
[ ! -L "$RUNTIME_CONFIG_CHECK" ] || fail RUNTIME_CONFIG_CHECK_UNSAFE
[ -d "$REPO/.git" ] || fail REPOSITORY_INVALID

cd "$REPO"
assert_clean_worktree
[ "$(git rev-parse HEAD)" = "$EXPECTED_COMMIT" ] || fail ACTIVE_COMMIT_MISMATCH
[ "$(git rev-parse HEAD^{tree})" = "$EXPECTED_TREE" ] || fail ACTIVE_TREE_MISMATCH

exec 9>"$LOCK_FILE"
flock -n 9 || fail SWITCH_ALREADY_RUNNING

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

if [ "$MODE" != public-read ]; then
  run_dependency_audit
  assert_audit_marker 'SOURCE_OSS_CURRENT_ACL=PUBLIC_READ' SOURCE_OSS_ACL_UNEXPECTED
  assert_audit_marker 'SOURCE_PRIVATE_SWITCH_BLOCKERS=0' SOURCE_OSS_BLOCKERS_REMAIN
  assert_audit_marker 'SOURCE_PRIVATE_SWITCH_REVIEW_REQUIRED=0' SOURCE_OSS_REVIEW_REQUIRED
  assert_audit_marker 'SOURCE_PRIVATE_SWITCH_READY=YES' SOURCE_PRIVATE_SWITCH_NOT_READY
  clear_audit_log
fi

if [ "$MODE" = preflight ]; then
  "$NODE" "$SWITCH_CLI" \
    --preflight \
    --repository="$REPO" \
    --app-pid="$APP_PID_BEFORE" \
    --process-started-at-ms="$PM2_STARTED_AT_MS" \
    || fail SWITCH_PREFLIGHT_FAILED
  printf 'OSS_REQUESTS=SOURCE_GET_BUCKET_INFO_AND_ACL_ONLY\n'
  printf 'OSS_MUTATION=NONE\n'
  printf 'APPLICATION_RESTART=NO\n'
  printf 'READY_FOR_SOURCE_OSS_PRIVATE_SWITCH=YES\n'
  printf 'PRODUCTION_SOURCE_OSS_PRIVATE_SWITCH_RUNNER_PREFLIGHT=PASS\n'
  exit 0
fi

if [ "$MODE" = private ]; then
  printf 'MINIAPP_RELEASE_CONFIRMATION=USER_CONFIRMED\n'
  "$NODE" "$SWITCH_CLI" \
    --authorize-private=YES \
    --repository="$REPO" \
    --app-pid="$APP_PID_BEFORE" \
    --process-started-at-ms="$PM2_STARTED_AT_MS" \
    || fail SOURCE_OSS_PRIVATE_SWITCH_FAILED
  SOURCE_BUCKET_ACL_CHANGED=PRIVATE

  run_dependency_audit
  assert_audit_marker 'SOURCE_OSS_CURRENT_ACL=PRIVATE' SOURCE_OSS_PRIVATE_POSTCHECK_FAILED
  assert_audit_marker 'SOURCE_PRIVATE_SWITCH_BLOCKERS=0' SOURCE_OSS_BLOCKERS_CHANGED
  assert_audit_marker 'SOURCE_PRIVATE_SWITCH_REVIEW_REQUIRED=0' SOURCE_OSS_REVIEW_CHANGED
  assert_audit_marker 'SOURCE_PRIVATE_SWITCH_READY=YES' SOURCE_PRIVATE_SWITCH_READY_CHANGED
  clear_audit_log
else
  "$NODE" "$SWITCH_CLI" \
    --authorize-rollback-public-read=YES \
    --repository="$REPO" \
    --app-pid="$APP_PID_BEFORE" \
    --process-started-at-ms="$PM2_STARTED_AT_MS" \
    || fail SOURCE_OSS_PUBLIC_READ_ROLLBACK_FAILED
  SOURCE_BUCKET_ACL_CHANGED=PUBLIC_READ

  run_dependency_audit
  assert_audit_marker 'SOURCE_OSS_CURRENT_ACL=PUBLIC_READ' SOURCE_OSS_ROLLBACK_POSTCHECK_FAILED
  clear_audit_log
fi

APP_PID_AFTER="$(pm2 pid "$APP_NAME" | awk '$1 != "0" { print $1 }')"
[ "$APP_PID_AFTER" = "$APP_PID_BEFORE" ] || fail APP_PID_CHANGED
[ "$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 10 \
  http://127.0.0.1:3000/api/health/ready)" = 200 ] || fail READINESS_CHANGED

printf 'APP_PID_AFTER=%s\n' "$APP_PID_AFTER"
printf 'APP_HTTP_AFTER=200\n'
printf 'SOURCE_BUCKET_ACL_CHANGED=%s\n' "$SOURCE_BUCKET_ACL_CHANGED"
printf 'OSS_MUTATION=SOURCE_BUCKET_ACL_ONLY\n'
printf 'DATABASE_WRITE=NONE\n'
printf 'JSON_WRITE=NONE\n'
printf 'APPLICATION_RESTART=NO\n'
printf 'SECRET_VALUES_PRINTED=NO\n'
if [ "$MODE" = private ]; then
  printf 'SOURCE_OSS_PRIVATE_SWITCH=PASS\n'
  printf 'ROLLBACK_MODE=AVAILABLE_EXPLICIT_AUTHORIZATION_ONLY\n'
  printf 'PRODUCTION_SOURCE_OSS_PRIVATE_SWITCH_RUNNER=PASS\n'
else
  printf 'SOURCE_OSS_PUBLIC_READ_ROLLBACK=PASS\n'
  printf 'PRODUCTION_SOURCE_OSS_PUBLIC_READ_ROLLBACK_RUNNER=PASS\n'
fi
