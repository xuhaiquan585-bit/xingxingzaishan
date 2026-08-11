'use strict';

const crypto = require('node:crypto');
const {
  qrImagePath,
  renderQrImage,
  stageFileReplacement
} = require('../qrImageService');

const QR_SUFFIX_WIDTH = 5;
const QR_MAX_SEQUENCE = 99_999;

class QrIssuanceError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'QrIssuanceError';
    this.code = code;
  }
}

function requireMethod(target, method) {
  if (!target || typeof target[method] !== 'function') {
    throw new QrIssuanceError('QR_ISSUANCE_DEPENDENCY_REQUIRED');
  }
  return target[method].bind(target);
}

function timestamp(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new QrIssuanceError('QR_ISSUANCE_CLOCK_INVALID');
  return date.toISOString();
}

function accessToken(randomBytes) {
  const value = randomBytes(16);
  if (!Buffer.isBuffer(value) || value.length !== 16) {
    throw new QrIssuanceError('QR_ISSUANCE_TOKEN_INVALID');
  }
  return value.toString('hex');
}

function presentIssuedQr(row) {
  return {
    id: row.id,
    issue_status: 'issued',
    activation_status: 'unactivated',
    hidden: false,
    batch_id: row.batch_id || null,
    print_batch_id: null,
    quality_check: {
      checked: false, checked_at: null, checked_by: null, result: null
    },
    content: null,
    image_url: null,
    image_object_key: null,
    phone: null,
    activated_at: null,
    blockchain_hash: null,
    chain_provider: 'avata_wenchang',
    chain_status: 'not_started',
    chain_operation_id: null,
    manifest_object_key: null,
    manifest_hash: null,
    chain_tx_hash: null,
    chain_block_height: null,
    chain_record_id: null,
    chain_certificate_url: null,
    chain_certificate_object_key: null,
    chain_certificate_object_url: null,
    chain_confirmed_at: null,
    chain_callback_received_at: null,
    chain_last_error: '',
    chain_retry_count: 0,
    image_sha256: null,
    legacy_manifest_object_key: null,
    archive_index_object_key: null,
    archive_status: 'not_started',
    archive_last_error: '',
    archive_updated_at: null,
    co_creation_enabled: false,
    co_creation_owner_phone: null,
    co_creation_comments: [],
    co_creation_started_at: null,
    show_brand_disclosure: false,
    brand_disclosure_text_snapshot: '',
    qr_image_url: row.qr_image_url_snapshot || null,
    qr_access_token: row.access_token,
    created_at: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : row.created_at
  };
}

function createQrIssuanceService({
  pool,
  transactionRunner,
  repositoryType,
  beforeOperation,
  clock = () => new Date(),
  randomBytes = crypto.randomBytes,
  renderImage = renderQrImage,
  imagePath = qrImagePath,
  stageImage = stageFileReplacement,
  env = process.env
} = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new QrIssuanceError('QR_ISSUANCE_POOL_REQUIRED');
  }
  if (typeof clock !== 'function' || typeof randomBytes !== 'function') {
    throw new QrIssuanceError('QR_ISSUANCE_GENERATOR_REQUIRED');
  }
  const runTransaction = transactionRunner
    || require('../../database/transaction').withTransaction;
  const Repository = repositoryType
    || require('../../repositories').QrIssuanceRepository;

  async function issue({ prefix, count, batchId = null, baseUrl } = {}) {
    const normalizedPrefix = String(prefix || '').trim().toUpperCase();
    const normalizedCount = Number(count);
    const normalizedBatchId = String(batchId || '').trim() || null;
    if (!/^[A-Z0-9]+$/.test(normalizedPrefix)) {
      throw new QrIssuanceError('QR_ISSUANCE_PREFIX_INVALID');
    }
    if (!Number.isInteger(normalizedCount) || normalizedCount <= 0) {
      throw new QrIssuanceError('QR_ISSUANCE_COUNT_INVALID');
    }

    const stagedImages = [];
    try {
      const rows = await runTransaction(pool, async (transactionContext) => {
        if (typeof beforeOperation === 'function') {
          await beforeOperation({ transactionContext });
        }
        const repository = new Repository(transactionContext);
        const lockPrefix = requireMethod(repository, 'lockPrefix');
        const findMaxSequence = requireMethod(repository, 'findMaxSequence');
        const batchExists = requireMethod(repository, 'batchExists');
        const insertIssued = requireMethod(repository, 'insertIssued');

        await lockPrefix(normalizedPrefix);
        if (normalizedBatchId && !(await batchExists(normalizedBatchId))) {
          throw new QrIssuanceError('BATCH_NOT_FOUND');
        }
        const maxSequence = await findMaxSequence(normalizedPrefix);
        if (!Number.isInteger(maxSequence) || maxSequence < 0) {
          throw new QrIssuanceError('QR_ISSUANCE_SEQUENCE_INVALID');
        }
        if (maxSequence + normalizedCount > QR_MAX_SEQUENCE) {
          throw new QrIssuanceError('QR_SEQUENCE_EXCEEDED');
        }

        const createdAt = timestamp(clock);
        const inserted = [];
        for (let offset = 1; offset <= normalizedCount; offset += 1) {
          const id = `${normalizedPrefix}${String(maxSequence + offset).padStart(
            QR_SUFFIX_WIDTH,
            '0'
          )}`;
          const token = accessToken(randomBytes);
          let imageUrl = '';
          let image = null;
          try {
            image = await renderImage({
              baseUrl,
              qrId: id,
              accessToken: token
            });
          } catch (_error) {
            // Preserve legacy behavior: rendering failure leaves no image URL.
          }
          if (image) {
            stagedImages.push(stageImage(imagePath(id, env), image));
            imageUrl = `/api/qr/image/${token}`;
          }
          const row = await insertIssued({
            id,
            batch_id: normalizedBatchId,
            qr_image_url_snapshot: imageUrl,
            access_token: token,
            created_at: createdAt
          });
          if (!row) throw new QrIssuanceError('QR_ISSUANCE_INSERT_FAILED');
          inserted.push(row);
        }
        return inserted;
      }, { isolationLevel: 'read committed' });

      stagedImages.forEach((artifact) => artifact.commit());
      const records = rows.map(presentIssuedQr);
      return Object.freeze({
        data: Object.freeze({
          count: records.length,
          ids: Object.freeze(records.map((item) => item.id)),
          records: Object.freeze(records)
        })
      });
    } catch (error) {
      stagedImages.reverse().forEach((artifact) => artifact.rollback());
      throw error;
    }
  }

  return Object.freeze({ issue });
}

module.exports = {
  QR_MAX_SEQUENCE,
  QrIssuanceError,
  createQrIssuanceService,
  presentIssuedQr
};
