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
NODE=/usr/local/bin/node
RUNTIME_CONFIG_CHECK="$REPO/scripts/acceptance/validate-running-production-config.js"
RUNTIME_POSTGRES_CONFIG_READER="$REPO/scripts/acceptance/read-running-postgres-client-config.js"

fail() {
  printf 'PRODUCTION_MANUAL_OFFSITE_BACKUP=FAIL\nERROR_CODE=%s\n' "$1" >&2
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

is_sha256() {
  [[ "${1,,}" =~ ^[0-9a-f]{64}$ ]]
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
  [ "$(runtime_value "$app_pid" RECORD_PROOF_RUNTIME_ENABLED)" = true ] || return 1
  [ "$(runtime_value "$app_pid" RECORD_PROOF_RUNTIME_SCOPE)" = all ] || return 1
  [ -z "$(runtime_value "$app_pid" RECORD_PROOF_RUNTIME_ALLOWLIST)" ] || return 1
  is_sha256 "$(runtime_value "$app_pid" RECORD_PROOF_RUNTIME_SOURCE_SHA256)" || return 1
  is_sha256 "$(runtime_value "$app_pid" RECORD_PROOF_RUNTIME_DOMAIN_SHA256)" || return 1
  [ -n "$(runtime_value "$app_pid" RECORD_PROOF_WORKER_ID)" ] || return 1
  [ "$(runtime_value "$app_pid" CHAIN_ENABLED)" = true ] || return 1
  case "$(runtime_value "$app_pid" AVATA_ENV)" in
    prod|production) ;;
    *) return 1 ;;
  esac
  case "$(runtime_value "$app_pid" AVATA_API_BASE)" in
    ''|https://apis.avata.bianjie.ai|https://apis.avata.bianjie.ai/) ;;
    *) return 1 ;;
  esac
  ! tr '\0' '\n' < "/proc/$app_pid/environ" |
    grep -Eq '^(DATABASE_URL|PGPASSWORD|OSS_ACCESS_KEY_ID|OSS_ACCESS_KEY_SECRET|AVATA_API_KEY|AVATA_API_SECRET)=.+$'
}

[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
cd "$REPO"
assert_clean_worktree

command -v flock >/dev/null 2>&1 || fail FLOCK_REQUIRED
command -v pm2 >/dev/null 2>&1 || fail PM2_REQUIRED
command -v /usr/local/bin/node >/dev/null 2>&1 || fail NODE_REQUIRED
command -v /usr/pgsql-15/bin/pg_dump >/dev/null 2>&1 || fail PG_DUMP_REQUIRED
command -v /usr/pgsql-15/bin/pg_restore >/dev/null 2>&1 || fail PG_RESTORE_REQUIRED
[ -x "$NODE" ] || fail NODE_REQUIRED

exec 9>"$LOCK_FILE"
flock -n 9 || fail BACKUP_ALREADY_RUNNING

[ -f "$BACKUP_SCRIPT" ] || fail BACKUP_SCRIPT_MISSING
[ -f "$RUNTIME_CONFIG_CHECK" ] || fail RUNTIME_CONFIG_CHECK_MISSING
[ ! -L "$RUNTIME_CONFIG_CHECK" ] || fail RUNTIME_CONFIG_CHECK_UNSAFE
[ -f "$RUNTIME_POSTGRES_CONFIG_READER" ] || fail RUNTIME_POSTGRES_CONFIG_READER_MISSING
[ ! -L "$RUNTIME_POSTGRES_CONFIG_READER" ] || fail RUNTIME_POSTGRES_CONFIG_READER_UNSAFE
[ -f "$EXPECTED_JSON" ] || fail PRODUCTION_JSON_MISSING
assert_root_private_regular_file "$EXPECTED_OSS_ENV" || fail OSS_ENV_FILE_UNSAFE
assert_root_private_regular_file "$EXPECTED_PM2_DUMP" || fail PM2_DUMP_UNSAFE

APP_PID_BEFORE="$(pm2 pid "$APP_NAME" | tail -n 1)"
[ -n "$APP_PID_BEFORE" ] || fail APP_PID_MISSING
[ "$APP_PID_BEFORE" != 0 ] || fail APP_NOT_ONLINE
[ -r "/proc/$APP_PID_BEFORE/environ" ] || fail APP_RUNTIME_UNREADABLE

PM2_STATE="$(pm2 jlist | "$NODE" -e '
const fs = require("node:fs");
const rows = JSON.parse(fs.readFileSync(0, "utf8"));
const apps = rows.filter(row => row.name === "xingxingzaishan");
if (apps.length !== 1) process.exit(2);
const app = apps[0];
process.stdout.write([
  String(Number(app.pid || 0)),
  String(app.pm2_env?.status || "ABSENT"),
  String(Number(app.pm2_env?.pm_uptime || 0))
].join("|"));
')" || fail PM2_STATE_INVALID
IFS='|' read -r PM2_PID APP_STATUS PM2_STARTED_AT_MS <<< "$PM2_STATE"
[ "$PM2_PID" = "$APP_PID_BEFORE" ] || fail APP_PID_CHANGED
[ "$APP_STATUS" = online ] || fail APP_NOT_ONLINE
[[ "$PM2_STARTED_AT_MS" =~ ^[0-9]+$ ]] || fail PM2_STATE_INVALID
[ "$PM2_STARTED_AT_MS" -gt 0 ] || fail PM2_STATE_INVALID
"$NODE" "$RUNTIME_CONFIG_CHECK" \
  "$APP_PID_BEFORE" "$REPO" "$EXPECTED_DATABASE" "$PM2_STARTED_AT_MS" \
  || fail RUNTIME_CONFIG_INVALID

HTTP_BEFORE="$(
  curl -sS -o /dev/null -w '%{http_code}' \
    --connect-timeout 5 --max-time 10 \
    http://127.0.0.1:3000/
)"
[ "$HTTP_BEFORE" = 200 ] || fail APP_HTTP_INVALID
assert_authority_runtime "$APP_PID_BEFORE" || fail POSTGRES_AUTHORITY_RUNTIME_INVALID

RUNTIME_POSTGRES_CONFIG="$(
  "$NODE" "$RUNTIME_POSTGRES_CONFIG_READER" --backup \
    "$APP_PID_BEFORE" "$REPO" "$EXPECTED_DATABASE" "$PM2_STARTED_AT_MS"
)" || fail RUNTIME_POSTGRES_CONFIG_INVALID
IFS='|' read -r PGHOST_VALUE PGPORT_VALUE PGUSER_VALUE PGDATABASE_VALUE \
  PGSSL_MODE PASSWORD_FILE <<< "$RUNTIME_POSTGRES_CONFIG"
[ "$PGHOST_VALUE" = 127.0.0.1 ] || fail POSTGRES_HOST_NOT_LOCAL
[[ "$PGPORT_VALUE" =~ ^[0-9]+$ ]] || fail PGPORT_INVALID
[ -n "$PGUSER_VALUE" ] || fail PGUSER_MISSING
[ "$PGDATABASE_VALUE" = "$EXPECTED_DATABASE" ] || fail PRODUCTION_DATABASE_MISMATCH
assert_root_private_regular_file "$PASSWORD_FILE" || fail POSTGRES_PASSWORD_FILE_UNSAFE
[ "$PGSSL_MODE" = require ] || [ "$PGSSL_MODE" = disable ] \
  || fail PGSSL_VALUE_INVALID

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
echo 'AVATA_ENABLED=YES'
echo 'POSTGRES_CLIENT_CONFIG=PASS_RECONSTRUCTED_REDACTED'
echo 'CRON_CONFIGURED=NO'
echo 'PRODUCTION_MANUAL_OFFSITE_BACKUP=PASS'
echo 'PRODUCTION_MANUAL_OFFSITE_BACKUP_ACCEPTANCE=PASS'
