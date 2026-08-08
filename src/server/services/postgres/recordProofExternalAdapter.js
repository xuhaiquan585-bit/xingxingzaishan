'use strict';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CONFIRMED_STATUSES = new Set([
  1,
  '1',
  'success',
  'succeed',
  'confirmed',
  'completed',
  'ok'
]);
const FAILED_STATUSES = new Set([2, '2', 'failed', 'fail', 'error']);
const SUBMITTED_STATUSES = new Set([
  0,
  '0',
  'pending',
  'processing',
  'submitted'
]);

class RecordProofExternalError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RecordProofExternalError';
    this.code = code;
  }
}

function normalizedText(value) {
  return String(value || '').trim();
}

function requiredFunction(value, code) {
  if (typeof value !== 'function') throw new RecordProofExternalError(code);
  return value;
}

function normalizedTimestamp(value, code) {
  if (value === null || value === undefined || value === '') {
    throw new RecordProofExternalError(code);
  }
  const candidate = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(candidate.getTime())) {
    throw new RecordProofExternalError(code);
  }
  return candidate.toISOString();
}

function normalizedSha256(value, { optional = false } = {}) {
  const normalized = normalizedText(value).toLowerCase();
  if (!normalized && optional) return null;
  if (!SHA256_PATTERN.test(normalized)) {
    throw new RecordProofExternalError('RECORD_PROOF_EXTERNAL_HASH_INVALID');
  }
  return normalized;
}

function normalizeProviderStatus(value) {
  const normalized = typeof value === 'string'
    ? value.trim().toLowerCase()
    : value;
  if (CONFIRMED_STATUSES.has(normalized)) return 'confirmed';
  if (FAILED_STATUSES.has(normalized)) return 'failed';
  if (SUBMITTED_STATUSES.has(normalized)) return 'submitted';
  throw new RecordProofExternalError('RECORD_PROOF_PROVIDER_STATUS_INVALID');
}

function normalizeBlockHeight(value) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new RecordProofExternalError('RECORD_PROOF_PROVIDER_RESULT_INVALID');
  }
  return normalized;
}

function defaultDependencies(overrides) {
  let manifestService;
  let archiveService;
  let avataService;
  if (!overrides.buildRecordManifest || !overrides.hashManifest) {
    manifestService = require('../manifestService');
  }
  if (!overrides.hashImageForRecord || !overrides.writeRecordArchive) {
    archiveService = require('../archiveService');
  }
  if (!overrides.submitRecordProof || !overrides.normalizeAvataResult) {
    avataService = require('../avataService');
  }
  return {
    buildRecordManifest:
      overrides.buildRecordManifest || manifestService.buildRecordManifest,
    hashManifest: overrides.hashManifest || manifestService.hashManifest,
    hashImageForRecord:
      overrides.hashImageForRecord || archiveService.hashImageForRecord,
    writeRecordArchive:
      overrides.writeRecordArchive || archiveService.writeRecordArchive,
    submitRecordProof:
      overrides.submitRecordProof || avataService.submitRecordProof,
    normalizeAvataResult:
      overrides.normalizeAvataResult || avataService.normalizeAvataResult
  };
}

function createRecordProofExternalAdapter(options = {}) {
  const dependencies = defaultDependencies(options);
  const buildManifest = requiredFunction(
    dependencies.buildRecordManifest,
    'RECORD_PROOF_MANIFEST_BUILDER_REQUIRED'
  );
  const hashManifest = requiredFunction(
    dependencies.hashManifest,
    'RECORD_PROOF_MANIFEST_HASHER_REQUIRED'
  );
  const hashImage = requiredFunction(
    dependencies.hashImageForRecord,
    'RECORD_PROOF_IMAGE_HASHER_REQUIRED'
  );
  const writeArchive = requiredFunction(
    dependencies.writeRecordArchive,
    'RECORD_PROOF_ARCHIVE_WRITER_REQUIRED'
  );
  const submitProof = requiredFunction(
    dependencies.submitRecordProof,
    'RECORD_PROOF_PROVIDER_SUBMITTER_REQUIRED'
  );
  const normalizeResult = requiredFunction(
    dependencies.normalizeAvataResult,
    'RECORD_PROOF_PROVIDER_NORMALIZER_REQUIRED'
  );
  const allowMock = options.allowMock === true;

  async function prepareRecord({ record, proof } = {}) {
    const recordId = normalizedText(record && record.id);
    if (!recordId || record.activation_status !== 'activated') {
      throw new RecordProofExternalError('RECORD_PROOF_EXTERNAL_RECORD_INVALID');
    }
    normalizedTimestamp(
      record.activated_at,
      'RECORD_PROOF_EXTERNAL_RECORD_INVALID'
    );
    const generatedAt = normalizedTimestamp(
      proof && proof.created_at,
      'RECORD_PROOF_EXTERNAL_PROOF_INVALID'
    );
    const imageSha256 = normalizedSha256(await hashImage(record), {
      optional: true
    });
    const sealedRecord = Object.freeze({
      ...record,
      image_sha256: imageSha256
    });
    const manifest = buildManifest(sealedRecord, { generatedAt });
    const manifestHash = normalizedSha256(hashManifest(manifest));
    const archive = await writeArchive({
      record: sealedRecord,
      manifest,
      manifestHash,
      imageSha256
    });
    const manifestObjectKey = normalizedText(
      archive && archive.manifest_object_key
    );
    if (!manifestObjectKey) {
      throw new RecordProofExternalError('RECORD_PROOF_ARCHIVE_RESULT_INVALID');
    }
    return Object.freeze({
      manifest_hash: manifestHash,
      manifest_object_key: manifestObjectKey,
      image_sha256: imageSha256,
      legacy_manifest_object_key: null,
      index_object_key:
        normalizedText(archive && archive.archive_index_object_key) || null
    });
  }

  async function submitRecord(input = {}) {
    const operationId = normalizedText(input.operation_id);
    const recordId = normalizedText(input.record_qr_id);
    const manifestHash = normalizedSha256(input.manifest_hash);
    const sealedAt = normalizedTimestamp(
      input.sealed_at,
      'RECORD_PROOF_EXTERNAL_SUBMISSION_INVALID'
    );
    if (!operationId || operationId.length > 200 || !recordId) {
      throw new RecordProofExternalError(
        'RECORD_PROOF_EXTERNAL_SUBMISSION_INVALID'
      );
    }
    const raw = await submitProof({
      operationId,
      manifestHash,
      starId: recordId,
      sealedAt
    });
    if (raw && raw.mock === true && !allowMock) {
      throw new RecordProofExternalError('RECORD_PROOF_PROVIDER_DISABLED');
    }
    const result = normalizeResult(raw);
    if (!result || typeof result !== 'object') {
      throw new RecordProofExternalError('RECORD_PROOF_PROVIDER_RESULT_INVALID');
    }
    return Object.freeze({
      status: normalizeProviderStatus(result.status),
      transaction_hash: normalizedText(result.tx_hash) || null,
      block_height: normalizeBlockHeight(result.block_height),
      provider_record_id: normalizedText(result.record_id) || null,
      provider_certificate_url:
        normalizedText(result.certificate_url) || null
    });
  }

  return Object.freeze({ prepareRecord, submitRecord });
}

module.exports = {
  RecordProofExternalError,
  createRecordProofExternalAdapter,
  normalizeProviderStatus
};
