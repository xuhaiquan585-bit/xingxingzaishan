#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE=/root/public-qr-domain-marker-audit-20260811/production-db-source.json
LIVE_DATABASE="$REPO/src/server/data/db.json"
WRITER_ENV=/etc/xingxingzaishan/postgresql-staging-retry-20260803.env
EXPECTED_DATABASE=xingxing_retry_20260803_staging
EXPECTED_SOURCE_SHA=f263df13b5c19f91b0f86d93960f6b26896f3ed605318c73dd8546d110b06cfd
EXPECTED_CANDIDATE_SHA=93def24ee6dd4de63fd4ebf776a0a2056d2563df492727231b8f6de08ec0c7ee
EXPECTED_SOURCE_DOMAIN_SHA=b4563b804ffa6e6789882b782584f2916a9f503fb07a7849178b40ae1bbb6fd0
EXPECTED_CANDIDATE_DOMAIN_SHA=be64b9b040d8b188b8bae9fb63e87621263bca9d8b76d40bf8c8ed302f08fa9d
EXPECTED_QR_IDS=SSS00003,SSS00008,SSS00009
PREPARATION_ROOT=/root/legacy-privacy-remediation-preparation-audit-20260812
AUDIT_ROOT=/root/legacy-privacy-remediation-apply-audit-20260812
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
AUDIT_DIR="$AUDIT_ROOT/$RUN_ID"
RESULT="$AUDIT_DIR/preflight-result.json"

fail() {
  echo "CONTENT_PRIVACY_REMEDIATION_APPLY_PREFLIGHT=BLOCKED_$1" >&2
  exit 1
}

assert_default_off() {
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

  for flag in \
    IDENTITY_POSTGRES_AUTHORITY_ENABLED \
    QR_ISSUANCE_POSTGRES_AUTHORITY_ENABLED
  do
    local value
    value="$(
      tr '\0' '\n' < "/proc/$app_pid/environ" |
        sed -n "s/^${flag}=//p" |
        tail -n 1
    )"
    [ -z "$value" ] || [ "$value" = false ] || return 1
  done

  if tr '\0' '\n' < "/proc/$app_pid/environ" |
     grep -Eq '^(DATABASE_URL|PGPASSWORD)=.+$'; then
    return 1
  fi
}

[ "$(id -u)" -eq 0 ] || fail ROOT_REQUIRED
cd "$REPO"
[ -z "$(git status --porcelain --untracked-files=no)" ] || \
  fail TRACKED_WORKTREE_DIRTY
[ -f "$SOURCE" ] || fail SOURCE_MISSING
[ ! -L "$SOURCE" ] || fail SOURCE_SYMLINK_FORBIDDEN
[ "$(sha256sum "$SOURCE" | awk '{print $1}')" = \
  "$EXPECTED_SOURCE_SHA" ] || fail SOURCE_HASH_MISMATCH
[ -f "$WRITER_ENV" ] || fail WRITER_ENV_MISSING
[ "$(stat -c '%U:%G' "$WRITER_ENV")" = root:root ] || \
  fail WRITER_ENV_OWNER_INVALID
[ "$(stat -c '%a' "$WRITER_ENV")" = 600 ] || \
  fail WRITER_ENV_MODE_INVALID

mapfile -t CANDIDATES < <(
  find "$PREPARATION_ROOT" -mindepth 2 -maxdepth 2 \
    -type f -name candidate-db.json -print0 |
    xargs -0 -r sha256sum |
    awk -v expected="$EXPECTED_CANDIDATE_SHA" '$1 == expected { print $2 }'
)
[ "${#CANDIDATES[@]}" -eq 1 ] || fail CANDIDATE_NOT_UNIQUE
CANDIDATE="${CANDIDATES[0]}"
REPORT="$(dirname "$CANDIDATE")/preparation-report.json"
[ -f "$REPORT" ] || fail REPORT_MISSING

for FILE in "$SOURCE" "$CANDIDATE" "$REPORT"; do
  [ ! -L "$FILE" ] || fail ARTIFACT_SYMLINK_FORBIDDEN
  [ "$(stat -c '%U:%G' "$FILE")" = root:root ] || \
    fail ARTIFACT_OWNER_INVALID
  [ "$(stat -c '%a' "$FILE")" = 600 ] || \
    fail ARTIFACT_MODE_INVALID
done

LIVE_SHA="$(sha256sum "$LIVE_DATABASE" | awk '{print $1}')"
[ "$LIVE_SHA" = "$EXPECTED_SOURCE_SHA" ] || \
  [ "$LIVE_SHA" = "$EXPECTED_CANDIDATE_SHA" ] || \
  fail LIVE_DATABASE_HASH_INVALID

APP_PID="$(pm2 pid xingxingzaishan | tail -n 1)"
[ -n "$APP_PID" ] || fail APP_PID_MISSING
HTTP_CODE="$(curl -sS -o /dev/null -w '%{http_code}' \
  --connect-timeout 5 --max-time 10 http://127.0.0.1:3000/)"
[ "$HTTP_CODE" = 200 ] || fail APP_HTTP_INVALID
assert_default_off "$APP_PID" || fail RUNTIME_NOT_DEFAULT_OFF
if ss -tnp | grep ':5432' | grep -Fq "pid=$APP_PID,"; then
  fail POSTGRES_RUNTIME_CONNECTION_PRESENT
fi

install -d -o root -g root -m 0700 "$AUDIT_ROOT" "$AUDIT_DIR"
install -o root -g root -m 0600 /dev/null "$RESULT"

unset DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE
unset PGSSL PGSSLMODE PGOPTIONS PGAPPLICATION_NAME
set -a
. "$WRITER_ENV"
set +a
[ "$PGDATABASE" = "$EXPECTED_DATABASE" ] || fail DATABASE_MISMATCH
export PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=15000ms'
export PGAPPLICATION_NAME=xingxingzaishan-privacy-apply-preflight

/usr/local/bin/node scripts/database/apply-content-privacy-remediation.js \
  --preflight \
  --source="$SOURCE" \
  --candidate="$CANDIDATE" \
  --report="$REPORT" \
  --live-database="$LIVE_DATABASE" \
  --expected-source-sha256="$EXPECTED_SOURCE_SHA" \
  --expected-candidate-sha256="$EXPECTED_CANDIDATE_SHA" \
  --expected-source-domain-sha256="$EXPECTED_SOURCE_DOMAIN_SHA" \
  --expected-candidate-domain-sha256="$EXPECTED_CANDIDATE_DOMAIN_SHA" \
  --expected-qr-ids="$EXPECTED_QR_IDS" \
  --expected-database="$EXPECTED_DATABASE" \
  > "$RESULT"

/usr/local/bin/node - "$RESULT" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
assert.equal(report.mode, 'preflight');
assert.equal(['READY', 'ALREADY_APPLIED'].includes(report.status), true);
assert.deepEqual(report.affected_qr_ids, [
  'SSS00003', 'SSS00008', 'SSS00009'
]);
assert.equal(report.external_calls, 'NONE');
assert.equal(report.apply_performed, false);
assert.equal(report.postgres_state, report.json_state);
console.log(`PREFLIGHT_STATUS=${report.status}`);
console.log(`PREFLIGHT_POSTGRES_STATE=${report.postgres_state}`);
console.log(`PREFLIGHT_JSON_STATE=${report.json_state}`);
NODE

unset DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE
unset PGSSL PGSSLMODE PGOPTIONS PGAPPLICATION_NAME

REMAINING_CONNECTIONS="$(
  runuser -u postgres -- /usr/pgsql-15/bin/psql -X -At -d postgres \
    -c "SELECT count(*) FROM pg_stat_activity
        WHERE datname = '$EXPECTED_DATABASE'
          AND application_name =
            'xingxingzaishan-privacy-apply-preflight';"
)"
[ "$REMAINING_CONNECTIONS" = 0 ] || fail CONNECTION_LEAK
[ "$(sha256sum "$LIVE_DATABASE" | awk '{print $1}')" = "$LIVE_SHA" ] || \
  fail LIVE_DATABASE_CHANGED
[ "$(sha256sum "$SOURCE" | awk '{print $1}')" = \
  "$EXPECTED_SOURCE_SHA" ] || fail SOURCE_CHANGED
[ "$(sha256sum "$CANDIDATE" | awk '{print $1}')" = \
  "$EXPECTED_CANDIDATE_SHA" ] || fail CANDIDATE_CHANGED

APP_PID_AFTER="$(pm2 pid xingxingzaishan | tail -n 1)"
[ "$APP_PID_AFTER" = "$APP_PID" ] || fail RUNTIME_RESTARTED
stat -c 'RESULT_OWNER=%U:%G MODE=%a SIZE=%s PATH=%n' "$RESULT"
echo "CANDIDATE_PATH=$CANDIDATE"
echo "CANDIDATE_SHA256=$EXPECTED_CANDIDATE_SHA"
echo "CANDIDATE_DOMAIN_SHA256=$EXPECTED_CANDIDATE_DOMAIN_SHA"
echo "REMAINING_PREFLIGHT_CONNECTIONS=$REMAINING_CONNECTIONS"
echo 'CONTENT_PRIVACY_REMEDIATION_APPLY_PREFLIGHT=PASS'
echo 'PRODUCTION_JSON_WRITE=NONE'
echo 'PRODUCTION_DATABASE_WRITE=NONE'
echo 'OSS_ACCESS=NONE'
echo 'PRODUCTION_RUNTIME_RESTARTED=NO'
echo 'NEXT_ACTION=VALIDATE_RESUMABLE_APPLY_IN_ISOLATED_POSTGRES'
