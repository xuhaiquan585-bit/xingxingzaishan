'use strict';

const ALLOWED_CURRENT_STATUSES = new Set([
  'submitting',
  'submitted',
  'confirmed',
  'failed',
  'retrying'
]);
const RESULT_STATUSES = new Set(['submitted', 'confirmed', 'failed']);
const SOURCES = new Set(['callback', 'query']);

class RecordProofResultError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RecordProofResultError';
    this.code = code;
  }
}

function normalizedText(value) {
  return String(value || '').trim();
}

function operationTimestamp(clock) {
  const candidate = clock();
  const value = candidate instanceof Date ? candidate : new Date(candidate);
  if (Number.isNaN(value.getTime())) {
    throw new RecordProofResultError('RECORD_PROOF_RESULT_CLOCK_INVALID');
  }
  return value.toISOString();
}

function boundedOptionalText(value, maximum) {
  const normalized = normalizedText(value);
  if (normalized.length > maximum) {
    throw new RecordProofResultError('RECORD_PROOF_PROVIDER_RESULT_INVALID');
  }
  return normalized || null;
}

function canonicalResult(value) {
  const status = normalizedText(value && value.status).toLowerCase();
  const operationId = normalizedText(value && value.operation_id);
  if (!RESULT_STATUSES.has(status) || !operationId || operationId.length > 200) {
    throw new RecordProofResultError('RECORD_PROOF_PROVIDER_RESULT_INVALID');
  }
  let blockHeight = value && value.block_height;
  if (blockHeight === null || blockHeight === undefined || blockHeight === '') {
    blockHeight = null;
  } else {
    blockHeight = Number(blockHeight);
    if (!Number.isSafeInteger(blockHeight) || blockHeight < 0) {
      throw new RecordProofResultError('RECORD_PROOF_PROVIDER_RESULT_INVALID');
    }
  }
  const certificateUrl = boundedOptionalText(
    value && value.provider_certificate_url,
    4096
  );
  if (certificateUrl) {
    let parsed;
    try {
      parsed = new URL(certificateUrl);
    } catch (_error) {
      throw new RecordProofResultError('RECORD_PROOF_PROVIDER_RESULT_INVALID');
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      throw new RecordProofResultError('RECORD_PROOF_PROVIDER_RESULT_INVALID');
    }
  }
  return Object.freeze({
    status,
    operation_id: operationId,
    transaction_hash: boundedOptionalText(value && value.transaction_hash, 255),
    block_height: blockHeight,
    provider_record_id: boundedOptionalText(value && value.provider_record_id, 200),
    provider_certificate_url: certificateUrl
  });
}

function assertCompatible(current, result) {
  const fields = [
    'transaction_hash',
    'block_height',
    'provider_record_id'
  ];
  for (const field of fields) {
    const existing = current[field];
    const incoming = result[field];
    if (
      existing !== null
      && existing !== undefined
      && existing !== ''
      && incoming !== null
      && incoming !== undefined
      && incoming !== ''
      && String(existing) !== String(incoming)
    ) {
      throw new RecordProofResultError('RECORD_PROOF_PROVIDER_RESULT_CONFLICT');
    }
  }
}

function createRecordProofResultService({
  pool,
  normalizeProviderResult,
  transactionRunner,
  repositoryTypes,
  provider = 'avata_wenchang',
  clock = () => new Date()
} = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new RecordProofResultError('RECORD_PROOF_RESULT_POOL_REQUIRED');
  }
  if (typeof normalizeProviderResult !== 'function') {
    throw new RecordProofResultError('RECORD_PROOF_RESULT_NORMALIZER_REQUIRED');
  }
  if (typeof clock !== 'function') {
    throw new RecordProofResultError('RECORD_PROOF_RESULT_CLOCK_REQUIRED');
  }
  const normalizedProvider = normalizedText(provider);
  if (!normalizedProvider || normalizedProvider.length > 64) {
    throw new RecordProofResultError('RECORD_PROOF_RESULT_PROVIDER_INVALID');
  }
  const runTransaction = transactionRunner
    || require('../../database/transaction').withTransaction;
  const repositories = repositoryTypes || require('../../repositories');

  async function apply(rawResult, source) {
    if (!SOURCES.has(source)) {
      throw new RecordProofResultError('RECORD_PROOF_RESULT_SOURCE_INVALID');
    }
    let result;
    try {
      result = canonicalResult(await normalizeProviderResult(rawResult));
    } catch (error) {
      if (error instanceof RecordProofResultError) throw error;
      throw new RecordProofResultError('RECORD_PROOF_PROVIDER_RESULT_INVALID');
    }
    const receivedAt = operationTimestamp(clock);
    return runTransaction(pool, async (context) => {
      const proofs = new repositories.ProofRepository(context);
      const current = await proofs.findByOperationIdForUpdate(
        normalizedProvider,
        result.operation_id
      );
      if (!current) {
        return Object.freeze({ outcome: 'not_found', status: null });
      }
      if (!ALLOWED_CURRENT_STATUSES.has(current.status)) {
        throw new RecordProofResultError('RECORD_PROOF_PROVIDER_STATE_INVALID');
      }
      assertCompatible(current, result);
      if (
        current.status === 'confirmed'
        && result.status !== 'confirmed'
      ) {
        return Object.freeze({ outcome: 'stale', status: current.status });
      }
      if (current.status === 'failed' && result.status === 'submitted') {
        return Object.freeze({ outcome: 'stale', status: current.status });
      }
      const updated = await proofs.applyProviderEvent({
        id: current.id,
        status: result.status,
        transaction_hash: result.transaction_hash,
        block_height: result.block_height,
        provider_record_id: result.provider_record_id,
        provider_certificate_url: result.provider_certificate_url,
        confirmed_at: result.status === 'confirmed' ? receivedAt : null,
        callback_received_at: source === 'callback' ? receivedAt : null,
        last_error: result.status === 'failed'
          ? 'RECORD_PROOF_PROVIDER_REPORTED_FAILURE'
          : '',
        updated_at: receivedAt
      });
      if (!updated) {
        throw new RecordProofResultError('RECORD_PROOF_PROVIDER_STATE_CONFLICT');
      }
      return Object.freeze({
        outcome: current.status === result.status ? 'duplicate' : 'applied',
        status: updated.status
      });
    }, { isolationLevel: 'read committed' });
  }

  return Object.freeze({
    applyCallback: (rawResult) => apply(rawResult, 'callback'),
    applyQueryResult: (rawResult) => apply(rawResult, 'query')
  });
}

module.exports = {
  RecordProofResultError,
  assertCompatible,
  canonicalResult,
  createRecordProofResultService
};
