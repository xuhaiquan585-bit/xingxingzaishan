'use strict';

const crypto = require('node:crypto');
const net = require('node:net');

const JOB_TYPE = 'record_proof_archive_certificate';
const MAX_CERTIFICATE_BYTES = 10 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15000;
const USER_AGENT = 'xingxingzaishan-record-proof/1.0';

class RecordProofCertificateArchiveError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RecordProofCertificateArchiveError';
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
    throw new RecordProofCertificateArchiveError('RECORD_PROOF_CERTIFICATE_CLOCK_INVALID');
  }
  return value.toISOString();
}

function validateArchiveJob(job) {
  const proofId = normalizedText(job && job.payload && job.payload.proof_id);
  if (
    !job
    || job.job_type !== JOB_TYPE
    || job.aggregate_type !== 'record'
    || !normalizedText(job.aggregate_id)
    || !proofId
    || proofId.length > 160
    || /[\r\n\0]/.test(proofId)
  ) {
    throw new RecordProofCertificateArchiveError('RECORD_PROOF_CERTIFICATE_JOB_INVALID');
  }
  return Object.freeze({ proofId, recordQrId: normalizedText(job.aggregate_id) });
}

function normalizeAllowedHosts(values) {
  const entries = values instanceof Set ? [...values] : values;
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 20) {
    throw new RecordProofCertificateArchiveError('RECORD_PROOF_CERTIFICATE_HOSTS_REQUIRED');
  }
  const hosts = new Set(entries.map((value) => normalizedText(value).toLowerCase()));
  if ([...hosts].some((host) => (
    !host
    || host === 'localhost'
    || net.isIP(host) !== 0
    || host.length > 253
    || !host.includes('.')
    || !/^[a-z0-9.-]+$/.test(host)
    || host.startsWith('.')
    || host.endsWith('.')
    || host.includes('..')
  ))) {
    throw new RecordProofCertificateArchiveError('RECORD_PROOF_CERTIFICATE_HOSTS_INVALID');
  }
  return hosts;
}

function validatedCertificateUrl(value, allowedHosts) {
  let parsed;
  try {
    parsed = new URL(normalizedText(value));
  } catch (_error) {
    throw new RecordProofCertificateArchiveError('RECORD_PROOF_CERTIFICATE_URL_INVALID');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.hash
    || (parsed.port && parsed.port !== '443')
    || !allowedHosts.has(hostname)
  ) {
    throw new RecordProofCertificateArchiveError('RECORD_PROOF_CERTIFICATE_URL_REJECTED');
  }
  return parsed.toString();
}

function validateCertificateBuffer(buffer, contentType) {
  if (
    !Buffer.isBuffer(buffer)
    || buffer.length === 0
    || buffer.length > MAX_CERTIFICATE_BYTES
    || buffer.subarray(0, 5).toString('ascii') !== '%PDF-'
  ) {
    throw new RecordProofCertificateArchiveError('RECORD_PROOF_CERTIFICATE_RESPONSE_INVALID');
  }
  const mediaType = normalizedText(contentType).split(';', 1)[0].toLowerCase();
  if (!['application/pdf', 'application/octet-stream'].includes(mediaType)) {
    throw new RecordProofCertificateArchiveError('RECORD_PROOF_CERTIFICATE_CONTENT_TYPE_INVALID');
  }
}

async function readBoundedBody(body, maximumBytes) {
  if (!body || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new RecordProofCertificateArchiveError('RECORD_PROOF_CERTIFICATE_RESPONSE_INVALID');
  }
  const chunks = [];
  let total = 0;

  function accept(value) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
    total += chunk.length;
    if (total > maximumBytes) {
      throw new RecordProofCertificateArchiveError('RECORD_PROOF_CERTIFICATE_RESPONSE_INVALID');
    }
    chunks.push(chunk);
  }

  if (typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        accept(item.value);
      }
    } catch (error) {
      if (error instanceof RecordProofCertificateArchiveError) {
        await reader.cancel().catch(() => null);
        throw error;
      }
      throw new RecordProofCertificateArchiveError('RECORD_PROOF_CERTIFICATE_DOWNLOAD_FAILED');
    } finally {
      if (typeof reader.releaseLock === 'function') reader.releaseLock();
    }
    return Buffer.concat(chunks, total);
  }

  if (typeof body[Symbol.asyncIterator] === 'function') {
    const iterator = body[Symbol.asyncIterator]();
    try {
      while (true) {
        const item = await iterator.next();
        if (item.done) break;
        accept(item.value);
      }
    } catch (error) {
      if (typeof iterator.return === 'function') await iterator.return().catch(() => null);
      if (error instanceof RecordProofCertificateArchiveError) throw error;
      throw new RecordProofCertificateArchiveError('RECORD_PROOF_CERTIFICATE_DOWNLOAD_FAILED');
    }
    return Buffer.concat(chunks, total);
  }

  throw new RecordProofCertificateArchiveError('RECORD_PROOF_CERTIFICATE_RESPONSE_INVALID');
}

function certificateObjectKey({ prefix, recordQrId, buffer }) {
  const recordHash = crypto.createHash('sha256').update(recordQrId, 'utf8').digest('hex');
  const contentHash = crypto.createHash('sha256').update(buffer).digest('hex');
  return `${prefix}/proof-certificates/${recordHash}/${contentHash}.pdf`;
}

async function enqueueCertificateArchiveJob({
  outboxRepository,
  proof,
  now,
  randomUUID = crypto.randomUUID
} = {}) {
  if (!outboxRepository || typeof outboxRepository.insertPendingOnce !== 'function') {
    throw new RecordProofCertificateArchiveError('RECORD_PROOF_CERTIFICATE_OUTBOX_REQUIRED');
  }
  if (
    !proof
    || proof.status !== 'confirmed'
    || !normalizedText(proof.provider_certificate_url)
    || normalizedText(proof.certificate_object_key)
  ) {
    return null;
  }
  const timestamp = normalizedText(now);
  const proofId = normalizedText(proof.id);
  const recordQrId = normalizedText(proof.record_qr_id);
  if (!timestamp || !proofId || !recordQrId) {
    throw new RecordProofCertificateArchiveError('RECORD_PROOF_CERTIFICATE_PROOF_INVALID');
  }
  return outboxRepository.insertPendingOnce({
    id: randomUUID(),
    job_type: JOB_TYPE,
    aggregate_type: 'record',
    aggregate_id: recordQrId,
    payload: { proof_id: proofId },
    idempotency_key: `record-proof-certificate:${proofId}`,
    available_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp
  });
}

function createRecordProofCertificateArchiveHandler({
  pool,
  allowedHosts,
  fetchImpl = globalThis.fetch,
  saveObject,
  objectPrefix,
  transactionRunner,
  repositoryTypes,
  clock = () => new Date()
} = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new RecordProofCertificateArchiveError('RECORD_PROOF_CERTIFICATE_POOL_REQUIRED');
  }
  if (typeof fetchImpl !== 'function') {
    throw new RecordProofCertificateArchiveError('RECORD_PROOF_CERTIFICATE_FETCH_REQUIRED');
  }
  const storage = saveObject && objectPrefix
    ? null
    : require('../storageService');
  const persistObject = saveObject || storage.saveBinaryObjectAtKey;
  const prefix = normalizedText(objectPrefix || storage.getObjectPrefix());
  if (typeof persistObject !== 'function' || !/^[a-zA-Z0-9_-]{1,120}$/.test(prefix)) {
    throw new RecordProofCertificateArchiveError('RECORD_PROOF_CERTIFICATE_STORAGE_INVALID');
  }
  const hosts = normalizeAllowedHosts(allowedHosts);
  const runTransaction = transactionRunner
    || require('../../database/transaction').withTransaction;
  const repositories = repositoryTypes || require('../../repositories');

  async function readProof(proofId) {
    return runTransaction(pool, async (context) => (
      new repositories.ProofRepository(context).findById(proofId)
    ), { isolationLevel: 'read committed', readOnly: true });
  }

  async function download(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Accept: 'application/pdf, application/octet-stream;q=0.8',
          'User-Agent': USER_AGENT
        }
      });
    } catch (_error) {
      throw new RecordProofCertificateArchiveError('RECORD_PROOF_CERTIFICATE_DOWNLOAD_FAILED');
    } finally {
      clearTimeout(timer);
    }
    const declaredLength = Number(response.headers && response.headers.get('content-length'));
    if (
      response.status !== 200
      || (Number.isFinite(declaredLength) && declaredLength > MAX_CERTIFICATE_BYTES)
    ) {
      throw new RecordProofCertificateArchiveError('RECORD_PROOF_CERTIFICATE_RESPONSE_INVALID');
    }
    const buffer = await readBoundedBody(response.body, MAX_CERTIFICATE_BYTES);
    validateCertificateBuffer(buffer, response.headers && response.headers.get('content-type'));
    return buffer;
  }

  return async function archiveCertificate(job) {
    const { proofId, recordQrId } = validateArchiveJob(job);
    const proof = await readProof(proofId);
    if (!proof || normalizedText(proof.record_qr_id) !== recordQrId) {
      throw new RecordProofCertificateArchiveError('RECORD_PROOF_CERTIFICATE_PROOF_NOT_FOUND');
    }
    if (normalizedText(proof.certificate_object_key)) return proof;
    if (proof.status !== 'confirmed' || !normalizedText(proof.provider_certificate_url)) {
      throw new RecordProofCertificateArchiveError('RECORD_PROOF_CERTIFICATE_PROOF_NOT_READY');
    }

    const url = validatedCertificateUrl(proof.provider_certificate_url, hosts);
    const buffer = await download(url);
    const objectKey = certificateObjectKey({ prefix, recordQrId, buffer });
    const saved = await persistObject({
      objectKey,
      buffer,
      contentType: 'application/pdf',
      allowCloudFallback: false
    });
    if (!saved || normalizedText(saved.object_key) !== objectKey) {
      throw new RecordProofCertificateArchiveError('RECORD_PROOF_CERTIFICATE_STORAGE_FAILED');
    }

    const updatedAt = operationTimestamp(clock);
    return runTransaction(pool, async (context) => {
      const proofs = new repositories.ProofRepository(context);
      const current = await proofs.findForUpdate(proofId);
      if (!current || normalizedText(current.record_qr_id) !== recordQrId) {
        throw new RecordProofCertificateArchiveError('RECORD_PROOF_CERTIFICATE_PROOF_NOT_FOUND');
      }
      if (normalizedText(current.certificate_object_key)) return current;
      if (
        current.status !== 'confirmed'
        || normalizedText(current.provider_certificate_url) !== normalizedText(proof.provider_certificate_url)
      ) {
        throw new RecordProofCertificateArchiveError('RECORD_PROOF_CERTIFICATE_STATE_CONFLICT');
      }
      const updated = await proofs.markCertificateArchived({
        id: current.id,
        certificate_object_key: objectKey,
        certificate_object_url_snapshot: null,
        updated_at: updatedAt
      });
      if (!updated) {
        throw new RecordProofCertificateArchiveError('RECORD_PROOF_CERTIFICATE_STATE_CONFLICT');
      }
      return updated;
    }, { isolationLevel: 'read committed' });
  };
}

module.exports = {
  JOB_TYPE,
  MAX_CERTIFICATE_BYTES,
  RecordProofCertificateArchiveError,
  certificateObjectKey,
  createRecordProofCertificateArchiveHandler,
  enqueueCertificateArchiveJob,
  readBoundedBody,
  validateArchiveJob,
  validatedCertificateUrl
};
