#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPECTED_JSON_SHA=f263df13b5c19f91b0f86d93960f6b26896f3ed605318c73dd8546d110b06cfd
TEST_DB=xingxing_stable_scope_20260812_test
TEST_ENV=/etc/xingxingzaishan/postgresql-stable-scope-test-20260812.env
SOURCE_ENV=/etc/xingxingzaishan/postgresql-staging-retry-20260803.env
PRODUCTION_DB=xingxing_retry_20260803_staging
AUDIT_ROOT=/root/stable-scope-integration-audit-20260812
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
AUDIT_DIR="$AUDIT_ROOT/$RUN_ID"
TEST_LOG="$AUDIT_DIR/postgresql-integration.log"
SUMMARY="$AUDIT_DIR/validation-summary.txt"
LOCK_FILE=/run/lock/xingxingzaishan-stable-scope-integration.lock

RESOURCES_OWNED=false
TEST_PASSED=false
APP_PID_BEFORE=''
HEAD=''

fail() {
  echo "STABLE_SCOPE_INTEGRATION=BLOCKED_$1" >&2
  exit 1
}

database_count() {
  runuser -u postgres -- /usr/pgsql-15/bin/psql \
    -X -At -d postgres \
    -c "SELECT count(*) FROM pg_database WHERE datname = '$1';"
}

assert_runtime_default_off() {
  local app_pid="$1"
  local flag
  for flag in \
    PUBLIC_QR_SHADOW_READ_ENABLED \
    PERSONAL_RECORD_SHADOW_READ_ENABLED \
    IDENTITY_SHADOW_READ_ENABLED \
    PUBLIC_QR_POSTGRES_READ_ENABLED \
    QR_LIFECYCLE_POSTGRES_WRITE_ENABLED \
    RECORD_PROOF_RUNTIME_ENABLED \
    PERSONAL_RECORD_POSTGRES_READ_ENABLED
  do
    tr '\0' '\n' < "/proc/$app_pid/environ" |
      grep -qx "${flag}=false" || return 1
  done

  local identity_authority_state
  identity_authority_state="$(
    tr '\0' '\n' < "/proc/$app_pid/environ" |
      sed -n 's/^IDENTITY_POSTGRES_AUTHORITY_ENABLED=//p' |
      tail -n 1
  )"
  [ -z "$identity_authority_state" ] || \
    [ "$identity_authority_state" = false ] || return 1

  local issuance_authority_state
  issuance_authority_state="$(
    tr '\0' '\n' < "/proc/$app_pid/environ" |
      sed -n 's/^QR_ISSUANCE_POSTGRES_AUTHORITY_ENABLED=//p' |
      tail -n 1
  )"
  [ -z "$issuance_authority_state" ] || \
    [ "$issuance_authority_state" = false ] || return 1

  if tr '\0' '\n' < "/proc/$app_pid/environ" |
     grep -Eq '^(DATABASE_URL|PGPASSWORD)=.+$'; then
    return 1
  fi

  if ss -tnp | grep ':5432' | grep -Fq "pid=$app_pid,"; then
    return 1
  fi
}

cleanup() {
  local original_status=$?
  local cleanup_status=0
  local app_pid_after=''
  local http_code=''
  local test_database_count=''
  local production_database_count=''

  trap - EXIT INT TERM
  set +e

  unset DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE
  unset PGSSL PGSSLMODE PGOPTIONS PGAPPLICATION_NAME
  unset NODE_ENV RUN_POSTGRES_INTEGRATION

  if [ "$RESOURCES_OWNED" = true ]; then
    runuser -u postgres -- /usr/pgsql-15/bin/psql \
      -X -d postgres \
      -c "SELECT pg_terminate_backend(pid)
          FROM pg_stat_activity
          WHERE datname = '$TEST_DB'
            AND pid <> pg_backend_pid();" \
      >/dev/null 2>&1 || cleanup_status=1

    runuser -u postgres -- /usr/pgsql-15/bin/dropdb \
      --if-exists "$TEST_DB" >/dev/null 2>&1 || cleanup_status=1
    rm -f -- "$TEST_ENV" || cleanup_status=1
  fi

  test_database_count="$(database_count "$TEST_DB" 2>/dev/null)" || cleanup_status=1
  production_database_count="$(database_count "$PRODUCTION_DB" 2>/dev/null)" || cleanup_status=1
  [ "$test_database_count" = 0 ] || cleanup_status=1
  [ "$production_database_count" = 1 ] || cleanup_status=1
  [ ! -e "$TEST_ENV" ] || cleanup_status=1

  [ "$(sha256sum "$REPO/src/server/data/db.json" | awk '{print $1}')" = \
    "$EXPECTED_JSON_SHA" ] || cleanup_status=1

  app_pid_after="$(pm2 pid xingxingzaishan | tail -n 1)"
  [ -n "$app_pid_after" ] || cleanup_status=1
  [ "$app_pid_after" = "$APP_PID_BEFORE" ] || cleanup_status=1
  http_code="$(curl -sS -o /dev/null -w '%{http_code}' \
    --connect-timeout 5 --max-time 10 http://127.0.0.1:3000/)" || cleanup_status=1
  [ "$http_code" = 200 ] || cleanup_status=1
  assert_runtime_default_off "$app_pid_after" || cleanup_status=1

  if [ "$original_status" -eq 0 ] && \
     [ "$cleanup_status" -eq 0 ] && \
     [ "$TEST_PASSED" = true ]; then
    printf '%s\n' \
      'STABLE_SCOPE_ISOLATED_INTEGRATION=PASS' \
      'POSTGRES_ONLY_PUBLIC_QR_ROUTES=PASS' \
      'POSTGRES_ONLY_LIFECYCLE_WRITE=PASS' \
      'POSTGRES_ONLY_PERSONAL_RECORD_ROUTES=PASS' \
      'POSTGRES_ONLY_IDENTITY_AUTHORITY=PASS' \
      'POSTGRES_ONLY_QR_ISSUANCE=PASS' \
      'POSTGRES_PROOF_ALL_SCOPE_WORKER=PASS' \
      'POSTGRES_PROOF_BACKLOG_MONITOR=PASS' \
      'CROSS_ACCOUNT_PHONE_WRITE_GATES=PASS' \
      'CONTENT_PRIVACY_RESUMABLE_APPLY=PASS' \
      'CONTENT_PRIVACY_REPROOF_ISOLATED=PASS' \
      'TEMP_DATABASE_REMOVED=YES' \
      'TEMP_ENV_REMOVED=YES' \
      'PRODUCTION_RUNTIME_RESTARTED=NO' \
      'PRODUCTION_DATABASE_SELECTED=NO' \
      'PRODUCTION_JSON_UNCHANGED=YES' \
      "VALIDATED_HEAD=$HEAD" \
      "VALIDATED_JSON_SHA256=$EXPECTED_JSON_SHA" \
      "TEST_LOG_SHA256=$(sha256sum "$TEST_LOG" | awk '{print $1}')" \
      "VALIDATED_AT_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      > "$SUMMARY"
    chmod 0600 "$SUMMARY"

    echo "TEST_DATABASE_COUNT_AFTER=$test_database_count"
    echo "PRODUCTION_DATABASE_COUNT=$production_database_count"
    echo "APP_PID=$app_pid_after"
    echo "APP_HTTP=$http_code"
    stat -c 'SUMMARY_OWNER=%U:%G MODE=%a SIZE=%s PATH=%n' "$SUMMARY"
    echo 'STABLE_SCOPE_ISOLATED_INTEGRATION=PASS'
    echo 'TEMP_DATABASE_REMOVED=YES'
    echo 'PRODUCTION_RUNTIME_RESTARTED=NO'
    echo 'PRODUCTION_DATABASE_SELECTED=NO'
    echo 'CONTENT_PRIVACY_REPROOF_ISOLATED=PASS'
    echo 'NEXT_ACTION=RUN_CLEAN_POSTGRES_BASELINE_PLAN'
    exit 0
  fi

  echo "STABLE_SCOPE_ISOLATED_INTEGRATION=FAIL"
  echo "ORIGINAL_EXIT_CODE=$original_status"
  echo "CLEANUP_EXIT_CODE=$cleanup_status"
  echo "TEST_LOG=$TEST_LOG"
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail ROOT_REQUIRED
[ "$TEST_DB" = xingxing_stable_scope_20260812_test ] || fail TEST_DB_MISMATCH
[ "$TEST_DB" != "$PRODUCTION_DB" ] || fail PRODUCTION_DB_SELECTED
[[ "$TEST_DB" == *_test ]] || fail TEST_DB_SUFFIX_INVALID
[ "$TEST_ENV" = \
  /etc/xingxingzaishan/postgresql-stable-scope-test-20260812.env ] || \
  fail TEST_ENV_MISMATCH
[ -f "$SOURCE_ENV" ] || fail SOURCE_ENV_MISSING

cd "$REPO"
HEAD="$(git rev-parse HEAD)"
[ -z "$(git status --porcelain --untracked-files=no)" ] || fail TRACKED_WORKTREE_DIRTY
[ "$(sha256sum src/server/data/db.json | awk '{print $1}')" = \
  "$EXPECTED_JSON_SHA" ] || fail JSON_SHA_MISMATCH

install -d -o root -g root -m 0700 "$AUDIT_ROOT" "$AUDIT_DIR"
install -o root -g root -m 0600 /dev/null "$TEST_LOG"
exec 9>"$LOCK_FILE"
flock -n 9 || fail ALREADY_RUNNING

APP_PID_BEFORE="$(pm2 pid xingxingzaishan | tail -n 1)"
[ -n "$APP_PID_BEFORE" ] || fail APP_PID_MISSING
assert_runtime_default_off "$APP_PID_BEFORE" || fail PRODUCTION_RUNTIME_NOT_DEFAULT_OFF

DB_COUNT="$(database_count "$TEST_DB")"
if [ "$DB_COUNT" = 0 ] && [ ! -e "$TEST_ENV" ]; then
  RESOURCES_OWNED=true
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  runuser -u postgres -- /usr/pgsql-15/bin/createdb \
    -O xingxing_staging_app \
    -E UTF8 \
    -T template0 \
    --lc-collate=C.utf8 \
    --lc-ctype=C.utf8 \
    "$TEST_DB"
  runuser -u postgres -- /usr/pgsql-15/bin/psql \
    -X -v ON_ERROR_STOP=1 -d postgres \
    -c "REVOKE ALL ON DATABASE $TEST_DB FROM PUBLIC;
        GRANT CONNECT, TEMPORARY ON DATABASE $TEST_DB
        TO xingxing_staging_app;"
  runuser -u postgres -- /usr/pgsql-15/bin/psql \
    -X -v ON_ERROR_STOP=1 -d "$TEST_DB" \
    -c 'REVOKE ALL ON SCHEMA public FROM PUBLIC;'

  install -o root -g root -m 0600 "$SOURCE_ENV" "$TEST_ENV"
  sed -i \
    -e "s/^PGDATABASE=.*/PGDATABASE=$TEST_DB/" \
    -e \
      's/^PGAPPLICATION_NAME=.*/PGAPPLICATION_NAME=xingxingzaishan-stable-scope-test/' \
    "$TEST_ENV"
  echo 'TEST_RESOURCE_STATE=CREATED'
elif [ "$DB_COUNT" = 1 ] && [ -f "$TEST_ENV" ]; then
  DB_OWNER="$(runuser -u postgres -- /usr/pgsql-15/bin/psql \
    -X -At -d postgres \
    -c "SELECT pg_get_userbyid(datdba) FROM pg_database
        WHERE datname = '$TEST_DB';")"
  [ "$DB_OWNER" = xingxing_staging_app ] || fail TEST_DB_OWNER_INVALID
  [ "$(stat -c '%U:%G' "$TEST_ENV")" = root:root ] || fail TEST_ENV_OWNER_INVALID
  [ "$(stat -c '%a' "$TEST_ENV")" = 600 ] || fail TEST_ENV_MODE_INVALID
  grep -qx "PGDATABASE=$TEST_DB" "$TEST_ENV" || fail TEST_ENV_DATABASE_INVALID
  grep -qx \
    'PGAPPLICATION_NAME=xingxingzaishan-stable-scope-test' \
    "$TEST_ENV" || fail TEST_ENV_APPLICATION_INVALID

  PREPARED_SCHEMA_COUNT="$(runuser -u postgres -- /usr/pgsql-15/bin/psql \
    -X -At -d "$TEST_DB" \
    -c "SELECT count(*) FROM information_schema.schemata
        WHERE schema_name = 'app';")"
  PREPARED_CONNECTION_COUNT="$(runuser -u postgres -- /usr/pgsql-15/bin/psql \
    -X -At -d postgres \
    -c "SELECT count(*) FROM pg_stat_activity
        WHERE datname = '$TEST_DB';")"
  [ "$PREPARED_SCHEMA_COUNT" = 0 ] || fail PREPARED_SCHEMA_NOT_EMPTY
  [ "$PREPARED_CONNECTION_COUNT" = 0 ] || fail PREPARED_CONNECTION_PRESENT

  RESOURCES_OWNED=true
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  echo 'TEST_RESOURCE_STATE=REUSED_VERIFIED_EMPTY'
else
  fail TEST_RESOURCE_STATE_INCONSISTENT
fi

unset DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE
unset PGSSL PGSSLMODE PGOPTIONS PGAPPLICATION_NAME
unset NODE_ENV RUN_POSTGRES_INTEGRATION DB_FILE AUTH_SECRET STORAGE_MODE
unset PUBLIC_QR_SHADOW_READ_ENABLED PUBLIC_QR_SHADOW_READ_ALLOWLIST
unset PERSONAL_RECORD_SHADOW_READ_ENABLED PERSONAL_RECORD_SHADOW_READ_ALLOWLIST
unset IDENTITY_SHADOW_READ_ENABLED IDENTITY_SHADOW_READ_ALLOWLIST
unset PUBLIC_QR_POSTGRES_READ_ENABLED PUBLIC_QR_POSTGRES_READ_SCOPE
unset PUBLIC_QR_POSTGRES_READ_ALLOWLIST PUBLIC_QR_POSTGRES_READ_DOMAIN_SHA256
unset QR_LIFECYCLE_POSTGRES_WRITE_ENABLED QR_LIFECYCLE_POSTGRES_WRITE_SCOPE
unset QR_LIFECYCLE_POSTGRES_WRITE_ALLOWLIST QR_LIFECYCLE_POSTGRES_WRITE_DOMAIN_SHA256
unset PERSONAL_RECORD_POSTGRES_READ_ENABLED PERSONAL_RECORD_POSTGRES_READ_SCOPE
unset PERSONAL_RECORD_POSTGRES_READ_ALLOWLIST
unset PERSONAL_RECORD_POSTGRES_READ_DOMAIN_SHA256
unset IDENTITY_POSTGRES_AUTHORITY_ENABLED IDENTITY_POSTGRES_AUTHORITY_SCOPE
unset IDENTITY_POSTGRES_AUTHORITY_ALLOWLIST
unset IDENTITY_POSTGRES_AUTHORITY_SOURCE_SHA256
unset IDENTITY_POSTGRES_AUTHORITY_DOMAIN_SHA256 MINIAPP_MOCK_ENABLED
unset QR_ISSUANCE_POSTGRES_AUTHORITY_ENABLED
unset QR_ISSUANCE_POSTGRES_AUTHORITY_SCOPE
unset QR_ISSUANCE_POSTGRES_AUTHORITY_ALLOWLIST
unset QR_ISSUANCE_POSTGRES_AUTHORITY_SOURCE_SHA256
unset QR_ISSUANCE_POSTGRES_AUTHORITY_DOMAIN_SHA256
unset QR_ISSUANCE_TEST_IMAGE_DIR
unset RECORD_PROOF_RUNTIME_ENABLED RECORD_PROOF_RUNTIME_ALLOWLIST
unset RECORD_PROOF_RUNTIME_SCOPE RECORD_PROOF_RUNTIME_SOURCE_SHA256
unset RECORD_PROOF_RUNTIME_DOMAIN_SHA256 RECORD_PROOF_WORKER_ID CHAIN_ENABLED

set -a
. "$TEST_ENV"
set +a

[ "$PGDATABASE" = "$TEST_DB" ] || fail LOADED_TEST_DB_MISMATCH
[ "$PGDATABASE" != "$PRODUCTION_DB" ] || fail LOADED_PRODUCTION_DB_SELECTED
export NODE_ENV=test
export RUN_POSTGRES_INTEGRATION=true

node --test tests/postgresql-read-adapter.integration.test.js \
  > "$TEST_LOG" 2>&1

tail -n 25 "$TEST_LOG"
grep -q '^# tests 1$' "$TEST_LOG"
grep -q '^# pass 1$' "$TEST_LOG"
grep -q '^# fail 0$' "$TEST_LOG"
[ "$(sha256sum src/server/data/db.json | awk '{print $1}')" = \
  "$EXPECTED_JSON_SHA" ]

RESIDUAL_SCHEMA_COUNT="$(/usr/pgsql-15/bin/psql -X -At -v ON_ERROR_STOP=1 \
  -c "SELECT count(*) FROM information_schema.schemata
      WHERE schema_name = 'app';")"
REMAINING_CONNECTIONS="$(/usr/pgsql-15/bin/psql -X -At -v ON_ERROR_STOP=1 \
  -c "SELECT count(*) FROM pg_stat_activity
      WHERE datname = '$TEST_DB'
        AND pid <> pg_backend_pid();")"
[ "$RESIDUAL_SCHEMA_COUNT" = 0 ]
[ "$REMAINING_CONNECTIONS" = 0 ]

echo "RESIDUAL_APP_SCHEMA_COUNT=$RESIDUAL_SCHEMA_COUNT"
echo "TEST_REMAINING_CONNECTIONS=$REMAINING_CONNECTIONS"
stat -c 'TEST_LOG_OWNER=%U:%G MODE=%a SIZE=%s PATH=%n' "$TEST_LOG"

TEST_PASSED=true
