#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

REPO=/www/wwwroot/xingxingzaishan
APP_NAME=xingxingzaishan
EXPECTED_DATABASE=xingxing_clean_baseline_20260812_staging
EXPECTED_JSON="$REPO/src/server/data/db.json"
EXPECTED_OSS_ENV="$REPO/.env"
EXPECTED_PM2_DUMP=/root/.pm2/dump.pm2
BACKUP_SCRIPT="$REPO/scripts/database/production-backup.js"
LOCK_FILE=/run/lock/xingxingzaishan-production-backup.lock

fail() {
  printf 'PRODUCTION_MANUAL_OFFSITE_BACKUP=FAIL\nERROR_CODE=%s\n' "$1" >&2
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

[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
cd "$REPO"
git diff --quiet || fail TRACKED_WORKTREE_DIRTY
git diff --cached --quiet || fail TRACKED_INDEX_DIRTY

command -v flock >/dev/null 2>&1 || fail FLOCK_REQUIRED
command -v pm2 >/dev/null 2>&1 || fail PM2_REQUIRED
command -v /usr/local/bin/node >/dev/null 2>&1 || fail NODE_REQUIRED
command -v /usr/pgsql-15/bin/pg_dump >/dev/null 2>&1 || fail PG_DUMP_REQUIRED
command -v /usr/pgsql-15/bin/pg_restore >/dev/null 2>&1 || fail PG_RESTORE_REQUIRED

exec 9>"$LOCK_FILE"
flock -n 9 || fail BACKUP_ALREADY_RUNNING

[ -f "$BACKUP_SCRIPT" ] || fail BACKUP_SCRIPT_MISSING
[ -f "$EXPECTED_JSON" ] || fail PRODUCTION_JSON_MISSING
assert_root_private_regular_file "$EXPECTED_OSS_ENV" || fail OSS_ENV_FILE_UNSAFE
assert_root_private_regular_file "$EXPECTED_PM2_DUMP" || fail PM2_DUMP_UNSAFE

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

PGHOST_VALUE="$(runtime_value "$APP_PID_BEFORE" PGHOST)"
PGPORT_VALUE="$(runtime_value "$APP_PID_BEFORE" PGPORT)"
PGUSER_VALUE="$(runtime_value "$APP_PID_BEFORE" PGUSER)"
PGDATABASE_VALUE="$(runtime_value "$APP_PID_BEFORE" PGDATABASE)"
PGSSL_VALUE="$(runtime_value "$APP_PID_BEFORE" PGSSL)"
PASSWORD_FILE="$(runtime_value "$APP_PID_BEFORE" PGPASSWORD_FILE)"

[ -n "$PGHOST_VALUE" ] || fail PGHOST_MISSING
[ -n "$PGPORT_VALUE" ] || fail PGPORT_MISSING
[ -n "$PGUSER_VALUE" ] || fail PGUSER_MISSING
[ "$PGDATABASE_VALUE" = "$EXPECTED_DATABASE" ] || fail PRODUCTION_DATABASE_MISMATCH
assert_root_private_regular_file "$PASSWORD_FILE" || fail POSTGRES_PASSWORD_FILE_UNSAFE

case "$PGSSL_VALUE" in
  true) PGSSL_MODE=require ;;
  false|'') PGSSL_MODE=disable ;;
  *) fail PGSSL_VALUE_INVALID ;;
esac

GIT_COMMIT="$(git rev-parse HEAD)"

/usr/local/bin/node "$BACKUP_SCRIPT" \
  "--pg-host=$PGHOST_VALUE" \
  "--pg-port=$PGPORT_VALUE" \
  "--pg-user=$PGUSER_VALUE" \
  "--pg-database=$PGDATABASE_VALUE" \
  "--pg-ssl-mode=$PGSSL_MODE" \
  "--password-file=$PASSWORD_FILE" \
  "--git-commit=$GIT_COMMIT" \
  "--app-pid=$APP_PID_BEFORE" \
  "--app-http=$HTTP_BEFORE"

APP_PID_AFTER="$(pm2 pid "$APP_NAME" | tail -n 1)"
[ "$APP_PID_AFTER" = "$APP_PID_BEFORE" ] || fail APP_PID_CHANGED

HTTP_AFTER="$(
  curl -sS -o /dev/null -w '%{http_code}' \
    --connect-timeout 5 --max-time 10 \
    http://127.0.0.1:3000/
)"
[ "$HTTP_AFTER" = 200 ] || fail APP_HTTP_INVALID_AFTER_BACKUP
assert_authority_runtime "$APP_PID_AFTER" || fail POSTGRES_AUTHORITY_RUNTIME_CHANGED

echo "APP_PID_AFTER=$APP_PID_AFTER"
echo "APP_HTTP_AFTER=$HTTP_AFTER"
echo 'POSTGRES_AUTHORITY_REMAINS_ENABLED=YES'
echo 'JSON_BUSINESS_PATH_CHANGED=NO'
echo 'AVATA_ENABLED=NO'
echo 'CRON_CONFIGURED=NO'
echo 'PRODUCTION_MANUAL_OFFSITE_BACKUP=PASS'
echo 'PRODUCTION_MANUAL_OFFSITE_BACKUP_ACCEPTANCE=PASS'
