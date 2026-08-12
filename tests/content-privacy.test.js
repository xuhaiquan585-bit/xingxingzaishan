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
const {
  assertPlanDelta,
  parseArguments: parseApplyArguments,
  readLiveDatabaseState,
  replaceLiveDatabase,
  validateArtifacts
} = require('../scripts/database/apply-content-privacy-remediation');
const {
  buildFinalSource,
  idempotencyKey,
  replaceLiveDatabaseWithFinal
} = require('../scripts/database/content-privacy-reproof');
const {
  parseArguments: parseReproofArguments,
  runtimeConfig: readControlledReproofConfig
} = require('../scripts/database/run-content-privacy-reproof');
const { mapSourceToPlan } = require('../scripts/database/importer/mapping');

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

function writeRemediationArtifacts(directory) {
  const sourceData = remediationSourceFixture();
  const sourceBytes = Buffer.from(JSON.stringify(sourceData), 'utf8');
  const sourceHash = sha256(sourceBytes);
  const prepared = prepareSource({
    source: sourceData,
    sourceHash,
    expectedQrIds: ['SSS00003', 'SSS00008', 'SSS00009'],
    remediatedAt: '2026-08-12T01:02:03.000Z'
  });
  const sourcePath = path.join(directory, 'source.json');
  const candidatePath = path.join(directory, 'candidate.json');
  const reportPath = path.join(directory, 'report.json');
  const liveDatabasePath = path.join(directory, 'live.json');
  fs.writeFileSync(sourcePath, sourceBytes);
  fs.writeFileSync(candidatePath, prepared.serialized);
  fs.writeFileSync(reportPath, `${JSON.stringify(prepared.report, null, 2)}\n`);
  fs.writeFileSync(liveDatabasePath, sourceBytes);
  return {
    prepared,
    options: {
      mode: 'preflight',
      sourcePath,
      candidatePath,
      reportPath,
      liveDatabasePath,
      expectedSourceSha256: sourceHash,
      expectedCandidateSha256: prepared.report.candidate_source_sha256,
      expectedSourceDomainSha256:
        prepared.report.source_public_qr_domain_sha256,
      expectedCandidateDomainSha256:
        prepared.report.candidate_public_qr_domain_sha256,
      expectedQrIds: Object.freeze(['SSS00003', 'SSS00008', 'SSS00009']),
      expectedDatabase: 'fixture_test'
    }
  };
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

test('privacy remediation apply requires an explicit mode and production gates', () => {
  assert.throws(
    () => parseApplyArguments([]),
    (error) => error.code === 'CONTENT_PRIVACY_APPLY_MODE_REQUIRED'
  );
  const common = [
    '--source=/tmp/source.json',
    '--candidate=/tmp/candidate.json',
    '--report=/tmp/report.json',
    '--live-database=/tmp/live.json',
    `--expected-source-sha256=${'1'.repeat(64)}`,
    `--expected-candidate-sha256=${'2'.repeat(64)}`,
    `--expected-source-domain-sha256=${'3'.repeat(64)}`,
    `--expected-candidate-domain-sha256=${'4'.repeat(64)}`,
    '--expected-qr-ids=SSS00003,SSS00008,SSS00009',
    '--expected-database=fixture_test'
  ];
  assert.equal(parseApplyArguments(['--preflight', ...common]).mode, 'preflight');
  assert.throws(
    () => parseApplyArguments(['--apply-production-snapshot', ...common]),
    (error) => error.code === 'CONTENT_PRIVACY_APPLY_CONFIRMATION_REQUIRED'
  );
  assert.equal(parseApplyArguments([
    '--apply-production-snapshot',
    '--production-confirmed',
    '--runtime-quiesced',
    ...common
  ]).mode, 'apply');
});

test('privacy remediation apply validates the exact candidate and approved plan delta', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-apply-artifacts-'));
  try {
    const fixture = writeRemediationArtifacts(directory);
    const artifacts = validateArtifacts(fixture.options);
    assert.deepEqual(artifacts.delta, {
      target_count: 3,
      proof_removal_count: 3,
      archive_removal_count: 2
    });
    assert.equal(artifacts.report.candidate_privacy_finding_count, 0);

    const sourcePlan = mapSourceToPlan(remediationSourceFixture()).plan;
    const driftedCandidate = JSON.parse(fixture.prepared.serialized);
    driftedCandidate.accounts[0].display_name = 'unapproved change';
    const candidatePlan = mapSourceToPlan(driftedCandidate).plan;
    assert.throws(
      () => assertPlanDelta({
        sourcePlan,
        candidatePlan,
        report: fixture.prepared.report,
        expectedQrIds: fixture.options.expectedQrIds
      }),
      (error) => error.code === 'CONTENT_PRIVACY_APPLY_UNAPPROVED_PLAN_DELTA'
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('privacy remediation live JSON replacement is atomic and resumable by hash', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-apply-json-'));
  try {
    const fixture = writeRemediationArtifacts(directory);
    const artifacts = validateArtifacts(fixture.options);
    assert.deepEqual(readLiveDatabaseState(fixture.options), {
      hash: fixture.options.expectedSourceSha256,
      state: 'source'
    });
    assert.deepEqual(replaceLiveDatabase({ options: fixture.options, artifacts }), {
      applied: true,
      state: 'candidate'
    });
    assert.equal(
      sha256(fs.readFileSync(fixture.options.liveDatabasePath)),
      fixture.options.expectedCandidateSha256
    );
    assert.deepEqual(replaceLiveDatabase({ options: fixture.options, artifacts }), {
      applied: false,
      state: 'candidate'
    });
    fs.writeFileSync(fixture.options.liveDatabasePath, '{}');
    assert.throws(
      () => readLiveDatabaseState(fixture.options),
      (error) => error.code === 'CONTENT_PRIVACY_APPLY_LIVE_DATABASE_DRIFT'
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('privacy reproof final source preserves operational evidence and exact timestamps', () => {
  const source = remediationSourceFixture();
  const prepared = prepareSource({
    source,
    sourceHash: sha256(Buffer.from(JSON.stringify(source), 'utf8')),
    expectedQrIds: ['SSS00003', 'SSS00008', 'SSS00009'],
    remediatedAt: '2026-08-12T01:02:03.000Z'
  });
  const candidate = JSON.parse(prepared.serialized);
  const candidatePlan = mapSourceToPlan(candidate).plan;
  const qrIds = prepared.report.affected_qr_ids;
  const qrs = new Map(candidatePlan.qr_codes
    .filter((row) => qrIds.includes(row.id))
    .map((row) => [row.id, row]));
  const records = new Map(candidatePlan.records
    .filter((row) => qrIds.includes(row.qr_id))
    .map((row) => [row.qr_id, {
      ...row,
      image_sha256: '9'.repeat(64),
      updated_at: '2026-08-12T01:03:00.000Z'
    }]));
  const proofs = new Map();
  const archives = new Map();
  const attempts = new Map();
  const jobs = new Map();
  qrIds.forEach((qrId, index) => {
    const proofId = `00000000-0000-4000-a000-${String(index + 1).padStart(12, '0')}`;
    proofs.set(qrId, {
      id: proofId,
      record_qr_id: qrId,
      provider: 'avata_wenchang',
      status: 'confirmed',
      operation_id: `record_${qrId}_fixture`,
      manifest_object_key: `records/${qrId}/manifest.json`,
      manifest_hash: String(index + 1).repeat(64),
      legacy_hash_snapshot: null,
      transaction_hash: `tx-${qrId}`,
      block_height: 100 + index,
      provider_record_id: `provider-${qrId}`,
      provider_certificate_url: `https://fixture.invalid/${qrId}.pdf`,
      certificate_object_key: null,
      certificate_object_url_snapshot: null,
      confirmed_at: '2026-08-12T01:04:00.000Z',
      callback_received_at: null,
      retry_count: 1,
      last_error: '',
      created_at: '2026-08-12T01:02:30.000Z',
      updated_at: '2026-08-12T01:04:00.000Z'
    });
    archives.set(qrId, {
      record_qr_id: qrId,
      manifest_object_key: `records/${qrId}/manifest.json`,
      legacy_manifest_object_key: null,
      index_object_key: `indexes/by-star/${qrId}.json`,
      status: 'ready',
      last_error: '',
      created_at: '2026-08-12T01:02:40.000Z',
      updated_at: '2026-08-12T01:02:40.000Z'
    });
    attempts.set(qrId, {
      record_qr_id: qrId,
      attempt_count: 1,
      succeeded_count: 1,
      pending_count: 0
    });
    jobs.set(qrId, {
      aggregate_id: qrId,
      status: 'succeeded',
      locked_at: null,
      locked_by: null
    });
  });
  const final = buildFinalSource({
    candidateSource: candidate,
    evidence: { qrIds, qrs, records, proofs, archives, attempts, jobs }
  });
  const finalPlan = mapSourceToPlan(final.source).plan;
  const finalProof = finalPlan.record_proofs.find(
    (row) => row.record_qr_id === 'SSS00003'
  );
  const finalRecord = finalPlan.records.find((row) => row.qr_id === 'SSS00003');
  assert.equal(finalProof.id, proofs.get('SSS00003').id);
  assert.equal(finalProof.created_at, '2026-08-12T01:02:30.000Z');
  assert.equal(finalProof.updated_at, '2026-08-12T01:04:00.000Z');
  assert.equal(finalRecord.updated_at, '2026-08-12T01:03:00.000Z');
  assert.equal(final.plan.proof_attempts.length, 0);
  assert.equal(final.source.qr_codes.find(
    (row) => row.id === 'SSS00003'
  ).chain_proof_id, proofs.get('SSS00003').id);
  assert.match(final.sourceHash, /^[0-9a-f]{64}$/);
  assert.match(final.domainHash, /^[0-9a-f]{64}$/);
});

test('privacy reproof final JSON replacement is candidate-hash gated and resumable', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-reproof-json-'));
  try {
    const live = path.join(directory, 'live.json');
    const candidateBytes = Buffer.from('{"state":"candidate"}\n');
    const final = {
      serialized: '{"state":"final"}\n',
      sourceHash: sha256(Buffer.from('{"state":"final"}\n'))
    };
    const candidateHash = sha256(candidateBytes);
    fs.writeFileSync(live, candidateBytes);
    assert.deepEqual(replaceLiveDatabaseWithFinal({
      liveDatabasePath: live,
      candidateHash,
      final
    }), { applied: true, sourceHash: final.sourceHash });
    assert.deepEqual(replaceLiveDatabaseWithFinal({
      liveDatabasePath: live,
      candidateHash,
      final
    }), { applied: false, sourceHash: final.sourceHash });
    fs.writeFileSync(live, '{}');
    assert.throws(
      () => replaceLiveDatabaseWithFinal({ liveDatabasePath: live, candidateHash, final }),
      (error) => error.code === 'CONTENT_PRIVACY_REPROOF_LIVE_DATABASE_DRIFT'
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('controlled privacy reproof requires exact provider and provenance gates', () => {
  const options = parseReproofArguments([
    '--preflight',
    '--candidate=/tmp/candidate.json',
    '--live-database=/tmp/live.json',
    `--expected-candidate-sha256=${'1'.repeat(64)}`,
    `--expected-candidate-domain-sha256=${'2'.repeat(64)}`,
    '--expected-qr-ids=SSS00003,SSS00008,SSS00009',
    '--expected-database=fixture_test'
  ]);
  assert.deepEqual(options.qrIds, ['SSS00003', 'SSS00008', 'SSS00009']);
  assert.throws(
    () => readControlledReproofConfig(options, {}),
    (error) => error.code === 'CONTENT_PRIVACY_REPROOF_RUNTIME_CONFIG_INVALID'
  );
  const config = readControlledReproofConfig(options, {
    CHAIN_ENABLED: 'true',
    CHAIN_CALLBACK_URL: 'https://fixture.invalid/callback',
    AVATA_API_KEY: 'fixture-key',
    AVATA_API_SECRET: 'fixture-secret',
    AVATA_IDENTITY_NAME: 'fixture-name',
    AVATA_IDENTITY_NUM: 'fixture-number'
  });
  assert.equal(config.enabled, true);
  assert.equal(config.scope, 'allowlist');
  assert.deepEqual([...config.allowlist].sort(), options.qrIds);
});
