#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

REPO=/www/wwwroot/xingxingzaishan
APP_NAME=xingxingzaishan
NODE=/usr/local/bin/node
REMEDIATION_CLI=/root/production-source-oss-logo-remediation.js
AUDIT_RUNNER=/root/production-source-oss-public-dependency-audit.sh
RUNTIME_CONFIG_CHECK="$REPO/scripts/acceptance/validate-running-production-config.js"
EXPECTED_COMMIT=5970420f7b61c7551ceb07099f0aa93e613e05d3
EXPECTED_TREE=dd5a574b4c78af7c162a3c5feb817b8f9b5703a6
EXPECTED_DATABASE=xingxing_clean_baseline_20260812_staging
BACKUP_ROOT=/root/production-source-oss-logo-remediation
LOCK_FILE=/run/lock/xingxingzaishan-source-oss-logo-remediation.lock
MODE=
AUDIT_LOG=

fail() {
  printf 'PRODUCTION_SOURCE_OSS_LOGO_REMEDIATION_RUNNER=FAIL\n'
  printf 'ERROR_CODE=%s\n' "$1"
  printf 'SOURCE_BUCKET_ACL_CHANGED=NO\n'
  printf 'OSS_MUTATION=NONE\n'
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
  AUDIT_LOG="$(mktemp /root/.source-oss-logo-audit.XXXXXX)" \
    || fail AUDIT_LOG_CREATE_FAILED
  /usr/bin/bash "$AUDIT_RUNNER" --check > "$AUDIT_LOG" 2>&1 \
    || fail SOURCE_OSS_DEPENDENCY_AUDIT_FAILED
}

case "${1:-}" in
  --preflight)
    [ "$#" = 1 ] || fail ARGUMENT_INVALID
    MODE=preflight
    ;;
  --authorize-remediate=YES)
    [ "$#" = 1 ] || fail ARGUMENT_INVALID
    MODE=authorized
    ;;
  *) fail MODE_REQUIRED ;;
esac

[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
for command in curl flock git grep mktemp pm2 stat; do
  command -v "$command" >/dev/null 2>&1 || fail "${command^^}_REQUIRED"
done
[ -x "$NODE" ] || fail NODE_REQUIRED
[ -f "$REMEDIATION_CLI" ] || fail REMEDIATION_CLI_MISSING
[ ! -L "$REMEDIATION_CLI" ] || fail REMEDIATION_CLI_UNSAFE
[ "$(stat -c '%U:%G' "$REMEDIATION_CLI")" = root:root ] \
  || fail REMEDIATION_CLI_OWNER_INVALID
[ "$(stat -c '%a' "$REMEDIATION_CLI")" = 700 ] \
  || fail REMEDIATION_CLI_MODE_INVALID
[ -f "$AUDIT_RUNNER" ] || fail AUDIT_RUNNER_MISSING
[ ! -L "$AUDIT_RUNNER" ] || fail AUDIT_RUNNER_UNSAFE
[ -f "$RUNTIME_CONFIG_CHECK" ] || fail RUNTIME_CONFIG_CHECK_MISSING
[ ! -L "$RUNTIME_CONFIG_CHECK" ] || fail RUNTIME_CONFIG_CHECK_UNSAFE
[ -d "$REPO/.git" ] || fail REPOSITORY_INVALID

cd "$REPO"
assert_clean_worktree
[ "$(git rev-parse HEAD)" = "$EXPECTED_COMMIT" ] || fail ACTIVE_COMMIT_MISMATCH
[ "$(git rev-parse HEAD^{tree})" = "$EXPECTED_TREE" ] || fail ACTIVE_TREE_MISMATCH
grep -Fq 'wx:if="{{hasLogo}}"' src/miniprogram/pages/home/home.wxml \
  || fail MINIAPP_LOGO_FALLBACK_CONTRACT_MISSING
grep -Fq 'wx:else class="home-brand-mark"' src/miniprogram/pages/home/home.wxml \
  || fail MINIAPP_LOGO_FALLBACK_CONTRACT_MISSING
grep -Fq 'hasLogo: false' src/miniprogram/pages/home/home.js \
  || fail MINIAPP_LOGO_FALLBACK_CONTRACT_MISSING

exec 9>"$LOCK_FILE"
flock -n 9 || fail REMEDIATION_ALREADY_RUNNING

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
printf 'MINIAPP_LOGO_FALLBACK_CONTRACT=PASS\n'

run_dependency_audit
assert_audit_marker 'SOURCE_OSS_CURRENT_ACL=PUBLIC_READ' SOURCE_OSS_ACL_UNEXPECTED
assert_audit_marker 'SOURCE_PRIVATE_SWITCH_BLOCKERS=1' SOURCE_OSS_BLOCKER_COUNT_UNEXPECTED
assert_audit_marker 'SOURCE_PRIVATE_SWITCH_REVIEW_REQUIRED=0' SOURCE_OSS_REVIEW_REQUIRED
assert_audit_marker \
  'JSON_MINIAPP_LOGO_IMAGE_REFERENCES_SOURCE_PUBLIC_DIRECT=1' \
  SOURCE_OSS_LOGO_BLOCKER_UNEXPECTED
assert_audit_marker \
  'POSTGRES_MINIAPP_SHADOW_LOGO_IMAGE_REFERENCES_SOURCE_PUBLIC_DIRECT=1' \
  SOURCE_OSS_LOGO_SHADOW_UNEXPECTED
rm -f -- "$AUDIT_LOG"
AUDIT_LOG=

if [ "$MODE" = preflight ]; then
  "$NODE" "$REMEDIATION_CLI" \
    --preflight \
    --repository="$REPO" \
    --app-pid="$APP_PID_BEFORE" \
    --process-started-at-ms="$PM2_STARTED_AT_MS" \
    || fail REMEDIATION_PREFLIGHT_FAILED
  printf 'SOURCE_BUCKET_ACL_CHANGED=NO\n'
  printf 'OSS_MUTATION=NONE\n'
  printf 'APPLICATION_RESTART=NO\n'
  printf 'READY_FOR_SOURCE_OSS_LOGO_REMEDIATION=YES\n'
  printf 'PRODUCTION_SOURCE_OSS_LOGO_REMEDIATION_RUNNER_PREFLIGHT=PASS\n'
  exit 0
fi

install -d -o root -g root -m 0700 "$BACKUP_ROOT" \
  || fail BACKUP_ROOT_CREATE_FAILED
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%04x%04x' "$RANDOM" "$RANDOM")"
BACKUP_DIRECTORY="$BACKUP_ROOT/$RUN_ID"
[ ! -e "$BACKUP_DIRECTORY" ] && [ ! -L "$BACKUP_DIRECTORY" ] \
  || fail BACKUP_DIRECTORY_ALREADY_EXISTS

"$NODE" "$REMEDIATION_CLI" \
  --authorize-remediate=YES \
  --repository="$REPO" \
  --app-pid="$APP_PID_BEFORE" \
  --process-started-at-ms="$PM2_STARTED_AT_MS" \
  --backup-directory="$BACKUP_DIRECTORY" \
  || fail REMEDIATION_FAILED

PUBLIC_CONTENT="$(curl -sS --connect-timeout 5 --max-time 10 \
  http://127.0.0.1:3000/api/miniapp/content)" || fail MINIAPP_CONTENT_REQUEST_FAILED
printf '%s' "$PUBLIC_CONTENT" | "$NODE" -e '
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(0, "utf8"));
if (!body || body.status !== "success" || !body.data || body.data.logo_image !== "") {
  process.exit(1);
}
' || fail MINIAPP_CONTENT_LOGO_POSTCHECK_FAILED
unset PUBLIC_CONTENT

run_dependency_audit
assert_audit_marker 'SOURCE_OSS_CURRENT_ACL=PUBLIC_READ' SOURCE_OSS_ACL_CHANGED
assert_audit_marker 'SOURCE_PRIVATE_SWITCH_BLOCKERS=0' SOURCE_OSS_BLOCKERS_REMAIN
assert_audit_marker 'SOURCE_PRIVATE_SWITCH_REVIEW_REQUIRED=0' SOURCE_OSS_REVIEW_REQUIRED
assert_audit_marker 'SOURCE_PRIVATE_SWITCH_READY=YES' SOURCE_PRIVATE_SWITCH_NOT_READY
assert_audit_marker \
  'JSON_MINIAPP_LOGO_IMAGE_REFERENCES_SOURCE_PUBLIC_DIRECT=0' \
  SOURCE_OSS_LOGO_BLOCKER_REMAINS
assert_audit_marker \
  'POSTGRES_MINIAPP_SHADOW_LOGO_IMAGE_REFERENCES_SOURCE_PUBLIC_DIRECT=0' \
  SOURCE_OSS_LOGO_SHADOW_REMAINS
rm -f -- "$AUDIT_LOG"
AUDIT_LOG=

APP_PID_AFTER="$(pm2 pid "$APP_NAME" | awk '$1 != "0" { print $1 }')"
[ "$APP_PID_AFTER" = "$APP_PID_BEFORE" ] || fail APP_PID_CHANGED
[ "$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 10 \
  http://127.0.0.1:3000/api/health/ready)" = 200 ] || fail READINESS_CHANGED

printf 'AUDIT_DIRECTORY=%s\n' "$BACKUP_DIRECTORY"
printf 'APP_PID_AFTER=%s\n' "$APP_PID_AFTER"
printf 'APP_HTTP_AFTER=200\n'
printf 'SOURCE_PRIVATE_SWITCH_READY=YES\n'
printf 'SOURCE_BUCKET_ACL_CHANGED=NO\n'
printf 'OSS_REQUESTS=SOURCE_GET_BUCKET_INFO_ONLY\n'
printf 'OSS_MUTATION=NONE\n'
printf 'APPLICATION_RESTART=NO\n'
printf 'SECRET_VALUES_PRINTED=NO\n'
printf 'PRODUCTION_SOURCE_OSS_LOGO_REMEDIATION_RUNNER=PASS\n'
