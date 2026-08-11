'use strict';

const crypto = require('node:crypto');
const { CO_CREATION_COMMENT_LIMIT } = require('./publicQrReadAdapter');

const BUSINESS_ERROR_CODES = new Set([
  'ACCOUNT_CONTEXT_REQUIRED',
  'COMMENT_NOT_FOUND',
  'CO_CREATION_CLOSED',
  'CO_CREATION_COMMENT_EXISTS',
  'CO_CREATION_COMMENT_LIMIT_REACHED',
  'CONTENT_PRIVACY_REJECTED',
  'FORBIDDEN',
  'QR_ALREADY_ACTIVATED',
  'QR_NOT_ISSUED',
  'QR_NOT_FOUND'
]);

class QrLifecycleWriteError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'QrLifecycleWriteError';
    this.code = code;
  }
}

function requireMethod(target, method) {
  if (!target || typeof target[method] !== 'function') {
    throw new QrLifecycleWriteError(
      'QR_LIFECYCLE_WRITE_DEPENDENCY_REQUIRED',
      'A required QR lifecycle write dependency is unavailable.'
    );
  }
  return target[method].bind(target);
}

function normalizedText(value) {
  return String(value || '').trim();
}

function operationTimestamp(clock) {
  const candidate = clock();
  const value = candidate instanceof Date ? candidate : new Date(candidate);
  if (Number.isNaN(value.getTime())) {
    throw new QrLifecycleWriteError('QR_LIFECYCLE_WRITE_CLOCK_INVALID');
  }
  return value.toISOString();
}

function operationUuid(randomUUID) {
  const value = normalizedText(randomUUID());
  if (!value) throw new QrLifecycleWriteError('QR_LIFECYCLE_WRITE_UUID_INVALID');
  return value;
}

function normalizedPayload(payload = {}) {
  const accountId = normalizedText(payload.account_id || payload.accountId);
  if (!accountId) throw new QrLifecycleWriteError('ACCOUNT_CONTEXT_REQUIRED');
  return {
    accountId,
    content: String(payload.content || ''),
    imageUrl: String(payload.image_url || payload.imageUrl || ''),
    imageObjectKey: normalizedText(payload.image_object_key || payload.imageObjectKey) || null,
    phone: normalizedText(payload.phone),
    showBrandDisclosure: payload.show_brand_disclosure === true
      || payload.showBrandDisclosure === true
  };
}

class QrLifecycleWriteTransaction {
  constructor({
    qrRepository,
    batchRepository,
    recordRepository,
    coCreationRepository,
    identityRepository,
    outboxRepository,
    clock = () => new Date(),
    randomUUID = crypto.randomUUID
  } = {}) {
    this.findQrByKeyForUpdate = requireMethod(qrRepository, 'findByKeyForUpdate');
    this.updateQrLifecycle = requireMethod(qrRepository, 'updateLifecycle');
    this.findBatchById = requireMethod(batchRepository, 'findById');
    this.findRecordForUpdate = requireMethod(recordRepository, 'findByQrIdForUpdate');
    this.insertRecord = requireMethod(recordRepository, 'insert');
    this.sealRecord = requireMethod(recordRepository, 'seal');
    this.findCoCreationForUpdate = requireMethod(coCreationRepository, 'findByQrIdForUpdate');
    this.listEffectiveComments = requireMethod(coCreationRepository, 'listEffectiveComments');
    this.nextCommentSourcePosition = requireMethod(
      coCreationRepository,
      'nextCommentSourcePosition'
    );
    this.findCommentForUpdate = requireMethod(
      coCreationRepository,
      'findEffectiveCommentByPublicIdForUpdate'
    );
    this.insertCoCreation = requireMethod(coCreationRepository, 'insert');
    this.insertComment = requireMethod(coCreationRepository, 'insertComment');
    this.deleteComment = requireMethod(coCreationRepository, 'deleteEffectiveComment');
    this.finalizeCoCreation = requireMethod(coCreationRepository, 'finalize');
    this.hasCrossAccountPhoneReference = requireMethod(
      identityRepository,
      'hasCrossAccountPhoneReference'
    );
    this.insertOutboxJob = requireMethod(outboxRepository, 'insertPending');
    if (typeof clock !== 'function' || typeof randomUUID !== 'function') {
      throw new QrLifecycleWriteError('QR_LIFECYCLE_WRITE_GENERATOR_REQUIRED');
    }
    this.clock = clock;
    this.randomUUID = randomUUID;
  }

  async activateByKey({ key, payload } = {}) {
    const input = normalizedPayload(payload);
    const qr = await this.#requireUnactivatedQr(key);
    await this.#assertContentPrivacy(input.accountId, input.content);
    const timestamp = operationTimestamp(this.clock);
    const disclosure = await this.#disclosureSnapshot(qr, input.showBrandDisclosure);
    await this.#requireNoLifecycleRows(qr.id);
    const record = await this.insertRecord({
      qr_id: qr.id,
      account_id: input.accountId,
      content: input.content,
      image_url_snapshot: input.imageUrl,
      image_object_key: input.imageObjectKey,
      image_sha256: null,
      phone_snapshot: input.phone,
      sealed_at: timestamp,
      show_brand_disclosure: input.showBrandDisclosure,
      brand_disclosure_text_snapshot: disclosure,
      created_at: timestamp,
      updated_at: timestamp
    });
    const updatedQr = await this.updateQrLifecycle({
      qr_id: qr.id,
      expected_status: 'unactivated',
      next_status: 'activated',
      updated_at: timestamp
    });
    if (!record || !updatedQr) throw new QrLifecycleWriteError('QR_LIFECYCLE_WRITE_CONFLICT');
    await this.#enqueueRecordProof(qr.id, timestamp);
    return Object.freeze({ qr: updatedQr, record, co_creation: null });
  }

  async startCoCreationByKey({ key, payload } = {}) {
    const input = normalizedPayload(payload);
    const qr = await this.#requireUnactivatedQr(key);
    await this.#assertContentPrivacy(input.accountId, input.content);
    const timestamp = operationTimestamp(this.clock);
    const disclosure = await this.#disclosureSnapshot(qr, input.showBrandDisclosure);
    await this.#requireNoLifecycleRows(qr.id);
    const record = await this.insertRecord({
      qr_id: qr.id,
      account_id: input.accountId,
      content: input.content,
      image_url_snapshot: input.imageUrl,
      image_object_key: input.imageObjectKey,
      image_sha256: null,
      phone_snapshot: input.phone,
      sealed_at: null,
      show_brand_disclosure: input.showBrandDisclosure,
      brand_disclosure_text_snapshot: disclosure,
      created_at: timestamp,
      updated_at: timestamp
    });
    const coCreation = await this.insertCoCreation({
      id: operationUuid(this.randomUUID),
      qr_id: qr.id,
      owner_account_id: input.accountId,
      owner_phone_snapshot: input.phone,
      status: 'active',
      started_at: timestamp,
      finalized_at: null,
      created_at: timestamp,
      updated_at: timestamp
    });
    const updatedQr = await this.updateQrLifecycle({
      qr_id: qr.id,
      expected_status: 'unactivated',
      next_status: 'co_creating',
      updated_at: timestamp
    });
    if (!record || !coCreation || !updatedQr) {
      throw new QrLifecycleWriteError('QR_LIFECYCLE_WRITE_CONFLICT');
    }
    return Object.freeze({ qr: updatedQr, record, co_creation: coCreation });
  }

  async addCommentByKey({ key, payload } = {}) {
    const accountId = normalizedText(payload && (payload.account_id || payload.accountId));
    if (!accountId) throw new QrLifecycleWriteError('ACCOUNT_CONTEXT_REQUIRED');
    const { qr, coCreation } = await this.#requireOpenCoCreation(key);
    const comments = await this.listEffectiveComments(coCreation.id);
    if (comments.some((comment) => String(comment.account_id) === accountId)) {
      throw new QrLifecycleWriteError('CO_CREATION_COMMENT_EXISTS');
    }
    if (comments.length >= CO_CREATION_COMMENT_LIMIT) {
      throw new QrLifecycleWriteError('CO_CREATION_COMMENT_LIMIT_REACHED');
    }
    await this.#assertContentPrivacy(accountId, normalizedText(payload.content));
    const timestamp = operationTimestamp(this.clock);
    const comment = await this.insertComment({
      id: operationUuid(this.randomUUID),
      co_creation_id: coCreation.id,
      account_id: accountId,
      legacy_comment_id: null,
      source_position: await this.nextCommentSourcePosition(coCreation.id),
      legacy_duplicate: false,
      phone_snapshot: normalizedText(payload.phone),
      author_name: normalizedText(payload.authorName || payload.author_name),
      content: normalizedText(payload.content),
      status: 'kept',
      created_at: timestamp,
      deleted_at: null
    });
    if (!comment) throw new QrLifecycleWriteError('QR_LIFECYCLE_WRITE_CONFLICT');
    return Object.freeze({ qr, co_creation: coCreation, comment });
  }

  async deleteCommentByKey({ key, commentId, accountId, account_id: legacyAccountId } = {}) {
    const normalizedAccountId = normalizedText(accountId || legacyAccountId);
    if (!normalizedAccountId) throw new QrLifecycleWriteError('ACCOUNT_CONTEXT_REQUIRED');
    const { qr, coCreation } = await this.#requireCoCreationForOwner(key, normalizedAccountId, {
      closedCode: 'FORBIDDEN'
    });
    const comment = await this.findCommentForUpdate(coCreation.id, normalizedText(commentId));
    if (!comment) throw new QrLifecycleWriteError('COMMENT_NOT_FOUND');
    const deleted = await this.deleteComment({
      id: comment.id,
      deleted_at: operationTimestamp(this.clock)
    });
    if (!deleted) throw new QrLifecycleWriteError('COMMENT_NOT_FOUND');
    return Object.freeze({ qr, co_creation: coCreation, comment: deleted });
  }

  async finalizeByKey({ key, accountId, account_id: legacyAccountId } = {}) {
    const normalizedAccountId = normalizedText(accountId || legacyAccountId);
    if (!normalizedAccountId) throw new QrLifecycleWriteError('ACCOUNT_CONTEXT_REQUIRED');
    const { qr, coCreation } = await this.#requireCoCreationForOwner(key, normalizedAccountId, {
      closedCode: 'CO_CREATION_CLOSED'
    });
    const record = await this.findRecordForUpdate(qr.id);
    if (!record || record.sealed_at) {
      throw new QrLifecycleWriteError('QR_LIFECYCLE_WRITE_INVARIANT');
    }
    const timestamp = operationTimestamp(this.clock);
    const sealedRecord = await this.sealRecord({
      qr_id: qr.id,
      sealed_at: timestamp,
      updated_at: timestamp
    });
    const finalized = await this.finalizeCoCreation({
      id: coCreation.id,
      finalized_at: timestamp,
      updated_at: timestamp
    });
    const updatedQr = await this.updateQrLifecycle({
      qr_id: qr.id,
      expected_status: 'co_creating',
      next_status: 'activated',
      updated_at: timestamp
    });
    if (!sealedRecord || !finalized || !updatedQr) {
      throw new QrLifecycleWriteError('QR_LIFECYCLE_WRITE_CONFLICT');
    }
    await this.#enqueueRecordProof(qr.id, timestamp);
    return Object.freeze({ qr: updatedQr, record: sealedRecord, co_creation: finalized });
  }

  async #enqueueRecordProof(qrId, timestamp) {
    const job = await this.insertOutboxJob({
      id: operationUuid(this.randomUUID),
      job_type: 'record_proof_prepare_submit',
      aggregate_type: 'record',
      aggregate_id: qrId,
      idempotency_key: `record-proof:${qrId}`,
      payload: { record_qr_id: qrId },
      available_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp
    });
    if (!job) throw new QrLifecycleWriteError('QR_LIFECYCLE_WRITE_CONFLICT');
  }

  async #assertContentPrivacy(accountId, content) {
    const hasReference = await this.hasCrossAccountPhoneReference({
      accountId,
      content
    });
    if (hasReference) {
      throw new QrLifecycleWriteError('CONTENT_PRIVACY_REJECTED');
    }
  }

  async #requireUnactivatedQr(key) {
    const qr = await this.findQrByKeyForUpdate(normalizedText(key));
    if (!qr) throw new QrLifecycleWriteError('QR_NOT_FOUND');
    if (qr.lifecycle_status !== 'unactivated') {
      throw new QrLifecycleWriteError('QR_ALREADY_ACTIVATED');
    }
    if (qr.issue_status !== 'issued') {
      throw new QrLifecycleWriteError('QR_NOT_ISSUED');
    }
    return qr;
  }

  async #requireNoLifecycleRows(qrId) {
    const [record, coCreation] = await Promise.all([
      this.findRecordForUpdate(qrId),
      this.findCoCreationForUpdate(qrId)
    ]);
    if (record || coCreation) throw new QrLifecycleWriteError('QR_LIFECYCLE_WRITE_INVARIANT');
  }

  async #requireOpenCoCreation(key) {
    const qr = await this.findQrByKeyForUpdate(normalizedText(key));
    if (!qr) throw new QrLifecycleWriteError('QR_NOT_FOUND');
    if (qr.lifecycle_status !== 'co_creating') {
      throw new QrLifecycleWriteError('CO_CREATION_CLOSED');
    }
    const coCreation = await this.findCoCreationForUpdate(qr.id);
    if (!coCreation || coCreation.status !== 'active') {
      throw new QrLifecycleWriteError('CO_CREATION_CLOSED');
    }
    return { qr, coCreation };
  }

  async #requireCoCreationForOwner(key, accountId, { closedCode }) {
    const qr = await this.findQrByKeyForUpdate(normalizedText(key));
    if (!qr) throw new QrLifecycleWriteError('QR_NOT_FOUND');
    if (qr.lifecycle_status !== 'co_creating') {
      throw new QrLifecycleWriteError(closedCode);
    }
    const coCreation = await this.findCoCreationForUpdate(qr.id);
    if (!coCreation || coCreation.status !== 'active') {
      throw new QrLifecycleWriteError(closedCode);
    }
    if (String(coCreation.owner_account_id) !== accountId) {
      throw new QrLifecycleWriteError('FORBIDDEN');
    }
    return { qr, coCreation };
  }

  async #disclosureSnapshot(qr, enabled) {
    if (!enabled || !qr.batch_id) return '';
    const batch = await this.findBatchById(qr.batch_id);
    return batch ? String(batch.disclosure_text || '') : '';
  }
}

function createQrLifecycleWriteService({
  pool,
  transactionRunner,
  repositoryTypes,
  clock,
  randomUUID
} = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new QrLifecycleWriteError('QR_LIFECYCLE_WRITE_POOL_REQUIRED');
  }
  const runTransaction = transactionRunner
    || require('../../database/transaction').withTransaction;
  const repositories = repositoryTypes || require('../../repositories');

  async function execute(operation, input) {
    try {
      const data = await runTransaction(pool, async (transactionContext) => {
        const transaction = new QrLifecycleWriteTransaction({
          qrRepository: new repositories.QrRepository(transactionContext),
          batchRepository: new repositories.QrBatchRepository(transactionContext),
          recordRepository: new repositories.RecordRepository(transactionContext),
          coCreationRepository: new repositories.CoCreationRepository(transactionContext),
          identityRepository: new repositories.IdentityRepository(transactionContext),
          outboxRepository: new repositories.OutboxRepository(transactionContext),
          clock,
          randomUUID
        });
        return transaction[operation](input);
      }, { isolationLevel: 'read committed' });
      return { data };
    } catch (error) {
      if (error instanceof QrLifecycleWriteError && BUSINESS_ERROR_CODES.has(error.code)) {
        return { error: error.code };
      }
      if (operation === 'addCommentByKey'
          && error && error.code === 'REPOSITORY_UNIQUE_CONFLICT') {
        return { error: 'CO_CREATION_COMMENT_EXISTS' };
      }
      throw error;
    }
  }

  return Object.freeze({
    activateQRByKey: (key, payload) => execute('activateByKey', { key, payload }),
    startCoCreationByKey: (key, payload) => execute('startCoCreationByKey', { key, payload }),
    addCoCreationCommentByKey: (key, payload) => execute('addCommentByKey', { key, payload }),
    deleteCoCreationCommentByKey: (key, payload = {}) => execute('deleteCommentByKey', {
      key,
      commentId: payload.commentId,
      account_id: payload.account_id
    }),
    finalizeCoCreationByKey: (key, payload = {}) => execute('finalizeByKey', {
      key,
      account_id: payload.account_id
    })
  });
}

module.exports = {
  QrLifecycleWriteError,
  QrLifecycleWriteTransaction,
  createQrLifecycleWriteService,
  normalizedPayload
};
