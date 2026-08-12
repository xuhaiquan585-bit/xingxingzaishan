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
JOINT_REHEARSAL_ROOT=/root/clean-postgres-candidate-e2e-audit-20260812
REBUILD_ROOT=/root/clean-postgres-baseline-rebuild-audit-20260812
AUDIT_ROOT=/root/stable-cutover-preflight-audit-20260812
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
AUDIT_DIR="$AUDIT_ROOT/$RUN_ID"
DATABASE_BACKUP="$AUDIT_DIR/clean-candidate.dump"
BACKUP_LIST="$AUDIT_DIR/clean-candidate.restore-list.txt"
JSON_BACKUP="$AUDIT_DIR/json-authority-snapshot.json"
SELECTOR_CONFIG="$AUDIT_DIR/stable-selectors.env"
CONFIG_REPORT="$AUDIT_DIR/stable-config-validation.json"
SUMMARY="$AUDIT_DIR/preflight-summary.txt"
LOCK_FILE=/run/lock/xingxingzaishan-stable-cutover-preflight.lock
PROVIDER_ENV="${STABLE_CUTOVER_PROVIDER_ENV:-}"
EXPECTED_PROVIDER_ENV="${STABLE_CUTOVER_EXPECTED_AVATA_ENV:-}"
EXPECTED_PROVIDER_ORIGIN="${STABLE_CUTOVER_EXPECTED_AVATA_ORIGIN:-}"

fail() {
  echo "STABLE_CUTOVER_PREFLIGHT=BLOCKED_$1" >&2
  exit 1
}

database_count() {
  runuser -u postgres -- /usr/pgsql-15/bin/psql -X -At -d postgres \
    -c "SELECT count(*) FROM pg_database WHERE datname = '$1';"
}

assert_default_off() {
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
}

find_unique_sha_file() {
  local root="$1"
  local name="$2"
  local expected_sha="$3"
  local -a matches=()
  mapfile -t matches < <(
    find "$root" -mindepth 2 -maxdepth 2 -type f -name "$name" -print0 |
      xargs -0 -r sha256sum |
      awk -v expected="$expected_sha" '$1 == expected { print $2 }'
  )
  [ "${#matches[@]}" -eq 1 ] || return 1
  printf '%s\n' "${matches[0]}"
}

candidate_state() {
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

[ "$(id -u)" -eq 0 ] || fail ROOT_REQUIRED
[ "$CANDIDATE_DB" != "$LEGACY_DB" ] || fail CANDIDATE_IS_LEGACY_DATABASE
[ "$(database_count "$CANDIDATE_DB")" = 1 ] || fail CANDIDATE_DATABASE_MISSING
[ "$(database_count "$LEGACY_DB")" = 1 ] || fail LEGACY_DATABASE_MISSING
CANDIDATE_DATABASE_METADATA="$(
  runuser -u postgres -- /usr/pgsql-15/bin/psql -X -At -F '|' -d postgres \
    -c "SELECT pg_get_userbyid(datdba), pg_encoding_to_char(encoding),
               datcollate, datctype
        FROM pg_database WHERE datname = '$CANDIDATE_DB';"
)"
[ "$CANDIDATE_DATABASE_METADATA" = 'xingxing_staging_app|UTF8|C.utf8|C.utf8' ] || \
  fail CANDIDATE_DATABASE_METADATA_INVALID
[ -f "$CANDIDATE_ENV" ] && [ ! -L "$CANDIDATE_ENV" ] || fail CANDIDATE_ENV_INVALID
[ "$(stat -c '%U:%G' "$CANDIDATE_ENV")" = root:root ] || fail CANDIDATE_ENV_OWNER_INVALID
[ "$(stat -c '%a' "$CANDIDATE_ENV")" = 600 ] || fail CANDIDATE_ENV_MODE_INVALID
grep -qx "PGDATABASE=$CANDIDATE_DB" "$CANDIDATE_ENV" || fail CANDIDATE_ENV_DATABASE_INVALID
command -v flock >/dev/null 2>&1 || fail FLOCK_REQUIRED
command -v /usr/pgsql-15/bin/pg_dump >/dev/null 2>&1 || fail PG_DUMP_REQUIRED
command -v /usr/pgsql-15/bin/pg_restore >/dev/null 2>&1 || fail PG_RESTORE_REQUIRED
exec 9>"$LOCK_FILE"
flock -n 9 || fail PREFLIGHT_ALREADY_RUNNING

cd "$REPO"
[ -z "$(git status --porcelain --untracked-files=no)" ] || fail TRACKED_WORKTREE_DIRTY
[ "$(sha256sum src/server/data/db.json | awk '{print $1}')" = "$EXPECTED_JSON_SHA" ] || \
  fail LIVE_JSON_HASH_MISMATCH

APP_PID="$(pm2 pid xingxingzaishan | tail -n 1)"
[ -n "$APP_PID" ] && [ "$APP_PID" != 0 ] || fail APP_PID_MISSING
HTTP_CODE="$(curl -sS -o /dev/null -w '%{http_code}' \
  --connect-timeout 5 --max-time 10 http://127.0.0.1:3000/)"
[ "$HTTP_CODE" = 200 ] || fail APP_HTTP_INVALID
assert_default_off "$APP_PID" || fail RUNTIME_NOT_DEFAULT_OFF
if ss -tnp | grep ':5432' | grep -Fq "pid=$APP_PID,"; then
  fail PRODUCTION_RUNTIME_POSTGRES_CONNECTION_PRESENT
fi
CANDIDATE_CONNECTIONS_BEFORE="$(
  runuser -u postgres -- /usr/pgsql-15/bin/psql -X -At -d postgres \
    -c "SELECT count(*) FROM pg_stat_activity WHERE datname = '$CANDIDATE_DB';"
)"
[ "$CANDIDATE_CONNECTIONS_BEFORE" = 0 ] || fail CANDIDATE_CONNECTIONS_PRESENT

JOINT_SUMMARY=''
mapfile -t JOINT_CANDIDATES < <(
  find "$JOINT_REHEARSAL_ROOT" -mindepth 2 -maxdepth 2 -type f \
    -name validation-summary.txt -printf '%T@|%p\n' |
    sort -nr |
    cut -d'|' -f2-
)
for FILE in "${JOINT_CANDIDATES[@]}"; do
  if grep -qx 'CLEAN_CANDIDATE_COORDINATED_JOINT_REHEARSAL=PASS' "$FILE" &&
     grep -qx "VALIDATED_SOURCE_SHA256=$EXPECTED_SOURCE_SHA" "$FILE" &&
     grep -qx "VALIDATED_PLAN_SHA256=$EXPECTED_PLAN_SHA" "$FILE" &&
     grep -qx "VALIDATED_DOMAIN_SHA256=$EXPECTED_DOMAIN_SHA" "$FILE"; then
    JOINT_SUMMARY="$FILE"
    break
  fi
done
[ -n "$JOINT_SUMMARY" ] || fail JOINT_SUMMARY_NOT_FOUND
grep -qx 'CLEAN_CANDIDATE_POSTGRES_ONLY_E2E=PASS' "$JOINT_SUMMARY" || fail JOINT_E2E_NOT_PASSED
grep -qx 'EXISTING_H5_ROUTES=PASS' "$JOINT_SUMMARY" || fail JOINT_H5_NOT_PASSED
grep -qx 'EXISTING_MINIAPP_ROUTES=PASS' "$JOINT_SUMMARY" || fail JOINT_MINIAPP_NOT_PASSED
grep -qx 'EXISTING_DATA_UNCHANGED=PASS' "$JOINT_SUMMARY" || fail JOINT_EXISTING_DATA_CHANGED
JOINT_HEAD="$(sed -n 's/^VALIDATED_HEAD=//p' "$JOINT_SUMMARY")"
[ -n "$JOINT_HEAD" ] || fail JOINT_HEAD_MISSING
git cat-file -e "${JOINT_HEAD}^{commit}" || fail JOINT_HEAD_INVALID
git merge-base --is-ancestor "$JOINT_HEAD" HEAD || fail JOINT_HEAD_NOT_ANCESTOR
if git diff --name-only "$JOINT_HEAD"..HEAD |
   grep -Eq '^(src/server/|scripts/database/run-clean-postgres-candidate-e2e\.sh$|tests/postgresql-clean-candidate\.e2e\.test\.js$)'; then
  fail JOINT_EVIDENCE_STALE
fi

SOURCE_ARTIFACT="$(find_unique_sha_file \
  "$REBUILD_ROOT" clean-baseline-source.json "$EXPECTED_SOURCE_SHA")" || \
  fail SOURCE_ARTIFACT_NOT_UNIQUE
for FILE in "$JOINT_SUMMARY" "$SOURCE_ARTIFACT"; do
  [ -f "$FILE" ] && [ ! -L "$FILE" ] || fail EVIDENCE_FILE_INVALID
  [ "$(stat -c '%U:%G' "$FILE")" = root:root ] || fail EVIDENCE_OWNER_INVALID
  [ "$(stat -c '%a' "$FILE")" = 600 ] || fail EVIDENCE_MODE_INVALID
done

install -d -o root -g root -m 0700 "$AUDIT_ROOT" "$AUDIT_DIR"
for FILE in "$DATABASE_BACKUP" "$BACKUP_LIST" "$JSON_BACKUP" \
  "$SELECTOR_CONFIG" "$CONFIG_REPORT" "$SUMMARY"
do
  [ ! -e "$FILE" ] || fail AUDIT_FILE_ALREADY_EXISTS
done

install -o root -g root -m 0600 src/server/data/db.json "$JSON_BACKUP"
runuser -u postgres -- /usr/pgsql-15/bin/pg_dump \
  -Fc --no-owner --no-privileges -d "$CANDIDATE_DB" > "$DATABASE_BACKUP"
chmod 0600 "$DATABASE_BACKUP"
/usr/pgsql-15/bin/pg_restore --list "$DATABASE_BACKUP" > "$BACKUP_LIST"
chmod 0600 "$BACKUP_LIST"
grep -q 'TABLE DATA app qr_codes' "$BACKUP_LIST" || fail BACKUP_QR_DATA_MISSING
grep -q 'TABLE DATA app records' "$BACKUP_LIST" || fail BACKUP_RECORD_DATA_MISSING
grep -q 'TABLE DATA app import_runs' "$BACKUP_LIST" || fail BACKUP_IMPORT_DATA_MISSING

unset DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE
unset PGSSL PGSSLMODE PGOPTIONS PGAPPLICATION_NAME NODE_ENV
set -a
. "$CANDIDATE_ENV"
set +a
[ "$PGDATABASE" = "$CANDIDATE_DB" ] || fail CANDIDATE_ENV_DATABASE_MISMATCH
export PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=15000ms'
export PGAPPLICATION_NAME=xingxingzaishan-stable-cutover-preflight
export NODE_ENV=staging
export POSTGRES_MIGRATION_TARGET=staging

CONNECTION_IDENTITY="$(
  /usr/pgsql-15/bin/psql -X -At -F '|' -v ON_ERROR_STOP=1 \
    -c "SELECT current_user, current_database();"
)"
[ "$CONNECTION_IDENTITY" = "xingxing_staging_app|$CANDIDATE_DB" ] || \
  fail CANDIDATE_CONNECTION_IDENTITY_INVALID

DATABASE_STATE="$(candidate_state)"
[ "$DATABASE_STATE" = "$EXPECTED_DATABASE_STATE" ] || fail CANDIDATE_STATE_INVALID
MIGRATION_STATE="$(/usr/local/bin/node scripts/database/migrate.js --dry-run)"
printf '%s' "$MIGRATION_STATE" | grep -Fq '"pending": []' || fail MIGRATIONS_PENDING
OUTBOX_STATE="$(
  /usr/pgsql-15/bin/psql -X -At -F '|' -v ON_ERROR_STOP=1 \
    -c "SELECT
          count(*) FILTER (WHERE status IN ('pending','processing')),
          count(*) FILTER (WHERE status = 'failed'),
          count(*) FILTER (WHERE locked_at IS NOT NULL)
        FROM app.outbox_jobs;"
)"
[ "$OUTBOX_STATE" = '0|0|0' ] || fail OUTBOX_NOT_QUIET

unset DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE
unset PGSSL PGSSLMODE PGOPTIONS PGAPPLICATION_NAME NODE_ENV POSTGRES_MIGRATION_TARGET
unset AVATA_API_KEY AVATA_API_SECRET AVATA_IDENTITY_NAME AVATA_IDENTITY_NUM
unset AVATA_API_BASE AVATA_ENV CHAIN_ENABLED CHAIN_CALLBACK_URL

cat > "$SELECTOR_CONFIG" <<EOF
PUBLIC_QR_SHADOW_READ_ENABLED=false
PERSONAL_RECORD_SHADOW_READ_ENABLED=false
IDENTITY_SHADOW_READ_ENABLED=false
PUBLIC_QR_POSTGRES_READ_ENABLED=true
PUBLIC_QR_POSTGRES_READ_SCOPE=all
PUBLIC_QR_POSTGRES_READ_DOMAIN_SHA256=$EXPECTED_DOMAIN_SHA
PERSONAL_RECORD_POSTGRES_READ_ENABLED=true
PERSONAL_RECORD_POSTGRES_READ_SCOPE=all
PERSONAL_RECORD_POSTGRES_READ_DOMAIN_SHA256=$EXPECTED_DOMAIN_SHA
QR_LIFECYCLE_POSTGRES_WRITE_ENABLED=true
QR_LIFECYCLE_POSTGRES_WRITE_SCOPE=all
QR_LIFECYCLE_POSTGRES_WRITE_DOMAIN_SHA256=$EXPECTED_DOMAIN_SHA
IDENTITY_POSTGRES_AUTHORITY_ENABLED=true
IDENTITY_POSTGRES_AUTHORITY_SCOPE=all
IDENTITY_POSTGRES_AUTHORITY_SOURCE_SHA256=$EXPECTED_SOURCE_SHA
IDENTITY_POSTGRES_AUTHORITY_DOMAIN_SHA256=$EXPECTED_DOMAIN_SHA
QR_ISSUANCE_POSTGRES_AUTHORITY_ENABLED=true
QR_ISSUANCE_POSTGRES_AUTHORITY_SCOPE=all
QR_ISSUANCE_POSTGRES_AUTHORITY_SOURCE_SHA256=$EXPECTED_SOURCE_SHA
QR_ISSUANCE_POSTGRES_AUTHORITY_DOMAIN_SHA256=$EXPECTED_DOMAIN_SHA
RECORD_PROOF_RUNTIME_ENABLED=true
RECORD_PROOF_RUNTIME_SCOPE=all
RECORD_PROOF_RUNTIME_SOURCE_SHA256=$EXPECTED_SOURCE_SHA
RECORD_PROOF_RUNTIME_DOMAIN_SHA256=$EXPECTED_DOMAIN_SHA
RECORD_PROOF_WORKER_ID=xingxingzaishan-stable-primary
EOF
chmod 0600 "$SELECTOR_CONFIG"

PROVIDER_STATE=READY_PENDING_PROVIDER_CONFIG
if [ -n "$PROVIDER_ENV" ]; then
  [[ "$PROVIDER_ENV" = /* ]] || fail PROVIDER_ENV_ABSOLUTE_PATH_REQUIRED
  case "$EXPECTED_PROVIDER_ENV" in
    stage|prod) ;;
    *) fail PROVIDER_ENVIRONMENT_CONFIRMATION_REQUIRED ;;
  esac
  [ -n "$EXPECTED_PROVIDER_ORIGIN" ] || fail PROVIDER_ORIGIN_CONFIRMATION_REQUIRED
  [ -f "$PROVIDER_ENV" ] && [ ! -L "$PROVIDER_ENV" ] || fail PROVIDER_ENV_INVALID
  [ "$(stat -c '%U:%G' "$PROVIDER_ENV")" = root:root ] || fail PROVIDER_ENV_OWNER_INVALID
  [ "$(stat -c '%a' "$PROVIDER_ENV")" = 600 ] || fail PROVIDER_ENV_MODE_INVALID
  set -a
  . "$PROVIDER_ENV"
  set +a
  PROVIDER_STATE=READY
fi

VALIDATOR_ARGS=(
  scripts/database/validate-stable-cutover-config.js
  --config="$SELECTOR_CONFIG" \
  --expected-source-sha256="$EXPECTED_SOURCE_SHA" \
  --expected-domain-sha256="$EXPECTED_DOMAIN_SHA"
)
if [ "$PROVIDER_STATE" = READY ]; then
  VALIDATOR_ARGS+=(
    --expected-provider-environment="$EXPECTED_PROVIDER_ENV"
    --expected-provider-origin="$EXPECTED_PROVIDER_ORIGIN"
  )
fi
/usr/local/bin/node "${VALIDATOR_ARGS[@]}" > "$CONFIG_REPORT"
chmod 0600 "$CONFIG_REPORT"
CONFIG_STATUS="$(/usr/local/bin/node -e \
  "console.log(require(process.argv[1]).status)" "$CONFIG_REPORT")"
[ "$CONFIG_STATUS" = "$PROVIDER_STATE" ] || fail CONFIG_PROVIDER_STATE_MISMATCH

unset AVATA_API_KEY AVATA_API_SECRET AVATA_IDENTITY_NAME AVATA_IDENTITY_NUM
unset AVATA_API_BASE AVATA_ENV CHAIN_ENABLED CHAIN_CALLBACK_URL

REMAINING_CONNECTIONS="$(
  runuser -u postgres -- /usr/pgsql-15/bin/psql -X -At -d postgres \
    -c "SELECT count(*) FROM pg_stat_activity
        WHERE datname = '$CANDIDATE_DB';"
)"
[ "$REMAINING_CONNECTIONS" = 0 ] || fail PREFLIGHT_CONNECTIONS_REMAIN
DATABASE_STATE_AFTER="$(
  runuser -u postgres -- /usr/pgsql-15/bin/psql -X -At -F '|' \
    -v ON_ERROR_STOP=1 -d "$CANDIDATE_DB" \
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
[ "$DATABASE_STATE_AFTER" = "$DATABASE_STATE" ] || fail CANDIDATE_DATABASE_CHANGED
[ "$(sha256sum src/server/data/db.json | awk '{print $1}')" = "$EXPECTED_JSON_SHA" ] || \
  fail LIVE_JSON_CHANGED
[ "$(sha256sum "$SOURCE_ARTIFACT" | awk '{print $1}')" = "$EXPECTED_SOURCE_SHA" ] || \
  fail SOURCE_ARTIFACT_CHANGED
[ "$(pm2 pid xingxingzaishan | tail -n 1)" = "$APP_PID" ] || fail PM2_RESTARTED
assert_default_off "$APP_PID" || fail RUNTIME_CHANGED
if ss -tnp | grep ':5432' | grep -Fq "pid=$APP_PID,"; then
  fail PRODUCTION_RUNTIME_POSTGRES_CONNECTION_CREATED
fi

if [ "$PROVIDER_STATE" = READY ]; then
  PREFLIGHT_STATUS=READY_FOR_MAINTENANCE_WINDOW
  NEXT_ACTION=REVIEW_BACKUPS_AND_PREPARE_CUTOVER_RUNNER
else
  PREFLIGHT_STATUS=READY_PENDING_PROVIDER_CONFIG
  NEXT_ACTION=SUPPLY_PROVIDER_CONFIG_THEN_RERUN_PREFLIGHT
fi

printf '%s\n' \
  "STABLE_CUTOVER_PREFLIGHT_STATUS=$PREFLIGHT_STATUS" \
  'CANDIDATE_DATABASE_GATE=PASS' \
  'CANONICAL_MIGRATION_GATE=PASS' \
  'JOINT_REHEARSAL_EVIDENCE_GATE=PASS' \
  'UNIFIED_SCOPE_ALL_CONFIG_GATE=PASS' \
  'STATIC_ALLOWLIST_COUNT=0' \
  'OUTBOX_BACKLOG_COUNT=0' \
  "PROVIDER_CONFIGURATION_STATE=$PROVIDER_STATE" \
  "CANDIDATE_DATABASE_BACKUP_SHA256=$(sha256sum "$DATABASE_BACKUP" | awk '{print $1}')" \
  "JSON_AUTHORITY_BACKUP_SHA256=$(sha256sum "$JSON_BACKUP" | awk '{print $1}')" \
  "STABLE_SELECTOR_CONFIG_SHA256=$(sha256sum "$SELECTOR_CONFIG" | awk '{print $1}')" \
  'PRODUCTION_RUNTIME_RESTARTED=NO' \
  'PRODUCTION_DATABASE_WRITE=NONE' \
  'CANDIDATE_DATABASE_WRITE=NONE' \
  'PM2_CONFIGURATION_LOADED=NO' \
  'AUTHORITY_COMMIT_POINT_CROSSED=NO' \
  "VALIDATED_HEAD=$(git rev-parse HEAD)" \
  "VALIDATED_AT_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "NEXT_ACTION=$NEXT_ACTION" \
  > "$SUMMARY"
chmod 0600 "$SUMMARY"

stat -c 'OWNER=%U:%G MODE=%a SIZE=%s PATH=%n' \
  "$DATABASE_BACKUP" "$BACKUP_LIST" "$JSON_BACKUP" \
  "$SELECTOR_CONFIG" "$CONFIG_REPORT" "$SUMMARY"
echo "DATABASE_STATE=$DATABASE_STATE"
echo "DATABASE_STATE_AFTER=$DATABASE_STATE_AFTER"
echo "CANDIDATE_DATABASE_METADATA=$CANDIDATE_DATABASE_METADATA"
echo "CANDIDATE_CONNECTION_IDENTITY=$CONNECTION_IDENTITY"
echo "OUTBOX_STATE=$OUTBOX_STATE"
echo "CANDIDATE_CONNECTIONS_BEFORE=$CANDIDATE_CONNECTIONS_BEFORE"
echo "PREFLIGHT_REMAINING_CONNECTIONS=$REMAINING_CONNECTIONS"
echo "APP_PID=$APP_PID"
echo "APP_HTTP=$HTTP_CODE"
echo "STABLE_CUTOVER_PREFLIGHT_STATUS=$PREFLIGHT_STATUS"
echo 'STABLE_CUTOVER_READ_ONLY_PREFLIGHT=PASS'
echo 'PRODUCTION_RUNTIME_RESTARTED=NO'
echo 'PRODUCTION_DATABASE_WRITE=NONE'
echo 'CANDIDATE_DATABASE_WRITE=NONE'
echo 'PM2_CONFIGURATION_LOADED=NO'
echo 'AUTHORITY_COMMIT_POINT_CROSSED=NO'
echo "NEXT_ACTION=$NEXT_ACTION"
