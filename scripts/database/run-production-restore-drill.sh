#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

REPO=/www/wwwroot/xingxingzaishan
APP_NAME=xingxingzaishan
PRODUCTION_DB=xingxing_clean_baseline_20260812_staging
PRODUCTION_JSON="$REPO/src/server/data/db.json"
EXPECTED_PRODUCTION_JSON_SHA=f263df13b5c19f91b0f86d93960f6b26896f3ed605318c73dd8546d110b06cfd
OSS_ENV="$REPO/.env"
PM2_DUMP=/root/.pm2/dump.pm2
RESTORE_ROOT=/root/xingxingzaishan-production-restore-drill
RESTORE_SCRIPT="$REPO/scripts/database/production-restore-drill.js"
LOCK_FILE=/run/lock/xingxingzaishan-production-restore-drill.lock
PG_RESTORE=/usr/pgsql-15/bin/pg_restore
PSQL=/usr/pgsql-15/bin/psql
CREATEDB=/usr/pgsql-15/bin/createdb

AUDIT_DIR=
RESTORE_DB=
RESTORE_ROLE=
ROLE_SQL=
PASSWORD_FILE=
PGPASS_FILE=
DRILL_COMPLETE=false

fail() {
  printf 'PRODUCTION_BACKUP_RESTORE_DRILL=FAIL\nERROR_CODE=%s\n' "$1" >&2
  exit 1
}

[ "$#" = 0 ] || fail RESTORE_ARGUMENT_INVALID

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
  [ "$(runtime_value "$app_pid" PGDATABASE)" = "$PRODUCTION_DB" ] || return 1
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

write_summary() {
  local status="$1"
  local file="$AUDIT_DIR/restore-drill-summary.txt"
  [ -n "$AUDIT_DIR" ] || return 0
  [ -d "$AUDIT_DIR" ] || return 0
  [ ! -e "$file" ] || return 0
  {
    echo "DRILL_ID=$DRILL_ID"
    echo "STATUS=$status"
    echo "BACKUP_RUN_ID=20260813T110535Z-6586d9b1"
    echo "RESTORE_DATABASE=$RESTORE_DB"
    echo "RESTORE_ROLE=$RESTORE_ROLE"
    echo "PRODUCTION_DATABASE=$PRODUCTION_DB"
    echo "PRODUCTION_DATABASE_RESTORE_CONNECTIONS=0"
    echo "OSS_MUTATION=NONE"
    echo "PM2_RESTARTED=NO"
    echo "AVATA_ENABLED=NO"
  } > "$file"
  chmod 600 "$file"
}

seal_resources() {
  local status="$1"
  local database_exists=0
  local role_exists=0
  local seal_failed=0
  if [ -n "$RESTORE_DB" ]; then
    database_exists="$(
      runuser -u postgres -- "$PSQL" -X -At -d postgres \
        -c "SELECT count(*) FROM pg_database WHERE datname = '$RESTORE_DB';" \
        2>/dev/null
    )"
  fi
  if [ -n "$RESTORE_ROLE" ]; then
    role_exists="$(
      runuser -u postgres -- "$PSQL" -X -At -d postgres \
        -c "SELECT count(*) FROM pg_roles WHERE rolname = '$RESTORE_ROLE';" \
        2>/dev/null
    )"
  fi
  if [ "$database_exists" = 1 ]; then
    if ! runuser -u postgres -- "$PSQL" -X -v ON_ERROR_STOP=1 \
      -d postgres >/dev/null <<SQL
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = '$RESTORE_DB'
  AND pid <> pg_backend_pid();
ALTER DATABASE "$RESTORE_DB" CONNECTION LIMIT 0;
REVOKE CONNECT ON DATABASE "$RESTORE_DB" FROM PUBLIC;
REVOKE CONNECT ON DATABASE "$RESTORE_DB" FROM "$RESTORE_ROLE";
COMMENT ON DATABASE "$RESTORE_DB" IS 'xingxingzaishan restore drill $status; retained for root/postgres inspection';
SQL
    then
      seal_failed=1
    fi
  fi
  if [ "$role_exists" = 1 ]; then
    if ! runuser -u postgres -- "$PSQL" -X -v ON_ERROR_STOP=1 \
      -d postgres >/dev/null <<SQL
ALTER ROLE "$RESTORE_ROLE" NOLOGIN PASSWORD NULL;
SQL
    then
      seal_failed=1
    fi
  fi
  return "$seal_failed"
}

cleanup() {
  local exit_code="$?"
  local seal_failed=0
  set +e
  [ -z "$ROLE_SQL" ] || rm -f -- "$ROLE_SQL"
  [ -z "$PASSWORD_FILE" ] || rm -f -- "$PASSWORD_FILE"
  [ -z "$PGPASS_FILE" ] || rm -f -- "$PGPASS_FILE"
  if [ "$DRILL_COMPLETE" = true ]; then
    seal_resources COMPLETE || seal_failed=1
    if [ "$seal_failed" = 0 ]; then
      write_summary PASS
    else
      write_summary SEAL_FAILED
    fi
  else
    seal_resources INCOMPLETE || seal_failed=1
    if [ "$seal_failed" = 0 ]; then
      write_summary FAILED
    else
      write_summary FAILED_AND_SEAL_FAILED
    fi
  fi
  if [ "$seal_failed" != 0 ]; then
    printf 'PRODUCTION_BACKUP_RESTORE_DRILL=FAIL\nERROR_CODE=RESTORE_RESOURCE_SEAL_FAILED\n' >&2
    exit 1
  fi
  exit "$exit_code"
}

[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
cd "$REPO"
git diff --quiet || fail TRACKED_WORKTREE_DIRTY
git diff --cached --quiet || fail TRACKED_INDEX_DIRTY

for command in flock pm2 curl openssl runuser sha256sum; do
  command -v "$command" >/dev/null 2>&1 || fail "${command^^}_REQUIRED"
done
for binary in /usr/local/bin/node "$PG_RESTORE" "$PSQL" "$CREATEDB"; do
  [ -x "$binary" ] || fail POSTGRES_RESTORE_DEPENDENCY_MISSING
done

exec 9>"$LOCK_FILE"
flock -n 9 || fail RESTORE_DRILL_ALREADY_RUNNING

[ -f "$RESTORE_SCRIPT" ] || fail RESTORE_SCRIPT_MISSING
[ -f "$PRODUCTION_JSON" ] || fail PRODUCTION_JSON_MISSING
assert_root_private_regular_file "$OSS_ENV" || fail OSS_ENV_FILE_UNSAFE
assert_root_private_regular_file "$PM2_DUMP" || fail PM2_DUMP_UNSAFE

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
PRODUCTION_USER="$(runtime_value "$APP_PID_BEFORE" PGUSER)"
PRODUCTION_PASSWORD_FILE="$(runtime_value "$APP_PID_BEFORE" PGPASSWORD_FILE)"
PGSSL_VALUE="$(runtime_value "$APP_PID_BEFORE" PGSSL)"
[ "$PGHOST_VALUE" = 127.0.0.1 ] || fail POSTGRES_HOST_NOT_LOCAL
[ "$PGPORT_VALUE" = 5432 ] || fail POSTGRES_PORT_UNEXPECTED
[ -n "$PRODUCTION_USER" ] || fail PRODUCTION_DATABASE_USER_MISSING
assert_root_private_regular_file "$PRODUCTION_PASSWORD_FILE" || fail POSTGRES_PASSWORD_FILE_UNSAFE

unset DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGPASSWORD_FILE
unset PGSSL PGSSL_REJECT_UNAUTHORIZED PGOPTIONS PGAPPNAME PGPASSFILE
unset OSS_ACCESS_KEY_ID OSS_ACCESS_KEY_SECRET
unset AVATA_API_KEY AVATA_API_SECRET CHAIN_ENABLED RECORD_PROOF_RUNTIME_ENABLED

case "$PGSSL_VALUE" in
  true) PGSSL_MODE=require ;;
  false|'') PGSSL_MODE=disable ;;
  *) fail PGSSL_VALUE_INVALID ;;
esac

PRODUCTION_DB_COUNT="$(
  runuser -u postgres -- "$PSQL" -X -At -d postgres \
    -c "SELECT count(*) FROM pg_database WHERE datname = '$PRODUCTION_DB';"
)"
[ "$PRODUCTION_DB_COUNT" = 1 ] || fail PRODUCTION_DATABASE_IDENTITY_INVALID

PM2_DUMP_SHA_BEFORE="$(sha256sum "$PM2_DUMP" | awk '{print $1}')"
JSON_SHA_BEFORE="$(sha256sum "$PRODUCTION_JSON" | awk '{print $1}')"
[ "$JSON_SHA_BEFORE" = "$EXPECTED_PRODUCTION_JSON_SHA" ] \
  || fail PRODUCTION_JSON_BASELINE_MISMATCH
GIT_COMMIT="$(git rev-parse HEAD)"
DATE_UTC="$(date -u +%Y%m%d)"
NONCE="$(openssl rand -hex 4)"
[[ "$NONCE" =~ ^[a-f0-9]{8}$ ]] || fail RESTORE_NONCE_INVALID
DRILL_ID="$(date -u +%Y%m%dT%H%M%SZ)-$NONCE"
RESTORE_DB="xingxing_restore_drill_${DATE_UTC}_${NONCE}"
RESTORE_ROLE="xingxing_restore_role_${DATE_UTC}_${NONCE}"
RESTORE_APPLICATION_NAME="xingxingzaishan-restore-drill-$NONCE"

mkdir -p -m 700 "$RESTORE_ROOT"
[ ! -L "$RESTORE_ROOT" ] || fail RESTORE_ROOT_INVALID
[ "$(stat -c '%U:%G' "$RESTORE_ROOT")" = root:root ] || fail RESTORE_ROOT_INVALID
chmod 700 "$RESTORE_ROOT"
AUDIT_DIR="$RESTORE_ROOT/$DRILL_ID"
[ ! -e "$AUDIT_DIR" ] || fail RESTORE_DRILL_DIRECTORY_EXISTS
mkdir -m 700 "$AUDIT_DIR"
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

RESTORE_DRILL_OUTPUT_DIRECTORY="$AUDIT_DIR" \
  /usr/local/bin/node "$RESTORE_SCRIPT" --download

DUMP_PATH="$AUDIT_DIR/20260813T110535Z-6586d9b1-${PRODUCTION_DB}.dump"
JSON_PATH="$AUDIT_DIR/20260813T110535Z-6586d9b1-db.json"
RESTORE_LIST="$AUDIT_DIR/postgresql-restore-list.txt"
[ -f "$DUMP_PATH" ] || fail RESTORE_DUMP_MISSING
[ -f "$JSON_PATH" ] || fail RESTORE_JSON_MISSING
"$PG_RESTORE" --list "$DUMP_PATH" > "$RESTORE_LIST" || fail RESTORE_DUMP_STRUCTURE_INVALID
chmod 600 "$RESTORE_LIST"
grep -q 'TABLE DATA app qr_codes' "$RESTORE_LIST" || fail RESTORE_DUMP_STRUCTURE_INVALID
grep -q 'TABLE DATA app records' "$RESTORE_LIST" || fail RESTORE_DUMP_STRUCTURE_INVALID

RESTORE_DB_COUNT="$(
  runuser -u postgres -- "$PSQL" -X -At -d postgres \
    -c "SELECT count(*) FROM pg_database WHERE datname = '$RESTORE_DB';"
)"
RESTORE_ROLE_COUNT="$(
  runuser -u postgres -- "$PSQL" -X -At -d postgres \
    -c "SELECT count(*) FROM pg_roles WHERE rolname = '$RESTORE_ROLE';"
)"
[ "$RESTORE_DB_COUNT" = 0 ] || fail RESTORE_DATABASE_ALREADY_EXISTS
[ "$RESTORE_ROLE_COUNT" = 0 ] || fail RESTORE_ROLE_ALREADY_EXISTS

ROLE_PASSWORD="$(openssl rand -hex 32)"
[[ "$ROLE_PASSWORD" =~ ^[a-f0-9]{64}$ ]] || fail RESTORE_PASSWORD_GENERATION_FAILED
ROLE_SQL="$AUDIT_DIR/create-restore-role.sql"
PASSWORD_FILE="$AUDIT_DIR/restore-role.password"
PGPASS_FILE="$AUDIT_DIR/restore-role.pgpass"
printf '%s' "$ROLE_PASSWORD" > "$PASSWORD_FILE"
printf '%s:%s:%s:%s:%s\n' \
  "$PGHOST_VALUE" "$PGPORT_VALUE" "$RESTORE_DB" "$RESTORE_ROLE" "$ROLE_PASSWORD" \
  > "$PGPASS_FILE"
{
  echo "CREATE ROLE \"$RESTORE_ROLE\" LOGIN PASSWORD '$ROLE_PASSWORD' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;"
  echo "COMMENT ON ROLE \"$RESTORE_ROLE\" IS 'temporary xingxingzaishan restore drill role';"
} > "$ROLE_SQL"
chmod 600 "$ROLE_SQL" "$PASSWORD_FILE" "$PGPASS_FILE"

runuser -u postgres -- "$PSQL" -X -1 -v ON_ERROR_STOP=1 -d postgres \
  < "$ROLE_SQL" \
  >/dev/null || fail RESTORE_ROLE_CREATE_FAILED
runuser -u postgres -- "$CREATEDB" -O "$RESTORE_ROLE" -E UTF8 -T template0 \
  --lc-collate=C.utf8 --lc-ctype=C.utf8 "$RESTORE_DB" \
  || fail RESTORE_DATABASE_CREATE_FAILED

runuser -u postgres -- "$PSQL" -X -v ON_ERROR_STOP=1 -d postgres >/dev/null <<SQL
REVOKE ALL ON DATABASE "$RESTORE_DB" FROM PUBLIC;
GRANT CONNECT, TEMPORARY, CREATE ON DATABASE "$RESTORE_DB" TO "$RESTORE_ROLE";
COMMENT ON DATABASE "$RESTORE_DB" IS 'xingxingzaishan restore drill INCOMPLETE; retained for root/postgres inspection';
SQL

PRODUCTION_WRITE_GRANTS="$(
  runuser -u postgres -- "$PSQL" -X -At -d "$PRODUCTION_DB" \
    -c "SELECT count(*) FROM information_schema.tables
        WHERE table_schema = 'app'
          AND (
            has_table_privilege('$RESTORE_ROLE', format('%I.%I', table_schema, table_name), 'INSERT')
            OR has_table_privilege('$RESTORE_ROLE', format('%I.%I', table_schema, table_name), 'UPDATE')
            OR has_table_privilege('$RESTORE_ROLE', format('%I.%I', table_schema, table_name), 'DELETE')
            OR has_table_privilege('$RESTORE_ROLE', format('%I.%I', table_schema, table_name), 'TRUNCATE')
            OR has_table_privilege('$RESTORE_ROLE', format('%I.%I', table_schema, table_name), 'REFERENCES')
            OR has_table_privilege('$RESTORE_ROLE', format('%I.%I', table_schema, table_name), 'TRIGGER')
          );"
)"
[ "$PRODUCTION_WRITE_GRANTS" = 0 ] || fail RESTORE_ROLE_PRODUCTION_WRITE_PRIVILEGE

PRODUCTION_RESTORE_CONNECTIONS="$(
  runuser -u postgres -- "$PSQL" -X -At -d postgres \
    -c "SELECT count(*) FROM pg_stat_activity
        WHERE datname = '$PRODUCTION_DB'
          AND application_name = '$RESTORE_APPLICATION_NAME';"
)"
[ "$PRODUCTION_RESTORE_CONNECTIONS" = 0 ] || fail RESTORE_APPLICATION_TOUCHED_PRODUCTION

export PGPASSFILE="$PGPASS_FILE"
export PGAPPNAME="$RESTORE_APPLICATION_NAME"
export PGSSLMODE="$PGSSL_MODE"
RESTORE_DRILL_DATABASE="$RESTORE_DB" \
RESTORE_DRILL_DUMP_PATH="$DUMP_PATH" \
PGHOST="$PGHOST_VALUE" \
PGPORT="$PGPORT_VALUE" \
PGUSER="$RESTORE_ROLE" \
  /usr/local/bin/node "$RESTORE_SCRIPT" --restore \
  || fail POSTGRES_RESTORE_FAILED

RESTORE_RESULT="$AUDIT_DIR/restore-validation.json"
RESTORE_DRILL_DATABASE="$RESTORE_DB" \
RESTORE_DRILL_RESULT_PATH="$RESTORE_RESULT" \
RESTORE_DRILL_APPLICATION_NAME="$RESTORE_APPLICATION_NAME" \
PGHOST="$PGHOST_VALUE" \
PGPORT="$PGPORT_VALUE" \
PGUSER="$RESTORE_ROLE" \
PGDATABASE="$RESTORE_DB" \
PGPASSWORD_FILE="$PASSWORD_FILE" \
PGSSL="$PGSSL_VALUE" \
PGSSL_REJECT_UNAUTHORIZED="$(runtime_value "$APP_PID_BEFORE" PGSSL_REJECT_UNAUTHORIZED)" \
  /usr/local/bin/node "$RESTORE_SCRIPT" --validate

unset PGPASSFILE PGAPPNAME PGSSLMODE ROLE_PASSWORD
rm -f -- "$ROLE_SQL" "$PASSWORD_FILE" "$PGPASS_FILE"
ROLE_SQL=
PASSWORD_FILE=
PGPASS_FILE=

RESTORE_CONNECTIONS="$(
  runuser -u postgres -- "$PSQL" -X -At -d postgres \
    -c "SELECT count(*) FROM pg_stat_activity
        WHERE datname = '$RESTORE_DB'
          AND application_name = '$RESTORE_APPLICATION_NAME';"
)"
[ "$RESTORE_CONNECTIONS" = 0 ] || fail RESTORE_CONNECTIONS_REMAIN

PRODUCTION_RESTORE_CONNECTIONS="$(
  runuser -u postgres -- "$PSQL" -X -At -d postgres \
    -c "SELECT count(*) FROM pg_stat_activity
        WHERE datname = '$PRODUCTION_DB'
          AND application_name = '$RESTORE_APPLICATION_NAME';"
)"
[ "$PRODUCTION_RESTORE_CONNECTIONS" = 0 ] || fail RESTORE_APPLICATION_TOUCHED_PRODUCTION

APP_PID_AFTER="$(pm2 pid "$APP_NAME" | tail -n 1)"
[ "$APP_PID_AFTER" = "$APP_PID_BEFORE" ] || fail APP_PID_CHANGED
HTTP_AFTER="$(
  curl -sS -o /dev/null -w '%{http_code}' \
    --connect-timeout 5 --max-time 10 \
    http://127.0.0.1:3000/
)"
[ "$HTTP_AFTER" = 200 ] || fail APP_HTTP_INVALID_AFTER_RESTORE
assert_authority_runtime "$APP_PID_AFTER" || fail POSTGRES_AUTHORITY_RUNTIME_CHANGED
[ "$(sha256sum "$PM2_DUMP" | awk '{print $1}')" = "$PM2_DUMP_SHA_BEFORE" ] \
  || fail PM2_DUMP_CHANGED
[ "$(sha256sum "$PRODUCTION_JSON" | awk '{print $1}')" = "$JSON_SHA_BEFORE" ] \
  || fail PRODUCTION_JSON_CHANGED

seal_resources COMPLETE
FINAL_ROLE_LOGIN="$(runuser -u postgres -- "$PSQL" -X -At -d postgres \
  -v ON_ERROR_STOP=1 \
  -v restore_role="$RESTORE_ROLE" <<'SQL'
SELECT rolcanlogin FROM pg_roles WHERE rolname = :'restore_role';
SQL
)"
[ "$FINAL_ROLE_LOGIN" = f ] || fail RESTORE_ROLE_NOT_SEALED

FINAL_DATABASE_CONNECTION_LIMIT="$(runuser -u postgres -- "$PSQL" -X -At \
  -d postgres \
  -v ON_ERROR_STOP=1 \
  -v restore_db="$RESTORE_DB" <<'SQL'
SELECT datconnlimit FROM pg_database WHERE datname = :'restore_db';
SQL
)"
[ "$FINAL_DATABASE_CONNECTION_LIMIT" = 0 ] \
  || fail RESTORE_DATABASE_NOT_SEALED

DRILL_COMPLETE=true

echo "DRILL_ID=$DRILL_ID"
echo "GIT_COMMIT=$GIT_COMMIT"
echo "BACKUP_RUN_ID=20260813T110535Z-6586d9b1"
echo "RESTORE_DATABASE=$RESTORE_DB"
echo "RESTORE_DATABASE_STATE=COMPLETE_SEALED"
echo "RESTORE_LOCAL_DIRECTORY=$AUDIT_DIR"
echo 'MANIFEST_SHA256_MATCH=YES'
echo 'POSTGRESQL_DUMP_SHA256_MATCH=YES'
echo 'JSON_SHA256_MATCH=YES'
echo 'POSTGRESQL_RESTORE=PASS'
echo 'MIGRATION_SCHEMA_VALIDATION=PASS'
echo 'RELATIONAL_INTEGRITY=PASS'
echo 'COMMENT_SOURCE_POSITION_ORDER=PASS'
echo 'OSS_OBJECT_KEY_REFERENCES=PASS'
echo 'REPOSITORY_SAMPLE_READ=PASS'
echo 'JSON_INTEGRITY_VALIDATION=PASS'
echo "APP_PID_BEFORE=$APP_PID_BEFORE"
echo "APP_PID_AFTER=$APP_PID_AFTER"
echo "APP_HTTP=$HTTP_AFTER"
echo 'PRODUCTION_DATABASE_RESTORE_CONNECTIONS=0'
echo 'PRODUCTION_DATABASE_MODIFIED_BY_DRILL=NO'
echo 'PM2_CONFIGURATION_CHANGED=NO'
echo 'OSS_MUTATION=NONE'
echo 'AVATA_ENABLED=NO'
echo 'TEMPORARY_DATABASE_RETAINED=YES'
echo 'TEMPORARY_ROLE_LOGIN_ENABLED=NO'
echo "TEMPORARY_DATABASE_CONNECTION_LIMIT=$FINAL_DATABASE_CONNECTION_LIMIT"
echo 'PRODUCTION_BACKUP_RESTORE_DRILL=PASS'
