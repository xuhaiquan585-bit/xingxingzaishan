#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE=/root/public-qr-domain-marker-audit-20260811/production-db-source.json
EXPECTED_SOURCE_SHA=f263df13b5c19f91b0f86d93960f6b26896f3ed605318c73dd8546d110b06cfd
EXPECTED_DOMAIN_SHA=b4563b804ffa6e6789882b782584f2916a9f503fb07a7849178b40ae1bbb6fd0
EXPECTED_QR_IDS=SSS00003,SSS00008,SSS00009
AUDIT_ROOT=/root/legacy-privacy-remediation-preparation-audit-20260812
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
AUDIT_DIR="$AUDIT_ROOT/$RUN_ID"
CANDIDATE="$AUDIT_DIR/candidate-db.json"
REPORT="$AUDIT_DIR/preparation-report.json"
REMEDIATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

fail() {
  echo "CONTENT_PRIVACY_REMEDIATION_PREPARATION=BLOCKED_$1"
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail ROOT_REQUIRED
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

/usr/local/bin/node scripts/database/prepare-content-privacy-remediation.js \
  --prepare \
  --input="$SOURCE" \
  --expected-source-sha256="$EXPECTED_SOURCE_SHA" \
  --expected-qr-ids="$EXPECTED_QR_IDS" \
  --remediated-at="$REMEDIATED_AT" \
  --candidate-output="$CANDIDATE" \
  --report-output="$REPORT"

/usr/local/bin/node - \
  "$REPORT" \
  "$CANDIDATE" \
  "$EXPECTED_SOURCE_SHA" \
  "$EXPECTED_DOMAIN_SHA" <<'NODE'
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');

const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const candidateBytes = fs.readFileSync(process.argv[3]);
const expectedSource = process.argv[4];
const expectedDomain = process.argv[5];
const candidateSha = crypto.createHash('sha256')
  .update(candidateBytes).digest('hex');

assert.equal(report.mode, 'prepare');
assert.equal(report.status, 'READY');
assert.equal(report.apply_performed, false);
assert.equal(report.strategy, 'PRELAUNCH_TEST_DATA_REDACT_AND_REPROOF');
assert.equal(report.policy, 'cross-account-full-phone-v1');
assert.equal(report.source_sha256, expectedSource);
assert.equal(report.source_public_qr_domain_sha256, expectedDomain);
assert.equal(report.candidate_source_sha256, candidateSha);
assert.notEqual(report.candidate_source_sha256, expectedSource);
assert.notEqual(report.candidate_public_qr_domain_sha256, expectedDomain);
assert.deepEqual(
  report.affected_qr_ids,
  ['SSS00003', 'SSS00008', 'SSS00009']
);
assert.equal(report.finding_count, 3);
assert.equal(report.evidence_dependency_count, 3);
assert.equal(report.archive_dependency_count, 2);
assert.equal(report.proof_rows_removed_from_candidate, 3);
assert.equal(report.archive_rows_removed_from_candidate, 2);
assert.equal(report.record_count_before, 56);
assert.equal(report.record_count_after, 56);
assert.equal(report.revisions.length, 3);
assert.equal(report.candidate_privacy_finding_count, 0);
assert.equal(report.raw_identity_values_persisted_in_report, false);
assert.equal(report.raw_business_content_persisted_in_report, false);
assert.equal(report.production_database_access, 'NONE');
assert.equal(report.production_database_write, 'NONE');
assert.equal(report.production_json_write, 'NONE');
assert.equal(report.oss_access, 'NONE');
assert.equal(report.oss_write, 'NONE');
for (const revision of report.revisions) {
  assert.match(revision.previous_content_sha256, /^[0-9a-f]{64}$/);
  assert.match(revision.revised_content_sha256, /^[0-9a-f]{64}$/);
  assert.match(revision.previous_evidence_sha256, /^[0-9a-f]{64}$/);
  assert.notEqual(
    revision.previous_content_sha256,
    revision.revised_content_sha256
  );
  assert.equal(revision.previous_proof_status, 'confirmed');
}

console.log('CONTENT_PRIVACY_REMEDIATION_CANDIDATE_GATE=PASS');
console.log(`CANDIDATE_SOURCE_SHA256=${report.candidate_source_sha256}`);
console.log(
  `CANDIDATE_PUBLIC_QR_DOMAIN_SHA256=${
    report.candidate_public_qr_domain_sha256
  }`
);
NODE

[ "$(sha256sum "$SOURCE" | awk '{print $1}')" = \
  "$EXPECTED_SOURCE_SHA" ] || fail SOURCE_CHANGED
[ "$(stat -c '%U:%G' "$CANDIDATE")" = root:root ] || \
  fail CANDIDATE_OWNER_INVALID
[ "$(stat -c '%a' "$CANDIDATE")" = 600 ] || \
  fail CANDIDATE_MODE_INVALID
[ "$(stat -c '%U:%G' "$REPORT")" = root:root ] || \
  fail REPORT_OWNER_INVALID
[ "$(stat -c '%a' "$REPORT")" = 600 ] || fail REPORT_MODE_INVALID

APP_PID="$(pm2 pid xingxingzaishan | tail -n 1)"
[ -n "$APP_PID" ] || fail APP_PID_MISSING
HTTP_CODE="$(curl -sS -o /dev/null -w '%{http_code}' \
  --connect-timeout 5 --max-time 10 http://127.0.0.1:3000/)"
[ "$HTTP_CODE" = 200 ] || fail APP_HTTP_INVALID

if ss -tnp | grep ':5432' | grep -Fq "pid=$APP_PID,"; then
  fail POSTGRES_RUNTIME_CONNECTION_PRESENT
fi

echo "VALIDATED_HEAD=$(git rev-parse HEAD)"
echo "APP_PID=$APP_PID"
echo "APP_HTTP=$HTTP_CODE"
stat -c 'OWNER=%U:%G MODE=%a SIZE=%s PATH=%n' "$CANDIDATE" "$REPORT"
echo 'CONTENT_PRIVACY_REMEDIATION_PREPARATION=PASS'
echo 'CANDIDATE_PRIVACY_FINDINGS=0'
echo 'OLD_PROOF_REFERENCES_REMOVED_FROM_CANDIDATE=3'
echo 'OLD_ARCHIVE_REFERENCES_REMOVED_FROM_CANDIDATE=2'
echo 'PRODUCTION_DATABASE_ACCESS=NONE'
echo 'PRODUCTION_JSON_WRITE=NONE'
echo 'OSS_ACCESS=NONE'
echo 'PRODUCTION_RUNTIME_RESTARTED=NO'
echo 'NEXT_ACTION=BUILD_RESUMABLE_APPLY_AND_REPROOF'
