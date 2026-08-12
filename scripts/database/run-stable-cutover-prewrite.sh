#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

REPO=/www/wwwroot/xingxingzaishan
APP_NAME=xingxingzaishan
CANDIDATE_DB=xingxing_clean_baseline_20260812_staging
LEGACY_DB=xingxing_retry_20260803_staging
EXPECTED_JSON_SHA=f263df13b5c19f91b0f86d93960f6b26896f3ed605318c73dd8546d110b06cfd
EXPECTED_SOURCE_SHA=fc13e36ec2d96c6e4411e602b65651b4b978f1f481276cbeef233aaf269a4dff
EXPECTED_PLAN_SHA=2eadabbe3a4d8144f6879a600e3a6e93f2290ed795aef05917ee198e61341a2c
EXPECTED_DOMAIN_SHA=f55db6acc5b6b3b9ca5d7b4b9357324b7a89a6eabc7cef3fcd8c4efd07bc454a
EXPECTED_DATABASE_STATE="103|55|1|0|0|$EXPECTED_SOURCE_SHA|$EXPECTED_PLAN_SHA|$EXPECTED_DOMAIN_SHA"
EXPECTED_DATABASE_STATE_SHA256=a008023f72166318a1b147d636908008e90ab5352971212539cb485b0be7f6f0
PLAN_ROOT=/root/stable-cutover-maintenance-prepare-audit-20260812
AUDIT_ROOT=/root/stable-cutover-prewrite-audit-20260812
LOCK_FILE=/run/lock/xingxingzaishan-stable-cutover-prewrite.lock
CONFIRMATION=ENTER_POSTGRES_AUTHORITY_PREWRITE_WITH_AUTO_OFF
QR_ID=A00001

fail() {
  echo "STABLE_CUTOVER_PREWRITE=BLOCKED_$1" >&2
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

assert_default_off() {
  local app_pid="$1"
  local flag value
  for flag in \
    PUBLIC_QR_SHADOW_READ_ENABLED \
    PERSONAL_RECORD_SHADOW_READ_ENABLED \
    IDENTITY_SHADOW_READ_ENABLED \
    PUBLIC_QR_POSTGRES_READ_ENABLED \
    PERSONAL_RECORD_POSTGRES_READ_ENABLED \
    QR_LIFECYCLE_POSTGRES_WRITE_ENABLED \
    RECORD_PROOF_RUNTIME_ENABLED \
    IDENTITY_POSTGRES_AUTHORITY_ENABLED \
    QR_ISSUANCE_POSTGRES_AUTHORITY_ENABLED
  do
    value="$(runtime_value "$app_pid" "$flag")"
    [ -z "$value" ] || [ "$value" = false ] || return 1
  done
  value="$(runtime_value "$app_pid" POSTGRES_CUTOVER_WRITE_FREEZE_ENABLED)"
  [ -z "$value" ] || [ "$value" = false ] || return 1
  ! tr '\0' '\n' < "/proc/$app_pid/environ" |
    grep -Eq '^(DATABASE_URL|PGPASSWORD|AVATA_API_KEY|AVATA_API_SECRET)=.+$'
}

wait_for_http() {
  local code=''
  for _attempt in $(seq 1 20); do
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

ENTER_MODE=false
PLAN_FILE=''
CONFIRM_VALUE=''
for ARG in "$@"; do
  case "$ARG" in
    --enter-prewrite) ENTER_MODE=true ;;
    --plan=*) PLAN_FILE="${ARG#--plan=}" ;;
    --confirm=*) CONFIRM_VALUE="${ARG#--confirm=}" ;;
    *) fail ARGUMENT_INVALID ;;
  esac
done
[ "$#" -eq 3 ] || fail ARGUMENT_COUNT_INVALID
[ "$ENTER_MODE" = true ] || fail EXPLICIT_PREWRITE_MODE_REQUIRED
[ "$CONFIRM_VALUE" = "$CONFIRMATION" ] || fail EXPLICIT_CONFIRMATION_REQUIRED
[ "$(id -u)" -eq 0 ] || fail ROOT_REQUIRED
case "$PLAN_FILE" in
  "$PLAN_ROOT"/*/prewrite-plan.env) ;;
  *) fail PLAN_PATH_INVALID ;;
esac
assert_protected_file "$PLAN_FILE" || fail PLAN_FILE_INVALID
if grep -Ev '^[A-Z][A-Z0-9_]*=[A-Za-z0-9_./:+-]+$' "$PLAN_FILE" |
   grep -q .; then
  fail PLAN_CONTENT_INVALID
fi

# The read-only preparation runner writes only validated key/value assignments.
. "$PLAN_FILE"
[ "${PLAN_VERSION:-}" = 1 ] || fail PLAN_VERSION_INVALID
[ "${START_STATE:-}" = JSON_AUTHORITY ] || fail PLAN_START_STATE_INVALID
[ "${TARGET_STATE:-}" = POSTGRES_AUTHORITY_PREWRITE ] || fail PLAN_TARGET_STATE_INVALID
[ "${EXPECTED_JSON_SHA256:-}" = "$EXPECTED_JSON_SHA" ] || fail PLAN_JSON_INVALID
[ "${EXPECTED_SOURCE_SHA256:-}" = "$EXPECTED_SOURCE_SHA" ] || fail PLAN_SOURCE_INVALID
[ "${EXPECTED_PLAN_SHA256:-}" = "$EXPECTED_PLAN_SHA" ] || fail PLAN_HASH_INVALID
[ "${EXPECTED_DOMAIN_SHA256:-}" = "$EXPECTED_DOMAIN_SHA" ] || fail PLAN_DOMAIN_INVALID
[ "${CANDIDATE_DATABASE:-}" = "$CANDIDATE_DB" ] || fail PLAN_DATABASE_INVALID

for command in flock pm2 curl systemd-run systemctl ss sha256sum; do
  command -v "$command" >/dev/null 2>&1 || fail "${command^^}_REQUIRED"
done
command -v /usr/pgsql-15/bin/psql >/dev/null 2>&1 || fail PSQL_REQUIRED
command -v /usr/local/bin/node >/dev/null 2>&1 || fail NODE_REQUIRED
exec 9>"$LOCK_FILE"
flock -n 9 || fail CUTOVER_OPERATION_ALREADY_RUNNING

cd "$REPO"
[ -z "$(git status --porcelain --untracked-files=no)" ] || fail TRACKED_WORKTREE_DIRTY
[ "$(git rev-parse HEAD)" = "$EXPECTED_HEAD" ] || fail HEAD_CHANGED
[ "$(git rev-parse 'HEAD^{tree}')" = "$EXPECTED_TREE" ] || fail TREE_CHANGED
[ "$(sha256sum src/server/data/db.json | awk '{print $1}')" = \
  "$EXPECTED_JSON_SHA" ] || fail LIVE_JSON_CHANGED

for FILE in \
  "$PREFLIGHT_SUMMARY" \
  "$JOINT_SUMMARY" \
  "$DATABASE_BACKUP" \
  "$JSON_AUTHORITY_BACKUP" \
  "$SELECTOR_CONFIG" \
  "$CANDIDATE_ENVIRONMENT"
do
  assert_protected_file "$FILE" || fail PLAN_DEPENDENCY_INVALID
done
[ "$(sha256sum "$PREFLIGHT_SUMMARY" | awk '{print $1}')" = \
  "$PREFLIGHT_SUMMARY_SHA256" ] || fail PREFLIGHT_SUMMARY_CHANGED
[ "$(sha256sum "$JOINT_SUMMARY" | awk '{print $1}')" = \
  "$JOINT_SUMMARY_SHA256" ] || fail JOINT_SUMMARY_CHANGED
[ "$(sha256sum "$DATABASE_BACKUP" | awk '{print $1}')" = \
  "$DATABASE_BACKUP_SHA256" ] || fail DATABASE_BACKUP_CHANGED
[ "$(sha256sum "$JSON_AUTHORITY_BACKUP" | awk '{print $1}')" = \
  "$JSON_AUTHORITY_BACKUP_SHA256" ] || fail JSON_BACKUP_CHANGED
[ "$JSON_AUTHORITY_BACKUP_SHA256" = "$EXPECTED_JSON_SHA" ] || \
  fail JSON_BACKUP_SOURCE_INVALID
[ "$(sha256sum "$SELECTOR_CONFIG" | awk '{print $1}')" = \
  "$SELECTOR_CONFIG_SHA256" ] || fail SELECTOR_CONFIG_CHANGED
grep -qx "PGDATABASE=$CANDIDATE_DB" "$CANDIDATE_ENVIRONMENT" || \
  fail CANDIDATE_ENV_DATABASE_INVALID
[ "$(sha256sum "$CANDIDATE_ENVIRONMENT" | awk '{print $1}')" = \
  "$CANDIDATE_ENVIRONMENT_SHA256" ] || fail CANDIDATE_ENV_CHANGED

/usr/local/bin/node scripts/database/validate-stable-cutover-config.js \
  --config="$SELECTOR_CONFIG" \
  --expected-source-sha256="$EXPECTED_SOURCE_SHA" \
  --expected-domain-sha256="$EXPECTED_DOMAIN_SHA" \
  >/dev/null

APP_PID_BEFORE="$(pm2 pid "$APP_NAME" | tail -n 1)"
[ -n "$APP_PID_BEFORE" ] && [ "$APP_PID_BEFORE" != 0 ] || fail APP_PID_MISSING
assert_default_off "$APP_PID_BEFORE" || fail RUNTIME_NOT_JSON_AUTHORITY
[ "$(wait_for_http)" = 200 ] || fail APP_HTTP_INVALID
if ss -tnp | grep ':5432' | grep -Fq "pid=$APP_PID_BEFORE,"; then
  fail PREWRITE_POSTGRES_CONNECTION_PRESENT
fi
ACTIVE_TIMER_COUNT="$(
  systemctl list-units --type=timer --state=active --no-legend --no-pager |
    grep -c 'xingxingzaishan-stable-cutover-prewrite-auto-off-' || true
)"
[ "$ACTIVE_TIMER_COUNT" = 0 ] || fail AUTO_OFF_TIMER_ALREADY_ACTIVE

unset DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE
unset PGSSL PGSSLMODE PGOPTIONS PGAPPLICATION_NAME
set -a
. "$CANDIDATE_ENVIRONMENT"
set +a
[ "$PGDATABASE" = "$CANDIDATE_DB" ] || fail CANDIDATE_ENV_DATABASE_MISMATCH
export PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=15000ms'
export PGAPPLICATION_NAME=xingxingzaishan-prewrite-entry-gate
DATABASE_STATE_BEFORE="$(database_state)"
[ "$DATABASE_STATE_BEFORE" = "$EXPECTED_DATABASE_STATE" ] || \
  fail CANDIDATE_STATE_INVALID
unset DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE
unset PGSSL PGSSLMODE PGOPTIONS PGAPPLICATION_NAME

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
AUDIT_DIR="$AUDIT_ROOT/$RUN_ID"
STATE_FILE="$AUDIT_DIR/prewrite-state.env"
BASELINE_FINGERPRINT="$AUDIT_DIR/json-public-fingerprints.json"
CANDIDATE_FINGERPRINT="$AUDIT_DIR/postgres-public-fingerprints.json"
AUTO_OFF_SCRIPT="$AUDIT_DIR/prewrite-auto-off.sh"
FREEZE_RESPONSE="$AUDIT_DIR/prewrite-freeze-response.json"
SUMMARY="$AUDIT_DIR/prewrite-summary.txt"
AUTO_OFF_UNIT="xingxingzaishan-stable-cutover-prewrite-auto-off-$RUN_ID"

install -d -o root -g root -m 0700 "$AUDIT_ROOT" "$AUDIT_DIR"
install -o root -g root -m 0700 \
  scripts/database/run-stable-cutover-prewrite-auto-off.sh \
  "$AUTO_OFF_SCRIPT"
/usr/local/bin/node scripts/database/capture-stable-cutover-public-fingerprints.js \
  --base-url=http://127.0.0.1:3000/ \
  --qr-id="$QR_ID" \
  --output="$BASELINE_FINGERPRINT"

cat > "$STATE_FILE" <<EOF
STATE_VERSION=1
PHASE=POSTGRES_AUTHORITY_PREWRITE
AUTHORITY_COMMIT_POINT_CROSSED=NO
APP_NAME=$APP_NAME
PLAN_FILE=$PLAN_FILE
PLAN_FILE_SHA256=$(sha256sum "$PLAN_FILE" | awk '{print $1}')
EXPECTED_HEAD=$EXPECTED_HEAD
EXPECTED_TREE=$EXPECTED_TREE
EXPECTED_JSON_SHA256=$EXPECTED_JSON_SHA
CANDIDATE_DATABASE=$CANDIDATE_DB
CANDIDATE_ENVIRONMENT=$CANDIDATE_ENVIRONMENT
CANDIDATE_ENVIRONMENT_SHA256=$CANDIDATE_ENVIRONMENT_SHA256
EXPECTED_DATABASE_STATE_SHA256=$EXPECTED_DATABASE_STATE_SHA256
AUTO_OFF_UNIT=$AUTO_OFF_UNIT
AUTO_OFF_SCRIPT_SHA256=$(sha256sum "$AUTO_OFF_SCRIPT" | awk '{print $1}')
BASELINE_FINGERPRINT_SHA256=$(sha256sum "$BASELINE_FINGERPRINT" | awk '{print $1}')
ENTERED_AT_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
chmod 0600 "$STATE_FILE"

AUTO_OFF_ARMED=false
cleanup_failure() {
  local exit_code=$?
  trap - EXIT
  if [ "$exit_code" -ne 0 ] && [ "$AUTO_OFF_ARMED" = true ]; then
    systemctl stop "${AUTO_OFF_UNIT}.timer" >/dev/null 2>&1 || true
    flock -u 9 || true
    "$AUTO_OFF_SCRIPT" --state="$STATE_FILE" --automatic=false || true
  fi
  exit "$exit_code"
}
trap cleanup_failure EXIT

systemd-run \
  --unit="$AUTO_OFF_UNIT" \
  --on-active=15m \
  "$AUTO_OFF_SCRIPT" \
  --state="$STATE_FILE" \
  --automatic=true
AUTO_OFF_ARMED=true
[ "$(systemctl is-active "${AUTO_OFF_UNIT}.timer")" = active ] || \
  fail AUTO_OFF_TIMER_NOT_ACTIVE

unset DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE
unset PGSSL PGSSLMODE PGOPTIONS PGAPPLICATION_NAME
set -a
. "$CANDIDATE_ENVIRONMENT"
. "$SELECTOR_CONFIG"
set +a
export POSTGRES_CUTOVER_WRITE_FREEZE_ENABLED=true
export RECORD_PROOF_RUNTIME_ENABLED=false
export PUBLIC_QR_POSTGRES_READ_ALLOWLIST=''
export PERSONAL_RECORD_POSTGRES_READ_ALLOWLIST=''
export QR_LIFECYCLE_POSTGRES_WRITE_ALLOWLIST=''
export IDENTITY_POSTGRES_AUTHORITY_ALLOWLIST=''
export QR_ISSUANCE_POSTGRES_AUTHORITY_ALLOWLIST=''
export PGAPPLICATION_NAME=xingxingzaishan-stable-prewrite
export AVATA_API_KEY=''
export AVATA_API_SECRET=''
export AVATA_IDENTITY_NAME=''
export AVATA_IDENTITY_NUM=''
export AVATA_API_BASE=''
export AVATA_ENV=''
export CHAIN_ENABLED=false
export CHAIN_CALLBACK_URL=''

pm2 restart "$APP_NAME" --update-env
APP_PID_PREWRITE="$(pm2 pid "$APP_NAME" | tail -n 1)"
[ -n "$APP_PID_PREWRITE" ] && [ "$APP_PID_PREWRITE" != 0 ] || \
  fail PREWRITE_PID_MISSING
[ "$APP_PID_PREWRITE" != "$APP_PID_BEFORE" ] || fail PREWRITE_PID_NOT_REPLACED
[ "$(wait_for_http)" = 200 ] || fail PREWRITE_HTTP_INVALID

for FLAG in \
  PUBLIC_QR_POSTGRES_READ_ENABLED \
  PERSONAL_RECORD_POSTGRES_READ_ENABLED \
  QR_LIFECYCLE_POSTGRES_WRITE_ENABLED \
  IDENTITY_POSTGRES_AUTHORITY_ENABLED \
  QR_ISSUANCE_POSTGRES_AUTHORITY_ENABLED
do
  [ "$(runtime_value "$APP_PID_PREWRITE" "$FLAG")" = true ] || \
    fail PREWRITE_BOUNDARY_NOT_ACTIVE
done
for FLAG in \
  PUBLIC_QR_POSTGRES_READ_SCOPE \
  PERSONAL_RECORD_POSTGRES_READ_SCOPE \
  QR_LIFECYCLE_POSTGRES_WRITE_SCOPE \
  IDENTITY_POSTGRES_AUTHORITY_SCOPE \
  QR_ISSUANCE_POSTGRES_AUTHORITY_SCOPE
do
  [ "$(runtime_value "$APP_PID_PREWRITE" "$FLAG")" = all ] || \
    fail PREWRITE_SCOPE_NOT_ALL
done
for FLAG in \
  PUBLIC_QR_POSTGRES_READ_DOMAIN_SHA256 \
  PERSONAL_RECORD_POSTGRES_READ_DOMAIN_SHA256 \
  QR_LIFECYCLE_POSTGRES_WRITE_DOMAIN_SHA256 \
  IDENTITY_POSTGRES_AUTHORITY_DOMAIN_SHA256 \
  QR_ISSUANCE_POSTGRES_AUTHORITY_DOMAIN_SHA256
do
  [ "$(runtime_value "$APP_PID_PREWRITE" "$FLAG")" = "$EXPECTED_DOMAIN_SHA" ] || \
    fail PREWRITE_DOMAIN_HASH_INVALID
done
for FLAG in \
  IDENTITY_POSTGRES_AUTHORITY_SOURCE_SHA256 \
  QR_ISSUANCE_POSTGRES_AUTHORITY_SOURCE_SHA256
do
  [ "$(runtime_value "$APP_PID_PREWRITE" "$FLAG")" = "$EXPECTED_SOURCE_SHA" ] || \
    fail PREWRITE_SOURCE_HASH_INVALID
done
[ "$(runtime_value "$APP_PID_PREWRITE" PGDATABASE)" = "$CANDIDATE_DB" ] || \
  fail PREWRITE_DATABASE_NOT_CANDIDATE
[ "$(runtime_value "$APP_PID_PREWRITE" POSTGRES_CUTOVER_WRITE_FREEZE_ENABLED)" = \
  true ] || fail PREWRITE_FREEZE_NOT_ACTIVE
[ "$(runtime_value "$APP_PID_PREWRITE" RECORD_PROOF_RUNTIME_ENABLED)" = false ] || \
  fail PREWRITE_PROOF_RUNTIME_NOT_OFF
tr '\0' '\n' < "/proc/$APP_PID_PREWRITE/environ" |
  grep -Eq '^PGPASSWORD=.+$' || fail PREWRITE_DATABASE_SECRET_MISSING
if tr '\0' '\n' < "/proc/$APP_PID_PREWRITE/environ" |
   grep -Eq '^(AVATA_API_KEY|AVATA_API_SECRET)=.+$'; then
  fail PREWRITE_PROVIDER_SECRET_PRESENT
fi

FREEZE_POST_CODE="$(curl -sS -o "$FREEZE_RESPONSE" -w '%{http_code}' \
  -H 'Content-Type: application/json' --data '{}' \
  --connect-timeout 5 --max-time 10 \
  http://127.0.0.1:3000/api/user/login)"
chmod 0600 "$FREEZE_RESPONSE"
[ "$FREEZE_POST_CODE" = 503 ] || fail PREWRITE_MUTATION_NOT_FROZEN
grep -Fq 'POSTGRES_CUTOVER_WRITE_FROZEN' "$FREEZE_RESPONSE" || \
  fail PREWRITE_FREEZE_RESPONSE_INVALID

/usr/local/bin/node scripts/database/capture-stable-cutover-public-fingerprints.js \
  --base-url=http://127.0.0.1:3000/ \
  --qr-id="$QR_ID" \
  --output="$CANDIDATE_FINGERPRINT"
/usr/local/bin/node - "$BASELINE_FINGERPRINT" "$CANDIDATE_FINGERPRINT" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const baseline = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const candidate = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
assert.equal(baseline.status, 'PASS');
assert.equal(candidate.status, 'PASS');
assert.equal(baseline.raw_dto_persisted, false);
assert.equal(candidate.raw_dto_persisted, false);
assert.deepEqual(candidate.route_sha256, baseline.route_sha256);
assert.equal(candidate.combined_sha256, baseline.combined_sha256);
console.log('STABLE_CUTOVER_PREWRITE_PUBLIC_PARITY=PASS');
NODE

export PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=15000ms'
export PGAPPLICATION_NAME=xingxingzaishan-prewrite-post-validation
DATABASE_STATE_AFTER="$(database_state)"
[ "$DATABASE_STATE_AFTER" = "$DATABASE_STATE_BEFORE" ] || \
  fail CANDIDATE_MUTATION_DETECTED_KEEP_POSTGRES_FROZEN
unset PGOPTIONS PGAPPLICATION_NAME
LEGACY_CONNECTION_COUNT="$(
  runuser -u postgres -- /usr/pgsql-15/bin/psql -X -At -d postgres \
    -c "SELECT count(*) FROM pg_stat_activity
        WHERE datname = '$LEGACY_DB'
          AND application_name = 'xingxingzaishan-stable-prewrite';"
)"
[ "$LEGACY_CONNECTION_COUNT" = 0 ] || fail LEGACY_DATABASE_SELECTED
if ! ss -tnp | grep ':5432' | grep -Fq "pid=$APP_PID_PREWRITE,"; then
  fail PREWRITE_POSTGRES_CONNECTION_MISSING
fi
[ "$(systemctl is-active "${AUTO_OFF_UNIT}.timer")" = active ] || \
  fail AUTO_OFF_TIMER_NOT_ACTIVE_AFTER_VALIDATION

STATE_TEMP="${STATE_FILE}.tmp.$$"
cat "$STATE_FILE" > "$STATE_TEMP"
printf '%s\n' \
  "PREWRITE_APP_PID=$APP_PID_PREWRITE" \
  "CANDIDATE_FINGERPRINT_SHA256=$(sha256sum "$CANDIDATE_FINGERPRINT" | awk '{print $1}')" \
  "PREWRITE_VALIDATED_AT_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  >> "$STATE_TEMP"
chmod 0600 "$STATE_TEMP"
mv -f "$STATE_TEMP" "$STATE_FILE"

install -o root -g root -m 0600 /dev/null "$SUMMARY"
printf '%s\n' \
  'STABLE_CUTOVER_PREWRITE_ENTRY=PASS' \
  'CURRENT_STATE=POSTGRES_AUTHORITY_PREWRITE' \
  'POSTGRES_CUTOVER_WRITE_FREEZE_ENABLED=true' \
  'POSTGRES_AUTHORITY_BOUNDARY_COUNT=5' \
  'PUBLIC_FINGERPRINT_PARITY=PASS' \
  'CANDIDATE_DATABASE_MUTATION=NONE' \
  'RECORD_PROOF_RUNTIME_ENABLED=false' \
  'AVATA_CONFIGURATION_LOADED=NO' \
  'EXTERNAL_PROVIDER_CALLS=NONE' \
  'PM2_CONFIGURATION_SAVED=NO' \
  'AUTHORITY_COMMIT_POINT_CROSSED=NO' \
  "APP_PID_BEFORE=$APP_PID_BEFORE" \
  "APP_PID_PREWRITE=$APP_PID_PREWRITE" \
  "AUTO_OFF_UNIT=$AUTO_OFF_UNIT" \
  "STATE_FILE_SHA256=$(sha256sum "$STATE_FILE" | awk '{print $1}')" \
  "COMPLETED_AT_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  'NEXT_ACTION=RUN_MANUAL_AUTO_OFF_REHEARSAL' \
  > "$SUMMARY"

AUTO_OFF_ARMED=false
trap - EXIT
stat -c 'OWNER=%U:%G MODE=%a SIZE=%s PATH=%n' \
  "$STATE_FILE" "$BASELINE_FINGERPRINT" "$CANDIDATE_FINGERPRINT" \
  "$AUTO_OFF_SCRIPT" "$SUMMARY"
echo "APP_PID_BEFORE=$APP_PID_BEFORE"
echo "APP_PID_PREWRITE=$APP_PID_PREWRITE"
echo "APP_HTTP=200"
echo "AUTO_OFF_UNIT=$AUTO_OFF_UNIT"
echo 'AUTO_OFF_DELAY=15_MINUTES'
echo 'STABLE_CUTOVER_PREWRITE_ENTRY=PASS'
echo 'CURRENT_STATE=POSTGRES_AUTHORITY_PREWRITE'
echo 'POSTGRES_CUTOVER_WRITE_FREEZE_ENABLED=true'
echo 'POSTGRES_AUTHORITY_BOUNDARY_COUNT=5'
echo 'PUBLIC_FINGERPRINT_PARITY=PASS'
echo 'CANDIDATE_DATABASE_MUTATION=NONE'
echo 'RECORD_PROOF_RUNTIME_ENABLED=false'
echo 'AVATA_CONFIGURATION_LOADED=NO'
echo 'PM2_CONFIGURATION_SAVED=NO'
echo 'AUTHORITY_COMMIT_POINT_CROSSED=NO'
echo 'NEXT_ACTION=RUN_MANUAL_AUTO_OFF_REHEARSAL'
