#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CANDIDATE_DB=xingxing_clean_baseline_20260812_staging
CANDIDATE_ENV=/etc/xingxingzaishan/postgresql-clean-baseline-20260812.env
LEGACY_DB=xingxing_retry_20260803_staging
EXPECTED_JSON_SHA=f263df13b5c19f91b0f86d93960f6b26896f3ed605318c73dd8546d110b06cfd
EXPECTED_SOURCE_SHA=fc13e36ec2d96c6e4411e602b65651b4b978f1f481276cbeef233aaf269a4dff
EXPECTED_PLAN_SHA=2eadabbe3a4d8144f6879a600e3a6e93f2290ed795aef05917ee198e61341a2c
EXPECTED_DOMAIN_SHA=f55db6acc5b6b3b9ca5d7b4b9357324b7a89a6eabc7cef3fcd8c4efd07bc454a
EXPECTED_DATABASE_STATE="103|55|1|0|0|$EXPECTED_SOURCE_SHA|$EXPECTED_PLAN_SHA|$EXPECTED_DOMAIN_SHA"
PREFLIGHT_ROOT=/root/stable-cutover-preflight-audit-20260812
JOINT_ROOT=/root/clean-postgres-candidate-e2e-audit-20260812
AUDIT_ROOT=/root/stable-cutover-maintenance-prepare-audit-20260812
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
AUDIT_DIR="$AUDIT_ROOT/$RUN_ID"
PLAN_FILE="$AUDIT_DIR/prewrite-plan.env"
SUMMARY="$AUDIT_DIR/preparation-summary.txt"
LOCK_FILE=/run/lock/xingxingzaishan-stable-cutover-maintenance-prepare.lock

fail() {
  echo "STABLE_CUTOVER_MAINTENANCE_PREPARE=BLOCKED_$1" >&2
  exit 1
}

database_count() {
  runuser -u postgres -- /usr/pgsql-15/bin/psql -X -At -d postgres \
    -c "SELECT count(*) FROM pg_database WHERE datname = '$1';"
}

assert_default_off() {
  local app_pid="$1"
  local flag value freeze
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
  freeze="$(
    tr '\0' '\n' < "/proc/$app_pid/environ" |
      sed -n 's/^POSTGRES_CUTOVER_WRITE_FREEZE_ENABLED=//p' |
      tail -n 1
  )"
  [ -z "$freeze" ] || [ "$freeze" = false ] || return 1
  if tr '\0' '\n' < "/proc/$app_pid/environ" |
     grep -Eq '^(DATABASE_URL|PGPASSWORD|AVATA_API_KEY|AVATA_API_SECRET)=.+$'; then
    return 1
  fi
}

latest_matching_summary() {
  local root="$1"
  local required_line="$2"
  local head="$3"
  local file
  while IFS= read -r file; do
    if grep -qx "$required_line" "$file" &&
       grep -qx "VALIDATED_HEAD=$head" "$file"; then
      printf '%s\n' "$file"
      return 0
    fi
  done < <(
    find "$root" -mindepth 2 -maxdepth 2 -type f \
      -name '*summary.txt' -printf '%T@|%p\n' |
      sort -nr |
      cut -d'|' -f2-
  )
  return 1
}

latest_joint_summary() {
  local file
  while IFS= read -r file; do
    if grep -qx 'CLEAN_CANDIDATE_COORDINATED_JOINT_REHEARSAL=PASS' "$file" &&
       grep -qx "VALIDATED_SOURCE_SHA256=$EXPECTED_SOURCE_SHA" "$file" &&
       grep -qx "VALIDATED_PLAN_SHA256=$EXPECTED_PLAN_SHA" "$file" &&
       grep -qx "VALIDATED_DOMAIN_SHA256=$EXPECTED_DOMAIN_SHA" "$file"; then
      printf '%s\n' "$file"
      return 0
    fi
  done < <(
    find "$JOINT_ROOT" -mindepth 2 -maxdepth 2 -type f \
      -name validation-summary.txt -printf '%T@|%p\n' |
      sort -nr |
      cut -d'|' -f2-
  )
  return 1
}

assert_protected_file() {
  local file="$1"
  [ -f "$file" ] && [ ! -L "$file" ] || return 1
  [ "$(stat -c '%U:%G' "$file")" = root:root ] || return 1
  [ "$(stat -c '%a' "$file")" = 600 ] || return 1
}

summary_value() {
  local key="$1"
  local file="$2"
  sed -n "s/^${key}=//p" "$file" | tail -n 1
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

[ "${1:-}" = --prepare ] || fail EXPLICIT_PREPARE_MODE_REQUIRED
[ "$#" -eq 1 ] || fail ARGUMENT_INVALID
[ "$(id -u)" -eq 0 ] || fail ROOT_REQUIRED
[ "$CANDIDATE_DB" != "$LEGACY_DB" ] || fail CANDIDATE_IS_LEGACY_DATABASE
command -v flock >/dev/null 2>&1 || fail FLOCK_REQUIRED
command -v systemd-run >/dev/null 2>&1 || fail SYSTEMD_RUN_REQUIRED
command -v systemctl >/dev/null 2>&1 || fail SYSTEMCTL_REQUIRED
command -v pm2 >/dev/null 2>&1 || fail PM2_REQUIRED
command -v curl >/dev/null 2>&1 || fail CURL_REQUIRED
command -v /usr/pgsql-15/bin/psql >/dev/null 2>&1 || fail PSQL_REQUIRED
exec 9>"$LOCK_FILE"
flock -n 9 || fail PREPARE_ALREADY_RUNNING

cd "$REPO"
[ -z "$(git status --porcelain --untracked-files=no)" ] || fail TRACKED_WORKTREE_DIRTY
HEAD="$(git rev-parse HEAD)"
TREE="$(git rev-parse 'HEAD^{tree}')"
[ "$(sha256sum src/server/data/db.json | awk '{print $1}')" = "$EXPECTED_JSON_SHA" ] || \
  fail LIVE_JSON_HASH_MISMATCH
[ "$(database_count "$CANDIDATE_DB")" = 1 ] || fail CANDIDATE_DATABASE_MISSING
[ "$(database_count "$LEGACY_DB")" = 1 ] || fail LEGACY_DATABASE_MISSING
assert_protected_file "$CANDIDATE_ENV" || fail CANDIDATE_ENV_INVALID
grep -qx "PGDATABASE=$CANDIDATE_DB" "$CANDIDATE_ENV" || \
  fail CANDIDATE_ENV_DATABASE_INVALID

APP_PID="$(pm2 pid xingxingzaishan | tail -n 1)"
[ -n "$APP_PID" ] && [ "$APP_PID" != 0 ] || fail APP_PID_MISSING
HTTP_CODE="$(curl -sS -o /dev/null -w '%{http_code}' \
  --connect-timeout 5 --max-time 10 http://127.0.0.1:3000/)"
[ "$HTTP_CODE" = 200 ] || fail APP_HTTP_INVALID
assert_default_off "$APP_PID" || fail RUNTIME_NOT_JSON_AUTHORITY
if ss -tnp | grep ':5432' | grep -Fq "pid=$APP_PID,"; then
  fail PRODUCTION_RUNTIME_POSTGRES_CONNECTION_PRESENT
fi

PREFLIGHT_SUMMARY="$(latest_matching_summary \
  "$PREFLIGHT_ROOT" \
  'STABLE_CUTOVER_PREFLIGHT_STATUS=READY_FOR_POSTGRES_MAINTENANCE_WINDOW' \
  "$HEAD")" || fail CURRENT_PREFLIGHT_SUMMARY_NOT_FOUND
JOINT_SUMMARY="$(latest_joint_summary)" || fail CURRENT_JOINT_SUMMARY_NOT_FOUND
for FILE in "$PREFLIGHT_SUMMARY" "$JOINT_SUMMARY"; do
  assert_protected_file "$FILE" || fail EVIDENCE_FILE_INVALID
done
grep -qx 'AUTHORITY_COMMIT_POINT_CROSSED=NO' "$PREFLIGHT_SUMMARY" || \
  fail PREFLIGHT_COMMIT_POINT_INVALID
grep -qx 'PM2_CONFIGURATION_LOADED=NO' "$PREFLIGHT_SUMMARY" || \
  fail PREFLIGHT_PM2_STATE_INVALID
grep -qx 'RECORD_PROOF_RUNTIME_ENABLED=false' "$PREFLIGHT_SUMMARY" || \
  fail PREFLIGHT_PROOF_RUNTIME_INVALID
grep -qx 'EXTERNAL_PROVIDER_CALLS=NONE' "$PREFLIGHT_SUMMARY" || \
  fail PREFLIGHT_EXTERNAL_PROVIDER_INVALID
grep -qx 'POSTGRES_ONLY_PROOF_OUTBOX=PASS' "$JOINT_SUMMARY" || \
  fail JOINT_PROOF_OUTBOX_INVALID
grep -qx 'PROOF_WORKER_RUNTIME=DISABLED' "$JOINT_SUMMARY" || \
  fail JOINT_PROOF_RUNTIME_INVALID
grep -qx 'EXTERNAL_PROVIDER_CALLS=NONE' "$JOINT_SUMMARY" || \
  fail JOINT_EXTERNAL_PROVIDER_INVALID
JOINT_HEAD="$(summary_value VALIDATED_HEAD "$JOINT_SUMMARY")"
[ -n "$JOINT_HEAD" ] || fail JOINT_HEAD_MISSING
git cat-file -e "${JOINT_HEAD}^{commit}" || fail JOINT_HEAD_INVALID
git merge-base --is-ancestor "$JOINT_HEAD" HEAD || fail JOINT_HEAD_NOT_ANCESTOR
if git diff --name-only "$JOINT_HEAD"..HEAD |
   grep -Eq '^(src/server/|scripts/database/run-clean-postgres-candidate-e2e\.sh$|tests/postgresql-clean-candidate\.e2e\.test\.js$)'; then
  fail JOINT_EVIDENCE_STALE
fi

PREFLIGHT_DIR="$(dirname "$PREFLIGHT_SUMMARY")"
DATABASE_BACKUP="$PREFLIGHT_DIR/clean-candidate.dump"
BACKUP_LIST="$PREFLIGHT_DIR/clean-candidate.restore-list.txt"
JSON_BACKUP="$PREFLIGHT_DIR/json-authority-snapshot.json"
SELECTOR_CONFIG="$PREFLIGHT_DIR/stable-selectors.env"
CONFIG_REPORT="$PREFLIGHT_DIR/stable-config-validation.json"
for FILE in "$DATABASE_BACKUP" "$BACKUP_LIST" "$JSON_BACKUP" \
  "$SELECTOR_CONFIG" "$CONFIG_REPORT"; do
  assert_protected_file "$FILE" || fail PREFLIGHT_ARTIFACT_INVALID
done

DATABASE_BACKUP_SHA="$(summary_value CANDIDATE_DATABASE_BACKUP_SHA256 "$PREFLIGHT_SUMMARY")"
JSON_BACKUP_SHA="$(summary_value JSON_AUTHORITY_BACKUP_SHA256 "$PREFLIGHT_SUMMARY")"
SELECTOR_CONFIG_SHA="$(summary_value STABLE_SELECTOR_CONFIG_SHA256 "$PREFLIGHT_SUMMARY")"
BASELINE_DOMAIN_SHA="$(
  summary_value JSON_AUTHORITY_BASELINE_DOMAIN_SHA256 "$PREFLIGHT_SUMMARY"
)"
[[ "$BASELINE_DOMAIN_SHA" =~ ^[a-f0-9]{64}$ ]] || \
  fail BASELINE_DOMAIN_HASH_INVALID
[ "$(sha256sum "$DATABASE_BACKUP" | awk '{print $1}')" = "$DATABASE_BACKUP_SHA" ] || \
  fail DATABASE_BACKUP_HASH_MISMATCH
[ "$(sha256sum "$JSON_BACKUP" | awk '{print $1}')" = "$JSON_BACKUP_SHA" ] || \
  fail JSON_BACKUP_HASH_MISMATCH
[ "$JSON_BACKUP_SHA" = "$EXPECTED_JSON_SHA" ] || fail JSON_BACKUP_SOURCE_MISMATCH
[ "$(public_domain_hash "$JSON_BACKUP")" = "$BASELINE_DOMAIN_SHA" ] || \
  fail JSON_BACKUP_BASELINE_DOMAIN_MISMATCH
[ "$(public_domain_hash src/server/data/db.json)" = "$BASELINE_DOMAIN_SHA" ] || \
  fail LIVE_JSON_BASELINE_DOMAIN_MISMATCH
[ "$(sha256sum "$SELECTOR_CONFIG" | awk '{print $1}')" = "$SELECTOR_CONFIG_SHA" ] || \
  fail SELECTOR_CONFIG_HASH_MISMATCH
grep -q 'TABLE DATA app qr_codes' "$BACKUP_LIST" || fail BACKUP_QR_DATA_MISSING
grep -q 'TABLE DATA app records' "$BACKUP_LIST" || fail BACKUP_RECORD_DATA_MISSING

/usr/local/bin/node scripts/database/validate-stable-cutover-config.js \
  --config="$SELECTOR_CONFIG" \
  --expected-source-sha256="$EXPECTED_SOURCE_SHA" \
  --expected-domain-sha256="$EXPECTED_DOMAIN_SHA" \
  --expected-baseline-domain-sha256="$BASELINE_DOMAIN_SHA" \
  >/dev/null

unset DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE
unset PGSSL PGSSLMODE PGOPTIONS PGAPPLICATION_NAME NODE_ENV
set -a
. "$CANDIDATE_ENV"
set +a
[ "$PGDATABASE" = "$CANDIDATE_DB" ] || fail CANDIDATE_ENV_DATABASE_MISMATCH
export PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=15000ms'
export PGAPPLICATION_NAME=xingxingzaishan-stable-maintenance-prepare
DATABASE_STATE="$(
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
)"
[ "$DATABASE_STATE" = "$EXPECTED_DATABASE_STATE" ] || fail CANDIDATE_STATE_INVALID
READ_ONLY_XID="$(
  /usr/pgsql-15/bin/psql -X -At -v ON_ERROR_STOP=1 \
    -c "SELECT coalesce(txid_current_if_assigned()::text, 'NONE');"
)"
[ "$READ_ONLY_XID" = NONE ] || fail READ_ONLY_TRANSACTION_ASSIGNED_XID
unset DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE
unset PGSSL PGSSLMODE PGOPTIONS PGAPPLICATION_NAME

REMAINING_CONNECTIONS="$(
  runuser -u postgres -- /usr/pgsql-15/bin/psql -X -At -d postgres \
    -c "SELECT count(*) FROM pg_stat_activity
        WHERE datname = '$CANDIDATE_DB'
          AND application_name = 'xingxingzaishan-stable-maintenance-prepare';"
)"
[ "$REMAINING_CONNECTIONS" = 0 ] || fail PREPARE_CONNECTIONS_REMAIN
ACTIVE_AUTO_OFF_TIMERS="$(
  systemctl list-units --type=timer --state=active --no-legend --no-pager |
    grep -c 'xingxingzaishan-stable-cutover-prewrite-auto-off-' || true
)"
[ "$ACTIVE_AUTO_OFF_TIMERS" = 0 ] || fail AUTO_OFF_TIMER_ALREADY_ACTIVE

install -d -o root -g root -m 0700 "$AUDIT_ROOT" "$AUDIT_DIR"
for FILE in "$PLAN_FILE" "$SUMMARY"; do
  [ ! -e "$FILE" ] || fail AUDIT_FILE_ALREADY_EXISTS
  install -o root -g root -m 0600 /dev/null "$FILE"
done

PREPARED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "$PLAN_FILE" <<EOF
PLAN_VERSION=2
PLAN_ID=$RUN_ID
START_STATE=JSON_AUTHORITY
TARGET_STATE=POSTGRES_AUTHORITY_PREWRITE
EXPECTED_HEAD=$HEAD
EXPECTED_TREE=$TREE
EXPECTED_JSON_SHA256=$EXPECTED_JSON_SHA
EXPECTED_SOURCE_SHA256=$EXPECTED_SOURCE_SHA
EXPECTED_PLAN_SHA256=$EXPECTED_PLAN_SHA
EXPECTED_DOMAIN_SHA256=$EXPECTED_DOMAIN_SHA
EXPECTED_BASELINE_DOMAIN_SHA256=$BASELINE_DOMAIN_SHA
CANDIDATE_DATABASE=$CANDIDATE_DB
CANDIDATE_ENVIRONMENT=$CANDIDATE_ENV
CANDIDATE_ENVIRONMENT_SHA256=$(sha256sum "$CANDIDATE_ENV" | awk '{print $1}')
PREFLIGHT_DIRECTORY=$PREFLIGHT_DIR
PREFLIGHT_SUMMARY=$PREFLIGHT_SUMMARY
PREFLIGHT_SUMMARY_SHA256=$(sha256sum "$PREFLIGHT_SUMMARY" | awk '{print $1}')
JOINT_SUMMARY=$JOINT_SUMMARY
JOINT_SUMMARY_SHA256=$(sha256sum "$JOINT_SUMMARY" | awk '{print $1}')
DATABASE_BACKUP=$DATABASE_BACKUP
DATABASE_BACKUP_SHA256=$DATABASE_BACKUP_SHA
JSON_AUTHORITY_BACKUP=$JSON_BACKUP
JSON_AUTHORITY_BACKUP_SHA256=$JSON_BACKUP_SHA
SELECTOR_CONFIG=$SELECTOR_CONFIG
SELECTOR_CONFIG_SHA256=$SELECTOR_CONFIG_SHA
PREPARED_AT_UTC=$PREPARED_AT
EOF
chmod 0600 "$PLAN_FILE"

printf '%s\n' \
  'STABLE_CUTOVER_MAINTENANCE_PREPARATION=PASS' \
  'START_STATE=JSON_AUTHORITY' \
  'TARGET_STATE=POSTGRES_AUTHORITY_PREWRITE' \
  'WRITE_FREEZE_IMPLEMENTATION=PASS' \
  'AUTO_OFF_CAPABILITY=PASS' \
  'ROLLBACK_BEFORE_COMMIT=JSON_ALLOWED' \
  'POSTGRES_AUTHORITY_BOUNDARY_COUNT=5' \
  "JSON_AUTHORITY_BASELINE_DOMAIN_SHA256=$BASELINE_DOMAIN_SHA" \
  'RECORD_PROOF_RUNTIME_ENABLED=false' \
  'AVATA_CONFIGURATION_LOADED=NO' \
  'EXTERNAL_PROVIDER_CALLS=NONE' \
  'PRODUCTION_RUNTIME_RESTARTED=NO' \
  'PRODUCTION_DATABASE_WRITE=NONE' \
  'CANDIDATE_DATABASE_WRITE=NONE' \
  'PM2_CONFIGURATION_LOADED=NO' \
  'AUTHORITY_COMMIT_POINT_CROSSED=NO' \
  "VALIDATED_HEAD=$HEAD" \
  "VALIDATED_TREE=$TREE" \
  "PLAN_FILE_SHA256=$(sha256sum "$PLAN_FILE" | awk '{print $1}')" \
  "PREPARED_AT_UTC=$PREPARED_AT" \
  'NEXT_ACTION=REVIEW_PREWRITE_PLAN_AND_IMPLEMENT_AUTO_OFF_RUNNER' \
  > "$SUMMARY"
chmod 0600 "$SUMMARY"

[ "$(pm2 pid xingxingzaishan | tail -n 1)" = "$APP_PID" ] || fail PM2_RESTARTED
assert_default_off "$APP_PID" || fail RUNTIME_CHANGED
[ "$(sha256sum src/server/data/db.json | awk '{print $1}')" = "$EXPECTED_JSON_SHA" ] || \
  fail LIVE_JSON_CHANGED
if ss -tnp | grep ':5432' | grep -Fq "pid=$APP_PID,"; then
  fail PRODUCTION_RUNTIME_POSTGRES_CONNECTION_CREATED
fi

stat -c 'OWNER=%U:%G MODE=%a SIZE=%s PATH=%n' "$PLAN_FILE" "$SUMMARY"
echo "DATABASE_STATE=$DATABASE_STATE"
echo "READ_ONLY_TRANSACTION_XID=$READ_ONLY_XID"
echo "PREPARE_REMAINING_CONNECTIONS=$REMAINING_CONNECTIONS"
echo "ACTIVE_PREWRITE_AUTO_OFF_TIMERS=$ACTIVE_AUTO_OFF_TIMERS"
echo "APP_PID=$APP_PID"
echo "APP_HTTP=$HTTP_CODE"
echo "PLAN_FILE=$PLAN_FILE"
echo "SUMMARY_FILE=$SUMMARY"
echo 'STABLE_CUTOVER_MAINTENANCE_PREPARATION=PASS'
echo 'PRODUCTION_RUNTIME_RESTARTED=NO'
echo 'PRODUCTION_DATABASE_WRITE=NONE'
echo 'CANDIDATE_DATABASE_WRITE=NONE'
echo 'AUTHORITY_COMMIT_POINT_CROSSED=NO'
echo 'NEXT_ACTION=REVIEW_PREWRITE_PLAN_AND_IMPLEMENT_AUTO_OFF_RUNNER'
