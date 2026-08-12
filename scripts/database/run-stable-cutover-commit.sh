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
PLAN_ROOT=/root/stable-cutover-maintenance-prepare-audit-20260812
REHEARSAL_ROOT=/root/stable-cutover-prewrite-audit-20260812
AUDIT_ROOT=/root/stable-cutover-commit-audit-20260813
PASSWORD_FILE=/etc/xingxingzaishan/postgresql-clean-baseline-20260812.password
PM2_HOME_EXPECTED=/root/.pm2
LOCK_FILE=/run/lock/xingxingzaishan-stable-cutover-prewrite.lock
CONFIRMATION=COMMIT_POSTGRES_AUTHORITY_NO_JSON_FALLBACK
QR_ID=A00001

fail() {
  echo "STABLE_CUTOVER_COMMIT=BLOCKED_$1" >&2
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

public_domain_hash() {
  /usr/local/bin/node - "$1" <<'NODE'
const fs = require('node:fs');
const {
  publicQrDomainSha256FromSource
} = require('./scripts/database/importer/domain-markers');

const source = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.stdout.write(publicQrDomainSha256FromSource(source));
NODE
}

assert_json_runtime() {
  local app_pid="$1"
  local expected_freeze="${2:-false}"
  local flag value
  for flag in \
    PUBLIC_QR_POSTGRES_READ_ENABLED \
    PERSONAL_RECORD_POSTGRES_READ_ENABLED \
    QR_LIFECYCLE_POSTGRES_WRITE_ENABLED \
    IDENTITY_POSTGRES_AUTHORITY_ENABLED \
    QR_ISSUANCE_POSTGRES_AUTHORITY_ENABLED \
    RECORD_PROOF_RUNTIME_ENABLED
  do
    value="$(runtime_value "$app_pid" "$flag")"
    [ -z "$value" ] || [ "$value" = false ] || return 1
  done
  value="$(runtime_value "$app_pid" POSTGRES_CUTOVER_WRITE_FREEZE_ENABLED)"
  if [ "$expected_freeze" = true ]; then
    [ "$value" = true ] || return 1
  else
    [ -z "$value" ] || [ "$value" = false ] || return 1
  fi
  value="$(runtime_value "$app_pid" PGPASSWORD_FILE)"
  [ -z "$value" ] || return 1
  ! tr '\0' '\n' < "/proc/$app_pid/environ" |
    grep -Eq '^(DATABASE_URL|PGPASSWORD|AVATA_API_KEY|AVATA_API_SECRET)=.+$'
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
  [ "$(runtime_value "$app_pid" PGPASSWORD_FILE)" = "$PASSWORD_FILE" ] || return 1
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

load_json_environment() {
  export PUBLIC_QR_SHADOW_READ_ENABLED=false
  export PERSONAL_RECORD_SHADOW_READ_ENABLED=false
  export IDENTITY_SHADOW_READ_ENABLED=false
  export PUBLIC_QR_POSTGRES_READ_ENABLED=false
  export PERSONAL_RECORD_POSTGRES_READ_ENABLED=false
  export QR_LIFECYCLE_POSTGRES_WRITE_ENABLED=false
  export IDENTITY_POSTGRES_AUTHORITY_ENABLED=false
  export QR_ISSUANCE_POSTGRES_AUTHORITY_ENABLED=false
  export RECORD_PROOF_RUNTIME_ENABLED=false
  export PUBLIC_QR_POSTGRES_READ_SCOPE=''
  export PERSONAL_RECORD_POSTGRES_READ_SCOPE=''
  export QR_LIFECYCLE_POSTGRES_WRITE_SCOPE=''
  export IDENTITY_POSTGRES_AUTHORITY_SCOPE=''
  export QR_ISSUANCE_POSTGRES_AUTHORITY_SCOPE=''
  export PUBLIC_QR_POSTGRES_READ_ALLOWLIST=''
  export PERSONAL_RECORD_POSTGRES_READ_ALLOWLIST=''
  export QR_LIFECYCLE_POSTGRES_WRITE_ALLOWLIST=''
  export IDENTITY_POSTGRES_AUTHORITY_ALLOWLIST=''
  export QR_ISSUANCE_POSTGRES_AUTHORITY_ALLOWLIST=''
  export PUBLIC_QR_POSTGRES_READ_DOMAIN_SHA256=''
  export PERSONAL_RECORD_POSTGRES_READ_DOMAIN_SHA256=''
  export QR_LIFECYCLE_POSTGRES_WRITE_DOMAIN_SHA256=''
  export IDENTITY_POSTGRES_AUTHORITY_SOURCE_SHA256=''
  export IDENTITY_POSTGRES_AUTHORITY_DOMAIN_SHA256=''
  export QR_ISSUANCE_POSTGRES_AUTHORITY_SOURCE_SHA256=''
  export QR_ISSUANCE_POSTGRES_AUTHORITY_DOMAIN_SHA256=''
  export POSTGRES_AUTHORITY_BASELINE_DOMAIN_SHA256=''
  export DATABASE_URL=''
  export PGHOST=''
  export PGPORT=''
  export PGUSER=''
  export PGPASSWORD=''
  export PGPASSWORD_FILE=''
  export PGDATABASE=''
  export PGSSL=''
  export PGAPPLICATION_NAME=''
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
  local authority="$1"
  local freeze="$2"
  local output="$3"
  /usr/local/bin/node scripts/database/validate-stable-pm2-state.js \
    --dump="$PM2_DUMP" \
    --app="$APP_NAME" \
    --expected-password-file="$PASSWORD_FILE" \
    --expected-database="$CANDIDATE_DB" \
    --expected-authority="$authority" \
    --expected-freeze="$freeze" \
    > "$output"
  chmod 0600 "$output"
}

write_state() {
  local phase="$1"
  local commit_point="$2"
  local state_temp="${STATE_FILE}.tmp.$$"
  cat > "$state_temp" <<EOF
STATE_VERSION=1
PHASE=$phase
AUTHORITY_COMMIT_POINT_CROSSED=$commit_point
APP_NAME=$APP_NAME
PLAN_FILE=$PLAN_FILE
PLAN_FILE_SHA256=$PLAN_FILE_SHA256
REHEARSAL_SUMMARY=$REHEARSAL_SUMMARY
REHEARSAL_SUMMARY_SHA256=$REHEARSAL_SUMMARY_SHA256
EXPECTED_HEAD=$EXPECTED_HEAD
EXPECTED_TREE=$EXPECTED_TREE
EXPECTED_JSON_SHA256=$EXPECTED_JSON_SHA
EXPECTED_BASELINE_DOMAIN_SHA256=$EXPECTED_BASELINE_DOMAIN_SHA256
CANDIDATE_DATABASE=$CANDIDATE_DB
CANDIDATE_ENVIRONMENT=$CANDIDATE_ENVIRONMENT
CANDIDATE_ENVIRONMENT_SHA256=$CANDIDATE_ENVIRONMENT_SHA256
SELECTOR_CONFIG=$SELECTOR_CONFIG
SELECTOR_CONFIG_SHA256=$SELECTOR_CONFIG_SHA256
PASSWORD_FILE=$PASSWORD_FILE
UPDATED_AT_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
  chmod 0600 "$state_temp"
  mv -f "$state_temp" "$STATE_FILE"
}

persist_current_pm2() {
  pm2 save --force >/dev/null
  assert_protected_file "$PM2_DUMP" || return 1
}

freeze_postgres_forward_only() {
  local failed=false
  load_postgres_environment
  export POSTGRES_CUTOVER_WRITE_FREEZE_ENABLED=true
  export PGAPPLICATION_NAME=xingxingzaishan-stable-committed-frozen
  pm2 restart "$APP_NAME" --update-env >/dev/null || failed=true
  local app_pid
  app_pid="$(pm2 pid "$APP_NAME" | tail -n 1)"
  [ -n "$app_pid" ] && [ "$app_pid" != 0 ] || failed=true
  wait_for_http >/dev/null || failed=true
  assert_postgres_runtime "$app_pid" true || failed=true
  persist_current_pm2 || failed=true
  validate_pm2_dump postgres true \
    "$AUDIT_DIR/pm2-committed-frozen-validation.json" || failed=true
  write_state POSTGRES_AUTHORITY_COMMITTED_FROZEN YES || failed=true
  if [ "$failed" = true ]; then
    echo 'STABLE_CUTOVER_FORWARD_FREEZE=FAILED_OPERATOR_ACTION_REQUIRED' >&2
    return 1
  fi
  echo 'STABLE_CUTOVER_FORWARD_FREEZE=ENGAGED' >&2
}

restore_json_before_commit() {
  load_json_environment
  export POSTGRES_CUTOVER_WRITE_FREEZE_ENABLED=true
  pm2 restart "$APP_NAME" --update-env >/dev/null || return 1
  local frozen_pid final_pid frozen_code
  frozen_pid="$(pm2 pid "$APP_NAME" | tail -n 1)"
  [ -n "$frozen_pid" ] && [ "$frozen_pid" != 0 ] || return 1
  wait_for_http >/dev/null || return 1
  assert_json_runtime "$frozen_pid" true || return 1
  frozen_code="$(curl -sS -o "$AUDIT_DIR/precommit-rollback-freeze.json" \
    -w '%{http_code}' -H 'Content-Type: application/json' --data '{}' \
    --connect-timeout 5 --max-time 10 \
    http://127.0.0.1:3000/api/user/login 2>/dev/null)" || return 1
  chmod 0600 "$AUDIT_DIR/precommit-rollback-freeze.json" 2>/dev/null || true
  [ "$frozen_code" = 503 ] || return 1
  grep -Fq 'POSTGRES_CUTOVER_WRITE_FROZEN' \
    "$AUDIT_DIR/precommit-rollback-freeze.json" || return 1
  export POSTGRES_CUTOVER_WRITE_FREEZE_ENABLED=false
  pm2 restart "$APP_NAME" --update-env >/dev/null || return 1
  final_pid="$(pm2 pid "$APP_NAME" | tail -n 1)"
  [ -n "$final_pid" ] && [ "$final_pid" != 0 ] || return 1
  wait_for_http >/dev/null || return 1
  assert_json_runtime "$final_pid" || return 1
  if ss -tnp | grep ':5432' | grep -Fq "pid=$final_pid,"; then
    return 1
  fi
  persist_current_pm2 || return 1
  validate_pm2_dump json false \
    "$AUDIT_DIR/pm2-json-rollback-validation.json" || return 1
  rm -f -- "$PASSWORD_FILE"
  [ ! -e "$PASSWORD_FILE" ] || return 1
  write_state JSON_AUTHORITY_ABORTED NO || return 1
  echo 'STABLE_CUTOVER_PRECOMMIT_ROLLBACK=PASS' >&2
}

COMMIT_MODE=false
PLAN_FILE=''
REHEARSAL_SUMMARY=''
CONFIRM_VALUE=''
for ARG in "$@"; do
  case "$ARG" in
    --commit-stable) COMMIT_MODE=true ;;
    --plan=*) PLAN_FILE="${ARG#--plan=}" ;;
    --rehearsal-summary=*) REHEARSAL_SUMMARY="${ARG#--rehearsal-summary=}" ;;
    --confirm=*) CONFIRM_VALUE="${ARG#--confirm=}" ;;
    *) fail ARGUMENT_INVALID ;;
  esac
done
[ "$#" -eq 4 ] || fail ARGUMENT_COUNT_INVALID
[ "$COMMIT_MODE" = true ] || fail EXPLICIT_COMMIT_MODE_REQUIRED
[ "$CONFIRM_VALUE" = "$CONFIRMATION" ] || fail EXPLICIT_CONFIRMATION_REQUIRED
[ "$(id -u)" -eq 0 ] || fail ROOT_REQUIRED
case "$PLAN_FILE" in
  "$PLAN_ROOT"/*/prewrite-plan.env) ;;
  *) fail PLAN_PATH_INVALID ;;
esac
case "$REHEARSAL_SUMMARY" in
  "$REHEARSAL_ROOT"/*/auto-off-summary.txt) ;;
  *) fail REHEARSAL_PATH_INVALID ;;
esac
assert_protected_file "$PLAN_FILE" || fail PLAN_FILE_INVALID
assert_protected_file "$REHEARSAL_SUMMARY" || fail REHEARSAL_SUMMARY_INVALID
for FILE in "$PLAN_FILE" "$REHEARSAL_SUMMARY"; do
  if grep -Ev '^[A-Z][A-Z0-9_]*=[A-Za-z0-9_./:+-]+$' "$FILE" |
     grep -q .; then
    fail EVIDENCE_CONTENT_INVALID
  fi
done

PLAN_FILE_SHA256="$(sha256sum "$PLAN_FILE" | awk '{print $1}')"
REHEARSAL_SUMMARY_SHA256="$(sha256sum "$REHEARSAL_SUMMARY" | awk '{print $1}')"
. "$PLAN_FILE"
[ "${PLAN_VERSION:-}" = 2 ] || fail PLAN_VERSION_INVALID
[ "${START_STATE:-}" = JSON_AUTHORITY ] || fail PLAN_START_STATE_INVALID
[ "${TARGET_STATE:-}" = POSTGRES_AUTHORITY_PREWRITE ] || fail PLAN_TARGET_INVALID
[ "${EXPECTED_JSON_SHA256:-}" = "$EXPECTED_JSON_SHA" ] || fail PLAN_JSON_INVALID
[ "${EXPECTED_SOURCE_SHA256:-}" = "$EXPECTED_SOURCE_SHA" ] || fail PLAN_SOURCE_INVALID
[ "${EXPECTED_PLAN_SHA256:-}" = "$EXPECTED_PLAN_SHA" ] || fail PLAN_HASH_INVALID
[ "${EXPECTED_DOMAIN_SHA256:-}" = "$EXPECTED_DOMAIN_SHA" ] || fail PLAN_DOMAIN_INVALID
[[ "${EXPECTED_BASELINE_DOMAIN_SHA256:-}" =~ ^[a-f0-9]{64}$ ]] || \
  fail PLAN_BASELINE_DOMAIN_INVALID
[ "${CANDIDATE_DATABASE:-}" = "$CANDIDATE_DB" ] || fail PLAN_DATABASE_INVALID

grep -qx 'STABLE_CUTOVER_PREWRITE_AUTO_OFF=PASS' "$REHEARSAL_SUMMARY" || \
  fail REHEARSAL_RESULT_INVALID
grep -qx 'FINAL_STATE=JSON_AUTHORITY' "$REHEARSAL_SUMMARY" || \
  fail REHEARSAL_FINAL_STATE_INVALID
grep -qx 'CANDIDATE_DATABASE_MUTATION=NONE' "$REHEARSAL_SUMMARY" || \
  fail REHEARSAL_MUTATION_INVALID
grep -qx 'AUTHORITY_COMMIT_POINT_CROSSED=NO' "$REHEARSAL_SUMMARY" || \
  fail REHEARSAL_COMMIT_POINT_INVALID
REHEARSAL_STATE="$(dirname "$REHEARSAL_SUMMARY")/prewrite-state.env"
assert_protected_file "$REHEARSAL_STATE" || fail REHEARSAL_STATE_INVALID
grep -qx 'PHASE=JSON_AUTHORITY_ABORTED' "$REHEARSAL_STATE" || \
  fail REHEARSAL_STATE_PHASE_INVALID
grep -qx "PLAN_FILE=$PLAN_FILE" "$REHEARSAL_STATE" || \
  fail REHEARSAL_PLAN_MISMATCH
grep -qx "PLAN_FILE_SHA256=$PLAN_FILE_SHA256" "$REHEARSAL_STATE" || \
  fail REHEARSAL_PLAN_HASH_MISMATCH

for command in flock pm2 curl systemctl ss sha256sum; do
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
[ "$(public_domain_hash src/server/data/db.json)" = \
  "$EXPECTED_BASELINE_DOMAIN_SHA256" ] || fail LIVE_BASELINE_DOMAIN_CHANGED

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
[ "$(sha256sum "$SELECTOR_CONFIG" | awk '{print $1}')" = \
  "$SELECTOR_CONFIG_SHA256" ] || fail SELECTOR_CONFIG_CHANGED
[ "$(sha256sum "$CANDIDATE_ENVIRONMENT" | awk '{print $1}')" = \
  "$CANDIDATE_ENVIRONMENT_SHA256" ] || fail CANDIDATE_ENV_CHANGED

/usr/local/bin/node scripts/database/validate-stable-cutover-config.js \
  --config="$SELECTOR_CONFIG" \
  --expected-source-sha256="$EXPECTED_SOURCE_SHA" \
  --expected-domain-sha256="$EXPECTED_DOMAIN_SHA" \
  --expected-baseline-domain-sha256="$EXPECTED_BASELINE_DOMAIN_SHA256" \
  >/dev/null

APP_PID_BEFORE="$(pm2 pid "$APP_NAME" | tail -n 1)"
[ -n "$APP_PID_BEFORE" ] && [ "$APP_PID_BEFORE" != 0 ] || fail APP_PID_MISSING
assert_json_runtime "$APP_PID_BEFORE" || fail RUNTIME_NOT_JSON_AUTHORITY
[ "$(wait_for_http)" = 200 ] || fail APP_HTTP_INVALID
if ss -tnp | grep ':5432' | grep -Fq "pid=$APP_PID_BEFORE,"; then
  fail INITIAL_POSTGRES_CONNECTION_PRESENT
fi
ACTIVE_TIMER_COUNT="$(
  systemctl list-units --type=timer --state=active --no-legend --no-pager |
    grep -c 'xingxingzaishan-stable-cutover-prewrite-auto-off-' || true
)"
[ "$ACTIVE_TIMER_COUNT" = 0 ] || fail AUTO_OFF_TIMER_ACTIVE

[ "${PM2_HOME:-$PM2_HOME_EXPECTED}" = "$PM2_HOME_EXPECTED" ] || \
  fail PM2_HOME_INVALID
PM2_DUMP="$PM2_HOME_EXPECTED/dump.pm2"
assert_protected_file "$PM2_DUMP" || fail PM2_DUMP_INVALID
[ ! -e "$PASSWORD_FILE" ] || fail STABLE_PASSWORD_FILE_ALREADY_EXISTS

unset DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGPASSWORD_FILE PGDATABASE
unset PGSSL PGSSLMODE PGOPTIONS PGAPPLICATION_NAME
set -a
. "$CANDIDATE_ENVIRONMENT"
set +a
[ "$PGDATABASE" = "$CANDIDATE_DB" ] || fail CANDIDATE_ENV_DATABASE_INVALID
[ -n "${PGPASSWORD:-}" ] || fail CANDIDATE_PASSWORD_MISSING
DATABASE_PASSWORD="$PGPASSWORD"
export PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=15000ms'
export PGAPPLICATION_NAME=xingxingzaishan-stable-commit-entry-gate
DATABASE_STATE_BEFORE="$(database_state)"
[ "$DATABASE_STATE_BEFORE" = "$EXPECTED_DATABASE_STATE" ] || \
  fail CANDIDATE_STATE_INVALID
unset DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGPASSWORD_FILE PGDATABASE
unset PGSSL PGSSLMODE PGOPTIONS PGAPPLICATION_NAME

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
AUDIT_DIR="$AUDIT_ROOT/$RUN_ID"
STATE_FILE="$AUDIT_DIR/stable-commit-state.env"
SUMMARY="$AUDIT_DIR/stable-commit-summary.txt"
JSON_FINGERPRINT="$AUDIT_DIR/json-public-fingerprints.json"
FROZEN_FINGERPRINT="$AUDIT_DIR/postgres-frozen-public-fingerprints.json"
STABLE_FINGERPRINT="$AUDIT_DIR/postgres-stable-public-fingerprints.json"

install -d -o root -g root -m 0700 "$AUDIT_ROOT" "$AUDIT_DIR"
install -o root -g root -m 0600 "$PM2_DUMP" "$AUDIT_DIR/pm2-before.dump.json"
validate_pm2_dump json false "$AUDIT_DIR/pm2-before-validation.json"
/usr/local/bin/node scripts/database/capture-stable-cutover-public-fingerprints.js \
  --base-url=http://127.0.0.1:3000/ \
  --qr-id="$QR_ID" \
  --output="$JSON_FINGERPRINT"
write_state STABLE_COMMIT_PREPARING NO

RUNTIME_TOUCHED=false
COMMIT_POINT_CROSSED=false
cleanup_failure() {
  local exit_code=$?
  trap - EXIT
  if [ "$exit_code" -ne 0 ] && [ "$RUNTIME_TOUCHED" = true ]; then
    if [ "$COMMIT_POINT_CROSSED" = true ]; then
      freeze_postgres_forward_only
    else
      set +e
      unset DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGPASSWORD_FILE PGDATABASE
      unset PGSSL PGSSLMODE PGOPTIONS PGAPPLICATION_NAME
      set -a
      . "$CANDIDATE_ENVIRONMENT"
      set +a
      export PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=15000ms'
      export PGAPPLICATION_NAME=xingxingzaishan-stable-precommit-rollback-gate
      local current_state
      current_state="$(database_state 2>/dev/null || echo UNKNOWN)"
      unset DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGPASSWORD_FILE PGDATABASE
      unset PGSSL PGSSLMODE PGOPTIONS PGAPPLICATION_NAME
      set -e
      if [ "$current_state" = "$DATABASE_STATE_BEFORE" ]; then
        if ! restore_json_before_commit; then
          echo 'STABLE_CUTOVER_PRECOMMIT_ROLLBACK=FAILED' >&2
          freeze_postgres_forward_only || true
        fi
      else
        freeze_postgres_forward_only || true
      fi
    fi
  elif [ "$exit_code" -ne 0 ]; then
    rm -f -- "$PASSWORD_FILE"
  fi
  exit "$exit_code"
}
trap cleanup_failure EXIT

install -o root -g root -m 0600 /dev/null "$PASSWORD_FILE"
printf '%s' "$DATABASE_PASSWORD" > "$PASSWORD_FILE"
unset DATABASE_PASSWORD
assert_protected_file "$PASSWORD_FILE" || fail STABLE_PASSWORD_FILE_INVALID

load_postgres_environment
export POSTGRES_CUTOVER_WRITE_FREEZE_ENABLED=true
export PGAPPLICATION_NAME=xingxingzaishan-stable-commit-frozen
RUNTIME_TOUCHED=true
pm2 restart "$APP_NAME" --update-env
APP_PID_FROZEN="$(pm2 pid "$APP_NAME" | tail -n 1)"
[ -n "$APP_PID_FROZEN" ] && [ "$APP_PID_FROZEN" != 0 ] || \
  fail FROZEN_PID_MISSING
[ "$APP_PID_FROZEN" != "$APP_PID_BEFORE" ] || fail FROZEN_PID_NOT_REPLACED
[ "$(wait_for_http)" = 200 ] || fail FROZEN_HTTP_INVALID
assert_postgres_runtime "$APP_PID_FROZEN" true || fail FROZEN_RUNTIME_INVALID

FREEZE_CODE="$(curl -sS -o "$AUDIT_DIR/frozen-write-response.json" \
  -w '%{http_code}' -H 'Content-Type: application/json' --data '{}' \
  --connect-timeout 5 --max-time 10 \
  http://127.0.0.1:3000/api/user/login)"
chmod 0600 "$AUDIT_DIR/frozen-write-response.json"
[ "$FREEZE_CODE" = 503 ] || fail FROZEN_WRITE_NOT_BLOCKED
grep -Fq 'POSTGRES_CUTOVER_WRITE_FROZEN' \
  "$AUDIT_DIR/frozen-write-response.json" || fail FROZEN_RESPONSE_INVALID

/usr/local/bin/node scripts/database/capture-stable-cutover-public-fingerprints.js \
  --base-url=http://127.0.0.1:3000/ \
  --qr-id="$QR_ID" \
  --output="$FROZEN_FINGERPRINT"
/usr/local/bin/node - "$JSON_FINGERPRINT" "$FROZEN_FINGERPRINT" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const baseline = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const candidate = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
assert.equal(baseline.status, 'PASS');
assert.equal(candidate.status, 'PASS');
assert.deepEqual(candidate.route_sha256, baseline.route_sha256);
assert.equal(candidate.combined_sha256, baseline.combined_sha256);
console.log('STABLE_CUTOVER_COMMIT_FROZEN_PUBLIC_PARITY=PASS');
NODE

export PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=15000ms'
export PGAPPLICATION_NAME=xingxingzaishan-stable-commit-post-freeze-gate
DATABASE_STATE_FROZEN="$(database_state_with_password_file)"
[ "$DATABASE_STATE_FROZEN" = "$DATABASE_STATE_BEFORE" ] || \
  fail CANDIDATE_MUTATION_DETECTED_KEEP_POSTGRES_FROZEN
unset PGOPTIONS PGAPPLICATION_NAME
if ! ss -tnp | grep ':5432' | grep -Fq "pid=$APP_PID_FROZEN,"; then
  fail FROZEN_POSTGRES_CONNECTION_MISSING
fi

persist_current_pm2 || fail PM2_FROZEN_SAVE_FAILED
validate_pm2_dump postgres true "$AUDIT_DIR/pm2-frozen-validation.json"

COMMIT_POINT_CROSSED=true
write_state POSTGRES_AUTHORITY_COMMITTING YES

export POSTGRES_CUTOVER_WRITE_FREEZE_ENABLED=false
export PGAPPLICATION_NAME=xingxingzaishan-stable
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
  --output="$STABLE_FINGERPRINT"
/usr/local/bin/node - "$JSON_FINGERPRINT" "$STABLE_FINGERPRINT" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const baseline = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const stable = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
assert.equal(baseline.status, 'PASS');
assert.equal(stable.status, 'PASS');
assert.deepEqual(stable.route_sha256, baseline.route_sha256);
assert.equal(stable.combined_sha256, baseline.combined_sha256);
console.log('STABLE_CUTOVER_COMMIT_PUBLIC_PARITY=PASS');
NODE

if ! ss -tnp | grep ':5432' | grep -Fq "pid=$APP_PID_STABLE,"; then
  fail STABLE_POSTGRES_CONNECTION_MISSING
fi
export PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=15000ms'
export PGAPPLICATION_NAME=xingxingzaishan-stable-commit-final-gate
DATABASE_STATE_STABLE="$(database_state_with_password_file)"
[ "$DATABASE_STATE_STABLE" = "$DATABASE_STATE_BEFORE" ] || \
  fail CANDIDATE_MUTATION_DETECTED_KEEP_POSTGRES_FROZEN
unset PGOPTIONS PGAPPLICATION_NAME
LEGACY_CONNECTION_COUNT="$(
  runuser -u postgres -- /usr/pgsql-15/bin/psql -X -At -d postgres \
    -c "SELECT count(*) FROM pg_stat_activity
        WHERE datname = '$LEGACY_DB'
          AND application_name = 'xingxingzaishan-stable';"
)"
[ "$LEGACY_CONNECTION_COUNT" = 0 ] || fail LEGACY_DATABASE_SELECTED

persist_current_pm2 || fail PM2_STABLE_SAVE_FAILED
validate_pm2_dump postgres false "$AUDIT_DIR/pm2-stable-validation.json"
write_state POSTGRES_AUTHORITY_COMMITTED YES

install -o root -g root -m 0600 /dev/null "$SUMMARY"
printf '%s\n' \
  'STABLE_CUTOVER_COMMIT=PASS' \
  'FINAL_STATE=POSTGRES_AUTHORITY_COMMITTED' \
  'POSTGRES_AUTHORITY_BOUNDARY_COUNT=5' \
  'POSTGRES_CUTOVER_WRITE_FREEZE_ENABLED=false' \
  'PUBLIC_FINGERPRINT_PARITY=PASS' \
  'CANDIDATE_DATABASE_MUTATION=NONE' \
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
  "$STATE_FILE" "$SUMMARY" "$PASSWORD_FILE" \
  "$AUDIT_DIR/pm2-stable-validation.json"
echo "APP_PID_BEFORE=$APP_PID_BEFORE"
echo "APP_PID_FROZEN=$APP_PID_FROZEN"
echo "APP_PID_STABLE=$APP_PID_STABLE"
echo 'APP_HTTP=200'
echo 'STABLE_CUTOVER_COMMIT=PASS'
echo 'FINAL_STATE=POSTGRES_AUTHORITY_COMMITTED'
echo 'POSTGRES_AUTHORITY_BOUNDARY_COUNT=5'
echo 'POSTGRES_CUTOVER_WRITE_FREEZE_ENABLED=false'
echo 'PUBLIC_FINGERPRINT_PARITY=PASS'
echo 'CANDIDATE_DATABASE_MUTATION=NONE'
echo 'PM2_CONFIGURATION_SAVED=YES'
echo 'PM2_DATABASE_PASSWORD_PERSISTED=NO'
echo 'RECORD_PROOF_RUNTIME_ENABLED=false'
echo 'AVATA_CONFIGURATION_LOADED=NO'
echo 'AUTHORITY_COMMIT_POINT_CROSSED=YES'
echo 'JSON_FALLBACK_ALLOWED=NO'
echo 'NEXT_ACTION=RUN_STABLE_POST_COMMIT_OBSERVATION'
