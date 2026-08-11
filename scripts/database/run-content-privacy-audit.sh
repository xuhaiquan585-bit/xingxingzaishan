#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE=/root/public-qr-domain-marker-audit-20260811/production-db-source.json
EXPECTED_SOURCE_SHA=f263df13b5c19f91b0f86d93960f6b26896f3ed605318c73dd8546d110b06cfd
AUDIT_ROOT=/root/legacy-privacy-remediation-audit-20260812
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
AUDIT_DIR="$AUDIT_ROOT/$RUN_ID"
REPORT="$AUDIT_DIR/cross-account-phone-dry-run.json"

fail() {
  echo "CONTENT_PRIVACY_SNAPSHOT_AUDIT=BLOCKED_$1"
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail ROOT_REQUIRED
[ "$SOURCE" = \
  /root/public-qr-domain-marker-audit-20260811/production-db-source.json ] || \
  fail SOURCE_PATH_MISMATCH

cd "$REPO"
[ -f "$SOURCE" ] || fail SOURCE_MISSING
[ ! -L "$SOURCE" ] || fail SOURCE_SYMLINK_FORBIDDEN
[ "$(stat -c '%U:%G' "$SOURCE")" = root:root ] || fail SOURCE_OWNER_INVALID
[ "$(stat -c '%a' "$SOURCE")" = 600 ] || fail SOURCE_MODE_INVALID
[ "$(sha256sum "$SOURCE" | awk '{print $1}')" = \
  "$EXPECTED_SOURCE_SHA" ] || fail SOURCE_HASH_MISMATCH
[ "$(git status --porcelain)" = \
  "?? src/frontend/5QJLlAJPza.txt" ] || fail WORKTREE_STATE_INVALID

install -d -o root -g root -m 0700 "$AUDIT_DIR"
install -o root -g root -m 0600 /dev/null "$REPORT"

/usr/local/bin/node scripts/database/audit-cross-account-phone-content.js \
  --dry-run \
  --input="$SOURCE" \
  --expected-source-sha256="$EXPECTED_SOURCE_SHA" \
  > "$REPORT"

/usr/local/bin/node - "$REPORT" "$EXPECTED_SOURCE_SHA" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');

const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const expectedSource = process.argv[3];
assert.equal(report.mode, 'dry-run');
assert.equal(report.status, 'FINDINGS_CONFIRMED');
assert.equal(report.read_only, true);
assert.equal(report.postgres_connected, false);
assert.equal(report.source_sha256, expectedSource);
assert.equal(report.policy, 'cross-account-full-phone-v1');
assert.equal(report.finding_count, 3);
assert.equal(report.record_finding_count, 3);
assert.equal(report.comment_finding_count, 0);
assert.deepEqual(
  report.affected_qr_ids,
  ['SSS00003', 'SSS00008', 'SSS00009']
);
assert.equal(Number.isInteger(report.evidence_dependency_count), true);
assert.equal(Array.isArray(report.evidence_dependency_qr_ids), true);
assert.equal(report.evidence_dependency_count,
  report.evidence_dependency_qr_ids.length);
assert.equal(Number.isInteger(report.archive_dependency_count), true);
assert.equal(Array.isArray(report.archive_dependency_qr_ids), true);
assert.equal(report.archive_dependency_count,
  report.archive_dependency_qr_ids.length);
assert.equal(report.raw_identity_values_persisted, false);
assert.equal(report.raw_business_content_persisted, false);
assert.equal(report.production_database_access, 'NONE');
assert.equal(report.production_database_write, 'NONE');
for (const finding of report.findings) {
  assert.equal(finding.collection, 'records');
  assert.match(finding.content_sha256, /^[0-9a-f]{64}$/);
  assert.match(finding.proposed_content_sha256, /^[0-9a-f]{64}$/);
  assert.notEqual(finding.content_sha256, finding.proposed_content_sha256);
  assert.equal(finding.match_count > 0, true);
  assert.equal(finding.matched_identity_count > 0, true);
  assert.equal(typeof finding.evidence_dependency.present, 'boolean');
  assert.match(finding.evidence_dependency.proof_hash_kind,
    /^(?:NONE|SHA256|LEGACY)$/);
}
console.log('CONTENT_PRIVACY_FINDING_SET_GATE=PASS');
console.log(
  `CONTENT_PRIVACY_EVIDENCE_DEPENDENCY_COUNT=${
    report.evidence_dependency_count
  }`
);
console.log(
  `CONTENT_PRIVACY_EVIDENCE_DEPENDENCY_QR_IDS=${
    report.evidence_dependency_qr_ids.join(',') || 'NONE'
  }`
);
console.log(
  `CONTENT_PRIVACY_ARCHIVE_DEPENDENCY_COUNT=${
    report.archive_dependency_count
  }`
);
NODE

[ "$(sha256sum "$SOURCE" | awk '{print $1}')" = \
  "$EXPECTED_SOURCE_SHA" ] || fail SOURCE_CHANGED
[ "$(stat -c '%U:%G' "$REPORT")" = root:root ] || fail REPORT_OWNER_INVALID
[ "$(stat -c '%a' "$REPORT")" = 600 ] || fail REPORT_MODE_INVALID

APP_PID="$(pm2 pid xingxingzaishan | tail -n 1)"
[ -n "$APP_PID" ] || fail APP_PID_MISSING
HTTP_CODE="$(curl -sS -o /dev/null -w '%{http_code}' \
  --connect-timeout 5 --max-time 10 http://127.0.0.1:3000/)"
[ "$HTTP_CODE" = 200 ] || fail APP_HTTP_INVALID

for FLAG in \
  PUBLIC_QR_SHADOW_READ_ENABLED \
  PERSONAL_RECORD_SHADOW_READ_ENABLED \
  IDENTITY_SHADOW_READ_ENABLED \
  PUBLIC_QR_POSTGRES_READ_ENABLED \
  PERSONAL_RECORD_POSTGRES_READ_ENABLED \
  QR_LIFECYCLE_POSTGRES_WRITE_ENABLED \
  RECORD_PROOF_RUNTIME_ENABLED
do
  tr '\0' '\n' < "/proc/$APP_PID/environ" |
    grep -qx "${FLAG}=false" || fail "${FLAG}_NOT_FALSE"
done

if tr '\0' '\n' < "/proc/$APP_PID/environ" |
   grep -Eq '^(DATABASE_URL|PGPASSWORD)=.+$'; then
  fail DATABASE_SECRET_PRESENT
fi
if ss -tnp | grep ':5432' | grep -Fq "pid=$APP_PID,"; then
  fail POSTGRES_RUNTIME_CONNECTION_PRESENT
fi

echo "VALIDATED_HEAD=$(git rev-parse HEAD)"
echo "APP_PID=$APP_PID"
echo "APP_HTTP=$HTTP_CODE"
stat -c 'REPORT_OWNER=%U:%G MODE=%a SIZE=%s PATH=%n' "$REPORT"
echo "REPORT_SHA256=$(sha256sum "$REPORT" | awk '{print $1}')"
echo 'CONTENT_PRIVACY_SNAPSHOT_AUDIT=PASS'
echo 'EXPECTED_HISTORICAL_FINDING_COUNT=3'
echo 'PRODUCTION_SOURCE_UNCHANGED=YES'
echo 'PRODUCTION_DATABASE_ACCESS=NONE'
echo 'PRODUCTION_RUNTIME_RESTARTED=NO'
echo 'NEXT_ACTION=CLASSIFY_PROOF_DEPENDENCIES_BEFORE_REMEDIATION'
