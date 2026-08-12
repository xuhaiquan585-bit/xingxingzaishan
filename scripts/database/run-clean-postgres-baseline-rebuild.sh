#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE=/root/public-qr-domain-marker-audit-20260811/production-db-source.json
EXPECTED_SOURCE_SHA=f263df13b5c19f91b0f86d93960f6b26896f3ed605318c73dd8546d110b06cfd
EXPECTED_CANDIDATE_SHA=93def24ee6dd4de63fd4ebf776a0a2056d2563df492727231b8f6de08ec0c7ee
EXPECTED_CANDIDATE_DOMAIN_SHA=be64b9b040d8b188b8bae9fb63e87621263bca9d8b76d40bf8c8ed302f08fa9d
EXPECTED_PLAN_REPORT_SHA=50f62c09ed3b3e18f9d2c2878fadffd8a3fab3564e89ab3a3b8ebde535291187
EXPECTED_TARGET_SOURCE_SHA=fc13e36ec2d96c6e4411e602b65651b4b978f1f481276cbeef233aaf269a4dff
EXPECTED_TARGET_PLAN_SHA=2eadabbe3a4d8144f6879a600e3a6e93f2290ed795aef05917ee198e61341a2c
EXPECTED_TARGET_DOMAIN_SHA=f55db6acc5b6b3b9ca5d7b4b9357324b7a89a6eabc7cef3fcd8c4efd07bc454a
EXPECTED_EXCLUDED_QR_IDS=STAR0001
EXPECTED_PRIVACY_QR_IDS=SSS00003,SSS00008,SSS00009

SOURCE_ENV=/etc/xingxingzaishan/postgresql-staging-retry-20260803.env
TARGET_ENV=/etc/xingxingzaishan/postgresql-clean-baseline-20260812.env
PRODUCTION_DB=xingxing_retry_20260803_staging
TARGET_DB=xingxing_clean_baseline_20260812_staging
DATABASE_OWNER=xingxing_staging_app
PREPARATION_ROOT=/root/legacy-privacy-remediation-preparation-audit-20260812
PLAN_ROOT=/root/clean-postgres-baseline-plan-audit-20260812
AUDIT_ROOT=/root/clean-postgres-baseline-rebuild-audit-20260812
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
AUDIT_DIR="$AUDIT_ROOT/$RUN_ID"
TARGET_SOURCE="$AUDIT_DIR/clean-baseline-source.json"
MATERIALIZE_RESULT="$AUDIT_DIR/materialize-result.json"
MIGRATION_RESULT="$AUDIT_DIR/migration-result.json"
MIGRATION_DRY_RESULT="$AUDIT_DIR/migration-dry-result.json"
IMPORT_RESULT="$AUDIT_DIR/import-result.json"
SUMMARY="$AUDIT_DIR/validation-summary.txt"

SUCCESS=false
TARGET_DB_CREATED=false
TARGET_ENV_CREATED=false

fail() {
  echo "CLEAN_POSTGRES_BASELINE_REBUILD=BLOCKED_$1" >&2
  exit 1
}

cleanup() {
  local original_status=$?
  trap - EXIT
  if [ "$SUCCESS" != true ]; then
    if [ "$TARGET_DB_CREATED" = true ]; then
      runuser -u postgres -- /usr/pgsql-15/bin/psql -X -d postgres \
        -c "SELECT pg_terminate_backend(pid)
            FROM pg_stat_activity
            WHERE datname = '$TARGET_DB'
              AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
      runuser -u postgres -- /usr/pgsql-15/bin/dropdb \
        --if-exists "$TARGET_DB" >/dev/null 2>&1 || true
    fi
    if [ "$TARGET_ENV_CREATED" = true ]; then
      rm -f -- "$TARGET_ENV"
    fi
    echo 'CLEAN_BASELINE_FAILURE_CLEANUP=ATTEMPTED' >&2
  fi
  exit "$original_status"
}
trap cleanup EXIT

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

[ "$(id -u)" -eq 0 ] || fail ROOT_REQUIRED
[ "$TARGET_DB" = xingxing_clean_baseline_20260812_staging ] || fail TARGET_DB_INVALID
[ "$TARGET_DB" != "$PRODUCTION_DB" ] || fail TARGET_IS_PRODUCTION
[[ "$TARGET_DB" == *_staging ]] || fail TARGET_SUFFIX_INVALID
cd "$REPO"
[ -z "$(git status --porcelain --untracked-files=no)" ] || fail TRACKED_WORKTREE_DIRTY
[ -f "$SOURCE" ] && [ ! -L "$SOURCE" ] || fail SOURCE_INVALID
[ -f "$SOURCE_ENV" ] && [ ! -L "$SOURCE_ENV" ] || fail SOURCE_ENV_INVALID
[ "$(sha256sum "$SOURCE" | awk '{print $1}')" = "$EXPECTED_SOURCE_SHA" ] || \
  fail SOURCE_HASH_MISMATCH

CANDIDATE="$(find_unique_sha_file \
  "$PREPARATION_ROOT" candidate-db.json "$EXPECTED_CANDIDATE_SHA")" || \
  fail CANDIDATE_NOT_UNIQUE
PREPARATION_REPORT="$(dirname "$CANDIDATE")/preparation-report.json"
APPROVED_PLAN_REPORT="$(find_unique_sha_file \
  "$PLAN_ROOT" clean-baseline-plan.json "$EXPECTED_PLAN_REPORT_SHA")" || \
  fail APPROVED_PLAN_NOT_UNIQUE
for FILE in "$SOURCE" "$CANDIDATE" "$PREPARATION_REPORT" "$APPROVED_PLAN_REPORT"; do
  [ -f "$FILE" ] && [ ! -L "$FILE" ] || fail ARTIFACT_INVALID
  [ "$(stat -c '%U:%G' "$FILE")" = root:root ] || fail ARTIFACT_OWNER_INVALID
  [ "$(stat -c '%a' "$FILE")" = 600 ] || fail ARTIFACT_MODE_INVALID
done

DB_EXISTS="$(
  runuser -u postgres -- /usr/pgsql-15/bin/psql -X -At -d postgres \
    -c "SELECT count(*) FROM pg_database WHERE datname = '$TARGET_DB';"
)"
[ "$DB_EXISTS" = 0 ] || fail TARGET_DATABASE_ALREADY_EXISTS
[ ! -e "$TARGET_ENV" ] || fail TARGET_ENV_ALREADY_EXISTS

PRODUCTION_DATABASE_COUNT="$(
  runuser -u postgres -- /usr/pgsql-15/bin/psql -X -At -d postgres \
    -c "SELECT count(*) FROM pg_database WHERE datname = '$PRODUCTION_DB';"
)"
[ "$PRODUCTION_DATABASE_COUNT" = 1 ] || fail PRODUCTION_DATABASE_MISSING

APP_PID="$(pm2 pid xingxingzaishan | tail -n 1)"
[ -n "$APP_PID" ] && [ "$APP_PID" != 0 ] || fail APP_PID_MISSING
HTTP_CODE="$(curl -sS -o /dev/null -w '%{http_code}' \
  --connect-timeout 5 --max-time 10 http://127.0.0.1:3000/)"
[ "$HTTP_CODE" = 200 ] || fail APP_HTTP_INVALID
assert_default_off "$APP_PID" || fail RUNTIME_NOT_DEFAULT_OFF
if ss -tnp | grep ':5432' | grep -Fq "pid=$APP_PID,"; then
  fail POSTGRES_RUNTIME_CONNECTION_PRESENT
fi

install -d -o root -g root -m 0700 "$AUDIT_ROOT" "$AUDIT_DIR"
for FILE in \
  "$MATERIALIZE_RESULT" \
  "$MIGRATION_RESULT" \
  "$MIGRATION_DRY_RESULT" \
  "$IMPORT_RESULT" \
  "$SUMMARY"
do
  install -o root -g root -m 0600 /dev/null "$FILE"
done

/usr/local/bin/node scripts/database/materialize-clean-postgres-baseline.js \
  --materialize \
  --source="$SOURCE" \
  --candidate="$CANDIDATE" \
  --preparation-report="$PREPARATION_REPORT" \
  --approved-plan-report="$APPROVED_PLAN_REPORT" \
  --output="$TARGET_SOURCE" \
  --expected-source-sha256="$EXPECTED_SOURCE_SHA" \
  --expected-candidate-sha256="$EXPECTED_CANDIDATE_SHA" \
  --expected-candidate-domain-sha256="$EXPECTED_CANDIDATE_DOMAIN_SHA" \
  --expected-approved-plan-report-sha256="$EXPECTED_PLAN_REPORT_SHA" \
  --expected-target-source-sha256="$EXPECTED_TARGET_SOURCE_SHA" \
  --expected-target-plan-sha256="$EXPECTED_TARGET_PLAN_SHA" \
  --expected-target-domain-sha256="$EXPECTED_TARGET_DOMAIN_SHA" \
  --exclude-qr-ids="$EXPECTED_EXCLUDED_QR_IDS" \
  --retained-privacy-qr-ids="$EXPECTED_PRIVACY_QR_IDS" \
  > "$MATERIALIZE_RESULT"

[ "$(stat -c '%U:%G' "$TARGET_SOURCE")" = root:root ] || fail TARGET_SOURCE_OWNER_INVALID
[ "$(stat -c '%a' "$TARGET_SOURCE")" = 600 ] || fail TARGET_SOURCE_MODE_INVALID
[ "$(sha256sum "$TARGET_SOURCE" | awk '{print $1}')" = "$EXPECTED_TARGET_SOURCE_SHA" ] || \
  fail TARGET_SOURCE_HASH_MISMATCH

runuser -u postgres -- /usr/pgsql-15/bin/createdb \
  -O "$DATABASE_OWNER" -E UTF8 -T template0 \
  --lc-collate=C.utf8 --lc-ctype=C.utf8 "$TARGET_DB"
TARGET_DB_CREATED=true
runuser -u postgres -- /usr/pgsql-15/bin/psql -X -v ON_ERROR_STOP=1 -d postgres \
  -c "REVOKE ALL ON DATABASE $TARGET_DB FROM PUBLIC;
      GRANT CONNECT, TEMPORARY ON DATABASE $TARGET_DB TO $DATABASE_OWNER;"
runuser -u postgres -- /usr/pgsql-15/bin/psql -X -v ON_ERROR_STOP=1 -d "$TARGET_DB" \
  -c 'REVOKE ALL ON SCHEMA public FROM PUBLIC;'

install -o root -g root -m 0600 "$SOURCE_ENV" "$TARGET_ENV"
TARGET_ENV_CREATED=true
sed -i \
  -e "s/^PGDATABASE=.*/PGDATABASE=$TARGET_DB/" \
  -e 's/^PGAPPLICATION_NAME=.*/PGAPPLICATION_NAME=xingxingzaishan-clean-baseline-rebuild/' \
  "$TARGET_ENV"
[ "$(stat -c '%U:%G' "$TARGET_ENV")" = root:root ] || fail TARGET_ENV_OWNER_INVALID
[ "$(stat -c '%a' "$TARGET_ENV")" = 600 ] || fail TARGET_ENV_MODE_INVALID

unset DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE
unset PGSSL PGSSLMODE PGOPTIONS PGAPPLICATION_NAME NODE_ENV
set -a
. "$TARGET_ENV"
set +a
[ "$PGDATABASE" = "$TARGET_DB" ] || fail TARGET_ENV_DATABASE_MISMATCH
[ "$PGDATABASE" != "$PRODUCTION_DB" ] || fail PRODUCTION_DATABASE_SELECTED
export NODE_ENV=staging
export POSTGRES_MIGRATION_TARGET=staging

/usr/local/bin/node scripts/database/migrate.js --apply > "$MIGRATION_RESULT"
/usr/local/bin/node scripts/database/migrate.js --dry-run > "$MIGRATION_DRY_RESULT"
/usr/local/bin/node scripts/database/import-staging.js \
  --input="$TARGET_SOURCE" \
  --expected-source-sha256="$EXPECTED_TARGET_SOURCE_SHA" \
  --target=staging \
  --apply-staging \
  --staging-confirmed \
  > "$IMPORT_RESULT"

/usr/local/bin/node - \
  "$APPROVED_PLAN_REPORT" \
  "$MATERIALIZE_RESULT" \
  "$MIGRATION_RESULT" \
  "$MIGRATION_DRY_RESULT" \
  "$IMPORT_RESULT" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const [planPath, materializePath, migrationPath, dryPath, importPath] =
  process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const materialized = JSON.parse(fs.readFileSync(materializePath, 'utf8'));
const migration = JSON.parse(fs.readFileSync(migrationPath, 'utf8'));
const dry = JSON.parse(fs.readFileSync(dryPath, 'utf8'));
const imported = JSON.parse(fs.readFileSync(importPath, 'utf8'));

assert.equal(materialized.status, 'MATERIALIZED');
assert.equal(materialized.target_source_sha256, plan.target_source_sha256);
assert.equal(materialized.target_plan_sha256, plan.target_plan_sha256);
assert.equal(
  materialized.target_public_qr_domain_sha256,
  plan.target_public_qr_domain_sha256
);
assert.equal(materialized.target_qr_count, 103);
assert.equal(materialized.target_record_count, 55);
assert.equal(migration.mode, 'apply');
assert.equal(migration.target, 'staging');
assert.equal(migration.applied.length, 6);
assert.equal(dry.mode, 'dry-run');
assert.deepEqual(dry.pending, []);
assert.equal(imported.status, 'PASSED');
assert.equal(imported.source_sha256, plan.target_source_sha256);
assert.equal(imported.plan_sha256, plan.target_plan_sha256);
assert.equal(
  imported.public_qr_domain_sha256,
  plan.target_public_qr_domain_sha256
);
assert.equal(imported.imported_counts.qr_codes, 103);
assert.equal(imported.imported_counts.records, 55);
for (const [collection, actual] of Object.entries(imported.imported_counts)) {
  assert.equal(actual, plan.target_counts[collection], collection);
}
assert.equal(
  Object.values(imported.integrity_checks).every(value => value === 0),
  true
);
console.log('CLEAN_POSTGRES_BASELINE_REBUILD_RESULT_GATE=PASS');
NODE

DATABASE_STATE="$(
  /usr/pgsql-15/bin/psql -X -At -F '|' -v ON_ERROR_STOP=1 \
    -c "SELECT
          (SELECT count(*) FROM app.qr_codes),
          (SELECT count(*) FROM app.records),
          (SELECT count(*) FROM app.import_runs WHERE status = 'passed'),
          (SELECT count(*) FROM app.import_runs WHERE status <> 'passed'),
          (SELECT count(*) FROM app.outbox_jobs),
          coalesce(txid_current_if_assigned()::text, 'NONE');"
)"
[ "$DATABASE_STATE" = '103|55|1|0|0|NONE' ] || fail TARGET_DATABASE_STATE_INVALID

unset DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE
unset PGSSL PGSSLMODE PGOPTIONS PGAPPLICATION_NAME NODE_ENV
unset POSTGRES_MIGRATION_TARGET

REMAINING_CONNECTIONS="$(
  runuser -u postgres -- /usr/pgsql-15/bin/psql -X -At -d postgres \
    -c "SELECT count(*) FROM pg_stat_activity WHERE datname = '$TARGET_DB';"
)"
[ "$REMAINING_CONNECTIONS" = 0 ] || fail TARGET_CONNECTIONS_REMAIN
APP_PID_AFTER="$(pm2 pid xingxingzaishan | tail -n 1)"
[ "$APP_PID_AFTER" = "$APP_PID" ] || fail PRODUCTION_RUNTIME_RESTARTED
if ss -tnp | grep ':5432' | grep -Fq "pid=$APP_PID_AFTER,"; then
  fail PRODUCTION_RUNTIME_POSTGRES_CONNECTION_CREATED
fi
[ "$(sha256sum src/server/data/db.json | awk '{print $1}')" = "$EXPECTED_SOURCE_SHA" ] || \
  fail LIVE_JSON_CHANGED

printf '%s\n' \
  'CLEAN_POSTGRES_BASELINE_REBUILD=PASS' \
  'TARGET_DATABASE_CREATED=YES' \
  "TARGET_DATABASE=$TARGET_DB" \
  "TARGET_SOURCE_SHA256=$EXPECTED_TARGET_SOURCE_SHA" \
  "TARGET_PLAN_SHA256=$EXPECTED_TARGET_PLAN_SHA" \
  "TARGET_DOMAIN_SHA256=$EXPECTED_TARGET_DOMAIN_SHA" \
  'TARGET_QR_COUNT=103' \
  'TARGET_RECORD_COUNT=55' \
  'TARGET_IMPORT_RUNS_PASSED=1' \
  'TARGET_OUTBOX_JOB_COUNT=0' \
  'PRODUCTION_DATABASE_SELECTED=NO' \
  'PRODUCTION_DATABASE_WRITE=NONE' \
  'PRODUCTION_JSON_WRITE=NONE' \
  'PRODUCTION_RUNTIME_RESTARTED=NO' \
  'EXTERNAL_PROVIDER_CALLS=NONE' \
  "VALIDATED_HEAD=$(git rev-parse HEAD)" \
  "VALIDATED_AT_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  > "$SUMMARY"
chmod 0600 "$SUMMARY"

SUCCESS=true
trap - EXIT
stat -c 'OWNER=%U:%G MODE=%a SIZE=%s PATH=%n' \
  "$TARGET_SOURCE" "$MATERIALIZE_RESULT" "$MIGRATION_RESULT" \
  "$MIGRATION_DRY_RESULT" "$IMPORT_RESULT" "$SUMMARY" "$TARGET_ENV"
echo "DATABASE_STATE=$DATABASE_STATE"
echo "TARGET_REMAINING_CONNECTIONS=$REMAINING_CONNECTIONS"
echo "APP_PID=$APP_PID_AFTER"
echo "APP_HTTP=$HTTP_CODE"
echo 'CLEAN_POSTGRES_BASELINE_REBUILD=PASS'
echo 'TARGET_DATABASE_READY_FOR_POSTGRES_ONLY_E2E=YES'
echo 'PRODUCTION_DATABASE_SELECTED=NO'
echo 'PRODUCTION_DATABASE_WRITE=NONE'
echo 'PRODUCTION_JSON_WRITE=NONE'
echo 'PRODUCTION_RUNTIME_RESTARTED=NO'
echo 'EXTERNAL_PROVIDER_CALLS=NONE'
echo 'NEXT_ACTION=RUN_NEW_QR_POSTGRES_ONLY_END_TO_END'
