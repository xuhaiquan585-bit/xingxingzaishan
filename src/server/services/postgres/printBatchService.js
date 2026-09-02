'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const JSZip = require('jszip');

const { renderLabel } = require('../labelRenderer');
const { validateTemplateSchema } = require('../labelTemplateSchema');

const MAX_PRINT_BATCH_SIZE = 500;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const QR_ID_PATTERN = /^[A-Z0-9]+$/;

class PrintBatchServiceError extends Error {
  constructor(code) {
    super(code);
    this.name = 'PrintBatchServiceError';
    this.code = code;
  }
}

function actor(input = {}) {
  return Object.freeze({
    operatorId: Number.isSafeInteger(Number(input.operatorId)) ? Number(input.operatorId) : null,
    username: String(input.username || '').trim() || 'admin'
  });
}

function boundedText(value, code, { required = false, max = 160 } = {}) {
  const text = String(value || '').trim();
  if ((required && !text) || text.length > max) throw new PrintBatchServiceError(code);
  return text;
}

function normalizeQrIds(values) {
  if (!Array.isArray(values)) throw new PrintBatchServiceError('PRINT_QR_IDS_INVALID');
  const ids = [...new Set(values.map((value) => String(value || '').trim().toUpperCase()))]
    .sort();
  if (ids.length < 1 || ids.length > MAX_PRINT_BATCH_SIZE
      || ids.some((id) => !QR_ID_PATTERN.test(id))) {
    throw new PrintBatchServiceError('PRINT_QR_IDS_INVALID');
  }
  return ids;
}

function validateIdempotencyKey(value) {
  const key = String(value || '').trim().toLowerCase();
  if (!UUID_PATTERN.test(key)) throw new PrintBatchServiceError('IDEMPOTENCY_KEY_INVALID');
  return key;
}

function presentBatch(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    name: row.name,
    template_version_id: row.template_version_id,
    template_name: row.template_name || '',
    template_version_number: row.template_version_number
      ? Number(row.template_version_number) : null,
    status: row.status,
    qr_count: Number(row.qr_count),
    vendor_name: row.vendor_name || '',
    note: row.note || '',
    artifact_sha256: row.artifact_sha256 || null,
    artifact_size_bytes: row.artifact_size_bytes == null
      ? null : Number(row.artifact_size_bytes),
    generation_attempt_count: Number(row.generation_attempt_count || 0),
    generation_error_code: row.generation_error_code || '',
    download_count: Number(row.download_count || 0),
    first_downloaded_at: row.first_downloaded_at || null,
    last_downloaded_at: row.last_downloaded_at || null,
    last_downloaded_by: row.last_downloaded_by_snapshot || '',
    created_by: row.created_by_snapshot || '',
    created_at: row.created_at,
    generated_at: row.generated_at,
    printing_started_at: row.printing_started_at,
    completed_at: row.completed_at,
    canceled_at: row.canceled_at,
    voided_at: row.voided_at,
    void_reason: row.void_reason || '',
    updated_at: row.updated_at
  });
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function buildQrManifestCsv({ batch, qrCodes }) {
  const rows = [[
    '二维码ID', 'PNG文件名', '原二维码批次', '印刷任务编号', '模板名称', '模板版本'
  ]];
  for (const qr of qrCodes) {
    rows.push([
      qr.id, `${qr.id}.png`, qr.batch_id || '', batch.id,
      batch.template_name, `v${batch.template_version_number}`
    ]);
  }
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

function qrPayload(baseUrl, accessToken) {
  return `${String(baseUrl || 'http://localhost:3000').replace(/\/$/, '')}`
    + `/record.html?t=${encodeURIComponent(accessToken)}`;
}

async function writeFormalZip({
  batch,
  qrCodes,
  template,
  assets,
  outputPath,
  baseUrl,
  render = renderLabel,
  onProgress = null
}) {
  const zip = new JSZip();
  const stableDate = new Date(batch.created_at);
  const zipDate = Number.isNaN(stableDate.getTime()) ? new Date('2026-01-01T00:00:00Z') : stableDate;
  for (let index = 0; index < qrCodes.length; index += 1) {
    const qr = qrCodes[index];
    const rendered = await render({
      template,
      qrId: qr.id,
      qrPayload: qrPayload(baseUrl, qr.access_token),
      assets,
      requireAssets: true
    });
    zip.file(`${qr.id}.png`, rendered.buffer, {
      binary: true, date: zipDate, compression: 'STORE', unixPermissions: 0o600
    });
    if (typeof onProgress === 'function') {
      onProgress({ completed: index + 1, total: qrCodes.length, rss: process.memoryUsage().rss });
    }
  }
  zip.file('二维码ID清单.csv', buildQrManifestCsv({ batch, qrCodes }), {
    date: zipDate, compression: 'DEFLATE', compressionOptions: { level: 6 },
    unixPermissions: 0o600
  });

  const hash = crypto.createHash('sha256');
  let size = 0;
  const digest = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    }
  });
  const stream = zip.generateNodeStream({
    type: 'nodebuffer', streamFiles: true, compression: 'STORE', platform: 'UNIX'
  });
  await pipeline(stream, digest, fs.createWriteStream(outputPath, { flags: 'wx', mode: 0o600 }));
  return Object.freeze({ sha256: hash.digest('hex'), size });
}

function createPrintBatchService({
  pool,
  transactionRunner,
  repositoryType,
  beforeOperation,
  readAssetBuffer,
  saveArtifactFile,
  openArtifactStream,
  clock = () => new Date(),
  uuid = () => crypto.randomUUID(),
  tempRoot = os.tmpdir(),
  baseUrl = process.env.BASE_URL || 'http://localhost:3000',
  render = renderLabel,
  onGenerationProgress = null
} = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new PrintBatchServiceError('POSTGRES_POOL_REQUIRED');
  }
  const runTransaction = transactionRunner || require('../../database/transaction').withTransaction;
  const Repository = repositoryType || require('../../repositories').PrintBatchRepository;
  const storage = require('../storageService');
  const assetReader = readAssetBuffer || storage.readObjectBuffer;
  const artifactWriter = saveArtifactFile || storage.saveProtectedArtifactFile;
  const artifactOpener = openArtifactStream || storage.openPrivateObjectStream;

  function timestamp() {
    const value = clock();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  }

  async function run(operation, callback, { readOnly = false } = {}) {
    return runTransaction(pool, async (transactionContext) => {
      if (typeof beforeOperation === 'function') {
        await beforeOperation({ transactionContext, operation });
      }
      return callback(new Repository(transactionContext));
    }, { isolationLevel: 'read committed', readOnly });
  }

  async function audit(repository, action, entityId, operator, metadata = {}, entityType = 'print_batch') {
    await repository.appendAudit({
      actor: operator.username, action, entityId, entityType, metadata, createdAt: timestamp()
    });
  }

  async function list(input = {}) {
    const status = String(input.status || '').trim();
    const search = String(input.search || '').trim().slice(0, 80);
    return run('list_print_batches', async (repository) => Object.freeze(
      (await repository.list({ status, search })).map(presentBatch)
    ), { readOnly: true });
  }

  async function get(input = {}) {
    const batchId = String(input.batchId || '').trim();
    return run('get_print_batch', async (repository) => {
      const batch = await repository.find(batchId);
      if (!batch) return null;
      const qrCodes = await repository.listQrCodes(batchId);
      return Object.freeze({
        batch: presentBatch(batch),
        qr_codes: Object.freeze(qrCodes.map((qr) => Object.freeze({
          id: qr.id,
          original_batch_id: qr.batch_id || null,
          print_status: qr.print_status,
          print_void_reason: qr.print_void_reason || ''
        })))
      });
    }, { readOnly: true });
  }

  async function listLegacyQrCodes(input = {}) {
    const sourceBatchId = boundedText(input.sourceBatchId, 'PRINT_HISTORY_FILTER_INVALID', {
      max: 160
    });
    const idPrefix = String(input.idPrefix || '').trim().toUpperCase();
    if (idPrefix.length > 80 || (idPrefix && !QR_ID_PATTERN.test(idPrefix))) {
      throw new PrintBatchServiceError('PRINT_HISTORY_FILTER_INVALID');
    }
    return run('list_legacy_print_qr_codes', async (repository) => Object.freeze(
      (await repository.listLegacyQrCodes({ sourceBatchId, idPrefix, limit: 500 }))
        .map((qr) => Object.freeze({
          id: qr.id,
          original_batch_id: qr.batch_id || null,
          issue_status: qr.issue_status,
          lifecycle_status: qr.lifecycle_status,
          print_status: qr.print_status,
          created_at: qr.created_at
        }))
    ), { readOnly: true });
  }

  async function classifyLegacyQrCodes(input = {}) {
    const operator = actor(input.actor);
    const qrIds = normalizeQrIds(input.qrIds);
    const targetStatus = String(input.targetStatus || '').trim();
    if (!['available', 'voided'].includes(targetStatus)) {
      throw new PrintBatchServiceError('PRINT_HISTORY_TARGET_INVALID');
    }
    const reason = targetStatus === 'voided'
      ? boundedText(input.reason, 'PRINT_VOID_REASON_INVALID', { required: true, max: 500 }) : '';
    return run('classify_legacy_print_qr_codes', async (repository) => {
      const qrCodes = await repository.lockQrCodes(qrIds);
      if (qrCodes.length !== qrIds.length) throw new PrintBatchServiceError('PRINT_QR_NOT_FOUND');
      if (qrCodes.some((qr) => qr.print_status !== 'legacy_unclassified'
          || qr.print_batch_id !== null)) {
        throw new PrintBatchServiceError('PRINT_HISTORY_QR_CONFLICT');
      }
      if (targetStatus === 'available' && qrCodes.some((qr) => (
        qr.issue_status !== 'issued' || qr.lifecycle_status !== 'unactivated'
      ))) {
        throw new PrintBatchServiceError('PRINT_HISTORY_QR_NOT_AVAILABLE');
      }
      const updated = await repository.classifyLegacyQrCodes(
        qrIds, targetStatus, reason, timestamp()
      );
      if (updated.length !== qrIds.length) {
        throw new PrintBatchServiceError('PRINT_HISTORY_QR_CONFLICT');
      }
      await audit(repository, 'legacy_print_qr_codes_classified', 'legacy-print-classification',
        operator, { target_status: targetStatus, qr_ids: qrIds, reason }, 'qr_print_classification');
      return Object.freeze({ target_status: targetStatus, updated_ids: Object.freeze(updated.sort()) });
    });
  }

  async function create(input = {}) {
    const operator = actor(input.actor);
    const name = boundedText(input.name, 'PRINT_BATCH_NAME_INVALID', { required: true });
    const vendorName = boundedText(input.vendorName, 'PRINT_VENDOR_NAME_INVALID');
    const note = boundedText(input.note, 'PRINT_BATCH_NOTE_INVALID', { max: 2000 });
    const templateVersionId = String(input.templateVersionId || '').trim();
    if (!UUID_PATTERN.test(templateVersionId)) {
      throw new PrintBatchServiceError('PRINT_TEMPLATE_VERSION_INVALID');
    }
    const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
    const qrIds = normalizeQrIds(input.qrIds);

    return run('create_print_batch', async (repository) => {
      const existing = await repository.findByIdempotencyKey(idempotencyKey);
      if (existing) {
        const existingIds = (await repository.listQrCodes(existing.id)).map((qr) => qr.id);
        if (existing.template_version_id !== templateVersionId
            || JSON.stringify(existingIds) !== JSON.stringify(qrIds)) {
          throw new PrintBatchServiceError('IDEMPOTENCY_KEY_CONFLICT');
        }
        return presentBatch(existing);
      }
      const template = await repository.findPublishedTemplateVersion(templateVersionId);
      if (!template || template.template_status !== 'published') {
        throw new PrintBatchServiceError('PRINT_TEMPLATE_NOT_AVAILABLE');
      }
      const qrCodes = await repository.lockQrCodes(qrIds);
      if (qrCodes.length !== qrIds.length) throw new PrintBatchServiceError('PRINT_QR_NOT_FOUND');
      if (qrCodes.some((qr) => qr.issue_status !== 'issued'
          || qr.lifecycle_status !== 'unactivated')) {
        throw new PrintBatchServiceError('PRINT_QR_NOT_UNACTIVATED');
      }
      if (qrCodes.some((qr) => qr.print_status !== 'available' || qr.print_batch_id !== null)) {
        throw new PrintBatchServiceError('PRINT_QR_ALREADY_RESERVED');
      }
      const now = timestamp();
      const batchId = `PRINT-${now.slice(0, 10).replace(/-/g, '')}-${uuid().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
      const batch = await repository.insert({
        id: batchId, name, template_version_id: templateVersionId,
        qr_count: qrIds.length, vendor_name: vendorName, note,
        idempotency_key: idempotencyKey,
        created_by_operator_id: operator.operatorId,
        created_by_snapshot: operator.username, created_at: now
      });
      const reserved = await repository.reserveQrCodes(batchId, qrIds, now);
      if (reserved.length !== qrIds.length) throw new PrintBatchServiceError('PRINT_QR_RESERVATION_CONFLICT');
      await audit(repository, 'print_batch_created', batchId, operator, {
        qr_count: qrIds.length, template_version_id: templateVersionId
      });
      return presentBatch({ ...batch, template_name: template.template_name,
        template_version_number: template.version_number });
    });
  }

  async function cancel(input = {}) {
    const operator = actor(input.actor);
    const batchId = String(input.batchId || '').trim();
    return run('cancel_print_batch', async (repository) => {
      const current = await repository.find(batchId, { forUpdate: true });
      if (!current) throw new PrintBatchServiceError('PRINT_BATCH_NOT_FOUND');
      if (!['reserved', 'generation_failed'].includes(current.status)) {
        throw new PrintBatchServiceError('PRINT_BATCH_CANNOT_CANCEL');
      }
      const qrCodes = await repository.listQrCodes(batchId, { forUpdate: true });
      const now = timestamp();
      const canceled = await repository.cancel(batchId, now);
      const released = await repository.releaseQrCodes(batchId, now);
      if (!canceled || released.length !== qrCodes.length) {
        throw new PrintBatchServiceError('PRINT_BATCH_CANCEL_FAILED');
      }
      await audit(repository, 'print_batch_canceled', batchId, operator, {
        released_qr_count: released.length
      });
      return presentBatch(canceled);
    });
  }

  async function prepareGeneration(batchId, operator) {
    return run('prepare_print_artifact', async (repository) => {
      const batch = await repository.find(batchId, { forUpdate: true });
      if (!batch) throw new PrintBatchServiceError('PRINT_BATCH_NOT_FOUND');
      if (['artifact_ready', 'printing', 'completed'].includes(batch.status)) {
        return { alreadyReady: true, batch };
      }
      if (batch.status === 'generating') {
        throw new PrintBatchServiceError('PRINT_ARTIFACT_GENERATION_IN_PROGRESS');
      }
      if (!['reserved', 'generation_failed'].includes(batch.status)) {
        throw new PrintBatchServiceError('PRINT_ARTIFACT_GENERATION_NOT_ALLOWED');
      }
      const qrCodes = await repository.listQrCodes(batchId, { forUpdate: true });
      if (qrCodes.length !== Number(batch.qr_count)
          || qrCodes.some((qr) => qr.print_status !== 'reserved' || !qr.access_token)) {
        throw new PrintBatchServiceError('PRINT_BATCH_QR_CONTRACT_INVALID');
      }
      const assets = await repository.listTemplateAssets(batch.template_id);
      const started = await repository.startGeneration(batchId, timestamp());
      if (!started) throw new PrintBatchServiceError('PRINT_ARTIFACT_GENERATION_CONFLICT');
      await audit(repository, 'print_artifact_generation_started', batchId, operator, {
        attempt: Number(started.generation_attempt_count)
      });
      return { alreadyReady: false, batch: { ...batch, ...started }, qrCodes, assets };
    });
  }

  async function failGeneration(batchId, error) {
    const code = error instanceof PrintBatchServiceError
      ? error.code : error && error.code === 'LABEL_TEMPLATE_INVALID'
        ? 'LABEL_TEMPLATE_INVALID' : 'PRINT_ARTIFACT_GENERATION_FAILED';
    await run('fail_print_artifact', async (repository) => {
      await repository.failGeneration(batchId, code, timestamp());
    }).catch(() => undefined);
    return code;
  }

  async function generate(input = {}) {
    const operator = actor(input.actor);
    const batchId = String(input.batchId || '').trim();
    const prepared = await prepareGeneration(batchId, operator);
    if (prepared.alreadyReady) return presentBatch(prepared.batch);
    let tempDirectory;
    try {
      tempDirectory = await fsp.mkdtemp(path.join(tempRoot, 'xingxing-print-'));
      const outputPath = path.join(tempDirectory, `${batchId}.zip`);
      const assetMetadata = new Map();
      const assetBuffers = new Map();
      for (const asset of prepared.assets) {
        const buffer = await assetReader(asset.object_key);
        if (!buffer) throw new PrintBatchServiceError('PRINT_TEMPLATE_ASSET_READ_FAILED');
        assetMetadata.set(asset.id, {
          pixelWidth: Number(asset.pixel_width), pixelHeight: Number(asset.pixel_height)
        });
        assetBuffers.set(asset.id, {
          buffer, pixelWidth: Number(asset.pixel_width), pixelHeight: Number(asset.pixel_height)
        });
      }
      const template = validateTemplateSchema(prepared.batch.template_schema, {
        assets: assetMetadata, requireAssets: true
      });
      const file = await writeFormalZip({
        batch: prepared.batch, qrCodes: prepared.qrCodes, template,
        assets: assetBuffers, outputPath, baseUrl, render,
        onProgress: onGenerationProgress
      });
      const objectKey = `printing/production/${batchId}/${prepared.batch.idempotency_key}.zip`;
      await artifactWriter({
        objectKey, localPath: outputPath, contentType: 'application/zip',
        sha256: file.sha256, size: file.size
      });
      const completed = await run('complete_print_artifact', async (repository) => {
        const current = await repository.find(batchId, { forUpdate: true });
        if (!current) throw new PrintBatchServiceError('PRINT_BATCH_NOT_FOUND');
        if (['artifact_ready', 'printing', 'completed'].includes(current.status)) {
          if (current.artifact_sha256 !== file.sha256
              || Number(current.artifact_size_bytes) !== file.size) {
            throw new PrintBatchServiceError('PRINT_ARTIFACT_IMMUTABILITY_CONFLICT');
          }
          return current;
        }
        if (current.status !== 'generating') {
          throw new PrintBatchServiceError('PRINT_ARTIFACT_GENERATION_CONFLICT');
        }
        const now = timestamp();
        const lockedQrs = await repository.listQrCodes(batchId, { forUpdate: true });
        const updatedQrs = await repository.markQrArtifactGenerated(batchId, now);
        if (lockedQrs.length !== Number(current.qr_count)
            || updatedQrs.length !== Number(current.qr_count)) {
          throw new PrintBatchServiceError('PRINT_ARTIFACT_QR_LOCK_FAILED');
        }
        const row = await repository.completeArtifact(batchId, {
          objectKey, sha256: file.sha256, size: file.size
        }, now);
        if (!row) throw new PrintBatchServiceError('PRINT_ARTIFACT_COMMIT_FAILED');
        await audit(repository, 'print_artifact_generated', batchId, operator, {
          qr_count: updatedQrs.length, artifact_sha256: file.sha256,
          artifact_size_bytes: file.size
        });
        return row;
      });
      return presentBatch(completed);
    } catch (error) {
      const code = await failGeneration(batchId, error);
      if (error instanceof PrintBatchServiceError || error?.code === 'LABEL_TEMPLATE_INVALID') {
        throw error;
      }
      throw new PrintBatchServiceError(code);
    } finally {
      if (tempDirectory) await fsp.rm(tempDirectory, { recursive: true, force: true });
    }
  }

  async function download(input = {}) {
    const operator = actor(input.actor);
    const batchId = String(input.batchId || '').trim();
    const batch = await run('record_print_artifact_download', async (repository) => {
      const current = await repository.find(batchId, { forUpdate: true });
      if (!current) throw new PrintBatchServiceError('PRINT_BATCH_NOT_FOUND');
      if (!current.artifact_object_key
          || !['artifact_ready', 'printing', 'completed'].includes(current.status)) {
        throw new PrintBatchServiceError('PRINT_ARTIFACT_NOT_READY');
      }
      const row = await repository.recordDownload(batchId, operator.username, timestamp());
      await audit(repository, 'print_artifact_downloaded', batchId, operator, {
        download_count: Number(row.download_count)
      });
      return row;
    });
    const opened = await artifactOpener(batch.artifact_object_key);
    return Object.freeze({
      ...opened,
      filename: `${batch.id}.zip`,
      sha256: batch.artifact_sha256,
      expectedSize: Number(batch.artifact_size_bytes)
    });
  }

  async function startPrinting(input = {}) {
    const operator = actor(input.actor);
    const batchId = String(input.batchId || '').trim();
    return run('start_printing', async (repository) => {
      if (!(await repository.find(batchId, { forUpdate: true }))) {
        throw new PrintBatchServiceError('PRINT_BATCH_NOT_FOUND');
      }
      const row = await repository.transition(
        batchId, ['artifact_ready'], 'printing', 'printing_started_at', timestamp()
      );
      if (!row) throw new PrintBatchServiceError('PRINT_BATCH_TRANSITION_INVALID');
      await audit(repository, 'print_batch_printing_started', batchId, operator);
      return presentBatch(row);
    });
  }

  async function complete(input = {}) {
    const operator = actor(input.actor);
    const batchId = String(input.batchId || '').trim();
    const voidIds = Array.isArray(input.voidQrIds) && input.voidQrIds.length
      ? normalizeQrIds(input.voidQrIds) : [];
    const reason = voidIds.length
      ? boundedText(input.voidReason, 'PRINT_VOID_REASON_INVALID', { required: true, max: 500 }) : '';
    return run('complete_print_batch', async (repository) => {
      const current = await repository.find(batchId, { forUpdate: true });
      if (!current) throw new PrintBatchServiceError('PRINT_BATCH_NOT_FOUND');
      if (current.status !== 'printing') {
        throw new PrintBatchServiceError('PRINT_BATCH_TRANSITION_INVALID');
      }
      const qrCodes = await repository.listQrCodes(batchId, { forUpdate: true });
      const taskIds = new Set(qrCodes.map((qr) => qr.id));
      if (voidIds.some((id) => !taskIds.has(id))) {
        throw new PrintBatchServiceError('PRINT_VOID_QR_SCOPE_INVALID');
      }
      const now = timestamp();
      const voided = voidIds.length
        ? await repository.voidQrCodes(batchId, voidIds, reason, now) : [];
      if (voided.length !== voidIds.length) throw new PrintBatchServiceError('PRINT_VOID_QR_CONFLICT');
      const printed = await repository.markQrPrinted(batchId, now);
      if (printed.length + voided.length !== qrCodes.length) {
        throw new PrintBatchServiceError('PRINT_COMPLETION_QR_CONTRACT_INVALID');
      }
      const row = await repository.transition(
        batchId, ['printing'], 'completed', 'completed_at', now
      );
      if (!row) throw new PrintBatchServiceError('PRINT_BATCH_TRANSITION_INVALID');
      await audit(repository, 'print_batch_completed', batchId, operator, {
        printed_count: printed.length, voided_count: voided.length
      });
      return presentBatch(row);
    });
  }

  async function voidBatch(input = {}) {
    const operator = actor(input.actor);
    const batchId = String(input.batchId || '').trim();
    const reason = boundedText(input.reason, 'PRINT_VOID_REASON_INVALID', {
      required: true, max: 500
    });
    return run('void_print_batch', async (repository) => {
      const current = await repository.find(batchId, { forUpdate: true });
      if (!current) throw new PrintBatchServiceError('PRINT_BATCH_NOT_FOUND');
      if (!['artifact_ready', 'printing'].includes(current.status)) {
        throw new PrintBatchServiceError('PRINT_BATCH_TRANSITION_INVALID');
      }
      const qrCodes = await repository.listQrCodes(batchId, { forUpdate: true });
      const now = timestamp();
      const voided = await repository.voidQrCodes(
        batchId, qrCodes.map((qr) => qr.id), reason, now
      );
      if (voided.length !== qrCodes.length) throw new PrintBatchServiceError('PRINT_VOID_QR_CONFLICT');
      const row = await repository.transition(
        batchId, [current.status], 'voided', 'voided_at', now, reason
      );
      if (!row) throw new PrintBatchServiceError('PRINT_BATCH_TRANSITION_INVALID');
      await audit(repository, 'print_batch_voided', batchId, operator, {
        voided_count: voided.length
      });
      return presentBatch(row);
    });
  }

  async function voidPrintedQrCodes(input = {}) {
    const operator = actor(input.actor);
    const batchId = String(input.batchId || '').trim();
    const qrIds = normalizeQrIds(input.qrIds);
    const reason = boundedText(input.reason, 'PRINT_VOID_REASON_INVALID', {
      required: true, max: 500
    });
    return run('void_printed_qr_codes', async (repository) => {
      const current = await repository.find(batchId, { forUpdate: true });
      if (!current) throw new PrintBatchServiceError('PRINT_BATCH_NOT_FOUND');
      if (current.status !== 'completed') {
        throw new PrintBatchServiceError('PRINT_BATCH_TRANSITION_INVALID');
      }
      const qrCodes = await repository.listQrCodes(batchId, { forUpdate: true });
      const selected = new Map(qrCodes.map((qr) => [qr.id, qr]));
      if (qrIds.some((id) => !selected.has(id))) {
        throw new PrintBatchServiceError('PRINT_VOID_QR_SCOPE_INVALID');
      }
      if (qrIds.some((id) => selected.get(id).print_status !== 'printed')) {
        throw new PrintBatchServiceError('PRINT_VOID_QR_CONFLICT');
      }
      const voided = await repository.voidQrCodes(batchId, qrIds, reason, timestamp());
      if (voided.length !== qrIds.length) throw new PrintBatchServiceError('PRINT_VOID_QR_CONFLICT');
      await audit(repository, 'printed_qr_codes_voided', batchId, operator, {
        qr_ids: qrIds, reason
      });
      return Object.freeze({ batch_id: batchId, voided_ids: Object.freeze(voided.sort()) });
    });
  }

  return Object.freeze({
    cancel, classifyLegacyQrCodes, complete, create, download, generate, get,
    list, listLegacyQrCodes, startPrinting, voidBatch, voidPrintedQrCodes
  });
}

module.exports = {
  MAX_PRINT_BATCH_SIZE,
  PrintBatchServiceError,
  buildQrManifestCsv,
  createPrintBatchService,
  normalizeQrIds,
  presentBatch,
  writeFormalZip
};
