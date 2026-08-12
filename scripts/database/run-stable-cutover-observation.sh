#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

REPO=/www/wwwroot/xingxingzaishan
APP_NAME=xingxingzaishan
CANDIDATE_DB=xingxing_clean_baseline_20260812_staging
EXPECTED_SOURCE_SHA=fc13e36ec2d96c6e4411e602b65651b4b978f1f481276cbeef233aaf269a4dff
EXPECTED_PLAN_SHA=2eadabbe3a4d8144f6879a600e3a6e93f2290ed795aef05917ee198e61341a2c
EXPECTED_DOMAIN_SHA=f55db6acc5b6b3b9ca5d7b4b9357324b7a89a6eabc7cef3fcd8c4efd07bc454a
COMMIT_ROOT=/root/stable-cutover-commit-audit-20260813
PASSWORD_FILE=/etc/xingxingzaishan/postgresql-clean-baseline-20260812.password
PM2_DUMP=/root/.pm2/dump.pm2
LOCK_FILE=/run/lock/xingxingzaishan-stable-cutover-observation.lock
CONFIRMATION=OBSERVE_POSTGRES_AUTHORITY_COMMITTED
QR_ID=A00001
OBSERVATION_CYCLES=3
OBSERVATION_INTERVAL_SECONDS=10

fail() {
  echo "STABLE_CUTOVER_OBSERVATION=BLOCKED_$1" >&2
  exit 1
}

assert_protected_file() {
  local file="$1"
  [ -f "$file" ] && [ ! -L "$file" ] || return 1
  [ "$(stat -c '%U:%G' "$file")" = root:root ] || return 1
  [ "$(stat -c '%a' "$file")" = 600 ] || return 1
}

runtime_value() {
  local app_pid="$1"
  local key="$2"
  tr '\0' '\n' < "/proc/$app_pid/environ" |
    sed -n "s/^${key}=//p" |
    tail -n 1
}

assert_stable_runtime() {
  local app_pid="$1"
  local flag
  for flag in \
    PUBLIC_QR_POSTGRES_READ_ENABLED \
    PERSONAL_RECORD_POSTGRES_READ_ENABLED \
    QR_LIFECYCLE_POSTGRES_WRITE_ENABLED \
    IDENTITY_POSTGRES_AUTHORITY_ENABLED \
    QR_ISSUANCE_POSTGRES_AUTHORITY_ENABLED
  do
    [ "$(runtime_value "$app_pid" "$flag")" = true ] || return 1
  done
  for flag in \
    PUBLIC_QR_POSTGRES_READ_SCOPE \
    PERSONAL_RECORD_POSTGRES_READ_SCOPE \
    QR_LIFECYCLE_POSTGRES_WRITE_SCOPE \
    IDENTITY_POSTGRES_AUTHORITY_SCOPE \
    QR_ISSUANCE_POSTGRES_AUTHORITY_SCOPE
  do
    [ "$(runtime_value "$app_pid" "$flag")" = all ] || return 1
  done
  [ "$(runtime_value "$app_pid" PGDATABASE)" = "$CANDIDATE_DB" ] || return 1
  [ "$(runtime_value "$app_pid" PGPASSWORD_FILE)" = "$PASSWORD_FILE" ] || return 1
  [ "$(runtime_value "$app_pid" POSTGRES_CUTOVER_WRITE_FREEZE_ENABLED)" = false ] || \
    return 1
  [ "$(runtime_value "$app_pid" RECORD_PROOF_RUNTIME_ENABLED)" = false ] || \
    return 1
  ! tr '\0' '\n' < "/proc/$app_pid/environ" |
    grep -Eq '^(DATABASE_URL|PGPASSWORD|AVATA_API_KEY|AVATA_API_SECRET)=.+$'
}

OBSERVE_MODE=false
COMMIT_SUMMARY=''
CONFIRM_VALUE=''
for ARG in "$@"; do
  case "$ARG" in
    --observe) OBSERVE_MODE=true ;;
    --commit-summary=*) COMMIT_SUMMARY="${ARG#--commit-summary=}" ;;
    --confirm=*) CONFIRM_VALUE="${ARG#--confirm=}" ;;
    *) fail ARGUMENT_INVALID ;;
  esac
done
[ "$#" -eq 3 ] || fail ARGUMENT_COUNT_INVALID
[ "$OBSERVE_MODE" = true ] || fail EXPLICIT_OBSERVE_MODE_REQUIRED
[ "$CONFIRM_VALUE" = "$CONFIRMATION" ] || fail EXPLICIT_CONFIRMATION_REQUIRED
[ "$(id -u)" -eq 0 ] || fail ROOT_REQUIRED
case "$COMMIT_SUMMARY" in
  "$COMMIT_ROOT"/*/stable-commit-summary.txt) ;;
  *) fail COMMIT_SUMMARY_PATH_INVALID ;;
esac
assert_protected_file "$COMMIT_SUMMARY" || fail COMMIT_SUMMARY_INVALID
grep -qx 'STABLE_CUTOVER_COMMIT=PASS' "$COMMIT_SUMMARY" || \
  fail COMMIT_RESULT_INVALID
grep -qx 'FINAL_STATE=POSTGRES_AUTHORITY_COMMITTED' "$COMMIT_SUMMARY" || \
  fail COMMIT_FINAL_STATE_INVALID
grep -qx 'AUTHORITY_COMMIT_POINT_CROSSED=YES' "$COMMIT_SUMMARY" || \
  fail COMMIT_POINT_INVALID
grep -qx 'JSON_FALLBACK_ALLOWED=NO' "$COMMIT_SUMMARY" || \
  fail JSON_FALLBACK_CONTRACT_INVALID
grep -qx 'RECORD_PROOF_RUNTIME_ENABLED=false' "$COMMIT_SUMMARY" || \
  fail PROOF_RUNTIME_CONTRACT_INVALID
grep -qx 'AVATA_CONFIGURATION_LOADED=NO' "$COMMIT_SUMMARY" || \
  fail AVATA_CONTRACT_INVALID

COMMIT_DIR="$(dirname "$COMMIT_SUMMARY")"
COMMIT_STATE="$COMMIT_DIR/stable-commit-state.env"
BASELINE_FINGERPRINT="$COMMIT_DIR/json-public-fingerprints.json"
for FILE in "$COMMIT_STATE" "$BASELINE_FINGERPRINT" "$PASSWORD_FILE" "$PM2_DUMP"; do
  assert_protected_file "$FILE" || fail DEPENDENCY_INVALID
done
grep -qx 'PHASE=POSTGRES_AUTHORITY_COMMITTED' "$COMMIT_STATE" || \
  fail COMMIT_STATE_PHASE_INVALID
grep -qx 'AUTHORITY_COMMIT_POINT_CROSSED=YES' "$COMMIT_STATE" || \
  fail COMMIT_STATE_POINT_INVALID

EXPECTED_HEAD="$(sed -n 's/^VALIDATED_HEAD=//p' "$COMMIT_SUMMARY" | tail -n 1)"
EXPECTED_TREE="$(sed -n 's/^VALIDATED_TREE=//p' "$COMMIT_SUMMARY" | tail -n 1)"
[[ "$EXPECTED_HEAD" =~ ^[a-f0-9]{40}$ ]] || fail COMMIT_HEAD_INVALID
[[ "$EXPECTED_TREE" =~ ^[a-f0-9]{40}$ ]] || fail COMMIT_TREE_INVALID

for command in flock curl pm2 ss sha256sum sleep; do
  command -v "$command" >/dev/null 2>&1 || fail "${command^^}_REQUIRED"
done
command -v /usr/pgsql-15/bin/psql >/dev/null 2>&1 || fail PSQL_REQUIRED
command -v /usr/local/bin/node >/dev/null 2>&1 || fail NODE_REQUIRED
exec 9>"$LOCK_FILE"
flock -n 9 || fail OBSERVATION_ALREADY_RUNNING

cd "$REPO"
[ -z "$(git status --porcelain --untracked-files=no)" ] || fail TRACKED_WORKTREE_DIRTY
[ "$(git rev-parse HEAD)" = "$EXPECTED_HEAD" ] || fail HEAD_CHANGED
[ "$(git rev-parse 'HEAD^{tree}')" = "$EXPECTED_TREE" ] || fail TREE_CHANGED

AUDIT_DIR="$COMMIT_DIR/observation-$(date -u +%Y%m%dT%H%M%SZ)-$$"
SUMMARY="$AUDIT_DIR/observation-summary.txt"
PM2_REPORT="$AUDIT_DIR/pm2-stable-validation.json"
install -d -o root -g root -m 0700 "$AUDIT_DIR"

/usr/local/bin/node scripts/database/validate-stable-pm2-state.js \
  --dump="$PM2_DUMP" \
  --app="$APP_NAME" \
  --expected-password-file="$PASSWORD_FILE" \
  --expected-database="$CANDIDATE_DB" \
  --expected-authority=postgres \
  --expected-freeze=false \
  > "$PM2_REPORT"
chmod 0600 "$PM2_REPORT"

set -a
. "$COMMIT_STATE"
set +a
assert_protected_file "$CANDIDATE_ENVIRONMENT" || fail CANDIDATE_ENV_INVALID
[ "$(sha256sum "$CANDIDATE_ENVIRONMENT" | awk '{print $1}')" = \
  "$CANDIDATE_ENVIRONMENT_SHA256" ] || fail CANDIDATE_ENV_CHANGED

unset DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGPASSWORD_FILE PGDATABASE
unset PGSSL PGSSLMODE PGOPTIONS PGAPPLICATION_NAME
set -a
. "$CANDIDATE_ENVIRONMENT"
set +a
[ "$PGDATABASE" = "$CANDIDATE_DB" ] || fail CANDIDATE_DATABASE_INVALID
PGPASSWORD="$(<"$PASSWORD_FILE")"
export PGPASSWORD
export PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=15000ms'
export PGAPPLICATION_NAME=xingxingzaishan-stable-observation

REFERENCE_DATABASE_STATE=''
for CYCLE in $(seq 1 "$OBSERVATION_CYCLES"); do
  APP_PID="$(pm2 pid "$APP_NAME" | tail -n 1)"
  [ -n "$APP_PID" ] && [ "$APP_PID" != 0 ] || fail APP_PID_MISSING
  assert_stable_runtime "$APP_PID" || fail STABLE_RUNTIME_INVALID

  HTTP_CODE="$(curl -sS -o /dev/null -w '%{http_code}' \
    --connect-timeout 5 --max-time 10 http://127.0.0.1:3000/)"
  [ "$HTTP_CODE" = 200 ] || fail APP_HTTP_INVALID
  if ! ss -tnp | grep ':5432' | grep -Fq "pid=$APP_PID,"; then
    fail POSTGRES_CONNECTION_MISSING
  fi

  DATABASE_STATE="$(
    /usr/pgsql-15/bin/psql -X -At -F '|' -v ON_ERROR_STOP=1 \
      -c "SELECT
            (SELECT count(*) FROM app.qr_codes),
            (SELECT count(*) FROM app.records),
            (SELECT count(*) FROM app.import_runs WHERE status = 'passed'),
            (SELECT count(*) FROM app.import_runs WHERE status <> 'passed'),
            (SELECT count(*) FROM app.outbox_jobs),
            (SELECT count(*) FROM app.outbox_jobs WHERE status = 'pending'),
            (SELECT count(*) FROM app.outbox_jobs WHERE status = 'processing'),
            (SELECT count(*) FROM app.outbox_jobs WHERE status = 'failed'),
            (SELECT checksum_summary->>'source_sha256' FROM app.import_runs
              WHERE status = 'passed' ORDER BY completed_at DESC LIMIT 1),
            (SELECT checksum_summary->>'plan_sha256' FROM app.import_runs
              WHERE status = 'passed' ORDER BY completed_at DESC LIMIT 1),
            (SELECT checksum_summary->>'public_qr_v1_sha256' FROM app.import_runs
              WHERE status = 'passed' ORDER BY completed_at DESC LIMIT 1);"
  )"
  IFS='|' read -r QR_COUNT RECORD_COUNT IMPORT_PASS IMPORT_FAIL OUTBOX_TOTAL \
    OUTBOX_PENDING OUTBOX_PROCESSING OUTBOX_FAILED SOURCE_SHA PLAN_SHA DOMAIN_SHA \
    <<< "$DATABASE_STATE"
  [ "$QR_COUNT" -ge 103 ] || fail QR_COUNT_INVALID
  [ "$RECORD_COUNT" -ge 55 ] || fail RECORD_COUNT_INVALID
  [ "$IMPORT_PASS" = 1 ] || fail IMPORT_PASS_INVALID
  [ "$IMPORT_FAIL" = 0 ] || fail IMPORT_FAILURE_PRESENT
  [ "$SOURCE_SHA" = "$EXPECTED_SOURCE_SHA" ] || fail SOURCE_HASH_INVALID
  [ "$PLAN_SHA" = "$EXPECTED_PLAN_SHA" ] || fail PLAN_HASH_INVALID
  [ "$DOMAIN_SHA" = "$EXPECTED_DOMAIN_SHA" ] || fail DOMAIN_HASH_INVALID
  [ "$OUTBOX_PROCESSING" = 0 ] || fail OUTBOX_PROCESSING_UNEXPECTED
  [ "$OUTBOX_FAILED" = 0 ] || fail OUTBOX_FAILURE_PRESENT

  CYCLE_FINGERPRINT="$AUDIT_DIR/postgres-public-fingerprints-cycle-$CYCLE.json"
  /usr/local/bin/node scripts/database/capture-stable-cutover-public-fingerprints.js \
    --base-url=http://127.0.0.1:3000/ \
    --qr-id="$QR_ID" \
    --output="$CYCLE_FINGERPRINT"
  /usr/local/bin/node - "$BASELINE_FINGERPRINT" "$CYCLE_FINGERPRINT" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const baseline = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const current = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
assert.equal(baseline.status, 'PASS');
assert.equal(current.status, 'PASS');
assert.deepEqual(current.route_sha256, baseline.route_sha256);
assert.equal(current.combined_sha256, baseline.combined_sha256);
NODE

  [ -z "$REFERENCE_DATABASE_STATE" ] || \
    [ "$DATABASE_STATE" = "$REFERENCE_DATABASE_STATE" ] || \
    fail DATABASE_CHANGED_DURING_OBSERVATION
  REFERENCE_DATABASE_STATE="$DATABASE_STATE"
  echo "OBSERVATION_CYCLE_${CYCLE}=PASS"
  echo "OBSERVATION_CYCLE_${CYCLE}_APP_PID=$APP_PID"
  echo "OBSERVATION_CYCLE_${CYCLE}_OUTBOX=$OUTBOX_TOTAL|$OUTBOX_PENDING|$OUTBOX_PROCESSING|$OUTBOX_FAILED"
  if [ "$CYCLE" -lt "$OBSERVATION_CYCLES" ]; then
    sleep "$OBSERVATION_INTERVAL_SECONDS"
  fi
done

unset DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGPASSWORD_FILE PGDATABASE
unset PGSSL PGSSLMODE PGOPTIONS PGAPPLICATION_NAME

install -o root -g root -m 0600 /dev/null "$SUMMARY"
printf '%s\n' \
  'STABLE_CUTOVER_POST_COMMIT_OBSERVATION=PASS' \
  "OBSERVATION_CYCLE_COUNT=$OBSERVATION_CYCLES" \
  'PUBLIC_FINGERPRINT_PARITY=PASS' \
  'POSTGRES_AUTHORITY_BOUNDARY_COUNT=5' \
  'PM2_CONFIGURATION_VALIDATION=PASS' \
  'PM2_DATABASE_PASSWORD_PERSISTED=NO' \
  "OUTBOX_TOTAL=$OUTBOX_TOTAL" \
  "OUTBOX_PENDING=$OUTBOX_PENDING" \
  "OUTBOX_PROCESSING=$OUTBOX_PROCESSING" \
  "OUTBOX_FAILED=$OUTBOX_FAILED" \
  'RECORD_PROOF_RUNTIME_ENABLED=false' \
  'AVATA_CONFIGURATION_LOADED=NO' \
  'EXTERNAL_PROVIDER_CALLS=NONE' \
  'AUTHORITY_COMMIT_POINT_CROSSED=YES' \
  'JSON_FALLBACK_ALLOWED=NO' \
  "VALIDATED_HEAD=$EXPECTED_HEAD" \
  "VALIDATED_TREE=$EXPECTED_TREE" \
  "COMPLETED_AT_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  'NEXT_ACTION=BEGIN_STABLE_OBSERVATION_PERIOD' \
  > "$SUMMARY"

stat -c 'OWNER=%U:%G MODE=%a SIZE=%s PATH=%n' "$PM2_REPORT" "$SUMMARY"
echo 'STABLE_CUTOVER_POST_COMMIT_OBSERVATION=PASS'
echo "OBSERVATION_CYCLE_COUNT=$OBSERVATION_CYCLES"
echo 'PUBLIC_FINGERPRINT_PARITY=PASS'
echo 'POSTGRES_AUTHORITY_BOUNDARY_COUNT=5'
echo 'PM2_DATABASE_PASSWORD_PERSISTED=NO'
echo "OUTBOX_STATE=$OUTBOX_TOTAL|$OUTBOX_PENDING|$OUTBOX_PROCESSING|$OUTBOX_FAILED"
echo 'RECORD_PROOF_RUNTIME_ENABLED=false'
echo 'AVATA_CONFIGURATION_LOADED=NO'
echo 'AUTHORITY_COMMIT_POINT_CROSSED=YES'
echo 'JSON_FALLBACK_ALLOWED=NO'
echo 'NEXT_ACTION=BEGIN_STABLE_OBSERVATION_PERIOD'
