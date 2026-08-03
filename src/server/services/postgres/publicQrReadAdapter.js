'use strict';

const { chainStatusForCustomer } = require('../chainViewService');

const CHANNELS = new Set(['h5', 'miniapp']);
const CO_CREATION_COMMENT_LIMIT = 12;

class PublicQrReadError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'PublicQrReadError';
    this.code = code;
  }
}

function requireMethod(target, method, code = 'PUBLIC_QR_READ_DEPENDENCY_REQUIRED') {
  if (!target || typeof target[method] !== 'function') {
    throw new PublicQrReadError(code, 'A required public QR read dependency is unavailable.');
  }
  return target[method].bind(target);
}

function normalizeViewer(viewer) {
  if (!viewer || typeof viewer !== 'object') {
    return { accountId: '', phoneBound: false };
  }
  const accountId = viewer.accountId || viewer.account_id;
  return {
    accountId: accountId ? String(accountId) : '',
    phoneBound: viewer.phoneBound === true || viewer.phone_bound === true
  };
}

function timestampValue(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function publicTimestamp(value, fallback = null) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : fallback;
  }
  if (typeof value === 'string') return value;
  return value === null || value === undefined ? fallback : String(value);
}

function publicComments(comments) {
  return (Array.isArray(comments) ? comments : [])
    .filter((comment) => comment && comment.status !== 'deleted')
    .map((comment) => {
      if (!Number.isSafeInteger(comment.source_position) || comment.source_position < 0) {
        throw new PublicQrReadError(
          'PUBLIC_QR_COMMENT_POSITION_INVALID',
          'A public co-creation comment has no stable source position.'
        );
      }
      return comment;
    })
    .sort((left, right) => {
      const timestampDifference = timestampValue(right.created_at)
        - timestampValue(left.created_at);
      return timestampDifference || left.source_position - right.source_position;
    })
    .map((comment) => ({
      id: comment.legacy_comment_id || comment.id,
      author_name: comment.author_name || '',
      content: comment.content || '',
      created_at: publicTimestamp(comment.created_at, '')
    }));
}

class PublicQrReadAdapter {
  constructor({
    qrRepository,
    recordRepository,
    coCreationRepository,
    proofRepository,
    batchReader = null,
    assetResolver = null,
    publicRuntimeMetadata
  } = {}) {
    this.findQrByKey = requireMethod(qrRepository, 'findByKey');
    this.findRecordByQrId = requireMethod(recordRepository, 'findByQrId');
    this.findCoCreationByQrId = requireMethod(coCreationRepository, 'findByQrId');
    this.listPublicCommentsCandidate = requireMethod(
      coCreationRepository,
      'listPublicCommentsCandidate'
    );
    this.findProofByRecordId = requireMethod(proofRepository, 'findByRecordId');
    this.batchReader = batchReader;
    this.assetResolver = assetResolver;

    const storageMode = publicRuntimeMetadata
      && String(publicRuntimeMetadata.storage_mode || '').trim();
    if (!storageMode) {
      throw new PublicQrReadError(
        'PUBLIC_QR_RUNTIME_METADATA_REQUIRED',
        'Public storage metadata must be injected.'
      );
    }
    this.storageMode = storageMode;
  }

  async read({ key, channel, viewer = null } = {}) {
    const snapshot = await this.loadSnapshot({ key, channel, viewer });
    return this.present(snapshot);
  }

  async loadSnapshot({ key, channel, viewer = null } = {}) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) {
      throw new PublicQrReadError('PUBLIC_QR_KEY_REQUIRED', 'A normalized QR key is required.');
    }
    if (!CHANNELS.has(channel)) {
      throw new PublicQrReadError('PUBLIC_QR_CHANNEL_INVALID', 'The public QR channel is invalid.');
    }

    const qr = await this.findQrByKey(normalizedKey);
    if (!qr) throw new PublicQrReadError('QR_NOT_FOUND', 'The QR code was not found.');
    if (qr.hidden === true) throw new PublicQrReadError('QR_HIDDEN', 'The QR code is hidden.');

    const normalizedViewer = normalizeViewer(viewer);
    const batch = await this.#readBatch(qr.batch_id);
    const baseSnapshot = { qr, batch, channel, normalizedViewer };
    if (qr.lifecycle_status === 'unactivated') return baseSnapshot;
    if (qr.lifecycle_status === 'co_creating' && !normalizedViewer.phoneBound) return baseSnapshot;

    const record = await this.findRecordByQrId(qr.id);
    if (!record) {
      throw new PublicQrReadError(
        'PUBLIC_QR_RECORD_MISSING',
        'The QR lifecycle requires a record row.'
      );
    }
    const coCreation = await this.findCoCreationByQrId(qr.id);
    const effectiveComments = coCreation
      ? await this.listPublicCommentsCandidate(coCreation.id, { limit: 13 })
      : [];
    if (effectiveComments.length > CO_CREATION_COMMENT_LIMIT) {
      throw new PublicQrReadError(
        'CANDIDATE_COMMENT_OVERFLOW',
        'The candidate exceeds the public comment contract.'
      );
    }
    if (qr.lifecycle_status !== 'co_creating' && qr.lifecycle_status !== 'activated') {
      throw new PublicQrReadError(
        'PUBLIC_QR_LIFECYCLE_INVALID',
        'The QR lifecycle is unsupported.'
      );
    }
    const proof = qr.lifecycle_status === 'activated'
      ? await this.findProofByRecordId(qr.id)
      : null;
    return { ...baseSnapshot, record, coCreation, effectiveComments, proof };
  }

  async present(snapshot, { assetResolver = this.assetResolver } = {}) {
    if (!snapshot || !snapshot.qr || !CHANNELS.has(snapshot.channel)) {
      throw new PublicQrReadError('PUBLIC_QR_SNAPSHOT_INVALID', 'The public QR snapshot is invalid.');
    }
    const {
      qr,
      batch,
      channel,
      normalizedViewer,
      record = null,
      coCreation = null,
      effectiveComments = [],
      proof = null
    } = snapshot;
    const base = this.#basePayload({ qr, batch, channel, normalizedViewer });

    if (qr.lifecycle_status === 'unactivated') {
      return channel === 'h5'
        ? { ...base, show_brand_disclosure: false }
        : base;
    }
    if (qr.lifecycle_status === 'co_creating' && !normalizedViewer.phoneBound) return base;
    if (!record) {
      throw new PublicQrReadError('PUBLIC_QR_RECORD_MISSING', 'The QR lifecycle requires a record row.');
    }

    const comments = publicComments(effectiveComments);
    const coCreationFields = this.#coCreationFields({
      coCreation,
      comments,
      effectiveComments,
      normalizedViewer
    });
    if (qr.lifecycle_status === 'co_creating') {
      const imageUrl = await this.#resolveRecordImage({ record, channel, assetResolver });
      const payload = {
        ...base,
        content: record.content || '',
        image_url: imageUrl,
        image_object_key: record.image_object_key || null,
        co_creation_enabled: true,
        ...coCreationFields,
        show_brand_disclosure: record.show_brand_disclosure === true,
        brand_disclosure_text_snapshot: record.brand_disclosure_text_snapshot || ''
      };
      if (channel === 'miniapp') payload.brand_name = batch ? batch.brand_name || '' : '';
      return payload;
    }

    if (qr.lifecycle_status !== 'activated') {
      throw new PublicQrReadError('PUBLIC_QR_LIFECYCLE_INVALID', 'The QR lifecycle is unsupported.');
    }
    const imageUrl = await this.#resolveRecordImage({ record, channel, assetResolver });
    const payload = {
      ...base,
      content: record.content || '',
      image_url: imageUrl,
      image_object_key: record.image_object_key || null,
      blockchain_hash: proof
        ? (proof.manifest_hash || proof.legacy_hash_snapshot || null)
        : null,
      ...await this.#chainPayload({ proof, channel, assetResolver }),
      activated_at: publicTimestamp(record.sealed_at),
      co_creation_enabled: Boolean(coCreation),
      ...coCreationFields,
      show_brand_disclosure: record.show_brand_disclosure === true,
      brand_disclosure_text_snapshot: record.brand_disclosure_text_snapshot || ''
    };
    if (channel === 'miniapp') payload.brand_name = batch ? batch.brand_name || '' : '';
    return payload;
  }

  #basePayload({ qr, batch, channel, normalizedViewer }) {
    const payload = {
      id: qr.id,
      qr_id: qr.id,
      activation_status: qr.lifecycle_status,
      issue_status: qr.issue_status,
      active_storage_mode: this.storageMode,
      batch_id: qr.batch_id || null
    };
    if (channel === 'miniapp') payload.phone_bound = normalizedViewer.phoneBound;
    if (batch) {
      payload.batch_brand_name = batch.brand_name || '';
      payload.batch_brand_disclosure_text = batch.disclosure_text || '';
      payload.batch_brand_disclosure_default = batch.show_brand_disclosure_default === true;
    }
    return payload;
  }

  #coCreationFields({ coCreation, comments, effectiveComments, normalizedViewer }) {
    const ownerAccountId = coCreation && coCreation.owner_account_id
      ? String(coCreation.owner_account_id)
      : '';
    const accountId = normalizedViewer.accountId;
    return {
      is_co_creation_owner: Boolean(accountId && ownerAccountId && accountId === ownerAccountId),
      co_creation_comments: comments,
      has_my_co_creation_comment: Boolean(accountId && effectiveComments.some((comment) => (
        comment && comment.status !== 'deleted' && String(comment.account_id || '') === accountId
      ))),
      co_creation_comment_count: comments.length,
      co_creation_comment_limit: CO_CREATION_COMMENT_LIMIT
    };
  }

  async #readBatch(batchId) {
    if (!batchId) return null;
    const findBatchById = requireMethod(
      this.batchReader,
      'findById',
      'PUBLIC_QR_BATCH_REPOSITORY_GAP'
    );
    return findBatchById(batchId);
  }

  async #resolveRecordImage({ record, channel, assetResolver }) {
    if (assetResolver && typeof assetResolver.resolveRecordImage === 'function') {
      return assetResolver.resolveRecordImage({ record, channel });
    }
    if (record.image_object_key) {
      throw new PublicQrReadError(
        'PUBLIC_QR_IMAGE_RESOLVER_REQUIRED',
        'An image resolver is required for object-key records.'
      );
    }
    return record.image_url_snapshot || '';
  }

  async #chainPayload({ proof, channel, assetResolver }) {
    const status = proof && proof.status ? proof.status : 'not_started';
    let resolvedCertificateUrl = proof && proof.provider_certificate_url
      ? proof.provider_certificate_url
      : null;
    if (proof && proof.certificate_object_key) {
      if (!assetResolver || typeof assetResolver.resolveCertificate !== 'function') {
        throw new PublicQrReadError(
          'PUBLIC_QR_CERTIFICATE_RESOLVER_REQUIRED',
          'A certificate resolver is required for object-key proofs.'
        );
      }
      resolvedCertificateUrl = await assetResolver.resolveCertificate({ proof, channel });
    }
    return {
      chain_provider: proof && proof.provider ? proof.provider : 'avata_wenchang',
      chain_status: status,
      chain_status_text: chainStatusForCustomer(status),
      manifest_hash: proof
        ? (proof.manifest_hash || proof.legacy_hash_snapshot || null)
        : null,
      chain_tx_hash: status === 'confirmed' && proof ? proof.transaction_hash || null : null,
      chain_certificate_url: status === 'confirmed' ? resolvedCertificateUrl : null,
      chain_confirmed_at: status === 'confirmed' && proof
        ? publicTimestamp(proof.confirmed_at)
        : null
    };
  }
}

module.exports = {
  CO_CREATION_COMMENT_LIMIT,
  PublicQrReadAdapter,
  PublicQrReadError,
  normalizeViewer,
  publicComments,
  publicTimestamp
};
