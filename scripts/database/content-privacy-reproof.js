#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { analyzeSource } = require('./audit-cross-account-phone-content');
const {
  PUBLIC_QR_DOMAIN_CHECKSUM_KEY,
  PUBLIC_QR_DOMAIN_COLLECTIONS,
  publicQrDomainSha256
} = require('./importer/domain-markers');
const { mapSourceToPlan } = require('./importer/mapping');
const { IMPORT_ORDER, TABLE_SPECS, planSha256 } = require('./importer/writer');
const { canonicalRows } = require('./importer/verify-import');

const FINALIZE_LOCK_KEY = 'xingxingzaishan:content-privacy-remediation:v1';
const FINAL_IMPORTER_VERSION = 'content-privacy-reproof-v1';
const JOB_TYPE = 'record_proof_prepare_submit';

function reproofError(code, message, details = {}) {
  const error = new Error(message || code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
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

function normalizedTimestamp(value, code) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw reproofError(code);
  return date.toISOString();
}

function normalizedOptionalText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function normalizedQrIds(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw reproofError('CONTENT_PRIVACY_REPROOF_QR_IDS_INVALID');
  }
  const ids = values.map((value) => String(value || '').trim()).sort();
  if (ids.some((id) => !/^[A-Za-z0-9_-]+$/.test(id))
      || new Set(ids).size !== ids.length) {
    throw reproofError('CONTENT_PRIVACY_REPROOF_QR_IDS_INVALID');
  }
  return Object.freeze(ids);
}

function keyedRows(rows, key, code) {
  const result = new Map();
  for (const row of rows) {
    const id = String(row && row[key] || '');
    if (!id || result.has(id)) throw reproofError(code);
    result.set(id, row);
  }
  return result;
}

function idempotencyKey(candidateHash, qrId) {
  return `privacy-reproof:${candidateHash.slice(0, 24)}:${qrId}`;
}

async function loadTargetEvidence(transactionContext, {
  candidateHash,
  qrIds
}) {
  const ids = normalizedQrIds(qrIds);
  // Keep one transaction client strictly sequential so driver queueing cannot
  // blur which evidence query failed during a resumable production run.
  const qrs = await transactionContext.query(
    'SELECT * FROM app.qr_codes WHERE id = ANY($1::text[]) ORDER BY id',
    [ids]
  );
  const records = await transactionContext.query(
    'SELECT * FROM app.records WHERE qr_id = ANY($1::text[]) ORDER BY qr_id',
    [ids]
  );
  const proofs = await transactionContext.query(
    'SELECT * FROM app.record_proofs WHERE record_qr_id = ANY($1::text[]) ORDER BY record_qr_id',
    [ids]
  );
  const archives = await transactionContext.query(
    'SELECT * FROM app.record_archives WHERE record_qr_id = ANY($1::text[]) ORDER BY record_qr_id',
    [ids]
  );
  const attempts = await transactionContext.query(
    `SELECT proof.record_qr_id,
            count(*)::integer AS attempt_count,
            count(*) FILTER (
              WHERE attempt.result_status = 'succeeded'
            )::integer AS succeeded_count,
            count(*) FILTER (
              WHERE attempt.result_status = 'pending'
            )::integer AS pending_count
     FROM app.proof_attempts attempt
     JOIN app.record_proofs proof ON proof.id = attempt.proof_id
     WHERE proof.record_qr_id = ANY($1::text[])
     GROUP BY proof.record_qr_id
     ORDER BY proof.record_qr_id`,
    [ids]
  );
  const jobs = await transactionContext.query(
    `SELECT * FROM app.outbox_jobs
     WHERE aggregate_id = ANY($1::text[])
       AND job_type = $2
     ORDER BY aggregate_id`,
    [ids, JOB_TYPE]
  );
  if (qrs.rows.length !== ids.length || records.rows.length !== ids.length) {
    throw reproofError('CONTENT_PRIVACY_REPROOF_TARGET_MISSING');
  }
  const proofMap = keyedRows(
    proofs.rows,
    'record_qr_id',
    'CONTENT_PRIVACY_REPROOF_PROOF_DUPLICATE'
  );
  const archiveMap = keyedRows(
    archives.rows,
    'record_qr_id',
    'CONTENT_PRIVACY_REPROOF_ARCHIVE_DUPLICATE'
  );
  const attemptMap = keyedRows(
    attempts.rows,
    'record_qr_id',
    'CONTENT_PRIVACY_REPROOF_ATTEMPT_DUPLICATE'
  );
  const jobMap = keyedRows(
    jobs.rows,
    'aggregate_id',
    'CONTENT_PRIVACY_REPROOF_OUTBOX_DUPLICATE'
  );
  for (const id of ids) {
    const job = jobMap.get(id);
    if (!job
        || job.aggregate_type !== 'record'
        || job.idempotency_key !== idempotencyKey(candidateHash, id)
        || String(job.payload && job.payload.record_qr_id || '') !== id) {
      throw reproofError('CONTENT_PRIVACY_REPROOF_OUTBOX_INVALID');
    }
  }
  return Object.freeze({
    qrIds: ids,
    qrs: keyedRows(qrs.rows, 'id', 'CONTENT_PRIVACY_REPROOF_QR_DUPLICATE'),
    records: keyedRows(
      records.rows,
      'qr_id',
      'CONTENT_PRIVACY_REPROOF_RECORD_DUPLICATE'
    ),
    proofs: proofMap,
    archives: archiveMap,
    attempts: attemptMap,
    jobs: jobMap
  });
}

function assertEvidenceComplete(evidence) {
  for (const qrId of evidence.qrIds) {
    const proof = evidence.proofs.get(qrId);
    const archive = evidence.archives.get(qrId);
    const attempt = evidence.attempts.get(qrId);
    const job = evidence.jobs.get(qrId);
    if (!proof
        || proof.status !== 'confirmed'
        || !normalizedOptionalText(proof.operation_id)
        || !normalizedOptionalText(proof.manifest_hash)
        || !normalizedOptionalText(proof.manifest_object_key)
        || !normalizedTimestamp(
          proof.confirmed_at,
          'CONTENT_PRIVACY_REPROOF_CONFIRMED_AT_INVALID'
        )) {
      throw reproofError('CONTENT_PRIVACY_REPROOF_PROOF_INCOMPLETE', null, { qrId });
    }
    if (!archive
        || archive.status !== 'ready'
        || archive.manifest_object_key !== proof.manifest_object_key) {
      throw reproofError('CONTENT_PRIVACY_REPROOF_ARCHIVE_INCOMPLETE', null, { qrId });
    }
    if (!attempt
        || Number(attempt.attempt_count) < 1
        || Number(attempt.succeeded_count) < 1
        || Number(attempt.pending_count) !== 0) {
      throw reproofError('CONTENT_PRIVACY_REPROOF_ATTEMPT_INCOMPLETE', null, { qrId });
    }
    if (!job || job.status !== 'succeeded'
        || job.locked_at !== null || job.locked_by !== null) {
      throw reproofError('CONTENT_PRIVACY_REPROOF_OUTBOX_INCOMPLETE', null, { qrId });
    }
  }
}

function buildFinalSource({ candidateSource, evidence }) {
  assertEvidenceComplete(evidence);
  const finalSource = JSON.parse(JSON.stringify(candidateSource));
  const qrs = keyedRows(
    finalSource.qr_codes,
    'id',
    'CONTENT_PRIVACY_REPROOF_SOURCE_QR_DUPLICATE'
  );
  for (const qrId of evidence.qrIds) {
    const item = qrs.get(qrId);
    const qr = evidence.qrs.get(qrId);
    const record = evidence.records.get(qrId);
    const proof = evidence.proofs.get(qrId);
    const archive = evidence.archives.get(qrId);
    if (!item || !qr || !record) {
      throw reproofError('CONTENT_PRIVACY_REPROOF_SOURCE_TARGET_MISSING');
    }
    item.updated_at = normalizedTimestamp(
      qr.updated_at,
      'CONTENT_PRIVACY_REPROOF_QR_TIMESTAMP_INVALID'
    );
    item.image_sha256 = normalizedOptionalText(record.image_sha256);
    item.record_created_at = normalizedTimestamp(
      record.created_at,
      'CONTENT_PRIVACY_REPROOF_RECORD_TIMESTAMP_INVALID'
    );
    item.record_updated_at = normalizedTimestamp(
      record.updated_at,
      'CONTENT_PRIVACY_REPROOF_RECORD_TIMESTAMP_INVALID'
    );
    item.chain_proof_id = String(proof.id);
    item.blockchain_hash = proof.manifest_hash || proof.legacy_hash_snapshot || null;
    item.chain_provider = proof.provider;
    item.chain_status = proof.status;
    item.chain_operation_id = normalizedOptionalText(proof.operation_id);
    item.manifest_object_key = normalizedOptionalText(proof.manifest_object_key);
    item.manifest_hash = normalizedOptionalText(proof.manifest_hash);
    item.chain_tx_hash = normalizedOptionalText(proof.transaction_hash);
    item.chain_block_height = proof.block_height === null
      || proof.block_height === undefined
      ? null
      : Number(proof.block_height);
    item.chain_record_id = normalizedOptionalText(proof.provider_record_id);
    item.chain_certificate_url = normalizedOptionalText(
      proof.provider_certificate_url
    );
    item.chain_certificate_object_key = normalizedOptionalText(
      proof.certificate_object_key
    );
    item.chain_certificate_object_url = normalizedOptionalText(
      proof.certificate_object_url_snapshot
    );
    item.chain_confirmed_at = normalizedTimestamp(
      proof.confirmed_at,
      'CONTENT_PRIVACY_REPROOF_PROOF_TIMESTAMP_INVALID'
    );
    item.chain_callback_received_at = normalizedTimestamp(
      proof.callback_received_at,
      'CONTENT_PRIVACY_REPROOF_PROOF_TIMESTAMP_INVALID'
    );
    item.chain_retry_count = Number(proof.retry_count || 0);
    item.chain_last_error = String(proof.last_error || '');
    item.chain_created_at = normalizedTimestamp(
      proof.created_at,
      'CONTENT_PRIVACY_REPROOF_PROOF_TIMESTAMP_INVALID'
    );
    item.chain_updated_at = normalizedTimestamp(
      proof.updated_at,
      'CONTENT_PRIVACY_REPROOF_PROOF_TIMESTAMP_INVALID'
    );
    item.legacy_manifest_object_key = normalizedOptionalText(
      archive.legacy_manifest_object_key
    );
    item.archive_index_object_key = normalizedOptionalText(archive.index_object_key);
    item.archive_status = archive.status;
    item.archive_last_error = String(archive.last_error || '');
    item.archive_created_at = normalizedTimestamp(
      archive.created_at,
      'CONTENT_PRIVACY_REPROOF_ARCHIVE_TIMESTAMP_INVALID'
    );
    item.archive_updated_at = normalizedTimestamp(
      archive.updated_at,
      'CONTENT_PRIVACY_REPROOF_ARCHIVE_TIMESTAMP_INVALID'
    );
  }
  const privacy = analyzeSource(finalSource, '0'.repeat(64));
  if (privacy.status !== 'CLEAN' || privacy.finding_count !== 0) {
    throw reproofError('CONTENT_PRIVACY_REPROOF_FINAL_SOURCE_NOT_CLEAN');
  }
  const serialized = `${JSON.stringify(finalSource, null, 2)}\n`;
  const sourceHash = crypto.createHash('sha256').update(serialized).digest('hex');
  const plan = mapSourceToPlan(finalSource).plan;
  return Object.freeze({
    source: finalSource,
    serialized,
    sourceHash,
    plan,
    domainHash: publicQrDomainSha256(plan)
  });
}

async function readCanonicalCollection(transactionContext, collection) {
  const spec = TABLE_SPECS[collection];
  if (!spec || !PUBLIC_QR_DOMAIN_COLLECTIONS.includes(collection)) {
    throw reproofError('CONTENT_PRIVACY_REPROOF_COLLECTION_INVALID');
  }
  const columns = spec.columns.filter((field) => field !== spec.generatedColumn);
  const result = await transactionContext.query(
    `SELECT ${columns.join(', ')} FROM app.${collection}`
  );
  return canonicalRows(spec, result.rows).map((row) => JSON.parse(row));
}

async function verifyPublicDomainParity(transactionContext, plan) {
  const actualPlan = {};
  const counts = {};
  for (const collection of PUBLIC_QR_DOMAIN_COLLECTIONS) {
    const actual = await readCanonicalCollection(transactionContext, collection);
    const expected = canonicalRows(TABLE_SPECS[collection], plan[collection])
      .map((row) => JSON.parse(row));
    if (stableJson(actual) !== stableJson(expected)) {
      throw reproofError(
        'CONTENT_PRIVACY_REPROOF_PUBLIC_DOMAIN_MISMATCH',
        null,
        { collection }
      );
    }
    actualPlan[collection] = actual;
    counts[collection] = actual.length;
  }
  const domainHash = publicQrDomainSha256(actualPlan);
  const expectedHash = publicQrDomainSha256(plan);
  if (domainHash !== expectedHash) {
    throw reproofError('CONTENT_PRIVACY_REPROOF_DOMAIN_HASH_MISMATCH');
  }
  return Object.freeze({ domainHash, counts });
}

function withoutFields(row, fields) {
  return Object.fromEntries(
    Object.entries(row).filter(([field]) => !fields.includes(field))
  );
}

async function verifyCandidateTransitionBase(transactionContext, {
  candidatePlan,
  qrIds
}) {
  const targets = new Set(normalizedQrIds(qrIds));
  for (const collection of PUBLIC_QR_DOMAIN_COLLECTIONS) {
    const actual = await readCanonicalCollection(transactionContext, collection);
    const expected = canonicalRows(TABLE_SPECS[collection], candidatePlan[collection])
      .map((row) => JSON.parse(row));
    let actualComparable = actual;
    let expectedComparable = expected;
    if (collection === 'records') {
      actualComparable = actual.map((row) => targets.has(String(row.qr_id))
        ? withoutFields(row, ['image_sha256', 'updated_at'])
        : row);
      expectedComparable = expected.map((row) => targets.has(String(row.qr_id))
        ? withoutFields(row, ['image_sha256', 'updated_at'])
        : row);
    } else if (collection === 'record_proofs'
        || collection === 'record_archives') {
      actualComparable = actual.filter(
        (row) => !targets.has(String(row.record_qr_id))
      );
      expectedComparable = expected.filter(
        (row) => !targets.has(String(row.record_qr_id))
      );
    }
    if (stableJson(actualComparable) !== stableJson(expectedComparable)) {
      throw reproofError(
        'CONTENT_PRIVACY_REPROOF_TRANSITION_BASE_MISMATCH',
        null,
        { collection }
      );
    }
  }
  return Object.freeze({ verified: true, targetCount: targets.size });
}

async function readActualCounts(transactionContext) {
  const counts = {};
  for (const collection of IMPORT_ORDER) {
    const result = await transactionContext.query(
      `SELECT count(*)::integer AS row_count FROM app.${collection}`
    );
    counts[collection] = Number(result.rows[0] && result.rows[0].row_count);
  }
  return counts;
}

async function finalizePostgresRevision({
  transactionContext,
  candidateSource,
  candidateHash,
  candidateDomainHash,
  qrIds,
  randomUUID = crypto.randomUUID
}) {
  await transactionContext.query(
    'SELECT pg_advisory_xact_lock(hashtext($1))',
    [FINALIZE_LOCK_KEY]
  );
  const evidence = await loadTargetEvidence(transactionContext, {
    candidateHash,
    qrIds
  });
  const final = buildFinalSource({ candidateSource, evidence });
  const parity = await verifyPublicDomainParity(transactionContext, final.plan);
  if (parity.domainHash !== final.domainHash) {
    throw reproofError('CONTENT_PRIVACY_REPROOF_DOMAIN_HASH_MISMATCH');
  }
  const markerResult = await transactionContext.query(
    `SELECT source_sha256, status,
            checksum_summary ->> $2 AS public_qr_domain_sha256,
            checksum_summary ->> 'superseded_by_source_sha256'
              AS superseded_by_source_sha256
     FROM app.import_runs
     WHERE source_sha256 = ANY($1::text[])
     ORDER BY source_sha256`,
    [[candidateHash, final.sourceHash], PUBLIC_QR_DOMAIN_CHECKSUM_KEY]
  );
  const markers = new Map(
    markerResult.rows.map((row) => [String(row.source_sha256), row])
  );
  const candidateMarker = markers.get(candidateHash);
  const finalMarker = markers.get(final.sourceHash);
  if (!candidateMarker
      || candidateMarker.public_qr_domain_sha256 !== candidateDomainHash) {
    throw reproofError('CONTENT_PRIVACY_REPROOF_CANDIDATE_MARKER_INVALID');
  }
  if (finalMarker) {
    if (finalMarker.status !== 'passed'
        || finalMarker.public_qr_domain_sha256 !== final.domainHash
        || candidateMarker.status !== 'blocked'
        || candidateMarker.superseded_by_source_sha256 !== final.sourceHash) {
      throw reproofError('CONTENT_PRIVACY_REPROOF_FINAL_MARKER_INVALID');
    }
    return Object.freeze({ ...final, markerApplied: false });
  }
  if (candidateMarker.status !== 'passed'
      || candidateMarker.superseded_by_source_sha256) {
    throw reproofError('CONTENT_PRIVACY_REPROOF_CANDIDATE_MARKER_INVALID');
  }
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
    [candidateHash, final.sourceHash]
  );
  if (superseded.rows.length !== 1) {
    throw reproofError('CONTENT_PRIVACY_REPROOF_CANDIDATE_SUPERSEDE_FAILED');
  }
  const sourceCounts = Object.fromEntries(
    IMPORT_ORDER.map((collection) => [collection, final.plan[collection].length])
  );
  const actualCounts = await readActualCounts(transactionContext);
  const attemptCount = evidence.qrIds.reduce(
    (count, qrId) => count + Number(evidence.attempts.get(qrId).attempt_count),
    0
  );
  await transactionContext.query(
    `INSERT INTO app.import_runs (
      id, source_sha256, source_label, importer_version, mode, status,
      source_counts, imported_counts, checksum_summary, completed_at
    ) VALUES (
      $1, $2, $3, $4, 'final', 'passed',
      $5::jsonb, $6::jsonb, $7::jsonb, CURRENT_TIMESTAMP
    )`,
    [
      randomUUID(),
      final.sourceHash,
      `privacy-reproof-${final.sourceHash.slice(0, 12)}`,
      FINAL_IMPORTER_VERSION,
      JSON.stringify(sourceCounts),
      JSON.stringify(actualCounts),
      JSON.stringify({
        source_sha256: final.sourceHash,
        plan_sha256: planSha256(final.plan),
        [PUBLIC_QR_DOMAIN_CHECKSUM_KEY]: final.domainHash,
        supersedes_source_sha256: candidateHash,
        verification_scope: 'public_qr_v1_and_operational_evidence_v1',
        reproof_target_count: evidence.qrIds.length,
        operational_proof_attempt_count: attemptCount,
        operational_proof_attempts_preserved: true
      })
    ]
  );
  return Object.freeze({ ...final, markerApplied: true });
}

function replaceLiveDatabaseWithFinal({
  liveDatabasePath,
  candidateHash,
  final
}) {
  const resolved = path.resolve(liveDatabasePath);
  if (!fs.existsSync(resolved) || fs.lstatSync(resolved).isSymbolicLink()) {
    throw reproofError('CONTENT_PRIVACY_REPROOF_LIVE_DATABASE_INVALID');
  }
  const currentBytes = fs.readFileSync(resolved);
  const currentHash = crypto.createHash('sha256').update(currentBytes).digest('hex');
  if (currentHash === final.sourceHash) {
    return Object.freeze({ applied: false, sourceHash: currentHash });
  }
  if (currentHash !== candidateHash) {
    throw reproofError('CONTENT_PRIVACY_REPROOF_LIVE_DATABASE_DRIFT');
  }
  const stat = fs.statSync(resolved);
  const tempPath = path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.reproof.${process.pid}.${Date.now()}.tmp`
  );
  let descriptor = null;
  try {
    descriptor = fs.openSync(tempPath, 'wx', stat.mode & 0o777);
    fs.writeFileSync(descriptor, final.serialized);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    const beforeRename = crypto.createHash('sha256')
      .update(fs.readFileSync(resolved))
      .digest('hex');
    if (beforeRename !== candidateHash) {
      throw reproofError('CONTENT_PRIVACY_REPROOF_LIVE_DATABASE_CHANGED');
    }
    fs.renameSync(tempPath, resolved);
    if (process.platform !== 'win32') {
      const directory = fs.openSync(path.dirname(resolved), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    try { fs.unlinkSync(tempPath); } catch (_cleanupError) {}
    throw error;
  }
  const finalHash = crypto.createHash('sha256')
    .update(fs.readFileSync(resolved))
    .digest('hex');
  if (finalHash !== final.sourceHash) {
    throw reproofError('CONTENT_PRIVACY_REPROOF_LIVE_DATABASE_WRITE_FAILED');
  }
  return Object.freeze({ applied: true, sourceHash: finalHash });
}

module.exports = {
  FINALIZE_LOCK_KEY,
  FINAL_IMPORTER_VERSION,
  JOB_TYPE,
  assertEvidenceComplete,
  buildFinalSource,
  finalizePostgresRevision,
  idempotencyKey,
  loadTargetEvidence,
  normalizedQrIds,
  replaceLiveDatabaseWithFinal,
  verifyCandidateTransitionBase,
  verifyPublicDomainParity
};
