'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  hasCrossAccountPhoneReference,
  redactCrossAccountPhoneReferences
} = require('../src/server/services/contentPrivacyService');
const {
  DEFAULT_JSON_DATABASE,
  auditFile,
  main,
  parseArguments,
  sha256
} = require('../scripts/database/audit-cross-account-phone-content');

const OWNER_PHONE = '13800000001';
const OTHER_PHONE = '13900000002';
const PRIVATE_PHRASE = 'private fixture phrase';

function identities() {
  return [
    { account_id: 'ACC_OWNER', phone: OWNER_PHONE },
    { account_id: 'ACC_OTHER', phone: OTHER_PHONE }
  ];
}

function sourceFixture() {
  const timestamp = '2026-08-12T00:00:00.000Z';
  return {
    accounts: [
      { id: 'ACC_OWNER', status: 'active', created_at: timestamp, updated_at: timestamp },
      { id: 'ACC_OTHER', status: 'active', created_at: timestamp, updated_at: timestamp }
    ],
    users: [
      {
        id: 1, account_id: 'ACC_OWNER', phone: OWNER_PHONE, source: 'web',
        created_at: timestamp, updated_at: timestamp
      },
      {
        id: 2, account_id: 'ACC_OTHER', phone: OTHER_PHONE, source: 'web',
        created_at: timestamp, updated_at: timestamp
      }
    ],
    qr_codes: [
      {
        id: 'QR_FOREIGN', issue_status: 'issued', activation_status: 'activated',
        account_id: 'ACC_OWNER', phone: OWNER_PHONE,
        content: `${PRIVATE_PHRASE} ${OTHER_PHONE}`,
        chain_status: 'confirmed', manifest_hash: 'a'.repeat(64),
        chain_tx_hash: 'fixture-transaction', chain_confirmed_at: timestamp,
        activated_at: timestamp, created_at: timestamp, updated_at: timestamp
      },
      {
        id: 'QR_OWNER', issue_status: 'issued', activation_status: 'activated',
        account_id: 'ACC_OWNER', phone: OWNER_PHONE,
        content: `owner reference ${OWNER_PHONE}`,
        activated_at: timestamp, created_at: timestamp, updated_at: timestamp
      },
      {
        id: 'QR_COMMENT', issue_status: 'issued', activation_status: 'co_creating',
        account_id: 'ACC_OWNER', phone: OWNER_PHONE, content: '',
        co_creation_enabled: true, co_creation_owner_account_id: 'ACC_OWNER',
        co_creation_owner_phone: OWNER_PHONE, co_creation_started_at: timestamp,
        co_creation_comments: [{
          id: 1, account_id: 'ACC_OWNER', phone: OWNER_PHONE,
          author_name: 'Owner', content: `comment ${OTHER_PHONE}`,
          status: 'kept', created_at: timestamp
        }],
        created_at: timestamp, updated_at: timestamp
      }
    ]
  };
}

function writeFixture(directory) {
  const filePath = path.join(directory, 'protected-source.json');
  const bytes = Buffer.from(JSON.stringify(sourceFixture()), 'utf8');
  fs.writeFileSync(filePath, bytes);
  return { filePath, sourceHash: sha256(bytes) };
}

test('privacy policy allows an owner phone and rejects another account full phone', () => {
  assert.equal(hasCrossAccountPhoneReference({
    ownerAccountId: 'ACC_OWNER',
    content: `owner ${OWNER_PHONE}`,
    identities: identities()
  }), false);
  assert.equal(hasCrossAccountPhoneReference({
    ownerAccountId: 'ACC_OWNER',
    content: `other ${OTHER_PHONE}`,
    identities: identities()
  }), true);
  assert.equal(hasCrossAccountPhoneReference({
    ownerAccountId: 'ACC_OWNER',
    content: 'masked 139****0002',
    identities: identities()
  }), false);
});

test('privacy redaction is deterministic and counts repeated exact matches', () => {
  const result = redactCrossAccountPhoneReferences({
    ownerAccountId: 'ACC_OWNER',
    content: `${OTHER_PHONE} / ${OTHER_PHONE}`,
    identities: identities()
  });
  assert.deepEqual(result, {
    content: '139****0002 / 139****0002',
    has_reference: true,
    match_count: 2,
    matched_identity_count: 1
  });
  assert.equal(Object.isFrozen(result), true);
});

test('privacy audit requires explicit dry-run, absolute snapshot, and source hash', () => {
  assert.throws(
    () => parseArguments([]),
    (error) => error.code === 'CONTENT_PRIVACY_AUDIT_DRY_RUN_REQUIRED'
  );
  assert.throws(
    () => parseArguments(['--dry-run']),
    (error) => error.code === 'CONTENT_PRIVACY_AUDIT_INPUT_REQUIRED'
  );
  assert.throws(
    () => parseArguments(['--dry-run', '--input=relative.json']),
    (error) => error.code === 'CONTENT_PRIVACY_AUDIT_ABSOLUTE_INPUT_REQUIRED'
  );
  assert.throws(
    () => auditFile({ inputPath: DEFAULT_JSON_DATABASE, expectedSha256: '0'.repeat(64) }),
    (error) => error.code === 'CONTENT_PRIVACY_AUDIT_RUNTIME_DATABASE_FORBIDDEN'
  );
});

test('privacy audit reports fingerprints and identifiers without raw sensitive values', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'content-privacy-audit-'));
  try {
    const fixture = writeFixture(directory);
    const before = fs.statSync(fixture.filePath, { bigint: true });
    const report = auditFile({
      inputPath: fixture.filePath,
      expectedSha256: fixture.sourceHash
    });
    const serialized = JSON.stringify(report);
    const after = fs.statSync(fixture.filePath, { bigint: true });

    assert.equal(report.status, 'FINDINGS_CONFIRMED');
    assert.equal(report.finding_count, 2);
    assert.equal(report.record_finding_count, 1);
    assert.equal(report.comment_finding_count, 1);
    assert.deepEqual(report.affected_qr_ids, ['QR_COMMENT', 'QR_FOREIGN']);
    assert.equal(report.schema_version, 2);
    assert.equal(report.evidence_dependency_count, 1);
    assert.deepEqual(report.evidence_dependency_qr_ids, ['QR_FOREIGN']);
    assert.equal(report.archive_dependency_count, 0);
    assert.deepEqual(report.archive_dependency_qr_ids, []);
    const foreign = report.findings.find((item) => item.qr_id === 'QR_FOREIGN');
    assert.deepEqual(foreign.evidence_dependency, {
      present: true,
      proof_status: 'confirmed',
      proof_hash_kind: 'SHA256',
      external_reference_present: true,
      archive_present: false,
      archive_status: null
    });
    const comment = report.findings.find((item) => item.qr_id === 'QR_COMMENT');
    assert.equal(comment.evidence_dependency.present, false);
    assert.equal(serialized.includes(OWNER_PHONE), false);
    assert.equal(serialized.includes(OTHER_PHONE), false);
    assert.equal(serialized.includes(PRIVATE_PHRASE), false);
    assert.equal(serialized.includes(fixture.filePath), false);
    assert.equal(report.raw_identity_values_persisted, false);
    assert.equal(report.raw_business_content_persisted, false);
    assert.equal(before.size, after.size);
    assert.equal(before.mtimeNs, after.mtimeNs);
    assert.equal(sha256(fs.readFileSync(fixture.filePath)), fixture.sourceHash);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('privacy audit CLI output stays sanitized', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'content-privacy-cli-'));
  try {
    const fixture = writeFixture(directory);
    let stdout = '';
    let stderr = '';
    const exitCode = main([
      '--dry-run',
      `--input=${fixture.filePath}`,
      `--expected-source-sha256=${fixture.sourceHash}`
    ], {
      stdout: { write(value) { stdout += value; } },
      stderr: { write(value) { stderr += value; } }
    });
    assert.equal(exitCode, 0);
    assert.equal(stderr, '');
    assert.equal(stdout.includes(OWNER_PHONE), false);
    assert.equal(stdout.includes(OTHER_PHONE), false);
    assert.equal(stdout.includes(PRIVATE_PHRASE), false);
    assert.equal(JSON.parse(stdout).finding_count, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
