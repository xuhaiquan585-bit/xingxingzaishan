'use strict';

const {
  CO_CREATION_COMMENT_LIMIT,
  PublicQrReadAdapter,
  PublicQrReadError,
  publicTimestamp
} = require('./publicQrReadAdapter');

const CHANNELS = new Set(['h5', 'miniapp']);
const READ_KINDS = new Set(['list', 'detail']);
const PERSONAL_RECORD_LIMIT = 1000;

function requireMethod(target, method) {
  if (!target || typeof target[method] !== 'function') {
    throw new PublicQrReadError(
      'PERSONAL_RECORD_READ_DEPENDENCY_REQUIRED',
      'A required personal record read dependency is unavailable.'
    );
  }
  return target[method].bind(target);
}

class PersonalRecordReadAdapter {
  constructor({
    qrRepository,
    recordRepository,
    coCreationRepository,
    proofRepository,
    batchReader,
    publicRuntimeMetadata
  } = {}) {
    this.findQrById = requireMethod(qrRepository, 'findById');
    this.findOwnedRecord = requireMethod(recordRepository, 'findOwnedByAccountId');
    this.listPersonalRecords = requireMethod(recordRepository, 'listPersonalByAccountId');
    this.findCoCreationByQrId = requireMethod(coCreationRepository, 'findByQrId');
    this.listPublicCommentsCandidate = requireMethod(
      coCreationRepository,
      'listPublicCommentsCandidate'
    );
    this.findProofByRecordId = requireMethod(proofRepository, 'findByRecordId');
    this.findBatchById = requireMethod(batchReader, 'findById');
    this.publicAdapter = new PublicQrReadAdapter({
      qrRepository,
      recordRepository,
      coCreationRepository,
      proofRepository,
      batchReader,
      assetResolver: null,
      publicRuntimeMetadata
    });
  }

  async loadSnapshot({ readKind, accountId, recordId = null, channel } = {}) {
    const normalizedAccountId = String(accountId || '').trim();
    if (!normalizedAccountId) {
      throw new PublicQrReadError('PERSONAL_RECORD_ACCOUNT_REQUIRED');
    }
    if (!READ_KINDS.has(readKind)) {
      throw new PublicQrReadError('PERSONAL_RECORD_READ_KIND_INVALID');
    }
    if (!CHANNELS.has(channel)) {
      throw new PublicQrReadError('PERSONAL_RECORD_CHANNEL_INVALID');
    }

    if (readKind === 'list') {
      const records = await this.listPersonalRecords(normalizedAccountId, {
        limit: PERSONAL_RECORD_LIMIT + 1
      });
      if (records.length > PERSONAL_RECORD_LIMIT) {
        throw new PublicQrReadError('PERSONAL_RECORD_LIST_OVERFLOW');
      }
      return { readKind, channel, records };
    }

    const normalizedRecordId = String(recordId || '').trim();
    if (!normalizedRecordId) {
      throw new PublicQrReadError('PERSONAL_RECORD_ID_REQUIRED');
    }
    const qr = await this.findQrById(normalizedRecordId);
    if (!qr || qr.lifecycle_status !== 'activated') {
      throw new PublicQrReadError('PERSONAL_RECORD_NOT_FOUND');
    }
    const record = await this.findOwnedRecord(normalizedAccountId, normalizedRecordId);
    if (!record) throw new PublicQrReadError('PERSONAL_RECORD_NOT_FOUND');

    const batch = qr.batch_id ? await this.findBatchById(qr.batch_id) : null;
    const coCreation = await this.findCoCreationByQrId(qr.id);
    const effectiveComments = coCreation
      ? await this.listPublicCommentsCandidate(coCreation.id, {
        limit: CO_CREATION_COMMENT_LIMIT + 1
      })
      : [];
    if (effectiveComments.length > CO_CREATION_COMMENT_LIMIT) {
      throw new PublicQrReadError('CANDIDATE_COMMENT_OVERFLOW');
    }
    const proof = await this.findProofByRecordId(qr.id);
    return {
      readKind,
      channel,
      publicSnapshot: {
        qr,
        batch,
        channel,
        normalizedViewer: { accountId: normalizedAccountId, phoneBound: true },
        record,
        coCreation,
        effectiveComments,
        proof
      }
    };
  }

  async present(snapshot, { assetResolver } = {}) {
    if (!snapshot || !READ_KINDS.has(snapshot.readKind) || !CHANNELS.has(snapshot.channel)) {
      throw new PublicQrReadError('PERSONAL_RECORD_SNAPSHOT_INVALID');
    }
    if (snapshot.readKind === 'list') {
      const records = await Promise.all(snapshot.records.map(async (record) => ({
        id: record.qr_id,
        content: record.content || '',
        activated_at: publicTimestamp(record.sealed_at),
        display_at: publicTimestamp(
          record.sealed_at || record.co_creation_started_at || record.created_at
        ),
        activation_status: record.lifecycle_status,
        image_url: await this.#resolveImage(record, snapshot.channel, assetResolver)
      })));
      return { total: records.length, records };
    }

    const publicDto = await this.publicAdapter.present(snapshot.publicSnapshot, { assetResolver });
    const chainFields = {
      chain_provider: publicDto.chain_provider,
      chain_status: publicDto.chain_status,
      chain_status_text: publicDto.chain_status_text,
      manifest_hash: publicDto.manifest_hash,
      chain_tx_hash: publicDto.chain_tx_hash,
      chain_certificate_url: publicDto.chain_certificate_url,
      chain_confirmed_at: publicDto.chain_confirmed_at
    };
    if (snapshot.channel === 'miniapp') {
      return {
        id: publicDto.id,
        content: publicDto.content || '',
        activated_at: publicDto.activated_at,
        blockchain_hash: publicDto.blockchain_hash || null,
        image_url: publicDto.image_url,
        co_creation_comments: publicDto.co_creation_comments,
        show_brand_disclosure: publicDto.show_brand_disclosure === true,
        brand_disclosure_text_snapshot: publicDto.brand_disclosure_text_snapshot || '',
        brand_name: publicDto.brand_name || '',
        ...chainFields
      };
    }
    return {
      id: publicDto.id,
      content: publicDto.content,
      activated_at: publicDto.activated_at,
      blockchain_hash: publicDto.blockchain_hash,
      ...chainFields,
      co_creation_enabled: publicDto.co_creation_enabled === true,
      co_creation_comments: publicDto.co_creation_comments,
      image_url: publicDto.image_url,
      show_brand_disclosure: publicDto.show_brand_disclosure,
      brand_disclosure_text_snapshot: publicDto.brand_disclosure_text_snapshot,
      brand_name: publicDto.batch_brand_name || ''
    };
  }

  async #resolveImage(record, channel, assetResolver) {
    if (assetResolver && typeof assetResolver.resolveRecordImage === 'function') {
      return assetResolver.resolveRecordImage({ record, channel });
    }
    if (record.image_object_key) {
      throw new PublicQrReadError('PUBLIC_QR_IMAGE_RESOLVER_REQUIRED');
    }
    return record.image_url_snapshot || '';
  }
}

module.exports = {
  PERSONAL_RECORD_LIMIT,
  PersonalRecordReadAdapter
};
