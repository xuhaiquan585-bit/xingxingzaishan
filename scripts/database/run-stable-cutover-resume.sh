#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

REPO=/www/wwwroot/xingxingzaishan
APP_NAME=xingxingzaishan
CANDIDATE_DB=xingxing_clean_baseline_20260812_staging
LEGACY_DB=xingxing_retry_20260803_staging
EXPECTED_SOURCE_SHA=fc13e36ec2d96c6e4411e602b65651b4b978f1f481276cbeef233aaf269a4dff
EXPECTED_PLAN_SHA=2eadabbe3a4d8144f6879a600e3a6e93f2290ed795aef05917ee198e61341a2c
EXPECTED_DOMAIN_SHA=f55db6acc5b6b3b9ca5d7b4b9357324b7a89a6eabc7cef3fcd8c4efd07bc454a
EXPECTED_DATABASE_STATE="103|55|1|0|0|$EXPECTED_SOURCE_SHA|$EXPECTED_PLAN_SHA|$EXPECTED_DOMAIN_SHA"
COMMIT_ROOT=/root/stable-cutover-commit-audit-20260813
PASSWORD_FILE=/etc/xingxingzaishan/postgresql-clean-baseline-20260812.password
PM2_DUMP=/root/.pm2/dump.pm2
LOCK_FILE=/run/lock/xingxingzaishan-stable-cutover-prewrite.lock
CONFIRMATION=RESUME_POSTGRES_AUTHORITY_COMMITTED_FORWARD_ONLY
QR_ID=A00001

fail() {
  echo "STABLE_CUTOVER_FORWARD_RESUME=BLOCKED_$1" >&2
  exit 1
}

assert_protected_file() {
  local file="$1"
  local mode="${2:-600}"
  [ -f "$file" ] && [ ! -L "$file" ] || return 1
  [ "$(stat -c '%U:%G' "$file")" = root:root ] || return 1
  [ "$(stat -c '%a' "$file")" = "$mode" ] || return 1
}

runtime_value() {
  local app_pid="$1"
  local key="$2"
  tr '\0' '\n' < "/proc/$app_pid/environ" |
    sed -n "s/^${key}=//p" |
    tail -n 1
}

wait_for_http() {
  local code=''
  for _attempt in $(seq 1 30); do
    code="$(curl -sS -o /dev/null -w '%{http_code}' \
      --connect-timeout 2 --max-time 3 \
      http://127.0.0.1:3000/ 2>/dev/null || true)"
    [ "$code" = 200 ] && {
      printf '%s\n' "$code"
      return 0
    }
    sleep 1
  done
  return 1
}

database_state() {
  /usr/pgsql-15/bin/psql -X -At -F '|' -v ON_ERROR_STOP=1 \
    -c "SELECT
          (SELECT count(*) FROM app.qr_codes),
          (SELECT count(*) FROM app.records),
          (SELECT count(*) FROM app.import_runs WHERE status = 'passed'),
          (SELECT count(*) FROM app.import_runs WHERE status <> 'passed'),
          (SELECT count(*) FROM app.outbox_jobs),
          (SELECT checksum_summary->>'source_sha256' FROM app.import_runs
            WHERE status = 'passed' ORDER BY completed_at DESC LIMIT 1),
          (SELECT checksum_summary->>'plan_sha256' FROM app.import_runs
            WHERE status = 'passed' ORDER BY completed_at DESC LIMIT 1),
          (SELECT checksum_summary->>'public_qr_v1_sha256' FROM app.import_runs
            WHERE status = 'passed' ORDER BY completed_at DESC LIMIT 1);"
}

database_state_with_password_file() {
  local password
  password="$(<"$PASSWORD_FILE")" || return 1
  PGPASSWORD="$password" database_state
}

postgres_control_query() {
  runuser -u postgres -- /usr/bin/env \
    -u DATABASE_URL \
    -u PGHOST \
    -u PGPORT \
    -u PGUSER \
    -u PGPASSWORD \
    -u PGPASSWORD_FILE \
    -u PGDATABASE \
    -u PGSSL \
    -u PGSSLMODE \
    -u PGOPTIONS \
    -u PGAPPLICATION_NAME \
    /usr/pgsql-15/bin/psql -X -At -d postgres "$@"
}

assert_postgres_runtime() {
  local app_pid="$1"
  local expected_freeze="$2"
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
  [ "$(runtime_value "$app_pid" PGPASSWORD_FILE)" = "$PASSWORD_FILE" ] || \
    return 1
  [ "$(runtime_value "$app_pid" POSTGRES_CUTOVER_WRITE_FREEZE_ENABLED)" = \
    "$expected_freeze" ] || return 1
  [ "$(runtime_value "$app_pid" RECORD_PROOF_RUNTIME_ENABLED)" = false ] || \
    return 1
  ! tr '\0' '\n' < "/proc/$app_pid/environ" |
    grep -Eq '^(DATABASE_URL|PGPASSWORD|AVATA_API_KEY|AVATA_API_SECRET)=.+$'
}

load_postgres_environment() {
  unset DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGPASSWORD_FILE PGDATABASE
  unset PGSSL PGSSLMODE PGOPTIONS PGAPPLICATION_NAME
  set -a
  . "$CANDIDATE_ENVIRONMENT"
  . "$SELECTOR_CONFIG"
  set +a
  export DATABASE_URL=''
  export PGPASSWORD=''
  export PGPASSWORD_FILE="$PASSWORD_FILE"
  export PUBLIC_QR_POSTGRES_READ_ALLOWLIST=''
  export PERSONAL_RECORD_POSTGRES_READ_ALLOWLIST=''
  export QR_LIFECYCLE_POSTGRES_WRITE_ALLOWLIST=''
  export IDENTITY_POSTGRES_AUTHORITY_ALLOWLIST=''
  export QR_ISSUANCE_POSTGRES_AUTHORITY_ALLOWLIST=''
  export RECORD_PROOF_RUNTIME_ENABLED=false
  export AVATA_API_KEY=''
  export AVATA_API_SECRET=''
  export AVATA_IDENTITY_NAME=''
  export AVATA_IDENTITY_NUM=''
  export AVATA_API_BASE=''
  export AVATA_ENV=''
  export CHAIN_ENABLED=false
  export CHAIN_CALLBACK_URL=''
}

validate_pm2_dump() {
  local freeze="$1"
  local output="$2"
  /usr/local/bin/node scripts/database/validate-stable-pm2-state.js \
    --dump="$PM2_DUMP" \
    --app="$APP_NAME" \
    --expected-password-file="$PASSWORD_FILE" \
    --expected-database="$CANDIDATE_DB" \
    --expected-authority=postgres \
    --expected-freeze="$freeze" \
    > "$output"
  chmod 0600 "$output"
}

persist_current_pm2() {
  pm2 save --force >/dev/null
  chmod 0600 "$PM2_DUMP"
  assert_protected_file "$PM2_DUMP"
}

update_state_phase() {
  local phase="$1"
  local state_temp="${STATE_FILE}.tmp.$$"
  awk -F= -v phase="$phase" '
    BEGIN { phase_seen = 0; point_seen = 0 }
    $1 == "PHASE" { print "PHASE=" phase; phase_seen = 1; next }
    $1 == "AUTHORITY_COMMIT_POINT_CROSSED" {
      print "AUTHORITY_COMMIT_POINT_CROSSED=YES"; point_seen = 1; next
    }
    { print }
    END {
      if (!phase_seen) print "PHASE=" phase
      if (!point_seen) print "AUTHORITY_COMMIT_POINT_CROSSED=YES"
    }
  ' "$STATE_FILE" > "$state_temp"
  printf '%s\n' "RESUMED_AT_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$state_temp"
  chmod 0600 "$state_temp"
  mv -f "$state_temp" "$STATE_FILE"
}

ensure_forward_freeze() {
  local failed=false app_pid
  load_postgres_environment
  export POSTGRES_CUTOVER_WRITE_FREEZE_ENABLED=true
  export PGAPPLICATION_NAME=xingxingzaishan-stable-committed-frozen
  pm2 restart "$APP_NAME" --update-env >/dev/null || failed=true
  app_pid="$(pm2 pid "$APP_NAME" | tail -n 1)"
  [ -n "$app_pid" ] && [ "$app_pid" != 0 ] || failed=true
  wait_for_http >/dev/null || failed=true
  assert_postgres_runtime "$app_pid" true || failed=true
  persist_current_pm2 || failed=true
  validate_pm2_dump true "$AUDIT_DIR/pm2-forward-frozen-validation.json" || \
    failed=true
  update_state_phase POSTGRES_AUTHORITY_COMMITTED_FROZEN || failed=true
  if [ "$failed" = true ]; then
    echo 'STABLE_CUTOVER_FORWARD_FREEZE=FAILED_OPERATOR_ACTION_REQUIRED' >&2
    return 1
  fi
  echo 'STABLE_CUTOVER_FORWARD_FREEZE=ENGAGED' >&2
}

RESUME_MODE=false
STATE_FILE=''
CONFIRM_VALUE=''
for ARG in "$@"; do
  case "$ARG" in
    --resume-forward) RESUME_MODE=true ;;
    --state=*) STATE_FILE="${ARG#--state=}" ;;
    --confirm=*) CONFIRM_VALUE="${ARG#--confirm=}" ;;
    *) fail ARGUMENT_INVALID ;;
  esac
done
[ "$#" -eq 3 ] || fail ARGUMENT_COUNT_INVALID
[ "$RESUME_MODE" = true ] || fail EXPLICIT_RESUME_MODE_REQUIRED
[ "$CONFIRM_VALUE" = "$CONFIRMATION" ] || fail EXPLICIT_CONFIRMATION_REQUIRED
[ "$(id -u)" -eq 0 ] || fail ROOT_REQUIRED
case "$STATE_FILE" in
  "$COMMIT_ROOT"/*/stable-commit-state.env) ;;
  *) fail STATE_PATH_INVALID ;;
esac
assert_protected_file "$STATE_FILE" || fail STATE_FILE_INVALID
if grep -Ev '^[A-Z][A-Z0-9_]*=[A-Za-z0-9_./:+-]+$' "$STATE_FILE" |
   grep -q .; then
  fail STATE_CONTENT_INVALID
fi

. "$STATE_FILE"
[ "${STATE_VERSION:-}" = 1 ] || fail STATE_VERSION_INVALID
[ "${PHASE:-}" = POSTGRES_AUTHORITY_COMMITTED_FROZEN ] || \
  fail STATE_PHASE_NOT_COMMITTED_FROZEN
[ "${AUTHORITY_COMMIT_POINT_CROSSED:-}" = YES ] || fail COMMIT_POINT_INVALID
[ "${APP_NAME:-}" = xingxingzaishan ] || fail APP_NAME_INVALID
[ "${CANDIDATE_DATABASE:-}" = "$CANDIDATE_DB" ] || fail DATABASE_INVALID
[ "${PASSWORD_FILE:-}" = \
  /etc/xingxingzaishan/postgresql-clean-baseline-20260812.password ] || \
  fail PASSWORD_FILE_INVALID
[[ "${EXPECTED_HEAD:-}" =~ ^[a-f0-9]{40}$ ]] || fail EXPECTED_HEAD_INVALID
[[ "${EXPECTED_TREE:-}" =~ ^[a-f0-9]{40}$ ]] || fail EXPECTED_TREE_INVALID

COMMIT_DIR="$(dirname "$STATE_FILE")"
AUDIT_DIR="$COMMIT_DIR/resume-$(date -u +%Y%m%dT%H%M%SZ)-$$"
BASELINE_FINGERPRINT="$COMMIT_DIR/json-public-fingerprints.json"
SUMMARY="$COMMIT_DIR/stable-commit-summary.txt"
RESUME_FINGERPRINT="$AUDIT_DIR/postgres-resumed-public-fingerprints.json"

for FILE in \
  "$CANDIDATE_ENVIRONMENT" \
  "$SELECTOR_CONFIG" \
  "$PASSWORD_FILE" \
  "$PM2_DUMP" \
  "$BASELINE_FINGERPRINT"
do
  assert_protected_file "$FILE" || fail DEPENDENCY_INVALID
done
[ "$(sha256sum "$CANDIDATE_ENVIRONMENT" | awk '{print $1}')" = \
  "$CANDIDATE_ENVIRONMENT_SHA256" ] || fail CANDIDATE_ENV_CHANGED
[ "$(sha256sum "$SELECTOR_CONFIG" | awk '{print $1}')" = \
  "$SELECTOR_CONFIG_SHA256" ] || fail SELECTOR_CONFIG_CHANGED
[ ! -e "$SUMMARY" ] || fail COMMIT_SUMMARY_ALREADY_EXISTS

for command in flock pm2 curl ss sha256sum runuser; do
  command -v "$command" >/dev/null 2>&1 || fail "${command^^}_REQUIRED"
done
command -v /usr/bin/env >/dev/null 2>&1 || fail ENV_REQUIRED
command -v /usr/pgsql-15/bin/psql >/dev/null 2>&1 || fail PSQL_REQUIRED
command -v /usr/local/bin/node >/dev/null 2>&1 || fail NODE_REQUIRED
exec 9>"$LOCK_FILE"
flock -n 9 || fail CUTOVER_OPERATION_ALREADY_RUNNING

cd "$REPO"
[ -z "$(git status --porcelain --untracked-files=no)" ] || \
  fail TRACKED_WORKTREE_DIRTY
[ "$(git rev-parse HEAD)" = "$EXPECTED_HEAD" ] || fail HEAD_CHANGED
[ "$(git rev-parse 'HEAD^{tree}')" = "$EXPECTED_TREE" ] || fail TREE_CHANGED

install -d -o root -g root -m 0700 "$AUDIT_DIR"
validate_pm2_dump true "$AUDIT_DIR/pm2-entry-frozen-validation.json"

APP_PID_FROZEN="$(pm2 pid "$APP_NAME" | tail -n 1)"
[ -n "$APP_PID_FROZEN" ] && [ "$APP_PID_FROZEN" != 0 ] || \
  fail FROZEN_PID_MISSING
[ "$(wait_for_http)" = 200 ] || fail FROZEN_HTTP_INVALID
assert_postgres_runtime "$APP_PID_FROZEN" true || fail FROZEN_RUNTIME_INVALID
if ! ss -tnp | grep ':5432' | grep -Fq "pid=$APP_PID_FROZEN,"; then
  fail FROZEN_POSTGRES_CONNECTION_MISSING
fi

load_postgres_environment
export PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=15000ms'
export PGAPPLICATION_NAME=xingxingzaishan-stable-forward-resume-entry
DATABASE_STATE_BEFORE="$(database_state_with_password_file)"
[ "$DATABASE_STATE_BEFORE" = "$EXPECTED_DATABASE_STATE" ] || \
  fail CANDIDATE_STATE_INVALID
unset PGOPTIONS PGAPPLICATION_NAME

LEGACY_CONNECTION_COUNT="$(
  postgres_control_query \
    -c "SELECT count(*) FROM pg_stat_activity
        WHERE datname = '$LEGACY_DB'
          AND application_name LIKE 'xingxingzaishan-stable%';"
)"
[ "$LEGACY_CONNECTION_COUNT" = 0 ] || fail LEGACY_DATABASE_SELECTED

RUNTIME_TOUCHED=false
cleanup_failure() {
  local exit_code=$?
  trap - EXIT
  if [ "$exit_code" -ne 0 ] && [ "$RUNTIME_TOUCHED" = true ]; then
    ensure_forward_freeze || true
  fi
  exit "$exit_code"
}
trap cleanup_failure EXIT

load_postgres_environment
export POSTGRES_CUTOVER_WRITE_FREEZE_ENABLED=false
export PGAPPLICATION_NAME=xingxingzaishan-stable
RUNTIME_TOUCHED=true
pm2 restart "$APP_NAME" --update-env
APP_PID_STABLE="$(pm2 pid "$APP_NAME" | tail -n 1)"
[ -n "$APP_PID_STABLE" ] && [ "$APP_PID_STABLE" != 0 ] || \
  fail STABLE_PID_MISSING
[ "$APP_PID_STABLE" != "$APP_PID_FROZEN" ] || fail STABLE_PID_NOT_REPLACED
[ "$(wait_for_http)" = 200 ] || fail STABLE_HTTP_INVALID
assert_postgres_runtime "$APP_PID_STABLE" false || fail STABLE_RUNTIME_INVALID

/usr/local/bin/node scripts/database/capture-stable-cutover-public-fingerprints.js \
  --base-url=http://127.0.0.1:3000/ \
  --qr-id="$QR_ID" \
  --output="$RESUME_FINGERPRINT"
/usr/local/bin/node - "$BASELINE_FINGERPRINT" "$RESUME_FINGERPRINT" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const baseline = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const resumed = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
assert.equal(baseline.status, 'PASS');
assert.equal(resumed.status, 'PASS');
assert.deepEqual(resumed.route_sha256, baseline.route_sha256);
assert.equal(resumed.combined_sha256, baseline.combined_sha256);
console.log('STABLE_CUTOVER_FORWARD_RESUME_PUBLIC_PARITY=PASS');
NODE

if ! ss -tnp | grep ':5432' | grep -Fq "pid=$APP_PID_STABLE,"; then
  fail STABLE_POSTGRES_CONNECTION_MISSING
fi
export PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=15000ms'
export PGAPPLICATION_NAME=xingxingzaishan-stable-forward-resume-final
DATABASE_STATE_AFTER="$(database_state_with_password_file)"
[ "$DATABASE_STATE_AFTER" = "$DATABASE_STATE_BEFORE" ] || \
  fail CANDIDATE_MUTATION_DETECTED_KEEP_POSTGRES_FROZEN
unset PGOPTIONS PGAPPLICATION_NAME

LEGACY_CONNECTION_COUNT="$(
  postgres_control_query \
    -c "SELECT count(*) FROM pg_stat_activity
        WHERE datname = '$LEGACY_DB'
          AND application_name LIKE 'xingxingzaishan-stable%';"
)"
[ "$LEGACY_CONNECTION_COUNT" = 0 ] || fail LEGACY_DATABASE_SELECTED

persist_current_pm2 || fail PM2_STABLE_SAVE_FAILED
validate_pm2_dump false "$AUDIT_DIR/pm2-stable-validation.json"
update_state_phase POSTGRES_AUTHORITY_COMMITTED

install -o root -g root -m 0600 /dev/null "$SUMMARY"
printf '%s\n' \
  'STABLE_CUTOVER_COMMIT=PASS' \
  'FINAL_STATE=POSTGRES_AUTHORITY_COMMITTED' \
  'FORWARD_RESUME_FROM_COMMITTED_FREEZE=PASS' \
  'POSTGRES_AUTHORITY_BOUNDARY_COUNT=5' \
  'POSTGRES_CUTOVER_WRITE_FREEZE_ENABLED=false' \
  'PUBLIC_FINGERPRINT_PARITY=PASS' \
  'CANDIDATE_DATABASE_MUTATION=NONE' \
  'LEGACY_DATABASE_SELECTED=NO' \
  'PM2_CONFIGURATION_SAVED=YES' \
  'PM2_DATABASE_PASSWORD_PERSISTED=NO' \
  "PM2_DATABASE_PASSWORD_FILE=$PASSWORD_FILE" \
  'RECORD_PROOF_RUNTIME_ENABLED=false' \
  'AVATA_CONFIGURATION_LOADED=NO' \
  'EXTERNAL_PROVIDER_CALLS=NONE' \
  'AUTHORITY_COMMIT_POINT_CROSSED=YES' \
  'JSON_FALLBACK_ALLOWED=NO' \
  "APP_PID_STABLE=$APP_PID_STABLE" \
  'APP_HTTP=200' \
  "VALIDATED_HEAD=$EXPECTED_HEAD" \
  "VALIDATED_TREE=$EXPECTED_TREE" \
  "COMMITTED_AT_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  'NEXT_ACTION=RUN_STABLE_POST_COMMIT_OBSERVATION' \
  > "$SUMMARY"

trap - EXIT
stat -c 'OWNER=%U:%G MODE=%a SIZE=%s PATH=%n' \
  "$STATE_FILE" "$SUMMARY" "$PASSWORD_FILE" "$PM2_DUMP" \
  "$AUDIT_DIR/pm2-stable-validation.json"
echo "APP_PID_FROZEN=$APP_PID_FROZEN"
echo "APP_PID_STABLE=$APP_PID_STABLE"
echo 'APP_HTTP=200'
echo 'STABLE_CUTOVER_FORWARD_RESUME=PASS'
echo 'STABLE_CUTOVER_COMMIT=PASS'
echo 'FINAL_STATE=POSTGRES_AUTHORITY_COMMITTED'
echo 'POSTGRES_AUTHORITY_BOUNDARY_COUNT=5'
echo 'POSTGRES_CUTOVER_WRITE_FREEZE_ENABLED=false'
echo 'PUBLIC_FINGERPRINT_PARITY=PASS'
echo 'CANDIDATE_DATABASE_MUTATION=NONE'
echo 'LEGACY_DATABASE_SELECTED=NO'
echo 'PM2_CONFIGURATION_SAVED=YES'
echo 'PM2_DATABASE_PASSWORD_PERSISTED=NO'
echo 'RECORD_PROOF_RUNTIME_ENABLED=false'
echo 'AVATA_CONFIGURATION_LOADED=NO'
echo 'AUTHORITY_COMMIT_POINT_CROSSED=YES'
echo 'JSON_FALLBACK_ALLOWED=NO'
echo 'NEXT_ACTION=RUN_STABLE_POST_COMMIT_OBSERVATION'
