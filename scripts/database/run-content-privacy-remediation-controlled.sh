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
AUDIT_ROOT=/root/legacy-privacy-remediation-controlled-audit-20260812
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
AUDIT_DIR="$AUDIT_ROOT/$RUN_ID"
APPLY_RESULT="$AUDIT_DIR/apply-result.json"
REPROOF_RESULT="$AUDIT_DIR/reproof-result.json"
PREFLIGHT_RESULT="$AUDIT_DIR/resume-preflight.json"
SUMMARY="$AUDIT_DIR/validation-summary.txt"
CONFIRMATION="${CONTENT_PRIVACY_PRODUCTION_APPLY_CONFIRMATION:-}"
PROVIDER_ENV="${CONTENT_PRIVACY_PROVIDER_ENV:-}"
EXPECTED_PROVIDER_ENV="${CONTENT_PRIVACY_EXPECTED_AVATA_ENV:-}"
EXPECTED_PROVIDER_ORIGIN="${CONTENT_PRIVACY_EXPECTED_AVATA_ORIGIN:-}"
RUNTIME_STOPPED=false

fail() {
  echo "CONTENT_PRIVACY_CONTROLLED_APPLY=BLOCKED_$1" >&2
  exit 1
}

unset_runtime_environment() {
  unset DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE
  unset PGSSL PGSSLMODE PGOPTIONS PGAPPLICATION_NAME
  unset AVATA_API_KEY AVATA_API_SECRET AVATA_IDENTITY_NAME AVATA_IDENTITY_NUM
  unset AVATA_API_BASE AVATA_ENV AVATA_PROJECT_ID AVATA_CHAIN_ID
  unset AVATA_IDENTITY_TYPE AVATA_RECORD_TYPE AVATA_HASH_TYPE
  unset CHAIN_ENABLED CHAIN_CALLBACK_URL
  unset RECORD_PROOF_RUNTIME_ENABLED RECORD_PROOF_RUNTIME_SCOPE
  unset RECORD_PROOF_RUNTIME_ALLOWLIST RECORD_PROOF_RUNTIME_SOURCE_SHA256
  unset RECORD_PROOF_RUNTIME_DOMAIN_SHA256 RECORD_PROOF_WORKER_ID
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

restart_default_runtime() {
  unset_runtime_environment
  pm2 restart xingxingzaishan >/dev/null
  local attempt app_pid http_code
  for attempt in $(seq 1 20); do
    app_pid="$(pm2 pid xingxingzaishan | tail -n 1)"
    http_code="$(
      curl -sS -o /dev/null -w '%{http_code}' \
        --connect-timeout 2 --max-time 5 \
        http://127.0.0.1:3000/ 2>/dev/null || true
    )"
    if [ -n "$app_pid" ] && [ "$app_pid" != 0 ] && [ "$http_code" = 200 ]; then
      assert_default_off "$app_pid" || return 1
      if ss -tnp | grep ':5432' | grep -Fq "pid=$app_pid,"; then
        return 1
      fi
      echo "APP_PID=$app_pid"
      echo "APP_HTTP=$http_code"
      return 0
    fi
    sleep 1
  done
  return 1
}

cleanup() {
  local exit_code=$?
  trap - EXIT
  if [ "$RUNTIME_STOPPED" = true ]; then
    if restart_default_runtime; then
      echo 'PRODUCTION_RUNTIME_RECOVERY=PASS'
    else
      echo 'PRODUCTION_RUNTIME_RECOVERY=FAILED' >&2
      exit_code=1
    fi
  fi
  if [ "$exit_code" -ne 0 ]; then
    echo "CONTROLLED_RUN_AUDIT_DIR=$AUDIT_DIR" >&2
  fi
  exit "$exit_code"
}
trap cleanup EXIT

[ "$(id -u)" -eq 0 ] || fail ROOT_REQUIRED
[ "$CONFIRMATION" = "$EXPECTED_CANDIDATE_SHA" ] || fail CONFIRMATION_REQUIRED
[ -n "$PROVIDER_ENV" ] && [[ "$PROVIDER_ENV" = /* ]] || fail PROVIDER_ENV_REQUIRED
case "$EXPECTED_PROVIDER_ENV" in
  stage|prod) ;;
  *) fail PROVIDER_ENVIRONMENT_CONFIRMATION_REQUIRED ;;
esac
[ -n "$EXPECTED_PROVIDER_ORIGIN" ] || fail PROVIDER_ORIGIN_CONFIRMATION_REQUIRED
[ -f "$PROVIDER_ENV" ] && [ ! -L "$PROVIDER_ENV" ] || fail PROVIDER_ENV_INVALID
[ "$(stat -c '%U:%G' "$PROVIDER_ENV")" = root:root ] || fail PROVIDER_ENV_OWNER_INVALID
[ "$(stat -c '%a' "$PROVIDER_ENV")" = 600 ] || fail PROVIDER_ENV_MODE_INVALID
[ -f "$WRITER_ENV" ] && [ ! -L "$WRITER_ENV" ] || fail WRITER_ENV_INVALID
[ "$(stat -c '%U:%G' "$WRITER_ENV")" = root:root ] || fail WRITER_ENV_OWNER_INVALID
[ "$(stat -c '%a' "$WRITER_ENV")" = 600 ] || fail WRITER_ENV_MODE_INVALID
command -v timeout >/dev/null 2>&1 || fail TIMEOUT_COMMAND_REQUIRED

cd "$REPO"
[ -z "$(git status --porcelain --untracked-files=no)" ] || fail TRACKED_WORKTREE_DIRTY
[ -f "$SOURCE" ] && [ ! -L "$SOURCE" ] || fail SOURCE_INVALID
[ "$(sha256sum "$SOURCE" | awk '{print $1}')" = "$EXPECTED_SOURCE_SHA" ] || \
  fail SOURCE_HASH_MISMATCH

mapfile -t CANDIDATES < <(
  find "$PREPARATION_ROOT" -mindepth 2 -maxdepth 2 \
    -type f -name candidate-db.json -print0 |
    xargs -0 -r sha256sum |
    awk -v expected="$EXPECTED_CANDIDATE_SHA" '$1 == expected { print $2 }'
)
[ "${#CANDIDATES[@]}" -eq 1 ] || fail CANDIDATE_NOT_UNIQUE
CANDIDATE="${CANDIDATES[0]}"
REPORT="$(dirname "$CANDIDATE")/preparation-report.json"
[ -f "$REPORT" ] && [ ! -L "$REPORT" ] || fail REPORT_INVALID

for FILE in "$CANDIDATE" "$REPORT"; do
  [ "$(stat -c '%U:%G' "$FILE")" = root:root ] || fail ARTIFACT_OWNER_INVALID
  [ "$(stat -c '%a' "$FILE")" = 600 ] || fail ARTIFACT_MODE_INVALID
done

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
for FILE in "$APPLY_RESULT" "$REPROOF_RESULT" "$PREFLIGHT_RESULT" "$SUMMARY"; do
  install -o root -g root -m 0600 /dev/null "$FILE"
done

LIVE_SHA="$(sha256sum "$LIVE_DATABASE" | awk '{print $1}')"
unset_runtime_environment
set -a
. "$PROVIDER_ENV"
. "$WRITER_ENV"
set +a
[ "$PGDATABASE" = "$EXPECTED_DATABASE" ] || fail DATABASE_MISMATCH
export CONTENT_PRIVACY_EXPECTED_AVATA_ENV="$EXPECTED_PROVIDER_ENV"
export CONTENT_PRIVACY_EXPECTED_AVATA_ORIGIN="$EXPECTED_PROVIDER_ORIGIN"

/usr/local/bin/node - <<'NODE'
const { readRecordProofRuntimeConfig } = require(
  './src/server/services/postgres/recordProofRuntimeConfig'
);
const config = readRecordProofRuntimeConfig({
  ...process.env,
  RECORD_PROOF_RUNTIME_ENABLED: 'true',
  RECORD_PROOF_RUNTIME_SCOPE: 'allowlist',
  RECORD_PROOF_RUNTIME_ALLOWLIST: 'SSS00003,SSS00008,SSS00009',
  RECORD_PROOF_RUNTIME_SOURCE_SHA256:
    '93def24ee6dd4de63fd4ebf776a0a2056d2563df492727231b8f6de08ec0c7ee',
  RECORD_PROOF_RUNTIME_DOMAIN_SHA256:
    'be64b9b040d8b188b8bae9fb63e87621263bca9d8b76d40bf8c8ed302f08fa9d',
  RECORD_PROOF_WORKER_ID: 'privacy-reproof-production-gate'
});
if (!config.enabled) throw new Error(`PROVIDER_GATE_${config.reason}`);
const normalizedEnvironment = (() => {
  const value = String(process.env.AVATA_ENV || '').trim().toLowerCase();
  if (value === 'prod' || value === 'production') return 'prod';
  if (value === 'stage' || value === 'staging') return 'stage';
  throw new Error('PROVIDER_GATE_AVATA_ENV_EXPLICIT_REQUIRED');
})();
const expectedEnvironment = process.env.CONTENT_PRIVACY_EXPECTED_AVATA_ENV;
if (normalizedEnvironment !== expectedEnvironment) {
  throw new Error('PROVIDER_GATE_AVATA_ENV_MISMATCH');
}
const defaultOrigin = normalizedEnvironment === 'prod'
  ? 'https://apis.avata.bianjie.ai'
  : 'https://stage.apis.avata.bianjie.ai';
const actualBase = new URL(String(process.env.AVATA_API_BASE || defaultOrigin));
const expectedOrigin = new URL(
  String(process.env.CONTENT_PRIVACY_EXPECTED_AVATA_ORIGIN || '')
);
if (actualBase.protocol !== 'https:'
    || actualBase.username || actualBase.password
    || expectedOrigin.protocol !== 'https:'
    || expectedOrigin.username || expectedOrigin.password
    || expectedOrigin.pathname !== '/'
    || expectedOrigin.search || expectedOrigin.hash
    || actualBase.origin !== expectedOrigin.origin) {
  throw new Error('PROVIDER_GATE_AVATA_ORIGIN_MISMATCH');
}
console.log('CONTROLLED_PROVIDER_CONFIGURATION_GATE=PASS');
console.log(`CONTROLLED_PROVIDER_ENVIRONMENT=${normalizedEnvironment}`);
console.log(`CONTROLLED_PROVIDER_ORIGIN=${actualBase.origin}`);
NODE

if [ "$LIVE_SHA" = "$EXPECTED_SOURCE_SHA" ]; then
  unset_runtime_environment
  npm run privacy:apply:preflight:production-snapshot >/dev/null
  set -a
  . "$PROVIDER_ENV"
  . "$WRITER_ENV"
  set +a
  echo 'CONTROLLED_RESUME_PHASE=SOURCE_READY'
else
  export PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=15000ms'
  export PGAPPLICATION_NAME=xingxingzaishan-privacy-reproof-preflight
  /usr/local/bin/node scripts/database/run-content-privacy-reproof.js \
    --preflight \
    --candidate="$CANDIDATE" \
    --live-database="$LIVE_DATABASE" \
    --expected-candidate-sha256="$EXPECTED_CANDIDATE_SHA" \
    --expected-candidate-domain-sha256="$EXPECTED_CANDIDATE_DOMAIN_SHA" \
    --expected-qr-ids="$EXPECTED_QR_IDS" \
    --expected-database="$EXPECTED_DATABASE" \
    > "$PREFLIGHT_RESULT"
  cat "$PREFLIGHT_RESULT"
  PREFLIGHT_STATUS="$(
    /usr/local/bin/node -e \
      "console.log(require(process.argv[1]).status)" "$PREFLIGHT_RESULT"
  )"
  if [ "$PREFLIGHT_STATUS" = ALREADY_COMPLETED ]; then
    echo 'CONTENT_PRIVACY_CONTROLLED_APPLY=ALREADY_COMPLETED'
    echo 'PRODUCTION_RUNTIME_RESTARTED=NO'
    echo 'NEXT_ACTION=RUN_POST_REMEDIATION_JOINT_REHEARSAL'
    exit 0
  fi
fi

unset PGOPTIONS PGAPPLICATION_NAME
pm2 stop xingxingzaishan >/dev/null
RUNTIME_STOPPED=true

if [ "$LIVE_SHA" = "$EXPECTED_SOURCE_SHA" ]; then
  /usr/local/bin/node scripts/database/apply-content-privacy-remediation.js \
    --apply-production-snapshot \
    --production-confirmed \
    --runtime-quiesced \
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
    > "$APPLY_RESULT"
else
  printf '%s\n' '{"status":"RESUME_EXISTING_CANDIDATE"}' > "$APPLY_RESULT"
fi

timeout --signal=TERM --kill-after=30s 1900s \
  /usr/local/bin/node scripts/database/run-content-privacy-reproof.js \
  --execute-controlled \
  --candidate="$CANDIDATE" \
  --live-database="$LIVE_DATABASE" \
  --expected-candidate-sha256="$EXPECTED_CANDIDATE_SHA" \
  --expected-candidate-domain-sha256="$EXPECTED_CANDIDATE_DOMAIN_SHA" \
  --expected-qr-ids="$EXPECTED_QR_IDS" \
  --expected-database="$EXPECTED_DATABASE" \
  --max-seconds=1800 \
  --poll-ms=3000 \
  > "$REPROOF_RESULT"

/usr/local/bin/node - "$REPROOF_RESULT" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const result = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
assert.equal(['COMPLETED', 'ALREADY_COMPLETED'].includes(result.status), true);
assert.deepEqual(result.affected_qr_ids, ['SSS00003', 'SSS00008', 'SSS00009']);
assert.match(result.final_source_sha256, /^[0-9a-f]{64}$/);
assert.match(result.final_public_qr_domain_sha256, /^[0-9a-f]{64}$/);
assert.equal(result.operational_proof_attempts_preserved, true);
console.log(`FINAL_SOURCE_SHA256=${result.final_source_sha256}`);
console.log(`FINAL_PUBLIC_QR_DOMAIN_SHA256=${result.final_public_qr_domain_sha256}`);
console.log('CONTROLLED_REPROOF_RESULT_GATE=PASS');
NODE

unset_runtime_environment
restart_default_runtime
RUNTIME_STOPPED=false

FINAL_SHA="$(sha256sum "$LIVE_DATABASE" | awk '{print $1}')"
RESULT_FINAL_SHA="$(
  /usr/local/bin/node -e \
    "console.log(require(process.argv[1]).final_source_sha256)" "$REPROOF_RESULT"
)"
[ "$FINAL_SHA" = "$RESULT_FINAL_SHA" ] || fail FINAL_JSON_HASH_MISMATCH

printf '%s\n' \
  'CONTENT_PRIVACY_CONTROLLED_APPLY_AND_REPROOF=PASS' \
  'AFFECTED_QR_IDS=SSS00003,SSS00008,SSS00009' \
  "FINAL_SOURCE_SHA256=$FINAL_SHA" \
  'PROOF_ATTEMPT_HISTORY_PRESERVED=YES' \
  'PRODUCTION_RUNTIME_DEFAULT_OFF=YES' \
  'NEXT_ACTION=RUN_POST_REMEDIATION_JOINT_REHEARSAL' \
  > "$SUMMARY"

stat -c 'OWNER=%U:%G MODE=%a SIZE=%s PATH=%n' \
  "$APPLY_RESULT" "$REPROOF_RESULT" "$SUMMARY"
echo 'CONTENT_PRIVACY_CONTROLLED_APPLY_AND_REPROOF=PASS'
echo 'PRODUCTION_RUNTIME_DEFAULT_OFF=YES'
echo 'NEXT_ACTION=RUN_POST_REMEDIATION_JOINT_REHEARSAL'
