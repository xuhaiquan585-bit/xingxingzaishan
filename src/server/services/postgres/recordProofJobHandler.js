'use strict';

const crypto = require('node:crypto');

const JOB_TYPE = 'record_proof_prepare_submit';
const TERMINAL_STATUSES = new Set(['submitted', 'confirmed']);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

class RecordProofJobError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'RecordProofJobError';
    this.code = code;
  }
}

function requiredFunction(value, code) {
  if (typeof value !== 'function') throw new RecordProofJobError(code);
  return value;
}

function normalizedText(value) {
  return String(value || '').trim();
}

function operationTimestamp(clock) {
  const candidate = clock();
  const value = candidate instanceof Date ? candidate : new Date(candidate);
  if (Number.isNaN(value.getTime())) {
    throw new RecordProofJobError('RECORD_PROOF_CLOCK_INVALID');
  }
  return value.toISOString();
}

function operationUuid(randomUUID) {
  const value = normalizedText(randomUUID());
  if (!value) throw new RecordProofJobError('RECORD_PROOF_UUID_INVALID');
  return value;
}

function validateJob(job) {
  const aggregateId = normalizedText(job && job.aggregate_id);
  const payloadId = normalizedText(job && job.payload && job.payload.record_qr_id);
  if (!job || job.job_type !== JOB_TYPE || job.aggregate_type !== 'record') {
    throw new RecordProofJobError('RECORD_PROOF_JOB_INVALID');
  }
  if (!aggregateId || !payloadId || aggregateId !== payloadId) {
    throw new RecordProofJobError('RECORD_PROOF_JOB_RECORD_MISMATCH');
  }
  return aggregateId;
}

function hasPreparedManifest(proof) {
  return Boolean(
    proof
    && SHA256_PATTERN.test(normalizedText(proof.manifest_hash))
    && normalizedText(proof.manifest_object_key)
    && normalizedText(proof.operation_id)
  );
}

function normalizePreparation(result) {
  const manifestHash = normalizedText(result && result.manifest_hash).toLowerCase();
  const manifestObjectKey = normalizedText(result && result.manifest_object_key);
  const imageSha256 = normalizedText(result && result.image_sha256).toLowerCase() || null;
  if (!SHA256_PATTERN.test(manifestHash) || !manifestObjectKey) {
    throw new RecordProofJobError('RECORD_PROOF_PREPARATION_RESULT_INVALID');
  }
  if (imageSha256 && !SHA256_PATTERN.test(imageSha256)) {
    throw new RecordProofJobError('RECORD_PROOF_PREPARATION_RESULT_INVALID');
  }
  return Object.freeze({
    manifest_hash: manifestHash,
    manifest_object_key: manifestObjectKey,
    image_sha256: imageSha256,
    legacy_manifest_object_key:
      normalizedText(result && result.legacy_manifest_object_key) || null,
    index_object_key: normalizedText(result && result.index_object_key) || null
  });
}

function optionalText(value, maximum, code) {
  const text = normalizedText(value);
  if (text.length > maximum) throw new RecordProofJobError(code);
  return text || null;
}

function normalizeSubmission(result, timestamp) {
  const status = normalizedText(result && result.status).toLowerCase();
  if (!['submitted', 'confirmed', 'failed'].includes(status)) {
    throw new RecordProofJobError('RECORD_PROOF_SUBMISSION_RESULT_INVALID');
  }
  let blockHeight = result && result.block_height;
  if (blockHeight === '' || blockHeight === undefined || blockHeight === null) {
    blockHeight = null;
  } else {
    blockHeight = Number(blockHeight);
    if (!Number.isSafeInteger(blockHeight) || blockHeight < 0) {
      throw new RecordProofJobError('RECORD_PROOF_SUBMISSION_RESULT_INVALID');
    }
  }
  let confirmedAt = null;
  if (status === 'confirmed') {
    confirmedAt = result && result.confirmed_at
      ? operationTimestamp(() => result.confirmed_at)
      : timestamp;
  }
  return Object.freeze({
    status,
    transaction_hash: optionalText(
      result && result.transaction_hash,
      255,
      'RECORD_PROOF_SUBMISSION_RESULT_INVALID'
    ),
    block_height: blockHeight,
    provider_record_id: optionalText(
      result && result.provider_record_id,
      200,
      'RECORD_PROOF_SUBMISSION_RESULT_INVALID'
    ),
    provider_certificate_url:
      normalizedText(result && result.provider_certificate_url) || null,
    confirmed_at: confirmedAt
  });
}

function operationId(recordQrId, manifestHash) {
  const value = `record_${recordQrId}_${manifestHash.slice(0, 16)}`;
  if (value.length > 200) {
    throw new RecordProofJobError('RECORD_PROOF_OPERATION_ID_INVALID');
  }
  return value;
}

function createRecordProofJobHandler({
  pool,
  prepareRecord,
  submitRecord,
  transactionRunner,
  repositoryTypes,
  provider = 'avata_wenchang',
  clock = () => new Date(),
  randomUUID = crypto.randomUUID
} = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new RecordProofJobError('RECORD_PROOF_POOL_REQUIRED');
  }
  const prepare = requiredFunction(prepareRecord, 'RECORD_PROOF_PREPARER_REQUIRED');
  const submit = requiredFunction(submitRecord, 'RECORD_PROOF_SUBMITTER_REQUIRED');
  requiredFunction(clock, 'RECORD_PROOF_CLOCK_REQUIRED');
  requiredFunction(randomUUID, 'RECORD_PROOF_UUID_REQUIRED');
  const normalizedProvider = normalizedText(provider);
  if (!normalizedProvider || normalizedProvider.length > 64) {
    throw new RecordProofJobError('RECORD_PROOF_PROVIDER_INVALID');
  }
  const runTransaction = transactionRunner
    || require('../../database/transaction').withTransaction;
  const repositories = repositoryTypes || require('../../repositories');

  function transaction(callback) {
    return runTransaction(pool, callback, { isolationLevel: 'read committed' });
  }

  function proofRepository(context) {
    return new repositories.ProofRepository(context);
  }

  async function loadState(recordQrId) {
    return transaction(async (context) => {
      const qrRepository = new repositories.QrRepository(context);
      const recordRepository = new repositories.RecordRepository(context);
      const coCreationRepository = new repositories.CoCreationRepository(context);
      const batchRepository = new repositories.QrBatchRepository(context);
      const proofs = proofRepository(context);
      const qr = await qrRepository.findById(recordQrId);
      const record = await recordRepository.findByQrIdForUpdate(recordQrId);
      if (!qr || !record) throw new RecordProofJobError('RECORD_PROOF_RECORD_NOT_FOUND');
      if (qr.lifecycle_status !== 'activated' || !record.sealed_at) {
        throw new RecordProofJobError('RECORD_PROOF_RECORD_NOT_SEALED');
      }
      let proof = await proofs.findByRecordIdForUpdate(recordQrId);
      if (!proof) {
        const timestamp = operationTimestamp(clock);
        proof = await proofs.insertPending({
          id: operationUuid(randomUUID),
          record_qr_id: recordQrId,
          provider: normalizedProvider,
          status: 'not_started',
          operation_id: null,
          manifest_object_key: null,
          manifest_hash: null,
          legacy_hash_snapshot: null,
          transaction_hash: null,
          block_height: null,
          provider_record_id: null,
          provider_certificate_url: null,
          certificate_object_key: null,
          certificate_object_url_snapshot: null,
          confirmed_at: null,
          callback_received_at: null,
          retry_count: 0,
          last_error: '',
          created_at: timestamp,
          updated_at: timestamp
        });
      }
      if (!proof) throw new RecordProofJobError('RECORD_PROOF_STATE_CONFLICT');
      if (proof.provider !== normalizedProvider) {
        throw new RecordProofJobError('RECORD_PROOF_PROVIDER_CONFLICT');
      }
      if (proof.legacy_hash_snapshot && !TERMINAL_STATUSES.has(proof.status)) {
        throw new RecordProofJobError('RECORD_PROOF_LEGACY_STATE_UNSUPPORTED');
      }
      if (TERMINAL_STATUSES.has(proof.status) || hasPreparedManifest(proof)) {
        return { proof, source: null, sealedAt: record.sealed_at };
      }
      const coCreation = await coCreationRepository.findByQrId(recordQrId);
      const comments = coCreation
        ? await coCreationRepository.listEffectiveComments(coCreation.id)
        : [];
      const batch = qr.batch_id ? await batchRepository.findById(qr.batch_id) : null;
      return {
        proof,
        sealedAt: record.sealed_at,
        source: Object.freeze({
          id: qr.id,
          activation_status: qr.lifecycle_status,
          activated_at: record.sealed_at,
          content: record.content,
          image_url: record.image_url_snapshot,
          image_object_key: record.image_object_key,
          image_sha256: record.image_sha256,
          co_creation_enabled: Boolean(coCreation),
          co_creation_comments: comments,
          show_brand_disclosure: record.show_brand_disclosure,
          brand_disclosure_text_snapshot: record.brand_disclosure_text_snapshot,
          batch_id: batch ? batch.id : qr.batch_id
        })
      };
    });
  }

  async function persistPreparation(recordQrId, proofId, prepared) {
    return transaction(async (context) => {
      const proofs = proofRepository(context);
      const current = await proofs.findForUpdate(proofId);
      if (!current) throw new RecordProofJobError('RECORD_PROOF_STATE_NOT_FOUND');
      if (TERMINAL_STATUSES.has(current.status) || hasPreparedManifest(current)) return current;
      const timestamp = operationTimestamp(clock);
      if (prepared.image_sha256) {
        const record = await new repositories.RecordRepository(context).setImageSha256({
          qr_id: recordQrId,
          image_sha256: prepared.image_sha256,
          updated_at: timestamp
        });
        if (!record) throw new RecordProofJobError('RECORD_PROOF_IMAGE_HASH_CONFLICT');
      }
      const updated = await proofs.markManifestReady({
        id: proofId,
        operation_id: operationId(recordQrId, prepared.manifest_hash),
        manifest_object_key: prepared.manifest_object_key,
        manifest_hash: prepared.manifest_hash,
        updated_at: timestamp
      });
      if (!updated) throw new RecordProofJobError('RECORD_PROOF_STATE_CONFLICT');
      const archive = await new repositories.ArchiveRepository(context).upsertReady({
        record_qr_id: recordQrId,
        manifest_object_key: prepared.manifest_object_key,
        legacy_manifest_object_key: prepared.legacy_manifest_object_key,
        index_object_key: prepared.index_object_key,
        created_at: timestamp,
        updated_at: timestamp
      });
      if (!archive) throw new RecordProofJobError('RECORD_PROOF_ARCHIVE_CONFLICT');
      return updated;
    });
  }

  async function persistPreparationFailure(recordQrId, proofId, code) {
    return transaction(async (context) => {
      const timestamp = operationTimestamp(clock);
      const proofs = proofRepository(context);
      const current = await proofs.findForUpdate(proofId);
      if (!current || TERMINAL_STATUSES.has(current.status)) return current;
      const failed = await proofs.markFailed({ id: proofId, last_error: code, updated_at: timestamp });
      await new repositories.ArchiveRepository(context).markFailed({
        record_qr_id: recordQrId,
        last_error: code,
        updated_at: timestamp
      });
      return failed;
    });
  }

  async function startAttempt(proofId) {
    return transaction(async (context) => {
      const proofs = proofRepository(context);
      const current = await proofs.findForUpdate(proofId);
      if (!current) throw new RecordProofJobError('RECORD_PROOF_STATE_NOT_FOUND');
      if (TERMINAL_STATUSES.has(current.status)) return { proof: current, attempt: null };
      if (!hasPreparedManifest(current)) {
        throw new RecordProofJobError('RECORD_PROOF_MANIFEST_NOT_READY');
      }
      const timestamp = operationTimestamp(clock);
      await proofs.failPendingAttempts({
        proof_id: proofId,
        sanitized_error: 'RECORD_PROOF_ATTEMPT_INTERRUPTED',
        completed_at: timestamp
      });
      const attemptNumber = Number(current.retry_count || 0) + 1;
      const updated = await proofs.markSubmitting({
        id: proofId,
        retry_count: attemptNumber,
        updated_at: timestamp
      });
      if (!updated) throw new RecordProofJobError('RECORD_PROOF_STATE_CONFLICT');
      const attempt = await proofs.appendAttempt({
        proof_id: proofId,
        attempt_number: attemptNumber,
        request_state: 'started',
        result_status: 'pending',
        sanitized_error: '',
        requested_at: timestamp,
        completed_at: null
      });
      if (!attempt) throw new RecordProofJobError('RECORD_PROOF_ATTEMPT_CONFLICT');
      return { proof: updated, attempt };
    });
  }

  async function finishAttempt(proofId, attemptNumber, result, errorCode = '') {
    return transaction(async (context) => {
      const timestamp = operationTimestamp(clock);
      const proofs = proofRepository(context);
      const current = await proofs.findForUpdate(proofId);
      if (!current) throw new RecordProofJobError('RECORD_PROOF_STATE_NOT_FOUND');
      let updated = current;
      if (TERMINAL_STATUSES.has(current.status)) {
        const completed = await proofs.completeAttempt({
          proof_id: proofId,
          attempt_number: attemptNumber,
          result_status: 'succeeded',
          sanitized_error: '',
          completed_at: timestamp
        });
        if (!completed) throw new RecordProofJobError('RECORD_PROOF_STATE_CONFLICT');
        return current;
      }
      if (errorCode || result.status === 'failed') {
        const code = errorCode || 'RECORD_PROOF_PROVIDER_REPORTED_FAILURE';
        updated = await proofs.markFailed({ id: proofId, last_error: code, updated_at: timestamp });
        const completed = await proofs.completeAttempt({
          proof_id: proofId,
          attempt_number: attemptNumber,
          result_status: 'failed',
          sanitized_error: code,
          completed_at: timestamp
        });
        if (!updated || !completed) throw new RecordProofJobError('RECORD_PROOF_STATE_CONFLICT');
        return updated;
      }
      const transition = result.status === 'confirmed' ? 'markConfirmed' : 'markSubmitted';
      updated = await proofs[transition]({ id: proofId, ...result, updated_at: timestamp });
      const completed = await proofs.completeAttempt({
        proof_id: proofId,
        attempt_number: attemptNumber,
        result_status: 'succeeded',
        sanitized_error: '',
        completed_at: timestamp
      });
      if (!updated || !completed) throw new RecordProofJobError('RECORD_PROOF_STATE_CONFLICT');
      return updated;
    });
  }

  async function handle(job) {
    const recordQrId = validateJob(job);
    const initial = await loadState(recordQrId);
    if (TERMINAL_STATUSES.has(initial.proof.status)) return initial.proof;
    let proof = initial.proof;
    if (!hasPreparedManifest(proof)) {
      let prepared;
      try {
        prepared = normalizePreparation(await prepare({
          record: initial.source,
          proof: initial.proof
        }));
      } catch (_error) {
        await persistPreparationFailure(
          recordQrId,
          proof.id,
          'RECORD_PROOF_PREPARATION_FAILED'
        );
        throw new RecordProofJobError('RECORD_PROOF_PREPARATION_FAILED');
      }
      proof = await persistPreparation(recordQrId, proof.id, prepared);
    }
    if (TERMINAL_STATUSES.has(proof.status)) return proof;
    const started = await startAttempt(proof.id);
    if (!started.attempt) return started.proof;
    let result;
    try {
      result = normalizeSubmission(await submit({
        record_qr_id: recordQrId,
        sealed_at: initial.sealedAt,
        proof_id: started.proof.id,
        operation_id: started.proof.operation_id,
        manifest_hash: started.proof.manifest_hash,
        attempt_number: started.attempt.attempt_number
      }), operationTimestamp(clock));
    } catch (error) {
      const code = error instanceof RecordProofJobError
        ? error.code
        : 'RECORD_PROOF_SUBMISSION_FAILED';
      await finishAttempt(started.proof.id, started.attempt.attempt_number, {
        status: 'failed'
      }, code);
      throw new RecordProofJobError(code);
    }
    const completed = await finishAttempt(
      started.proof.id,
      started.attempt.attempt_number,
      result
    );
    if (result.status === 'failed') {
      throw new RecordProofJobError('RECORD_PROOF_PROVIDER_REPORTED_FAILURE');
    }
    return completed;
  }

  return handle;
}

module.exports = {
  JOB_TYPE,
  RecordProofJobError,
  createRecordProofJobHandler,
  hasPreparedManifest,
  normalizePreparation,
  normalizeSubmission,
  validateJob
};
