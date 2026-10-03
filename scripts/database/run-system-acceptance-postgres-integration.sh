#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

REPO=/www/wwwroot/xingxingzaishan
APP_NAME=xingxingzaishan
PRODUCTION_DATABASE=xingxing_clean_baseline_20260812_staging
AUDIT_ROOT=/root/xingxingzaishan-system-acceptance
NODE=/usr/local/bin/node
RUNTIME_CONFIG_CHECK="$REPO/scripts/acceptance/validate-running-production-config.js"
RUNTIME_POSTGRES_CONFIG_READER="$REPO/scripts/acceptance/read-running-postgres-client-config.js"
MODE="${1:-}"
TEST_DB=''
TEST_ROLE=''
TEST_PASSWORD=''
TEST_DB_CREATED=NO
TEST_ROLE_CREATED=NO
APP_PID_BEFORE=''
AUDIT_DIR=''

fail() {
  printf 'SYSTEM_ACCEPTANCE_POSTGRES_INTEGRATION=FAIL\n'
  printf 'ERROR_CODE=%s\n' "$1"
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

admin_psql() {
  runuser -u postgres -- env \
    -u DATABASE_URL -u PGHOST -u PGPORT -u PGUSER -u PGPASSWORD \
    -u PGPASSWORD_FILE -u PGPASSFILE -u PGDATABASE -u PGSSL -u PGSSLMODE \
    /usr/pgsql-15/bin/psql "$@"
}

database_count() {
  admin_psql -X -At -d postgres -v ON_ERROR_STOP=1 \
    -v database_name="$1" \
    -c "SELECT count(*) FROM pg_database WHERE datname = :'database_name';"
}

role_count() {
  admin_psql -X -At -d postgres -v ON_ERROR_STOP=1 \
    -v role_name="$1" \
    -c "SELECT count(*) FROM pg_roles WHERE rolname = :'role_name';"
}

cleanup() {
  local original_status=$?
  local cleanup_status=0
  trap - EXIT INT TERM
  set +e
  if [ "$TEST_DB_CREATED" = YES ]; then
    admin_psql -X -d postgres -v ON_ERROR_STOP=1 \
      -v database_name="$TEST_DB" \
      -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = :'database_name' AND pid <> pg_backend_pid();" \
      >/dev/null 2>&1 || cleanup_status=1
    runuser -u postgres -- env \
      -u DATABASE_URL -u PGHOST -u PGPORT -u PGUSER -u PGPASSWORD \
      -u PGPASSWORD_FILE -u PGPASSFILE -u PGDATABASE -u PGSSL -u PGSSLMODE \
      /usr/pgsql-15/bin/dropdb --if-exists "$TEST_DB" >/dev/null 2>&1 || cleanup_status=1
    [ "$(database_count "$TEST_DB" 2>/dev/null)" = 0 ] || cleanup_status=1
  fi
  if [ "$TEST_ROLE_CREATED" = YES ]; then
    runuser -u postgres -- env \
      -u DATABASE_URL -u PGHOST -u PGPORT -u PGUSER -u PGPASSWORD \
      -u PGPASSWORD_FILE -u PGPASSFILE -u PGDATABASE -u PGSSL -u PGSSLMODE \
      /usr/pgsql-15/bin/dropuser --if-exists "$TEST_ROLE" >/dev/null 2>&1 || cleanup_status=1
    [ "$(role_count "$TEST_ROLE" 2>/dev/null)" = 0 ] || cleanup_status=1
  fi
  TEST_PASSWORD=''
  if [ "$original_status" -ne 0 ] || [ "$cleanup_status" -ne 0 ]; then
    printf 'DISPOSABLE_TEST_DATABASE_REMOVED=%s\n' "$([ "$cleanup_status" -eq 0 ] && printf YES || printf NO)"
    [ -z "$AUDIT_DIR" ] || printf 'AUDIT_DIRECTORY=%s\n' "$AUDIT_DIR"
    exit 1
  fi
}

for command in git pm2 curl runuser sha256sum openssl; do
  command -v "$command" >/dev/null 2>&1 || fail "${command^^}_REQUIRED"
done
[ -x /usr/pgsql-15/bin/psql ] || fail PSQL_REQUIRED
[ -x /usr/pgsql-15/bin/createdb ] || fail CREATEDB_REQUIRED
[ -x /usr/pgsql-15/bin/dropdb ] || fail DROPDB_REQUIRED
[ -x /usr/pgsql-15/bin/dropuser ] || fail DROPUSER_REQUIRED
[ -x "$NODE" ] || fail NODE_REQUIRED
[ -f "$RUNTIME_CONFIG_CHECK" ] || fail RUNTIME_CONFIG_CHECK_MISSING
[ ! -L "$RUNTIME_CONFIG_CHECK" ] || fail RUNTIME_CONFIG_CHECK_UNSAFE
[ -f "$RUNTIME_POSTGRES_CONFIG_READER" ] || fail RUNTIME_POSTGRES_CONFIG_READER_MISSING
[ ! -L "$RUNTIME_POSTGRES_CONFIG_READER" ] || fail RUNTIME_POSTGRES_CONFIG_READER_UNSAFE
[ "$(id -u)" -eq 0 ] || fail ROOT_REQUIRED
[ -d "$REPO/.git" ] || fail REPOSITORY_REQUIRED
cd "$REPO"
assert_clean_worktree

HEAD="$(git rev-parse HEAD)"
TREE="$(git rev-parse 'HEAD^{tree}')"
[[ "$HEAD" =~ ^[a-f0-9]{40}$ ]] || fail HEAD_INVALID
[[ "$TREE" =~ ^[a-f0-9]{40}$ ]] || fail TREE_INVALID
APP_PID_BEFORE="$(pm2 pid "$APP_NAME" | awk '$1 != "0" { print $1 }')"
[[ "$APP_PID_BEFORE" =~ ^[0-9]+$ ]] || fail APP_SINGLE_PID_REQUIRED
[ -r "/proc/$APP_PID_BEFORE/environ" ] || fail APP_ENVIRONMENT_UNREADABLE
PM2_STATE="$(pm2 jlist | "$NODE" -e '
const fs = require("node:fs");
const rows = JSON.parse(fs.readFileSync(0, "utf8"));
const app = rows.filter((row) => row.name === "xingxingzaishan");
if (app.length !== 1) process.exit(2);
const env = app[0].pm2_env || {};
process.stdout.write([
  String(Number(app[0].pid || 0)),
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
  "$APP_PID_BEFORE" "$REPO" "$PRODUCTION_DATABASE" "$PM2_STARTED_AT_MS" \
  || fail RUNTIME_CONFIG_INVALID
RUNTIME_POSTGRES_CONFIG="$(
  "$NODE" "$RUNTIME_POSTGRES_CONFIG_READER" \
    "$APP_PID_BEFORE" "$REPO" "$PRODUCTION_DATABASE" "$PM2_STARTED_AT_MS"
)" || fail RUNTIME_POSTGRES_CONFIG_INVALID
IFS='|' read -r PGHOST_VALUE PGPORT_VALUE PGSSL_VALUE \
  PGSSL_REJECT_UNAUTHORIZED_VALUE <<< "$RUNTIME_POSTGRES_CONFIG"
[ "$PGHOST_VALUE" = 127.0.0.1 ] || fail POSTGRES_HOST_NOT_LOCAL
[[ "$PGPORT_VALUE" =~ ^[0-9]+$ ]] || fail PGPORT_INVALID
[[ "$PGSSL_VALUE" =~ ^(true|false)$ ]] || fail PGSSL_INVALID
[[ "$PGSSL_REJECT_UNAUTHORIZED_VALUE" =~ ^(true|false)$ ]] \
  || fail PGSSL_REJECT_UNAUTHORIZED_INVALID
[ "$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 10 http://127.0.0.1:3000/api/health/ready)" = 200 ] || fail CURRENT_READINESS_FAILED

printf 'ACTIVE_COMMIT=%s\n' "$HEAD"
printf 'ACTIVE_TREE=%s\n' "$TREE"
printf 'PRODUCTION_DATABASE=%s\n' "$PRODUCTION_DATABASE"
printf 'CURRENT_READINESS=PASS_200_READY\n'
printf 'PRODUCTION_RUNTIME_CONFIG=PASS\n'
printf 'POSTGRES_CLIENT_CONFIG=PASS_RECONSTRUCTED_REDACTED\n'
printf 'PRODUCTION_DATABASE_WRITE_BY_RUNNER=NONE\n'
printf 'APPLICATION_RESTART=NO\n'
printf 'EXTERNAL_PROVIDER_CALLS=NONE\n'

if [ "$MODE" = --preflight ]; then
  printf 'DISPOSABLE_TEST_DATABASE_CREATED=NO\n'
  printf 'READY_FOR_POSTGRES_INTEGRATION=YES\n'
  printf 'SYSTEM_ACCEPTANCE_POSTGRES_INTEGRATION_PREFLIGHT=PASS\n'
  exit 0
fi

[ "$MODE" = --authorize-run=YES ] || fail AUTHORIZATION_REQUIRED

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
AUDIT_DIR="$AUDIT_ROOT/$RUN_ID"
install -d -o root -g root -m 0700 "$AUDIT_ROOT" "$AUDIT_DIR"
TEST_DB="xingxing_acceptance_${HEAD:0:8}_$$_test"
TEST_ROLE="xingxing_acceptance_${HEAD:0:8}_$$"
TEST_PASSWORD="$(openssl rand -hex 32)"
[[ "$TEST_DB" =~ ^[a-z0-9_]+_test$ ]] || fail TEST_DATABASE_NAME_INVALID
[[ "$TEST_ROLE" =~ ^[a-z0-9_]+$ ]] || fail TEST_DATABASE_ROLE_NAME_INVALID
[[ "$TEST_PASSWORD" =~ ^[a-f0-9]{64}$ ]] || fail TEST_DATABASE_PASSWORD_INVALID
[ "$TEST_DB" != "$PRODUCTION_DATABASE" ] || fail TEST_DATABASE_IS_PRODUCTION
[ "$(database_count "$TEST_DB")" = 0 ] || fail TEST_DATABASE_ALREADY_EXISTS
[ "$(role_count "$TEST_ROLE")" = 0 ] || fail TEST_DATABASE_ROLE_ALREADY_EXISTS

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

TEST_ROLE_CREATED=YES
printf 'CREATE ROLE "%s" LOGIN PASSWORD '\''%s'\'' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;\n' \
  "$TEST_ROLE" "$TEST_PASSWORD" |
  admin_psql -X -d postgres -v ON_ERROR_STOP=1 >/dev/null
TEST_DB_CREATED=YES
runuser -u postgres -- env \
  -u DATABASE_URL -u PGHOST -u PGPORT -u PGUSER -u PGPASSWORD \
  -u PGPASSWORD_FILE -u PGPASSFILE -u PGDATABASE -u PGSSL -u PGSSLMODE \
  /usr/pgsql-15/bin/createdb -O "$TEST_ROLE" -E UTF8 -T template0 "$TEST_DB"
admin_psql -X -d postgres -v ON_ERROR_STOP=1 \
  -v database_name="$TEST_DB" -v database_user="$TEST_ROLE" \
  -c "REVOKE ALL ON DATABASE :\"database_name\" FROM PUBLIC; GRANT CONNECT, TEMPORARY ON DATABASE :\"database_name\" TO :\"database_user\";" \
  >/dev/null

unset DATABASE_URL PGPASSWORD PGPASSFILE
export PGHOST="$PGHOST_VALUE"
export PGPORT="$PGPORT_VALUE"
export PGUSER="$TEST_ROLE"
export PGDATABASE="$TEST_DB"
export PGPASSWORD="$TEST_PASSWORD"
unset PGPASSWORD_FILE
export PGSSL="$PGSSL_VALUE"
export PGSSL_REJECT_UNAUTHORIZED="$PGSSL_REJECT_UNAUTHORIZED_VALUE"
export PGAPPLICATION_NAME=xingxingzaishan-system-acceptance
export NODE_ENV=test
export RUN_POSTGRES_INTEGRATION=true

node --test tests/postgresql-read-adapter.integration.test.js \
  > "$AUDIT_DIR/postgresql-read-adapter.integration.log" 2>&1
grep -Eq '^# fail 0$|^ℹ fail 0$' "$AUDIT_DIR/postgresql-read-adapter.integration.log" \
  || fail POSTGRES_READ_ADAPTER_INTEGRATION_FAILED

unset RUN_POSTGRES_INTEGRATION
export RUN_POSTGRES_PRINT_PRODUCTION_TEST=true
node --test tests/postgresql-print-production.integration.test.js \
  > "$AUDIT_DIR/postgresql-print-production.integration.log" 2>&1
grep -Eq '^# fail 0$|^ℹ fail 0$' "$AUDIT_DIR/postgresql-print-production.integration.log" \
  || fail POSTGRES_PRINT_PRODUCTION_INTEGRATION_FAILED
unset RUN_POSTGRES_PRINT_PRODUCTION_TEST

cleanup
trap - EXIT INT TERM
TEST_DB_CREATED=NO
TEST_ROLE_CREATED=NO
unset PGPASSWORD
TEST_PASSWORD=''

[ "$(pm2 pid "$APP_NAME" | awk '$1 != "0" { print $1 }')" = "$APP_PID_BEFORE" ] || fail APPLICATION_PID_CHANGED
[ "$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 10 http://127.0.0.1:3000/api/health/ready)" = 200 ] || fail READINESS_FAILED_AFTER_TEST

printf 'POSTGRES_READ_ADAPTER_INTEGRATION=PASS\n'
printf 'POSTGRES_PRINT_PRODUCTION_INTEGRATION=PASS\n'
printf 'DISPOSABLE_TEST_DATABASE_REMOVED=YES\n'
printf 'PRODUCTION_DATABASE_WRITE_BY_RUNNER=NONE\n'
printf 'APPLICATION_PID_UNCHANGED=YES\n'
printf 'APPLICATION_RESTART=NO\n'
printf 'EXTERNAL_PROVIDER_CALLS=NONE\n'
printf 'AUDIT_DIRECTORY=%s\n' "$AUDIT_DIR"
printf 'SYSTEM_ACCEPTANCE_POSTGRES_INTEGRATION=PASS\n'
