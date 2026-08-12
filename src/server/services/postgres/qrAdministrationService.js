'use strict';

const MAX_PAGE_SIZE = 100_000;
const MAX_MUTATION_IDS = 1_000;

class QrAdministrationError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'QrAdministrationError';
    this.code = code;
  }
}

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function timestamp(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new QrAdministrationError('QR_ADMINISTRATION_CLOCK_INVALID');
  }
  return date;
}

function localDayKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function positiveInteger(value, fallback, maximum = MAX_PAGE_SIZE) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new QrAdministrationError('QR_ADMINISTRATION_PAGINATION_INVALID');
  }
  return Math.min(parsed, maximum);
}

function normalizeIds(values) {
  if (!Array.isArray(values)) {
    throw new QrAdministrationError('QR_ADMINISTRATION_IDS_INVALID');
  }
  const ids = [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
  if (ids.length === 0 || ids.length > MAX_MUTATION_IDS
    || ids.some((id) => id.length > 160 || /[\r\n\0]/u.test(id))) {
    throw new QrAdministrationError('QR_ADMINISTRATION_IDS_INVALID');
  }
  return ids;
}

function activationRate(total, activated) {
  return total > 0 ? Number(((activated / total) * 100).toFixed(2)) : 0;
}

function presentBatch(row) {
  const total = Number(row.total_codes || 0);
  const activated = Number(row.activated_codes || 0);
  return Object.freeze({
    id: row.id,
    name: row.name,
    brand_name: row.brand_name || '',
    note: row.note || '',
    brand_disclosure_text: row.disclosure_text || '',
    brand_disclosure_default: row.show_brand_disclosure_default === true,
    created_at: iso(row.created_at),
    created_by: row.created_by_snapshot || 'admin',
    total_codes: total,
    activated_codes: activated,
    activation_rate: activationRate(total, activated)
  });
}

function presentAdminQr(row) {
  if (!row) return null;
  const qualityChecked = Boolean(row.quality_checked_at);
  const chainStatus = row.chain_status || 'not_started';
  const comments = Array.isArray(row.co_creation_comments)
    ? row.co_creation_comments.map((comment) => Object.freeze({
      ...comment,
      created_at: iso(comment.created_at),
      deleted_at: iso(comment.deleted_at)
    }))
    : [];
  return Object.freeze({
    id: row.id,
    issue_status: row.issue_status,
    activation_status: row.lifecycle_status,
    hidden: row.hidden === true,
    batch_id: row.batch_id || null,
    print_batch_id: row.print_batch_id || null,
    quality_check: Object.freeze({
      checked: qualityChecked,
      checked_at: iso(row.quality_checked_at),
      checked_by: row.quality_checked_by || null,
      result: qualityChecked ? 'pass' : null
    }),
    content: row.content ?? null,
    image_url: row.image_url_snapshot || null,
    image_object_key: row.image_object_key || null,
    phone: row.phone_snapshot || null,
    activated_at: iso(row.sealed_at),
    blockchain_hash: row.manifest_hash || row.legacy_hash_snapshot || null,
    chain_provider: row.chain_provider || 'avata_wenchang',
    chain_status: chainStatus,
    chain_operation_id: row.chain_operation_id || null,
    manifest_object_key: row.manifest_object_key || null,
    manifest_hash: row.manifest_hash || null,
    chain_tx_hash: row.chain_tx_hash || null,
    chain_block_height: row.chain_block_height ?? null,
    chain_record_id: row.chain_record_id || null,
    chain_certificate_url: row.chain_certificate_url || null,
    chain_certificate_object_key: row.chain_certificate_object_key || null,
    chain_certificate_object_url: row.chain_certificate_object_url || null,
    chain_confirmed_at: iso(row.chain_confirmed_at),
    chain_callback_received_at: iso(row.chain_callback_received_at),
    chain_last_error: row.chain_last_error || '',
    chain_retry_count: Number(row.chain_retry_count || 0),
    image_sha256: row.image_sha256 || null,
    legacy_manifest_object_key: row.legacy_manifest_object_key || null,
    archive_index_object_key: row.archive_index_object_key || null,
    archive_status: row.archive_status || 'not_started',
    archive_last_error: row.archive_last_error || '',
    archive_updated_at: iso(row.archive_updated_at),
    co_creation_enabled: Boolean(row.co_creation_id),
    co_creation_owner_account_id: row.co_creation_owner_account_id || null,
    co_creation_owner_phone: row.co_creation_owner_phone || null,
    co_creation_comments: Object.freeze(comments),
    co_creation_started_at: iso(row.co_creation_started_at),
    show_brand_disclosure: row.show_brand_disclosure === true,
    brand_disclosure_text_snapshot: row.brand_disclosure_text_snapshot || '',
    qr_image_url: row.qr_image_url_snapshot || null,
    qr_access_token: row.access_token || null,
    created_at: iso(row.created_at)
  });
}

function dateBoundary(value, endOfDay = false) {
  const text = String(value || '').trim();
  if (!text) return null;
  const suffix = endOfDay ? 'T23:59:59.999' : 'T00:00:00.000';
  const date = new Date(`${text}${suffix}`);
  if (Number.isNaN(date.getTime())) {
    throw new QrAdministrationError('QR_ADMINISTRATION_DATE_INVALID');
  }
  return date.toISOString();
}

function normalizeRecordFilters(input = {}) {
  const hiddenText = String(input.hidden ?? '').trim();
  return {
    issueStatus: String(input.issueStatus || '').trim() || null,
    activationStatus: String(input.activationStatus || '').trim() || null,
    hidden: hiddenText === 'true' ? true : hiddenText === 'false' ? false : null,
    idPrefix: String(input.idPrefix || '').trim().toUpperCase() || null,
    batchId: String(input.batchId || '').trim() || null,
    dateFrom: dateBoundary(input.dateFrom),
    dateTo: dateBoundary(input.dateTo, true),
    ids: input.ids ? normalizeIds(input.ids) : null
  };
}

function createQrAdministrationService({
  pool,
  transactionRunner,
  repositoryType,
  beforeOperation,
  clock = () => new Date()
} = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new QrAdministrationError('QR_ADMINISTRATION_POOL_REQUIRED');
  }
  const runTransaction = transactionRunner
    || require('../../database/transaction').withTransaction;
  const Repository = repositoryType
    || require('../../repositories').QrAdministrationRepository;

  async function run(operation, callback, { readOnly = false } = {}) {
    return runTransaction(pool, async (transactionContext) => {
      if (typeof beforeOperation === 'function') {
        await beforeOperation({ transactionContext, operation });
      }
      return callback(new Repository(transactionContext), transactionContext);
    }, {
      isolationLevel: readOnly ? 'repeatable read' : 'read committed',
      readOnly
    });
  }

  async function createBatch(input = {}) {
    const name = String(input.name || '').trim();
    if (!name) throw new QrAdministrationError('BATCH_NAME_REQUIRED');
    const now = timestamp(clock);
    const dayKey = localDayKey(now);
    const createdBy = String(input.createdBy || '').trim() || 'admin';
    return run('create_batch', async (repository) => {
      await repository.lockBatchDay(dayKey);
      const ids = await repository.listBatchIdsForDay(dayKey);
      const maxSequence = ids.reduce((maximum, id) => {
        const match = String(id).match(/_(\d{3,})$/u);
        return match ? Math.max(maximum, Number(match[1])) : maximum;
      }, 0);
      const id = `BATCH_${dayKey}_${String(maxSequence + 1).padStart(3, '0')}`;
      const row = await repository.insertBatch({
        id,
        name,
        brand_name: String(input.brandName || '').trim(),
        note: String(input.note || '').trim(),
        disclosure_text: String(input.brandDisclosureText || '').trim(),
        show_brand_disclosure_default: input.brandDisclosureDefault === true,
        created_by_snapshot: createdBy,
        created_at: now.toISOString()
      });
      if (!row) throw new QrAdministrationError('BATCH_INSERT_FAILED');
      return presentBatch({ ...row, total_codes: 0, activated_codes: 0 });
    });
  }

  async function listBatches() {
    return run(
      'list_batches',
      async (repository) => (await repository.listBatches()).map(presentBatch),
      { readOnly: true }
    );
  }

  async function getBatchDetail(input = {}) {
    const batchId = String(input.batchId || '').trim();
    return run('get_batch_detail', async (repository) => {
      const batch = await repository.findBatch(batchId);
      if (!batch) return null;
      const data = await repository.listAdminRecords(
        { ...normalizeRecordFilters({ batchId }), batchId },
        { limit: MAX_PAGE_SIZE, offset: 0 }
      );
      const records = data.records.map(presentAdminQr);
      const activated = records.filter(
        (record) => record.activation_status === 'activated'
      ).length;
      const presented = presentBatch({
        ...batch,
        total_codes: records.length,
        activated_codes: activated
      });
      return Object.freeze({
        ...presented,
        pending_codes: records.length - activated,
        records: Object.freeze(records)
      });
    }, { readOnly: true });
  }

  async function assignBatch(input = {}) {
    const batchId = String(input.batchId || '').trim();
    const ids = normalizeIds(input.ids);
    return run('assign_batch', async (repository) => {
      if (!(await repository.findBatch(batchId))) {
        throw new QrAdministrationError('BATCH_NOT_FOUND');
      }
      const updated = await repository.assignBatch(
        batchId,
        ids,
        timestamp(clock).toISOString()
      );
      return Object.freeze({ updated_count: updated.length });
    });
  }

  async function listRecords(input = {}) {
    const page = positiveInteger(input.page, 1);
    const limit = positiveInteger(input.limit, 20);
    const filters = normalizeRecordFilters(input);
    return run('list_records', async (repository) => {
      const data = await repository.listAdminRecords(filters, {
        limit,
        offset: (page - 1) * limit
      });
      return Object.freeze({
        total: data.total,
        page,
        limit,
        records: Object.freeze(data.records.map(presentAdminQr))
      });
    }, { readOnly: true });
  }

  async function getRecord(input = {}) {
    const qrId = String(input.qrId || '').trim();
    return run(
      'get_record',
      async (repository) => presentAdminQr(await repository.findAdminRecord(qrId)),
      { readOnly: true }
    );
  }

  async function setHidden(input = {}) {
    const ids = normalizeIds(input.ids);
    const hidden = input.hidden === true;
    return run('set_hidden', async (repository) => {
      const updatedIds = await repository.setHidden(
        ids,
        hidden,
        timestamp(clock).toISOString()
      );
      if (updatedIds.length === 0) return Object.freeze([]);
      const data = await repository.listAdminRecords(
        normalizeRecordFilters({ ids: updatedIds }),
        { limit: updatedIds.length, offset: 0 }
      );
      return Object.freeze(data.records.map(presentAdminQr));
    });
  }

  async function runQualityCheck(input = {}) {
    const qrId = String(input.qrId || '').trim();
    const checkedBy = String(input.checkedBy || '').trim() || 'qc';
    return run('quality_check', async (repository) => {
      const qr = await repository.findQrForQualityCheck(qrId);
      if (!qr) throw new QrAdministrationError('QR_NOT_FOUND');
      const result = qr.lifecycle_status === 'activated'
        ? 'bound'
        : qr.has_quality_log ? 'duplicate' : 'pass';
      const message = result === 'bound'
        ? '该星已被顾客绑定，请标记异常。'
        : result === 'duplicate'
          ? '重复！该码已存在质检记录。'
          : '首次质检通过，可以流通。';
      const log = await repository.insertQualityCheckLog({
        qrId,
        checkedBy,
        result,
        checkedAt: timestamp(clock).toISOString()
      });
      return Object.freeze({
        qr_id: qrId,
        result,
        message,
        checked_at: iso(log.checked_at),
        checked_by: log.checked_by_snapshot
      });
    });
  }

  async function listQualityCheckLogs(input = {}) {
    const page = positiveInteger(input.page, 1);
    const limit = positiveInteger(input.limit, 20);
    return run('list_quality_logs', async (repository) => {
      const data = await repository.listQualityCheckLogs({
        limit,
        offset: (page - 1) * limit
      });
      return Object.freeze({
        total: data.total,
        page,
        limit,
        logs: Object.freeze(data.logs.map((log) => Object.freeze({
          id: Number(log.id),
          qr_id: log.qr_id,
          checked_at: iso(log.checked_at),
          checked_by: log.checked_by_snapshot,
          result: log.result
        })))
      });
    }, { readOnly: true });
  }

  async function getQualityCheckStats() {
    const now = timestamp(clock);
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);
    return run('quality_stats', async (repository) => {
      const stats = await repository.qualityCheckStats({
        dayStart: dayStart.toISOString(),
        dayEnd: dayEnd.toISOString()
      });
      return Object.freeze({
        today_checked: Number(stats.today_checked || 0),
        today_abnormal: Number(stats.today_abnormal || 0),
        total_checked: Number(stats.total_checked || 0)
      });
    }, { readOnly: true });
  }

  async function getDashboardStats(input = {}) {
    const now = timestamp(clock);
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);
    return run('dashboard_stats', async (repository) => {
      const stats = await repository.dashboardStats({
        dayStart: dayStart.toISOString(),
        dayEnd: dayEnd.toISOString(),
        dateFrom: dateBoundary(input.dateFrom),
        dateTo: dateBoundary(input.dateTo, true)
      });
      const quality = await repository.qualityCheckStats({
        dayStart: dayStart.toISOString(),
        dayEnd: dayEnd.toISOString()
      });
      const periodIssued = Number(stats.period_issued || 0);
      const periodActivated = Number(stats.period_activated || 0);
      return Object.freeze({
        total_issued: Number(stats.total_issued || 0),
        total_activated: Number(stats.total_activated || 0),
        total_co_creating: Number(stats.total_co_creating || 0),
        circulating_pending: Number(stats.circulating_pending || 0),
        today_new_records: Number(stats.today_new_records || 0),
        published_products: null,
        hidden_records: Number(stats.hidden_records || 0),
        today_quality_checked: Number(quality.today_checked || 0),
        today_quality_abnormal: Number(quality.today_abnormal || 0),
        chain_pending: Number(stats.chain_pending || 0),
        chain_processing: Number(stats.chain_processing || 0),
        chain_confirmed: Number(stats.chain_confirmed || 0),
        chain_failed: Number(stats.chain_failed || 0),
        period_issued: periodIssued,
        period_activated: periodActivated,
        period_activation_rate: activationRate(periodIssued, periodActivated)
      });
    }, { readOnly: true });
  }

  return Object.freeze({
    assignBatch,
    createBatch,
    getBatchDetail,
    getDashboardStats,
    getQualityCheckStats,
    getRecord,
    listBatches,
    listQualityCheckLogs,
    listRecords,
    runQualityCheck,
    setHidden
  });
}

module.exports = {
  MAX_MUTATION_IDS,
  QrAdministrationError,
  createQrAdministrationService,
  presentAdminQr,
  presentBatch
};
