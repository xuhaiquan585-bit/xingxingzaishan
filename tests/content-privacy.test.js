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
const {
  MAX_REDACTION_ROUNDS,
  prepareFiles,
  prepareSource,
  runBoundedRedactionRounds
} = require('../scripts/database/prepare-content-privacy-remediation');

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

function remediationSourceFixture() {
  const timestamp = '2026-08-12T00:00:00.000Z';
  const source = sourceFixture();
  source.qr_codes = ['SSS00003', 'SSS00008', 'SSS00009'].map((id, index) => ({
    id,
    issue_status: 'issued',
    activation_status: 'activated',
    account_id: 'ACC_OWNER',
    phone: OWNER_PHONE,
    content: `${PRIVATE_PHRASE} ${index} ${OTHER_PHONE}`,
    chain_provider: 'avata_wenchang',
    chain_status: 'confirmed',
    chain_operation_id: `operation-${index}`,
    manifest_object_key: `stars/${id}/record_manifest.json`,
    manifest_hash: String(index + 1).repeat(64),
    chain_tx_hash: `transaction-${index}`,
    chain_record_id: `provider-record-${index}`,
    chain_confirmed_at: timestamp,
    archive_index_object_key: index > 0 ? `indexes/by-star/${id}.json` : null,
    archive_status: index > 0 ? 'ready' : 'not_started',
    archive_updated_at: index > 0 ? timestamp : null,
    activated_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp
  }));
  return source;
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

test('privacy remediation preparation redacts only the exact approved records', () => {
  const source = remediationSourceFixture();
  const sourceBytes = Buffer.from(JSON.stringify(source), 'utf8');
  const before = JSON.stringify(source);
  const prepared = prepareSource({
    source,
    sourceHash: sha256(sourceBytes),
    expectedQrIds: ['SSS00003', 'SSS00008', 'SSS00009'],
    remediatedAt: '2026-08-12T01:02:03.000Z'
  });
  const candidate = JSON.parse(prepared.serialized);

  assert.equal(JSON.stringify(source), before);
  assert.equal(prepared.report.status, 'READY');
  assert.equal(prepared.report.apply_performed, false);
  assert.equal(prepared.report.candidate_privacy_finding_count, 0);
  assert.equal(prepared.report.proof_rows_removed_from_candidate, 3);
  assert.equal(prepared.report.archive_rows_removed_from_candidate, 2);
  assert.equal(prepared.report.record_count_before, 3);
  assert.equal(prepared.report.record_count_after, 3);
  assert.equal(prepared.report.revisions.length, 3);
  assert.equal(prepared.report.redaction_round_count, 1);
  assert.equal(JSON.stringify(prepared.report).includes(OWNER_PHONE), false);
  assert.equal(JSON.stringify(prepared.report).includes(OTHER_PHONE), false);
  assert.equal(JSON.stringify(prepared.report).includes(PRIVATE_PHRASE), false);
  for (const row of candidate.qr_codes) {
    assert.match(row.content, /139\*\*\*\*0002/);
    assert.equal(row.content.includes(OTHER_PHONE), false);
    assert.equal(row.chain_status, 'not_started');
    assert.equal(row.manifest_hash, null);
    assert.equal(row.chain_tx_hash, null);
    assert.equal(row.archive_status, 'not_started');
    assert.equal(row.updated_at, '2026-08-12T01:02:03.000Z');
  }
  for (const revision of prepared.report.revisions) {
    assert.equal(revision.redaction_round_count, 1);
    assert.equal(revision.redaction_rounds.length, 1);
  }

  assert.throws(
    () => prepareSource({
      source,
      sourceHash: sha256(sourceBytes),
      expectedQrIds: ['SSS00003'],
      remediatedAt: '2026-08-12T01:02:03.000Z'
    }),
    (error) => error.code === 'CONTENT_PRIVACY_REMEDIATION_FINDING_SET_MISMATCH'
  );
});

test('privacy remediation runs bounded rounds until the approved scope is clean', () => {
  const finding = (qrId) => ({ qr_id: qrId, collection: 'records' });
  const audits = [
    {
      status: 'FINDINGS_CONFIRMED', finding_count: 3,
      findings: ['SSS00003', 'SSS00008', 'SSS00009'].map(finding)
    },
    {
      status: 'FINDINGS_CONFIRMED', finding_count: 2,
      findings: ['SSS00003', 'SSS00009'].map(finding)
    },
    { status: 'CLEAN', finding_count: 0, findings: [] }
  ];
  const applied = [];
  let auditIndex = 0;
  const result = runBoundedRedactionRounds({
    initialAudit: audits[0],
    expectedQrIds: ['SSS00003', 'SSS00008', 'SSS00009'],
    applyRound({ audit, round }) {
      applied.push({ round, ids: audit.findings.map((item) => item.qr_id) });
    },
    analyzeAfterRound() {
      auditIndex += 1;
      return audits[auditIndex];
    }
  });

  assert.equal(MAX_REDACTION_ROUNDS, 8);
  assert.equal(result.roundCount, 2);
  assert.equal(result.afterAudit.status, 'CLEAN');
  assert.deepEqual(applied, [
    { round: 1, ids: ['SSS00003', 'SSS00008', 'SSS00009'] },
    { round: 2, ids: ['SSS00003', 'SSS00009'] }
  ]);
});

test('privacy remediation blocks any residual finding outside the approved scope', () => {
  assert.throws(
    () => runBoundedRedactionRounds({
      initialAudit: {
        status: 'FINDINGS_CONFIRMED',
        finding_count: 1,
        findings: [{ qr_id: 'UNAPPROVED', collection: 'records' }]
      },
      expectedQrIds: ['SSS00003'],
      applyRound() {},
      analyzeAfterRound() {
        return { status: 'CLEAN', finding_count: 0, findings: [] };
      }
    }),
    (error) => error.code === 'CONTENT_PRIVACY_REMEDIATION_SCOPE_EXPANDED'
  );
});

test('privacy remediation blocks an approved finding set that does not converge', () => {
  const audit = {
    status: 'FINDINGS_CONFIRMED',
    finding_count: 1,
    findings: [{ qr_id: 'SSS00003', collection: 'records' }]
  };
  let appliedRounds = 0;
  assert.throws(
    () => runBoundedRedactionRounds({
      initialAudit: audit,
      expectedQrIds: ['SSS00003'],
      maxRounds: 2,
      applyRound() { appliedRounds += 1; },
      analyzeAfterRound() { return audit; }
    }),
    (error) => error.code === 'CONTENT_PRIVACY_REMEDIATION_NOT_CONVERGED'
  );
  assert.equal(appliedRounds, 2);
});

test('privacy remediation preparation writes protected outputs without changing input', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-remediation-'));
  try {
    const input = path.join(directory, 'protected-source.json');
    const candidate = path.join(directory, 'candidate.json');
    const report = path.join(directory, 'report.json');
    const inputBytes = Buffer.from(JSON.stringify(remediationSourceFixture()), 'utf8');
    fs.writeFileSync(input, inputBytes);
    const result = prepareFiles({
      inputPath: input,
      expectedSourceSha256: sha256(inputBytes),
      expectedQrIds: ['SSS00003', 'SSS00008', 'SSS00009'],
      remediatedAt: '2026-08-12T01:02:03.000Z',
      candidateOutput: candidate,
      reportOutput: report
    });

    assert.equal(result.status, 'READY');
    assert.equal(fs.existsSync(candidate), true);
    assert.equal(fs.existsSync(report), true);
    assert.equal(sha256(fs.readFileSync(input)), sha256(inputBytes));
    assert.equal(JSON.parse(fs.readFileSync(report, 'utf8')).apply_performed, false);
    assert.throws(
      () => prepareFiles({
        inputPath: input,
        expectedSourceSha256: sha256(inputBytes),
        expectedQrIds: ['SSS00003', 'SSS00008', 'SSS00009'],
        remediatedAt: '2026-08-12T01:02:03.000Z',
        candidateOutput: candidate,
        reportOutput: report
      }),
      (error) => error.code === 'CONTENT_PRIVACY_REMEDIATION_OUTPUT_EXISTS'
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
