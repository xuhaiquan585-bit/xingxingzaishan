#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE_DB=xingxing_clean_baseline_20260812_staging
SOURCE_ENV=/etc/xingxingzaishan/postgresql-clean-baseline-20260812.env
TEST_DB=xingxing_clean_baseline_e2e_20260812_test
TEST_ENV=/etc/xingxingzaishan/postgresql-clean-baseline-e2e-20260812.env
PRODUCTION_DB=xingxing_retry_20260803_staging
DATABASE_OWNER=xingxing_staging_app
EXPECTED_JSON_SHA=f263df13b5c19f91b0f86d93960f6b26896f3ed605318c73dd8546d110b06cfd
EXPECTED_SOURCE_SHA=fc13e36ec2d96c6e4411e602b65651b4b978f1f481276cbeef233aaf269a4dff
EXPECTED_PLAN_SHA=2eadabbe3a4d8144f6879a600e3a6e93f2290ed795aef05917ee198e61341a2c
EXPECTED_DOMAIN_SHA=f55db6acc5b6b3b9ca5d7b4b9357324b7a89a6eabc7cef3fcd8c4efd07bc454a
SOURCE_ARTIFACT_ROOT=/root/clean-postgres-baseline-rebuild-audit-20260812
AUDIT_ROOT=/root/clean-postgres-candidate-e2e-audit-20260812
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
AUDIT_DIR="$AUDIT_ROOT/$RUN_ID"
TEST_LOG="$AUDIT_DIR/postgresql-candidate-e2e.log"
SUMMARY="$AUDIT_DIR/validation-summary.txt"
RUNTIME_ROOT="$AUDIT_DIR/runtime-storage"
QR_IMAGE_DIR="$RUNTIME_ROOT/public/qrcodes"
LOCK_FILE=/run/lock/xingxingzaishan-clean-candidate-e2e.lock

RESOURCES_OWNED=false
TEST_PASSED=false
APP_PID_BEFORE=''
HEAD=''
SOURCE_ARTIFACT=''

fail() {
  echo "CLEAN_CANDIDATE_E2E=BLOCKED_$1" >&2
  exit 1
}

database_count() {
  runuser -u postgres -- /usr/pgsql-15/bin/psql -X -At -d postgres \
    -c "SELECT count(*) FROM pg_database WHERE datname = '$1';"
}

assert_runtime_default_off() {
  local app_pid="$1"
  local flag value
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
  for flag in IDENTITY_POSTGRES_AUTHORITY_ENABLED QR_ISSUANCE_POSTGRES_AUTHORITY_ENABLED
  do
    value="$(
      tr '\0' '\n' < "/proc/$app_pid/environ" |
        sed -n "s/^${flag}=//p" |
        tail -n 1
    )"
    [ -z "$value" ] || [ "$value" = false ] || return 1
  done
  if tr '\0' '\n' < "/proc/$app_pid/environ" |
     grep -Eq '^(DATABASE_URL|PGPASSWORD|AVATA_API_KEY|AVATA_API_SECRET)=.+$'; then
    return 1
  fi
  if ss -tnp | grep ':5432' | grep -Fq "pid=$app_pid,"; then
    return 1
  fi
}

candidate_state() {
  runuser -u postgres -- /usr/pgsql-15/bin/psql -X -At -F '|' \
    -v ON_ERROR_STOP=1 -d "$SOURCE_DB" \
    -c "SELECT
          (SELECT count(*) FROM app.qr_codes),
          (SELECT count(*) FROM app.records),
          (SELECT count(*) FROM app.import_runs WHERE status = 'passed'),
          (SELECT count(*) FROM app.import_runs WHERE status <> 'passed'),
          (SELECT count(*) FROM app.outbox_jobs),
          (SELECT checksum_summary->>'source_sha256'
           FROM app.import_runs WHERE status = 'passed'
           ORDER BY completed_at DESC LIMIT 1),
          (SELECT checksum_summary->>'plan_sha256'
           FROM app.import_runs WHERE status = 'passed'
           ORDER BY completed_at DESC LIMIT 1),
          (SELECT checksum_summary->>'public_qr_v1_sha256'
           FROM app.import_runs WHERE status = 'passed'
           ORDER BY completed_at DESC LIMIT 1);"
}

cleanup_runtime_storage() {
  if [ -d "$RUNTIME_ROOT" ]; then
    find "$RUNTIME_ROOT" -type f -delete
    find "$RUNTIME_ROOT" -depth -type d -empty -delete
  fi
  [ ! -e "$RUNTIME_ROOT" ]
}

cleanup() {
  local original_status=$?
  local cleanup_status=0
  local test_count source_count production_count source_connections
  local state app_pid_after http_code

  trap - EXIT INT TERM
  set +e
  unset DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE
  unset PGSSL PGSSLMODE PGOPTIONS PGAPPLICATION_NAME NODE_ENV
  unset RUN_CLEAN_POSTGRES_CANDIDATE_E2E DB_FILE AUTH_SECRET STORAGE_MODE
  unset PUBLIC_QR_POSTGRES_READ_ENABLED PUBLIC_QR_POSTGRES_READ_SCOPE
  unset PUBLIC_QR_POSTGRES_READ_DOMAIN_SHA256
  unset QR_LIFECYCLE_POSTGRES_WRITE_ENABLED QR_LIFECYCLE_POSTGRES_WRITE_SCOPE
  unset QR_LIFECYCLE_POSTGRES_WRITE_DOMAIN_SHA256
  unset PERSONAL_RECORD_POSTGRES_READ_ENABLED PERSONAL_RECORD_POSTGRES_READ_SCOPE
  unset PERSONAL_RECORD_POSTGRES_READ_DOMAIN_SHA256
  unset IDENTITY_POSTGRES_AUTHORITY_ENABLED IDENTITY_POSTGRES_AUTHORITY_SCOPE
  unset IDENTITY_POSTGRES_AUTHORITY_SOURCE_SHA256
  unset IDENTITY_POSTGRES_AUTHORITY_DOMAIN_SHA256
  unset QR_ISSUANCE_POSTGRES_AUTHORITY_ENABLED QR_ISSUANCE_POSTGRES_AUTHORITY_SCOPE
  unset QR_ISSUANCE_POSTGRES_AUTHORITY_SOURCE_SHA256
  unset QR_ISSUANCE_POSTGRES_AUTHORITY_DOMAIN_SHA256 QR_ISSUANCE_TEST_IMAGE_DIR
  unset RECORD_PROOF_RUNTIME_ENABLED RECORD_PROOF_RUNTIME_SCOPE
  unset RECORD_PROOF_RUNTIME_SOURCE_SHA256 RECORD_PROOF_RUNTIME_DOMAIN_SHA256
  unset RECORD_PROOF_WORKER_ID MINIAPP_MOCK_ENABLED CHAIN_ENABLED
  unset CHAIN_CALLBACK_URL AVATA_API_KEY AVATA_API_SECRET
  unset AVATA_IDENTITY_NAME AVATA_IDENTITY_NUM
  unset CLEAN_CANDIDATE_EXPECTED_SOURCE_SHA256
  unset CLEAN_CANDIDATE_EXPECTED_PLAN_SHA256
  unset CLEAN_CANDIDATE_EXPECTED_DOMAIN_SHA256

  if [ "$RESOURCES_OWNED" = true ]; then
    runuser -u postgres -- /usr/pgsql-15/bin/psql -X -d postgres \
      -c "SELECT pg_terminate_backend(pid)
          FROM pg_stat_activity
          WHERE datname = '$TEST_DB'
            AND pid <> pg_backend_pid();" >/dev/null 2>&1 || cleanup_status=1
    runuser -u postgres -- /usr/pgsql-15/bin/dropdb \
      --if-exists "$TEST_DB" >/dev/null 2>&1 || cleanup_status=1
    rm -f -- "$TEST_ENV" || cleanup_status=1
  fi
  cleanup_runtime_storage || cleanup_status=1

  test_count="$(database_count "$TEST_DB" 2>/dev/null)" || cleanup_status=1
  source_count="$(database_count "$SOURCE_DB" 2>/dev/null)" || cleanup_status=1
  production_count="$(database_count "$PRODUCTION_DB" 2>/dev/null)" || cleanup_status=1
  [ "$test_count" = 0 ] || cleanup_status=1
  [ "$source_count" = 1 ] || cleanup_status=1
  [ "$production_count" = 1 ] || cleanup_status=1
  [ ! -e "$TEST_ENV" ] || cleanup_status=1

  state="$(candidate_state 2>/dev/null)" || cleanup_status=1
  [ "$state" = "103|55|1|0|0|$EXPECTED_SOURCE_SHA|$EXPECTED_PLAN_SHA|$EXPECTED_DOMAIN_SHA" ] || \
    cleanup_status=1
  source_connections="$(
    runuser -u postgres -- /usr/pgsql-15/bin/psql -X -At -d postgres \
      -c "SELECT count(*) FROM pg_stat_activity WHERE datname = '$SOURCE_DB';" \
      2>/dev/null
  )" || cleanup_status=1
  [ "$source_connections" = 0 ] || cleanup_status=1
  [ "$(sha256sum "$REPO/src/server/data/db.json" | awk '{print $1}')" = \
    "$EXPECTED_JSON_SHA" ] || cleanup_status=1
  [ "$(sha256sum "$SOURCE_ARTIFACT" | awk '{print $1}')" = \
    "$EXPECTED_SOURCE_SHA" ] || cleanup_status=1

  app_pid_after="$(pm2 pid xingxingzaishan | tail -n 1)"
  [ -n "$app_pid_after" ] || cleanup_status=1
  [ "$app_pid_after" = "$APP_PID_BEFORE" ] || cleanup_status=1
  http_code="$(curl -sS -o /dev/null -w '%{http_code}' \
    --connect-timeout 5 --max-time 10 http://127.0.0.1:3000/)" || cleanup_status=1
  [ "$http_code" = 200 ] || cleanup_status=1
  assert_runtime_default_off "$app_pid_after" || cleanup_status=1

  if [ "$original_status" -eq 0 ] && [ "$cleanup_status" -eq 0 ] && \
     [ "$TEST_PASSED" = true ]; then
    printf '%s\n' \
      'CLEAN_CANDIDATE_POSTGRES_ONLY_E2E=PASS' \
      'CLEAN_CANDIDATE_COORDINATED_JOINT_REHEARSAL=PASS' \
      'EXISTING_H5_ROUTES=PASS' \
      'EXISTING_MINIAPP_ROUTES=PASS' \
      'EXISTING_DATA_UNCHANGED=PASS' \
      'CANDIDATE_DATABASE_WRITE=NONE' \
      'DISPOSABLE_CLONE_REMOVED=YES' \
      'POSTGRES_ONLY_QR_ISSUANCE=PASS' \
      'POSTGRES_ONLY_IDENTITY_AUTHORITY=PASS' \
      'POSTGRES_ONLY_LIFECYCLE_WRITE=PASS' \
      'POSTGRES_ONLY_PUBLIC_QR_ROUTES=PASS' \
      'POSTGRES_ONLY_PERSONAL_RECORD_ROUTES=PASS' \
      'POSTGRES_ONLY_PROOF_OUTBOX=PASS' \
      'PROOF_WORKER_RUNTIME=DISABLED' \
      'EXTERNAL_PROVIDER_CALLS=NONE' \
      'PRODUCTION_RUNTIME_RESTARTED=NO' \
      'PRODUCTION_DATABASE_SELECTED=NO' \
      "VALIDATED_HEAD=$HEAD" \
      "VALIDATED_SOURCE_SHA256=$EXPECTED_SOURCE_SHA" \
      "VALIDATED_PLAN_SHA256=$EXPECTED_PLAN_SHA" \
      "VALIDATED_DOMAIN_SHA256=$EXPECTED_DOMAIN_SHA" \
      "TEST_LOG_SHA256=$(sha256sum "$TEST_LOG" | awk '{print $1}')" \
      "VALIDATED_AT_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      > "$SUMMARY"
    chmod 0600 "$SUMMARY"
    echo "TEST_DATABASE_COUNT_AFTER=$test_count"
    echo "CANDIDATE_DATABASE_COUNT=$source_count"
    echo "PRODUCTION_DATABASE_COUNT=$production_count"
    echo "CANDIDATE_DATABASE_STATE=$state"
    echo "CANDIDATE_REMAINING_CONNECTIONS=$source_connections"
    echo "APP_PID=$app_pid_after"
    echo "APP_HTTP=$http_code"
    stat -c 'SUMMARY_OWNER=%U:%G MODE=%a SIZE=%s PATH=%n' "$SUMMARY"
    echo 'CLEAN_CANDIDATE_POSTGRES_ONLY_E2E=PASS'
    echo 'CLEAN_CANDIDATE_COORDINATED_JOINT_REHEARSAL=PASS'
    echo 'DISPOSABLE_CLONE_REMOVED=YES'
    echo 'CANDIDATE_DATABASE_WRITE=NONE'
    echo 'PRODUCTION_RUNTIME_RESTARTED=NO'
    echo 'EXTERNAL_PROVIDER_CALLS=NONE'
    echo 'NEXT_ACTION=PREPARE_STABLE_CUTOVER_PREFLIGHT'
    exit 0
  fi

  echo 'CLEAN_CANDIDATE_POSTGRES_ONLY_E2E=FAIL'
  echo "ORIGINAL_EXIT_CODE=$original_status"
  echo "CLEANUP_EXIT_CODE=$cleanup_status"
  echo "TEST_LOG=$TEST_LOG"
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail ROOT_REQUIRED
[ "$SOURCE_DB" = xingxing_clean_baseline_20260812_staging ] || fail SOURCE_DB_INVALID
[ "$TEST_DB" = xingxing_clean_baseline_e2e_20260812_test ] || fail TEST_DB_INVALID
[ "$SOURCE_DB" != "$PRODUCTION_DB" ] || fail SOURCE_IS_PRODUCTION
[ "$TEST_DB" != "$SOURCE_DB" ] || fail TEST_IS_SOURCE
[ "$TEST_DB" != "$PRODUCTION_DB" ] || fail TEST_IS_PRODUCTION
[[ "$TEST_DB" == *_test ]] || fail TEST_SUFFIX_INVALID
[ -f "$SOURCE_ENV" ] && [ ! -L "$SOURCE_ENV" ] || fail SOURCE_ENV_INVALID
[ "$(stat -c '%U:%G' "$SOURCE_ENV")" = root:root ] || fail SOURCE_ENV_OWNER_INVALID
[ "$(stat -c '%a' "$SOURCE_ENV")" = 600 ] || fail SOURCE_ENV_MODE_INVALID
grep -qx "PGDATABASE=$SOURCE_DB" "$SOURCE_ENV" || fail SOURCE_ENV_DATABASE_INVALID

cd "$REPO"
HEAD="$(git rev-parse HEAD)"
[ -z "$(git status --porcelain --untracked-files=no)" ] || fail TRACKED_WORKTREE_DIRTY
[ "$(sha256sum src/server/data/db.json | awk '{print $1}')" = \
  "$EXPECTED_JSON_SHA" ] || fail LIVE_JSON_CHANGED

mapfile -t SOURCE_ARTIFACTS < <(
  find "$SOURCE_ARTIFACT_ROOT" -mindepth 2 -maxdepth 2 -type f \
    -name clean-baseline-source.json -print0 |
    xargs -0 -r sha256sum |
    awk -v expected="$EXPECTED_SOURCE_SHA" '$1 == expected { print $2 }'
)
[ "${#SOURCE_ARTIFACTS[@]}" -eq 1 ] || fail SOURCE_ARTIFACT_NOT_UNIQUE
SOURCE_ARTIFACT="${SOURCE_ARTIFACTS[0]}"
[ ! -L "$SOURCE_ARTIFACT" ] || fail SOURCE_ARTIFACT_SYMLINK
[ "$(stat -c '%U:%G' "$SOURCE_ARTIFACT")" = root:root ] || \
  fail SOURCE_ARTIFACT_OWNER_INVALID
[ "$(stat -c '%a' "$SOURCE_ARTIFACT")" = 600 ] || fail SOURCE_ARTIFACT_MODE_INVALID

[ "$(database_count "$SOURCE_DB")" = 1 ] || fail SOURCE_DATABASE_MISSING
[ "$(database_count "$PRODUCTION_DB")" = 1 ] || fail PRODUCTION_DATABASE_MISSING
[ "$(database_count "$TEST_DB")" = 0 ] || fail TEST_DATABASE_ALREADY_EXISTS
[ ! -e "$TEST_ENV" ] || fail TEST_ENV_ALREADY_EXISTS
BASELINE_STATE="$(candidate_state)"
[ "$BASELINE_STATE" = \
  "103|55|1|0|0|$EXPECTED_SOURCE_SHA|$EXPECTED_PLAN_SHA|$EXPECTED_DOMAIN_SHA" ] || \
  fail CANDIDATE_STATE_INVALID
SOURCE_CONNECTIONS="$(
  runuser -u postgres -- /usr/pgsql-15/bin/psql -X -At -d postgres \
    -c "SELECT count(*) FROM pg_stat_activity WHERE datname = '$SOURCE_DB';"
)"
[ "$SOURCE_CONNECTIONS" = 0 ] || fail CANDIDATE_CONNECTION_PRESENT

install -d -o root -g root -m 0700 \
  "$AUDIT_ROOT" "$AUDIT_DIR" "$RUNTIME_ROOT" \
  "$RUNTIME_ROOT/public" "$QR_IMAGE_DIR"
install -o root -g root -m 0600 /dev/null "$TEST_LOG"
exec 9>"$LOCK_FILE"
flock -n 9 || fail ALREADY_RUNNING

APP_PID_BEFORE="$(pm2 pid xingxingzaishan | tail -n 1)"
[ -n "$APP_PID_BEFORE" ] && [ "$APP_PID_BEFORE" != 0 ] || fail APP_PID_MISSING
assert_runtime_default_off "$APP_PID_BEFORE" || fail PRODUCTION_RUNTIME_NOT_DEFAULT_OFF

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
runuser -u postgres -- /usr/pgsql-15/bin/createdb \
  -O "$DATABASE_OWNER" -T "$SOURCE_DB" "$TEST_DB"
RESOURCES_OWNED=true
runuser -u postgres -- /usr/pgsql-15/bin/psql -X -v ON_ERROR_STOP=1 -d postgres \
  -c "REVOKE ALL ON DATABASE $TEST_DB FROM PUBLIC;
      GRANT CONNECT, TEMPORARY ON DATABASE $TEST_DB TO $DATABASE_OWNER;"
install -o root -g root -m 0600 "$SOURCE_ENV" "$TEST_ENV"
sed -i \
  -e "s/^PGDATABASE=.*/PGDATABASE=$TEST_DB/" \
  -e 's/^PGAPPLICATION_NAME=.*/PGAPPLICATION_NAME=xingxingzaishan-clean-candidate-e2e/' \
  "$TEST_ENV"

unset DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE
unset PGSSL PGSSLMODE PGOPTIONS PGAPPLICATION_NAME
set -a
. "$TEST_ENV"
set +a
[ "$PGDATABASE" = "$TEST_DB" ] || fail TEST_ENV_DATABASE_MISMATCH
[ "$PGDATABASE" != "$SOURCE_DB" ] || fail CANDIDATE_DATABASE_SELECTED
[ "$PGDATABASE" != "$PRODUCTION_DB" ] || fail PRODUCTION_DATABASE_SELECTED

export NODE_ENV=test
export RUN_CLEAN_POSTGRES_CANDIDATE_E2E=true
export DB_FILE="$SOURCE_ARTIFACT"
export AUTH_SECRET=clean-candidate-e2e-secret
export STORAGE_MODE=local
export BASE_URL=https://clean-candidate.invalid
export PUBLIC_QR_SHADOW_READ_ENABLED=false
export PERSONAL_RECORD_SHADOW_READ_ENABLED=false
export IDENTITY_SHADOW_READ_ENABLED=false
export PUBLIC_QR_POSTGRES_READ_ENABLED=true
export PUBLIC_QR_POSTGRES_READ_SCOPE=all
export PUBLIC_QR_POSTGRES_READ_DOMAIN_SHA256="$EXPECTED_DOMAIN_SHA"
export QR_LIFECYCLE_POSTGRES_WRITE_ENABLED=true
export QR_LIFECYCLE_POSTGRES_WRITE_SCOPE=all
export QR_LIFECYCLE_POSTGRES_WRITE_DOMAIN_SHA256="$EXPECTED_DOMAIN_SHA"
export PERSONAL_RECORD_POSTGRES_READ_ENABLED=true
export PERSONAL_RECORD_POSTGRES_READ_SCOPE=all
export PERSONAL_RECORD_POSTGRES_READ_DOMAIN_SHA256="$EXPECTED_DOMAIN_SHA"
export IDENTITY_POSTGRES_AUTHORITY_ENABLED=true
export IDENTITY_POSTGRES_AUTHORITY_SCOPE=all
export IDENTITY_POSTGRES_AUTHORITY_SOURCE_SHA256="$EXPECTED_SOURCE_SHA"
export IDENTITY_POSTGRES_AUTHORITY_DOMAIN_SHA256="$EXPECTED_DOMAIN_SHA"
export QR_ISSUANCE_POSTGRES_AUTHORITY_ENABLED=true
export QR_ISSUANCE_POSTGRES_AUTHORITY_SCOPE=all
export QR_ISSUANCE_POSTGRES_AUTHORITY_SOURCE_SHA256="$EXPECTED_SOURCE_SHA"
export QR_ISSUANCE_POSTGRES_AUTHORITY_DOMAIN_SHA256="$EXPECTED_DOMAIN_SHA"
export QR_ISSUANCE_TEST_IMAGE_DIR="$QR_IMAGE_DIR"
export RECORD_PROOF_RUNTIME_ENABLED=false
unset RECORD_PROOF_RUNTIME_SCOPE RECORD_PROOF_RUNTIME_SOURCE_SHA256
unset RECORD_PROOF_RUNTIME_DOMAIN_SHA256 RECORD_PROOF_WORKER_ID
export MINIAPP_MOCK_ENABLED=true
export CHAIN_ENABLED=false
unset CHAIN_CALLBACK_URL AVATA_API_KEY AVATA_API_SECRET
unset AVATA_IDENTITY_NAME AVATA_IDENTITY_NUM
export CLEAN_CANDIDATE_EXPECTED_SOURCE_SHA256="$EXPECTED_SOURCE_SHA"
export CLEAN_CANDIDATE_EXPECTED_PLAN_SHA256="$EXPECTED_PLAN_SHA"
export CLEAN_CANDIDATE_EXPECTED_DOMAIN_SHA256="$EXPECTED_DOMAIN_SHA"
unset WECHAT_MINIAPP_APPID WECHAT_MINIAPP_SECRET

node --test tests/postgresql-clean-candidate.e2e.test.js > "$TEST_LOG" 2>&1
tail -n 30 "$TEST_LOG"
grep -q '^# tests 1$' "$TEST_LOG"
grep -q '^# pass 1$' "$TEST_LOG"
grep -q '^# fail 0$' "$TEST_LOG"
grep -q 'CLEAN_CANDIDATE_POSTGRES_ONLY_QR_ISSUANCE=PASS' "$TEST_LOG"
grep -q 'CLEAN_CANDIDATE_POSTGRES_ONLY_PROOF_OUTBOX=PASS' "$TEST_LOG"
grep -q 'CLEAN_CANDIDATE_PROOF_WORKER_RUNTIME=DISABLED' "$TEST_LOG"
grep -q 'CLEAN_CANDIDATE_EXISTING_H5_ROUTES=PASS' "$TEST_LOG"
grep -q 'CLEAN_CANDIDATE_EXISTING_MINIAPP_ROUTES=PASS' "$TEST_LOG"
grep -q 'CLEAN_CANDIDATE_EXISTING_DATA_UNCHANGED=PASS' "$TEST_LOG"
grep -q 'CLEAN_CANDIDATE_COORDINATED_JOINT_REHEARSAL=PASS' "$TEST_LOG"
grep -q 'CLEAN_CANDIDATE_EXTERNAL_FETCH_CALLS=0' "$TEST_LOG"
TEST_PASSED=true
