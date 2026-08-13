#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

REPO=/www/wwwroot/xingxingzaishan
APP_NAME=xingxingzaishan
EXPECTED_DATABASE=xingxing_clean_baseline_20260812_staging
PROTECTION_SCRIPT="$REPO/scripts/database/apply-issued-qr-protection-production.js"
LOCK_FILE=/run/lock/xingxingzaishan-production-backup.lock
BACKUP_STATE_DIRECTORY=/var/lib/xingxingzaishan-production-backup
BACKUP_ATTEMPT_FILE="$BACKUP_STATE_DIRECTORY/last-attempt.env"
BACKUP_LOG_DIRECTORY=/var/log/xingxingzaishan-production-backup
PRODUCTION_JSON="$REPO/src/server/data/db.json"

fail() {
  printf 'ISSUED_QR_PRODUCTION_MIGRATION=FAIL\nERROR_CODE=%s\n' "$1" >&2
  exit 1
}

runtime_value() {
  local app_pid="$1"
  local key="$2"
  tr '\0' '\n' < "/proc/$app_pid/environ" |
    sed -n "s/^${key}=//p" |
    tail -n 1
}

assert_root_private_regular_file() {
  local file="$1"
  [ -f "$file" ] || return 1
  [ ! -L "$file" ] || return 1
  [ "$(stat -c '%U:%G' "$file")" = root:root ] || return 1
  [ "$(stat -c '%a' "$file")" = 600 ] || return 1
}

assert_root_private_directory() {
  local directory="$1"
  [ -d "$directory" ] || return 1
  [ ! -L "$directory" ] || return 1
  [ "$(stat -c '%U:%G' "$directory")" = root:root ] || return 1
  [ "$(stat -c '%a' "$directory")" = 700 ] || return 1
}

assert_root_controlled_regular_file() {
  local file="$1"
  local mode
  [ -f "$file" ] || return 1
  [ ! -L "$file" ] || return 1
  [ "$(stat -c '%U:%G' "$file")" = root:root ] || return 1
  mode="$(stat -c '%a' "$file")"
  [ "$((8#$mode & 022))" -eq 0 ] || return 1
}

assert_authority_runtime() {
  local app_pid="$1"
  local key
  for key in \
    PUBLIC_QR_POSTGRES_READ_ENABLED \
    PERSONAL_RECORD_POSTGRES_READ_ENABLED \
    QR_LIFECYCLE_POSTGRES_WRITE_ENABLED \
    IDENTITY_POSTGRES_AUTHORITY_ENABLED \
    QR_ISSUANCE_POSTGRES_AUTHORITY_ENABLED
  do
    [ "$(runtime_value "$app_pid" "$key")" = true ] || return 1
  done
  for key in \
    PUBLIC_QR_POSTGRES_READ_SCOPE \
    PERSONAL_RECORD_POSTGRES_READ_SCOPE \
    QR_LIFECYCLE_POSTGRES_WRITE_SCOPE \
    IDENTITY_POSTGRES_AUTHORITY_SCOPE \
    QR_ISSUANCE_POSTGRES_AUTHORITY_SCOPE
  do
    [ "$(runtime_value "$app_pid" "$key")" = all ] || return 1
  done
  [ "$(runtime_value "$app_pid" PGDATABASE)" = "$EXPECTED_DATABASE" ] || return 1
  [ "$(runtime_value "$app_pid" POSTGRES_CUTOVER_WRITE_FREEZE_ENABLED)" = false ] || return 1
  [ "$(runtime_value "$app_pid" RECORD_PROOF_RUNTIME_ENABLED)" = false ] || return 1
  local chain_enabled
  chain_enabled="$(runtime_value "$app_pid" CHAIN_ENABLED)"
  [ -z "$chain_enabled" ] || [ "$chain_enabled" = false ] || return 1
  for key in \
    AVATA_API_KEY \
    AVATA_API_SECRET \
    AVATA_IDENTITY_NAME \
    AVATA_IDENTITY_NUM \
    AVATA_API_BASE \
    AVATA_ENV \
    CHAIN_CALLBACK_URL
  do
    [ -z "$(runtime_value "$app_pid" "$key")" ] || return 1
  done
  ! tr '\0' '\n' < "/proc/$app_pid/environ" |
    grep -Eq '^(DATABASE_URL|PGPASSWORD|OSS_ACCESS_KEY_ID|OSS_ACCESS_KEY_SECRET|AVATA_API_KEY|AVATA_API_SECRET)=.+$'
}

[ "$#" = 0 ] || fail ARGUMENTS_FORBIDDEN
[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
cd "$REPO"
git diff --quiet || fail TRACKED_WORKTREE_DIRTY
git diff --cached --quiet || fail TRACKED_INDEX_DIRTY

command -v flock >/dev/null 2>&1 || fail FLOCK_REQUIRED
command -v pm2 >/dev/null 2>&1 || fail PM2_REQUIRED
command -v /usr/local/bin/node >/dev/null 2>&1 || fail NODE_REQUIRED
[ -f "$PROTECTION_SCRIPT" ] || fail PROTECTION_SCRIPT_MISSING

exec 9>"$LOCK_FILE"
flock -n 9 || fail BACKUP_OR_MIGRATION_RUNNING

assert_root_private_directory "$BACKUP_STATE_DIRECTORY" || fail BACKUP_STATE_DIRECTORY_UNSAFE
assert_root_private_directory "$BACKUP_LOG_DIRECTORY" || fail BACKUP_LOG_DIRECTORY_UNSAFE
assert_root_private_regular_file "$BACKUP_ATTEMPT_FILE" || fail BACKUP_ATTEMPT_FILE_UNSAFE
assert_root_controlled_regular_file "$PRODUCTION_JSON" || fail PRODUCTION_JSON_FILE_UNSAFE

APP_PID_BEFORE="$(pm2 pid "$APP_NAME" | tail -n 1)"
[ -n "$APP_PID_BEFORE" ] || fail APP_PID_MISSING
[ "$APP_PID_BEFORE" != 0 ] || fail APP_NOT_ONLINE
[ -r "/proc/$APP_PID_BEFORE/environ" ] || fail APP_RUNTIME_UNREADABLE

APP_STATUS="$(pm2 jlist | /usr/local/bin/node -e '
const fs = require("node:fs");
const rows = JSON.parse(fs.readFileSync(0, "utf8"));
const app = rows.find(row => row.name === "xingxingzaishan");
process.stdout.write(app?.pm2_env?.status || "ABSENT");
')"
[ "$APP_STATUS" = online ] || fail APP_NOT_ONLINE

HTTP_BEFORE="$(
  curl -sS -o /dev/null -w '%{http_code}' \
    --connect-timeout 5 --max-time 10 \
    http://127.0.0.1:3000/
)"
[ "$HTTP_BEFORE" = 200 ] || fail APP_HTTP_INVALID
assert_authority_runtime "$APP_PID_BEFORE" || fail POSTGRES_AUTHORITY_RUNTIME_INVALID

PGHOST="$(runtime_value "$APP_PID_BEFORE" PGHOST)"
PGPORT="$(runtime_value "$APP_PID_BEFORE" PGPORT)"
PGUSER="$(runtime_value "$APP_PID_BEFORE" PGUSER)"
PGDATABASE="$(runtime_value "$APP_PID_BEFORE" PGDATABASE)"
PGSSL="$(runtime_value "$APP_PID_BEFORE" PGSSL)"
PGSSL_REJECT_UNAUTHORIZED="$(runtime_value "$APP_PID_BEFORE" PGSSL_REJECT_UNAUTHORIZED)"
PGPASSWORD_FILE="$(runtime_value "$APP_PID_BEFORE" PGPASSWORD_FILE)"

[ -n "$PGHOST" ] || fail PGHOST_MISSING
[ -n "$PGPORT" ] || fail PGPORT_MISSING
[ -n "$PGUSER" ] || fail PGUSER_MISSING
[ "$PGDATABASE" = "$EXPECTED_DATABASE" ] || fail PRODUCTION_DATABASE_MISMATCH
assert_root_private_regular_file "$PGPASSWORD_FILE" || fail POSTGRES_PASSWORD_FILE_UNSAFE

unset DATABASE_URL PGPASSWORD
export PGHOST PGPORT PGUSER PGDATABASE PGSSL PGSSL_REJECT_UNAUTHORIZED PGPASSWORD_FILE
export NODE_ENV=production

/usr/local/bin/node "$PROTECTION_SCRIPT"

APP_PID_AFTER="$(pm2 pid "$APP_NAME" | tail -n 1)"
[ "$APP_PID_AFTER" = "$APP_PID_BEFORE" ] || fail APP_PID_CHANGED
HTTP_AFTER="$(
  curl -sS -o /dev/null -w '%{http_code}' \
    --connect-timeout 5 --max-time 10 \
    http://127.0.0.1:3000/
)"
[ "$HTTP_AFTER" = 200 ] || fail APP_HTTP_INVALID_AFTER_MIGRATION
assert_authority_runtime "$APP_PID_AFTER" || fail POSTGRES_AUTHORITY_RUNTIME_CHANGED

echo "APP_PID=$APP_PID_AFTER"
echo "APP_HTTP=$HTTP_AFTER"
echo 'PRODUCTION_RUNTIME_RESTARTED=NO'
echo 'AVATA_ENABLED=NO'
echo 'ISSUED_QR_PRODUCTION_MIGRATION=PASS'
