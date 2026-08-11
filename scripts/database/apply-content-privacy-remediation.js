#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  closePostgresPool,
  createPostgresPool,
  sanitizePostgresError
} = require('../../src/server/database/connection');
const { readPostgresConfig } = require('../../src/server/database/config');
const { withTransaction } = require('../../src/server/database/transaction');
const { analyzeSource } = require('./audit-cross-account-phone-content');
const { inspectMigrationState, loadMigrations } = require('./migrate');
const {
  PUBLIC_QR_DOMAIN_CHECKSUM_KEY,
  publicQrDomainSha256
} = require('./importer/domain-markers');
const { mapSourceToPlan } = require('./importer/mapping');
const {
  assertSourceUnchanged,
  readSourceSnapshot,
  sha256
} = require('./importer/reader');
const { IMPORT_ORDER, planSha256 } = require('./importer/writer');
const { verifyImportedPlan } = require('./importer/verify-import');

const APPLY_LOCK_KEY = 'xingxingzaishan:content-privacy-remediation:v1';
const IMPORTER_VERSION = 'content-privacy-remediation-v1';
const JOB_TYPE = 'record_proof_prepare_submit';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function remediationApplyError(code, message, details = {}) {
  const error = new Error(message || code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function normalizedHash(value, code) {
  const hash = String(value || '').trim().toLowerCase();
  if (!SHA256_PATTERN.test(hash)) throw remediationApplyError(code);
  return hash;
}

function normalizeQrIds(value) {
  const ids = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .sort();
  if (ids.length === 0
      || ids.some((id) => !/^[A-Za-z0-9_-]+$/.test(id))
      || new Set(ids).size !== ids.length) {
    throw remediationApplyError('CONTENT_PRIVACY_APPLY_QR_IDS_INVALID');
  }
  return Object.freeze(ids);
}

function parseArguments(argv) {
  const values = {};
  let mode = null;
  let productionConfirmed = false;
  let runtimeQuiesced = false;
  for (const argument of argv) {
    if (argument === '--preflight') {
      if (mode) throw remediationApplyError('CONTENT_PRIVACY_APPLY_MODE_INVALID');
      mode = 'preflight';
      continue;
    }
    if (argument === '--apply-production-snapshot') {
      if (mode) throw remediationApplyError('CONTENT_PRIVACY_APPLY_MODE_INVALID');
      mode = 'apply';
      continue;
    }
    if (argument === '--production-confirmed') {
      productionConfirmed = true;
      continue;
    }
    if (argument === '--runtime-quiesced') {
      runtimeQuiesced = true;
      continue;
    }
    const match = /^--([a-z0-9-]+)=(.*)$/i.exec(argument);
    const allowed = [
      'source', 'candidate', 'report', 'live-database',
      'expected-source-sha256', 'expected-candidate-sha256',
      'expected-source-domain-sha256', 'expected-candidate-domain-sha256',
      'expected-qr-ids', 'expected-database'
    ];
    if (!match || !allowed.includes(match[1]) || Object.hasOwn(values, match[1])) {
      throw remediationApplyError('CONTENT_PRIVACY_APPLY_ARGUMENT_INVALID');
    }
    values[match[1]] = match[2];
  }
  if (!mode) throw remediationApplyError('CONTENT_PRIVACY_APPLY_MODE_REQUIRED');
  if (mode === 'apply' && (!productionConfirmed || !runtimeQuiesced)) {
    throw remediationApplyError('CONTENT_PRIVACY_APPLY_CONFIRMATION_REQUIRED');
  }
  const paths = ['source', 'candidate', 'report', 'live-database'];
  for (const key of paths) {
    if (!values[key] || !path.isAbsolute(values[key])) {
      throw remediationApplyError('CONTENT_PRIVACY_APPLY_ABSOLUTE_PATH_REQUIRED');
    }
  }
  const expectedDatabase = String(values['expected-database'] || '').trim();
  if (!/^[A-Za-z0-9_]+$/.test(expectedDatabase)) {
    throw remediationApplyError('CONTENT_PRIVACY_APPLY_DATABASE_INVALID');
  }
  return Object.freeze({
    mode,
    sourcePath: path.resolve(values.source),
    candidatePath: path.resolve(values.candidate),
    reportPath: path.resolve(values.report),
    liveDatabasePath: path.resolve(values['live-database']),
    expectedSourceSha256: normalizedHash(
      values['expected-source-sha256'],
      'CONTENT_PRIVACY_APPLY_SOURCE_SHA256_INVALID'
    ),
    expectedCandidateSha256: normalizedHash(
      values['expected-candidate-sha256'],
      'CONTENT_PRIVACY_APPLY_CANDIDATE_SHA256_INVALID'
    ),
    expectedSourceDomainSha256: normalizedHash(
      values['expected-source-domain-sha256'],
      'CONTENT_PRIVACY_APPLY_SOURCE_DOMAIN_INVALID'
    ),
    expectedCandidateDomainSha256: normalizedHash(
      values['expected-candidate-domain-sha256'],
      'CONTENT_PRIVACY_APPLY_CANDIDATE_DOMAIN_INVALID'
    ),
    expectedQrIds: normalizeQrIds(values['expected-qr-ids']),
    expectedDatabase
  });
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = stableValue(value[key]);
      return result;
    }, {});
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function keyedRows(rows, key, code) {
  const result = new Map();
  for (const row of rows) {
    const id = String(row && row[key] || '');
    if (!id || result.has(id)) throw remediationApplyError(code);
    result.set(id, row);
  }
  return result;
}

function rowsEqual(left, right) {
  return stableJson(left) === stableJson(right);
}

function assertRowsEqual(left, right, code) {
  if (!rowsEqual(left, right)) throw remediationApplyError(code);
}

function withoutFields(row, fields) {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => !fields.includes(key))
  );
}

function assertPlanDelta({ sourcePlan, candidatePlan, report, expectedQrIds }) {
  const targetIds = new Set(expectedQrIds);
  const revisions = keyedRows(
    report.revisions,
    'qr_id',
    'CONTENT_PRIVACY_APPLY_REVISION_DUPLICATE'
  );
  if (revisions.size !== expectedQrIds.length
      || expectedQrIds.some((id) => !revisions.has(id))) {
    throw remediationApplyError('CONTENT_PRIVACY_APPLY_REVISION_SCOPE_INVALID');
  }

  for (const collection of Object.keys(sourcePlan)) {
    if (['qr_codes', 'records', 'record_proofs', 'record_archives'].includes(collection)) {
      continue;
    }
    assertRowsEqual(
      sourcePlan[collection],
      candidatePlan[collection],
      'CONTENT_PRIVACY_APPLY_UNAPPROVED_PLAN_DELTA'
    );
  }

  const sourceQrs = keyedRows(sourcePlan.qr_codes, 'id', 'CONTENT_PRIVACY_APPLY_QR_DUPLICATE');
  const candidateQrs = keyedRows(
    candidatePlan.qr_codes,
    'id',
    'CONTENT_PRIVACY_APPLY_QR_DUPLICATE'
  );
  if (sourceQrs.size !== candidateQrs.size) {
    throw remediationApplyError('CONTENT_PRIVACY_APPLY_QR_COUNT_CHANGED');
  }
  for (const [id, sourceRow] of sourceQrs) {
    const candidateRow = candidateQrs.get(id);
    if (!candidateRow) throw remediationApplyError('CONTENT_PRIVACY_APPLY_QR_SCOPE_CHANGED');
    if (!targetIds.has(id)) {
      assertRowsEqual(sourceRow, candidateRow, 'CONTENT_PRIVACY_APPLY_NON_TARGET_CHANGED');
      continue;
    }
    assertRowsEqual(
      withoutFields(sourceRow, ['updated_at']),
      withoutFields(candidateRow, ['updated_at']),
      'CONTENT_PRIVACY_APPLY_QR_FIELDS_CHANGED'
    );
    if (candidateRow.updated_at !== report.remediated_at) {
      throw remediationApplyError('CONTENT_PRIVACY_APPLY_TIMESTAMP_MISMATCH');
    }
  }

  const sourceRecords = keyedRows(
    sourcePlan.records,
    'qr_id',
    'CONTENT_PRIVACY_APPLY_RECORD_DUPLICATE'
  );
  const candidateRecords = keyedRows(
    candidatePlan.records,
    'qr_id',
    'CONTENT_PRIVACY_APPLY_RECORD_DUPLICATE'
  );
  if (sourceRecords.size !== candidateRecords.size) {
    throw remediationApplyError('CONTENT_PRIVACY_APPLY_RECORD_COUNT_CHANGED');
  }
  for (const [id, sourceRow] of sourceRecords) {
    const candidateRow = candidateRecords.get(id);
    if (!candidateRow) throw remediationApplyError('CONTENT_PRIVACY_APPLY_RECORD_SCOPE_CHANGED');
    if (!targetIds.has(id)) {
      assertRowsEqual(sourceRow, candidateRow, 'CONTENT_PRIVACY_APPLY_NON_TARGET_CHANGED');
      continue;
    }
    assertRowsEqual(
      withoutFields(sourceRow, ['content', 'updated_at']),
      withoutFields(candidateRow, ['content', 'updated_at']),
      'CONTENT_PRIVACY_APPLY_RECORD_FIELDS_CHANGED'
    );
    const revision = revisions.get(id);
    const sourceContentHash = sha256(Buffer.from(sourceRow.content, 'utf8'));
    const candidateContentHash = sha256(Buffer.from(candidateRow.content, 'utf8'));
    if (sourceContentHash !== revision.previous_content_sha256
        || candidateContentHash !== revision.revised_content_sha256
        || sourceContentHash === candidateContentHash
        || candidateRow.updated_at !== report.remediated_at) {
      throw remediationApplyError('CONTENT_PRIVACY_APPLY_CONTENT_HASH_MISMATCH');
    }
  }

  const expectedProofs = sourcePlan.record_proofs.filter(
    (row) => !targetIds.has(String(row.record_qr_id))
  );
  const removedProofs = sourcePlan.record_proofs.filter(
    (row) => targetIds.has(String(row.record_qr_id))
  );
  if (removedProofs.length !== expectedQrIds.length
      || removedProofs.some((row) => row.status !== 'confirmed')) {
    throw remediationApplyError('CONTENT_PRIVACY_APPLY_PROOF_SCOPE_INVALID');
  }
  assertRowsEqual(
    expectedProofs,
    candidatePlan.record_proofs,
    'CONTENT_PRIVACY_APPLY_PROOF_DELTA_INVALID'
  );

  const expectedArchives = sourcePlan.record_archives.filter(
    (row) => !targetIds.has(String(row.record_qr_id))
  );
  assertRowsEqual(
    expectedArchives,
    candidatePlan.record_archives,
    'CONTENT_PRIVACY_APPLY_ARCHIVE_DELTA_INVALID'
  );
  const archiveRemovalCount = sourcePlan.record_archives.length - expectedArchives.length;
  if (archiveRemovalCount !== report.archive_dependency_count) {
    throw remediationApplyError('CONTENT_PRIVACY_APPLY_ARCHIVE_COUNT_INVALID');
  }

  return Object.freeze({
    target_count: expectedQrIds.length,
    proof_removal_count: removedProofs.length,
    archive_removal_count: archiveRemovalCount
  });
}

function readJsonFile(filePath, code) {
  if (!fs.existsSync(filePath) || fs.lstatSync(filePath).isSymbolicLink()) {
    throw remediationApplyError(code);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    throw remediationApplyError(code);
  }
}

function validateArtifacts(options) {
  const distinctPaths = new Set([
    options.sourcePath,
    options.candidatePath,
    options.reportPath,
    options.liveDatabasePath
  ].map((item) => path.resolve(item)));
  if (distinctPaths.size !== 4) {
    throw remediationApplyError('CONTENT_PRIVACY_APPLY_PATH_CONFLICT');
  }
  const source = readSourceSnapshot({
    inputPath: options.sourcePath,
    expectedSha256: options.expectedSourceSha256
  });
  const candidate = readSourceSnapshot({
    inputPath: options.candidatePath,
    expectedSha256: options.expectedCandidateSha256
  });
  const report = readJsonFile(
    options.reportPath,
    'CONTENT_PRIVACY_APPLY_REPORT_INVALID'
  );
  const sourcePlan = mapSourceToPlan(source.data).plan;
  const candidatePlan = mapSourceToPlan(candidate.data).plan;
  const sourceDomain = publicQrDomainSha256(sourcePlan);
  const candidateDomain = publicQrDomainSha256(candidatePlan);
  const expectedIdsJson = JSON.stringify(options.expectedQrIds);

  if (report.schema_version !== 2
      || report.mode !== 'prepare'
      || report.status !== 'READY'
      || report.apply_performed !== false
      || report.strategy !== 'PRELAUNCH_TEST_DATA_REDACT_AND_REPROOF'
      || report.source_sha256 !== options.expectedSourceSha256
      || report.candidate_source_sha256 !== options.expectedCandidateSha256
      || report.source_public_qr_domain_sha256 !== options.expectedSourceDomainSha256
      || report.candidate_public_qr_domain_sha256 !== options.expectedCandidateDomainSha256
      || JSON.stringify(report.affected_qr_ids) !== expectedIdsJson
      || report.candidate_privacy_finding_count !== 0
      || report.raw_identity_values_persisted_in_report !== false
      || report.raw_business_content_persisted_in_report !== false
      || sourceDomain !== options.expectedSourceDomainSha256
      || candidateDomain !== options.expectedCandidateDomainSha256) {
    throw remediationApplyError('CONTENT_PRIVACY_APPLY_ARTIFACT_GATE_FAILED');
  }
  const privacyAudit = analyzeSource(candidate.data, candidate.sourceHash);
  if (privacyAudit.status !== 'CLEAN' || privacyAudit.finding_count !== 0) {
    throw remediationApplyError('CONTENT_PRIVACY_APPLY_CANDIDATE_NOT_CLEAN');
  }
  const delta = assertPlanDelta({
    sourcePlan,
    candidatePlan,
    report,
    expectedQrIds: options.expectedQrIds
  });
  return Object.freeze({
    source,
    candidate,
    report,
    sourcePlan,
    candidatePlan,
    delta
  });
}

function planCounts(plan) {
  return Object.fromEntries(IMPORT_ORDER.map((key) => [key, plan[key].length]));
}

function idempotencyKey(candidateHash, qrId) {
  return `privacy-reproof:${candidateHash.slice(0, 24)}:${qrId}`;
}

async function inspectMarkers(transactionContext, artifacts) {
  const result = await transactionContext.query(
    `SELECT source_sha256, status,
            checksum_summary ->> $2 AS public_qr_domain_sha256,
            checksum_summary ->> 'superseded_by_source_sha256'
              AS superseded_by_source_sha256
     FROM app.import_runs
     WHERE source_sha256 = ANY($1::text[])
     ORDER BY source_sha256`,
    [
      [artifacts.source.sourceHash, artifacts.candidate.sourceHash],
      PUBLIC_QR_DOMAIN_CHECKSUM_KEY
    ]
  );
  const markers = new Map(result.rows.map((row) => [String(row.source_sha256), row]));
  const sourceMarker = markers.get(artifacts.source.sourceHash);
  const candidateMarker = markers.get(artifacts.candidate.sourceHash);
  if (!sourceMarker
      || sourceMarker.public_qr_domain_sha256
        !== artifacts.report.source_public_qr_domain_sha256) {
    throw remediationApplyError('CONTENT_PRIVACY_APPLY_SOURCE_MARKER_INVALID');
  }
  if (candidateMarker
      && (candidateMarker.status !== 'passed'
        || candidateMarker.public_qr_domain_sha256
          !== artifacts.report.candidate_public_qr_domain_sha256)) {
    throw remediationApplyError('CONTENT_PRIVACY_APPLY_CANDIDATE_MARKER_INVALID');
  }
  if (candidateMarker) {
    if (sourceMarker.status !== 'blocked'
        || sourceMarker.superseded_by_source_sha256
          !== artifacts.candidate.sourceHash) {
      throw remediationApplyError('CONTENT_PRIVACY_APPLY_SOURCE_MARKER_NOT_SUPERSEDED');
    }
  } else if (sourceMarker.status !== 'passed'
      || sourceMarker.superseded_by_source_sha256) {
    throw remediationApplyError('CONTENT_PRIVACY_APPLY_SOURCE_MARKER_INVALID');
  }
  return { sourceMarker, candidateMarker };
}

async function assertMigrationsCurrent(transactionContext) {
  const state = await inspectMigrationState(transactionContext, loadMigrations());
  if (state.pending.length > 0) {
    throw remediationApplyError('CONTENT_PRIVACY_APPLY_MIGRATIONS_REQUIRED');
  }
}

async function assertExistingOutbox(transactionContext, artifacts) {
  const keys = artifacts.report.affected_qr_ids.map(
    (id) => idempotencyKey(artifacts.candidate.sourceHash, id)
  );
  const result = await transactionContext.query(
    `SELECT aggregate_id, idempotency_key, job_type, aggregate_type, payload
     FROM app.outbox_jobs
     WHERE aggregate_id = ANY($1::text[])
       AND job_type = $2
     ORDER BY aggregate_id`,
    [artifacts.report.affected_qr_ids, JOB_TYPE]
  );
  if (result.rows.length !== keys.length) {
    throw remediationApplyError('CONTENT_PRIVACY_APPLY_OUTBOX_STATE_INVALID');
  }
  for (const row of result.rows) {
    if (row.job_type !== JOB_TYPE
        || row.aggregate_type !== 'record'
        || row.idempotency_key
          !== idempotencyKey(artifacts.candidate.sourceHash, row.aggregate_id)
        || String(row.payload && row.payload.record_qr_id || '') !== row.aggregate_id) {
      throw remediationApplyError('CONTENT_PRIVACY_APPLY_OUTBOX_STATE_INVALID');
    }
  }
}

async function assertSourceOutboxEmpty(transactionContext, artifacts) {
  const result = await transactionContext.query(
    `SELECT COUNT(*)::text AS job_count
     FROM app.outbox_jobs
     WHERE aggregate_id = ANY($1::text[])
       AND job_type = $2`,
    [artifacts.report.affected_qr_ids, JOB_TYPE]
  );
  if (Number(result.rows[0] && result.rows[0].job_count) !== 0) {
    throw remediationApplyError('CONTENT_PRIVACY_APPLY_OUTBOX_CONFLICT');
  }
}

async function inspectPostgresState(transactionContext, artifacts, { verifyPlan = true } = {}) {
  await assertMigrationsCurrent(transactionContext);
  const markers = await inspectMarkers(transactionContext, artifacts);
  if (markers.candidateMarker) {
    await assertExistingOutbox(transactionContext, artifacts);
    const verification = verifyPlan
      ? await verifyImportedPlan({
        plan: artifacts.candidatePlan,
        transactionContext
      })
      : null;
    return Object.freeze({ state: 'candidate', verification });
  }
  await assertSourceOutboxEmpty(transactionContext, artifacts);
  const verification = verifyPlan
    ? await verifyImportedPlan({
      plan: artifacts.sourcePlan,
      transactionContext
    })
    : null;
  return Object.freeze({ state: 'source', verification });
}

async function applyPostgresRemediation({
  pool,
  artifacts,
  transactionRunner = withTransaction,
  randomUUID = crypto.randomUUID
}) {
  return transactionRunner(pool, async (transactionContext) => {
    await transactionContext.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [APPLY_LOCK_KEY]
    );
    const state = await inspectPostgresState(transactionContext, artifacts);
    if (state.state === 'candidate') {
      return Object.freeze({ state: 'candidate', applied: false });
    }

    const qrIds = artifacts.report.affected_qr_ids;
    const candidateRecords = keyedRows(
      artifacts.candidatePlan.records,
      'qr_id',
      'CONTENT_PRIVACY_APPLY_RECORD_DUPLICATE'
    );
    const candidateQrs = keyedRows(
      artifacts.candidatePlan.qr_codes,
      'id',
      'CONTENT_PRIVACY_APPLY_QR_DUPLICATE'
    );
    const locked = await transactionContext.query(
      `SELECT record.qr_id
       FROM app.records record
       JOIN app.qr_codes qr ON qr.id = record.qr_id
       WHERE record.qr_id = ANY($1::text[])
       ORDER BY record.qr_id
       FOR UPDATE OF record, qr`,
      [qrIds]
    );
    if (locked.rows.length !== qrIds.length
        || JSON.stringify(locked.rows.map((row) => row.qr_id)) !== JSON.stringify(qrIds)) {
      throw remediationApplyError('CONTENT_PRIVACY_APPLY_TARGET_STATE_INVALID');
    }
    const attempts = await transactionContext.query(
      `SELECT COUNT(*)::text AS attempt_count
       FROM app.proof_attempts attempt
       JOIN app.record_proofs proof ON proof.id = attempt.proof_id
       WHERE proof.record_qr_id = ANY($1::text[])`,
      [qrIds]
    );
    if (Number(attempts.rows[0] && attempts.rows[0].attempt_count) !== 0) {
      throw remediationApplyError('CONTENT_PRIVACY_APPLY_PROOF_ATTEMPTS_PRESENT');
    }
    await transactionContext.query(
      'DELETE FROM app.record_archives WHERE record_qr_id = ANY($1::text[])',
      [qrIds]
    );
    const removedProofs = await transactionContext.query(
      'DELETE FROM app.record_proofs WHERE record_qr_id = ANY($1::text[]) RETURNING record_qr_id',
      [qrIds]
    );
    if (removedProofs.rows.length !== qrIds.length) {
      throw remediationApplyError('CONTENT_PRIVACY_APPLY_PROOF_STATE_INVALID');
    }
    for (const qrId of qrIds) {
      const record = candidateRecords.get(qrId);
      const qr = candidateQrs.get(qrId);
      const recordResult = await transactionContext.query(
        `UPDATE app.records
         SET content = $2, updated_at = $3
         WHERE qr_id = $1
         RETURNING qr_id`,
        [qrId, record.content, record.updated_at]
      );
      const qrResult = await transactionContext.query(
        `UPDATE app.qr_codes
         SET updated_at = $2
         WHERE id = $1
         RETURNING id`,
        [qrId, qr.updated_at]
      );
      if (recordResult.rows.length !== 1 || qrResult.rows.length !== 1) {
        throw remediationApplyError('CONTENT_PRIVACY_APPLY_TARGET_UPDATE_FAILED');
      }
    }

    const verification = await verifyImportedPlan({
      plan: artifacts.candidatePlan,
      transactionContext
    });
    assertSourceUnchanged(artifacts.source);
    assertSourceUnchanged(artifacts.candidate);

    const counts = planCounts(artifacts.candidatePlan);
    const superseded = await transactionContext.query(
      `UPDATE app.import_runs
       SET status = 'blocked',
           checksum_summary = jsonb_set(
             checksum_summary,
             '{superseded_by_source_sha256}',
             to_jsonb($2::text),
             true
           )
       WHERE source_sha256 = $1 AND status = 'passed'
       RETURNING id`,
      [artifacts.source.sourceHash, artifacts.candidate.sourceHash]
    );
    if (superseded.rows.length !== 1) {
      throw remediationApplyError('CONTENT_PRIVACY_APPLY_SOURCE_SUPERSEDE_FAILED');
    }
    await transactionContext.query(
      `INSERT INTO app.import_runs (
        id, source_sha256, source_label, importer_version, mode, status,
        source_counts, imported_counts, checksum_summary, completed_at
      ) VALUES (
        $1, $2, $3, $4, 'final', 'passed',
        $5::jsonb, $5::jsonb, $6::jsonb, CURRENT_TIMESTAMP
      )`,
      [
        randomUUID(),
        artifacts.candidate.sourceHash,
        `privacy-redaction-${artifacts.candidate.sourceHash.slice(0, 12)}`,
        IMPORTER_VERSION,
        JSON.stringify(counts),
        JSON.stringify({
          source_sha256: artifacts.candidate.sourceHash,
          plan_sha256: planSha256(artifacts.candidatePlan),
          [PUBLIC_QR_DOMAIN_CHECKSUM_KEY]:
            artifacts.report.candidate_public_qr_domain_sha256,
          remediation_strategy: artifacts.report.strategy,
          remediation_target_count: qrIds.length
        })
      ]
    );

    for (const qrId of qrIds) {
      const timestamp = artifacts.report.remediated_at;
      await transactionContext.query(
        `INSERT INTO app.outbox_jobs (
          id, job_type, aggregate_type, aggregate_id, idempotency_key,
          payload, status, attempt_count, available_at, locked_at,
          locked_by, last_error, created_at, updated_at
        ) VALUES (
          $1, $2, 'record', $3, $4,
          $5::jsonb, 'pending', 0, $6, NULL,
          NULL, '', $6, $6
        )`,
        [
          randomUUID(),
          JOB_TYPE,
          qrId,
          idempotencyKey(artifacts.candidate.sourceHash, qrId),
          JSON.stringify({ record_qr_id: qrId }),
          timestamp
        ]
      );
    }
    return Object.freeze({
      state: 'candidate',
      applied: true,
      verification
    });
  }, { isolationLevel: 'serializable' });
}

function readLiveDatabaseState(options) {
  if (!fs.existsSync(options.liveDatabasePath)
      || fs.lstatSync(options.liveDatabasePath).isSymbolicLink()) {
    throw remediationApplyError('CONTENT_PRIVACY_APPLY_LIVE_DATABASE_INVALID');
  }
  const bytes = fs.readFileSync(options.liveDatabasePath);
  const hash = sha256(bytes);
  if (![options.expectedSourceSha256, options.expectedCandidateSha256].includes(hash)) {
    throw remediationApplyError('CONTENT_PRIVACY_APPLY_LIVE_DATABASE_DRIFT');
  }
  return Object.freeze({
    hash,
    state: hash === options.expectedSourceSha256 ? 'source' : 'candidate'
  });
}

function replaceLiveDatabase({ options, artifacts }) {
  const initial = readLiveDatabaseState(options);
  if (initial.state === 'candidate') return Object.freeze({ applied: false, state: 'candidate' });
  assertSourceUnchanged(artifacts.source);
  assertSourceUnchanged(artifacts.candidate);
  const candidateBytes = fs.readFileSync(artifacts.candidate.sourcePath);
  if (sha256(candidateBytes) !== options.expectedCandidateSha256) {
    throw remediationApplyError('CONTENT_PRIVACY_APPLY_CANDIDATE_CHANGED');
  }
  const liveStat = fs.statSync(options.liveDatabasePath);
  const tempPath = path.join(
    path.dirname(options.liveDatabasePath),
    `.${path.basename(options.liveDatabasePath)}.privacy.${process.pid}.${Date.now()}.tmp`
  );
  let descriptor = null;
  try {
    descriptor = fs.openSync(tempPath, 'wx', liveStat.mode & 0o777);
    fs.writeFileSync(descriptor, candidateBytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    if (readLiveDatabaseState(options).state !== 'source') {
      throw remediationApplyError('CONTENT_PRIVACY_APPLY_LIVE_DATABASE_CHANGED');
    }
    fs.renameSync(tempPath, options.liveDatabasePath);
    if (process.platform !== 'win32') {
      const directory = fs.openSync(path.dirname(options.liveDatabasePath), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    try { fs.unlinkSync(tempPath); } catch (_cleanupError) {}
    throw error;
  }
  const finalState = readLiveDatabaseState(options);
  if (finalState.state !== 'candidate') {
    throw remediationApplyError('CONTENT_PRIVACY_APPLY_LIVE_DATABASE_WRITE_FAILED');
  }
  return Object.freeze({ applied: true, state: 'candidate' });
}

async function executeRemediation({
  options,
  pool,
  artifacts = validateArtifacts(options),
  transactionRunner = withTransaction
}) {
  const liveBefore = readLiveDatabaseState(options);
  if (options.mode === 'preflight') {
    const postgres = await transactionRunner(
      pool,
      (context) => inspectPostgresState(context, artifacts),
      { isolationLevel: 'repeatable read', readOnly: true }
    );
    if (postgres.state !== liveBefore.state) {
      throw remediationApplyError('CONTENT_PRIVACY_APPLY_STATE_SPLIT');
    }
    return Object.freeze({
      mode: 'preflight',
      status: postgres.state === 'source' ? 'READY' : 'ALREADY_APPLIED',
      source_sha256: artifacts.source.sourceHash,
      candidate_source_sha256: artifacts.candidate.sourceHash,
      candidate_public_qr_domain_sha256:
        artifacts.report.candidate_public_qr_domain_sha256,
      affected_qr_ids: artifacts.report.affected_qr_ids,
      postgres_state: postgres.state,
      json_state: liveBefore.state,
      external_calls: 'NONE',
      apply_performed: false
    });
  }

  const postgres = await applyPostgresRemediation({
    pool,
    artifacts,
    transactionRunner
  });
  const json = replaceLiveDatabase({ options, artifacts });
  return Object.freeze({
    mode: 'apply',
    status: postgres.applied || json.applied ? 'APPLIED' : 'ALREADY_APPLIED',
    source_sha256: artifacts.source.sourceHash,
    candidate_source_sha256: artifacts.candidate.sourceHash,
    candidate_public_qr_domain_sha256:
      artifacts.report.candidate_public_qr_domain_sha256,
    affected_qr_ids: artifacts.report.affected_qr_ids,
    postgres_applied: postgres.applied,
    json_applied: json.applied,
    reproof_jobs_enqueued: artifacts.report.affected_qr_ids.length,
    external_calls: 'NONE'
  });
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArguments(argv);
  const config = readPostgresConfig(env);
  if (String(config.database || '') !== options.expectedDatabase) {
    throw remediationApplyError('CONTENT_PRIVACY_APPLY_DATABASE_MISMATCH');
  }
  const pool = createPostgresPool({ config });
  try {
    const result = await executeRemediation({ options, pool });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await closePostgresPool(pool);
  }
}

if (require.main === module) {
  main().catch((error) => {
    const safe = error && String(error.code || '').startsWith('CONTENT_PRIVACY_')
      ? error
      : sanitizePostgresError(error, 'CONTENT_PRIVACY_APPLY_FAILED');
    process.stderr.write(`${JSON.stringify({
      status: 'BLOCKED',
      code: safe.code || 'CONTENT_PRIVACY_APPLY_FAILED'
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  APPLY_LOCK_KEY,
  IMPORTER_VERSION,
  applyPostgresRemediation,
  assertPlanDelta,
  executeRemediation,
  idempotencyKey,
  main,
  parseArguments,
  readLiveDatabaseState,
  replaceLiveDatabase,
  validateArtifacts
};
