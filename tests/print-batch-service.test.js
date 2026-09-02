'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const JSZip = require('jszip');

const {
  PrintBatchServiceError,
  buildQrManifestCsv,
  createPrintBatchService,
  writeFormalZip
} = require('../src/server/services/postgres/printBatchService');
const { defaultLabelTemplateSchema } = require('../src/server/services/labelTemplateSchema');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function fixtureStore() {
  return {
    batches: new Map(), audits: [], assets: [],
    template: {
      id: '10000000-0000-4000-8000-000000000001',
      template_id: '20000000-0000-4000-8000-000000000001',
      version_number: 1, status: 'published', template_status: 'published',
      template_name: '80x20 默认款', template_schema: defaultLabelTemplateSchema()
    },
    qrs: new Map(['SSS10001', 'SSS10002', 'SSS10003'].map((id) => [id, {
      id, issue_status: 'issued', lifecycle_status: 'unactivated', batch_id: 'QR-BATCH-1',
      print_batch_id: null, print_status: 'available', print_void_reason: '',
      access_token: `token-${id}`
    }]))
  };
}

class MemoryPrintBatchRepository {
  constructor(store) {
    this.store = store;
  }

  view(row) {
    if (!row) return null;
    return clone({
      ...row,
      template_name: this.store.template.template_name,
      template_version_number: this.store.template.version_number,
      template_id: this.store.template.template_id,
      template_schema: this.store.template.template_schema
    });
  }

  async list() { return [...this.store.batches.values()].map((row) => this.view(row)); }
  async find(id) { return this.view(this.store.batches.get(id)); }
  async findByIdempotencyKey(key) {
    return clone([...this.store.batches.values()].find((row) => row.idempotency_key === key));
  }
  async findPublishedTemplateVersion(id) {
    return id === this.store.template.id ? clone(this.store.template) : null;
  }
  async lockQrCodes(ids) {
    return ids.map((id) => this.store.qrs.get(id)).filter(Boolean).map(clone);
  }
  async insert(input) {
    const row = {
      ...clone(input), status: 'reserved', artifact_object_key: null,
      artifact_sha256: null, artifact_size_bytes: null, generated_at: null,
      generation_attempt_count: 0, generation_error_code: '', download_count: 0,
      first_downloaded_at: null, last_downloaded_at: null,
      printing_started_at: null, completed_at: null, canceled_at: null,
      voided_at: null, void_reason: '', updated_at: input.created_at
    };
    this.store.batches.set(row.id, row);
    return clone(row);
  }
  async reserveQrCodes(batchId, ids, at) {
    const updated = [];
    for (const id of ids) {
      const qr = this.store.qrs.get(id);
      if (qr && qr.print_status === 'available' && qr.print_batch_id === null) {
        Object.assign(qr, { print_batch_id: batchId, print_status: 'reserved',
          print_status_updated_at: at });
        updated.push(id);
      }
    }
    return updated;
  }
  async listQrCodes(batchId) {
    return [...this.store.qrs.values()].filter((qr) => qr.print_batch_id === batchId)
      .sort((left, right) => left.id.localeCompare(right.id)).map(clone);
  }
  async listLegacyQrCodes({ sourceBatchId, idPrefix, limit = 500 } = {}) {
    return [...this.store.qrs.values()].filter((qr) => (
      qr.print_status === 'legacy_unclassified'
      && (!sourceBatchId || qr.batch_id === sourceBatchId)
      && (!idPrefix || qr.id.startsWith(idPrefix))
    )).sort((left, right) => left.id.localeCompare(right.id)).slice(0, limit).map(clone);
  }
  async classifyLegacyQrCodes(ids, targetStatus, reason, at) {
    const updated = [];
    for (const id of ids) {
      const qr = this.store.qrs.get(id);
      if (qr && qr.print_status === 'legacy_unclassified') {
        Object.assign(qr, { print_status: targetStatus,
          print_void_reason: targetStatus === 'voided' ? reason : '',
          print_status_updated_at: at });
        updated.push(id);
      }
    }
    return updated;
  }
  async listTemplateAssets() { return clone(this.store.assets); }
  async startGeneration(id, at) {
    const row = this.store.batches.get(id);
    if (!row || !['reserved', 'generation_failed'].includes(row.status)) return null;
    Object.assign(row, { status: 'generating', generation_attempt_count: row.generation_attempt_count + 1,
      generation_error_code: '', updated_at: at });
    return clone(row);
  }
  async failGeneration(id, code, at) {
    const row = this.store.batches.get(id);
    if (!row || row.status !== 'generating') return null;
    Object.assign(row, { status: 'generation_failed', generation_error_code: code,
      updated_at: at });
    return clone(row);
  }
  async completeArtifact(id, artifact, at) {
    const row = this.store.batches.get(id);
    if (!row || row.status !== 'generating') return null;
    Object.assign(row, { status: 'artifact_ready', artifact_object_key: artifact.objectKey,
      artifact_sha256: artifact.sha256, artifact_size_bytes: artifact.size,
      generated_at: at, updated_at: at });
    return clone(row);
  }
  async markQrArtifactGenerated(batchId, at) {
    const ids = [];
    for (const qr of this.store.qrs.values()) {
      if (qr.print_batch_id === batchId && qr.print_status === 'reserved') {
        Object.assign(qr, { print_status: 'artifact_generated', print_status_updated_at: at });
        ids.push(qr.id);
      }
    }
    return ids;
  }
  async cancel(id, at) {
    const row = this.store.batches.get(id);
    if (!row || !['reserved', 'generation_failed'].includes(row.status)) return null;
    Object.assign(row, { status: 'canceled', canceled_at: at, updated_at: at });
    return clone(row);
  }
  async releaseQrCodes(batchId, at) {
    const ids = [];
    for (const qr of this.store.qrs.values()) {
      if (qr.print_batch_id === batchId && qr.print_status === 'reserved') {
        Object.assign(qr, { print_batch_id: null, print_status: 'available',
          print_status_updated_at: at });
        ids.push(qr.id);
      }
    }
    return ids;
  }
  async recordDownload(id, username, at) {
    const row = this.store.batches.get(id);
    if (!row || !['artifact_ready', 'printing', 'completed'].includes(row.status)) return null;
    row.download_count += 1;
    row.first_downloaded_at ||= at;
    Object.assign(row, { last_downloaded_at: at, last_downloaded_by_snapshot: username,
      updated_at: at });
    return clone(row);
  }
  async transition(id, from, status, timestampColumn, at, reason = '') {
    const row = this.store.batches.get(id);
    if (!row || !from.includes(row.status)) return null;
    Object.assign(row, { status, [timestampColumn]: at, updated_at: at });
    if (status === 'voided') row.void_reason = reason;
    return clone(row);
  }
  async markQrPrinted(batchId, at) {
    const ids = [];
    for (const qr of this.store.qrs.values()) {
      if (qr.print_batch_id === batchId && qr.print_status === 'artifact_generated') {
        Object.assign(qr, { print_status: 'printed', print_status_updated_at: at });
        ids.push(qr.id);
      }
    }
    return ids;
  }
  async voidQrCodes(batchId, ids, reason, at) {
    const updated = [];
    for (const id of ids) {
      const qr = this.store.qrs.get(id);
      if (qr && qr.print_batch_id === batchId
          && ['artifact_generated', 'printed'].includes(qr.print_status)) {
        Object.assign(qr, { print_status: 'voided', print_void_reason: reason,
          print_status_updated_at: at });
        updated.push(id);
      }
    }
    return updated;
  }
  async appendAudit(event) { this.store.audits.push(clone(event)); }
}

function serviceFixture() {
  const store = fixtureStore();
  const artifacts = new Map();
  let now = 0;
  let writes = 0;
  const service = createPrintBatchService({
    pool: { connect() {} }, repositoryType: MemoryPrintBatchRepository,
    transactionRunner: async (_pool, callback) => callback(store),
    clock: () => new Date(Date.UTC(2026, 8, 2, 0, 0, now++)),
    uuid: () => '30000000-0000-4000-8000-000000000001',
    baseUrl: 'https://xingxingzaishan.top',
    saveArtifactFile: async ({ objectKey, localPath, sha256, size }) => {
      writes += 1;
      const buffer = await fs.readFile(localPath);
      assert.equal(buffer.length, size);
      const existing = artifacts.get(objectKey);
      if (existing) assert.equal(existing.sha256, sha256);
      artifacts.set(objectKey, { buffer, sha256, size });
      return { object_key: objectKey, sha256, size };
    },
    openArtifactStream: async (objectKey) => ({
      stream: Readable.from(artifacts.get(objectKey).buffer),
      size: artifacts.get(objectKey).size,
      contentType: 'application/zip'
    })
  });
  return { service, store, artifacts, getWrites: () => writes };
}

const ACTOR = { operatorId: 1, username: 'admin' };
const VERSION_ID = '10000000-0000-4000-8000-000000000001';

test('reservation is exclusive and cancel releases only pre-artifact QR codes', async () => {
  const { service, store } = serviceFixture();
  const first = await service.create({
    name: '首批打样', templateVersionId: VERSION_ID,
    idempotencyKey: '40000000-0000-4000-8000-000000000001',
    qrIds: ['SSS10001', 'SSS10002'], actor: ACTOR
  });
  assert.equal(first.status, 'reserved');
  assert.equal(store.qrs.get('SSS10001').print_status, 'reserved');
  await assert.rejects(service.create({
    name: '重复任务', templateVersionId: VERSION_ID,
    idempotencyKey: '40000000-0000-4000-8000-000000000002',
    qrIds: ['SSS10002'], actor: ACTOR
  }), (error) => error instanceof PrintBatchServiceError
    && error.code === 'PRINT_QR_ALREADY_RESERVED');
  const canceled = await service.cancel({ batchId: first.id, actor: ACTOR });
  assert.equal(canceled.status, 'canceled');
  assert.equal(store.qrs.get('SSS10001').print_status, 'available');
  assert.equal(store.qrs.get('SSS10001').print_batch_id, null);
});

test('formal artifact is unique, downloadable and closes with explicit scrap IDs', async () => {
  const { service, store, artifacts, getWrites } = serviceFixture();
  const created = await service.create({
    name: '正式生产批次', vendorName: '测试印刷厂', templateVersionId: VERSION_ID,
    idempotencyKey: '40000000-0000-4000-8000-000000000003',
    qrIds: ['SSS10001', 'SSS10002'], actor: ACTOR
  });
  const generated = await service.generate({ batchId: created.id, actor: ACTOR });
  assert.equal(generated.status, 'artifact_ready');
  assert.match(generated.artifact_sha256, /^[a-f0-9]{64}$/);
  assert.equal(store.qrs.get('SSS10001').print_status, 'artifact_generated');
  assert.equal(getWrites(), 1);
  const repeated = await service.generate({ batchId: created.id, actor: ACTOR });
  assert.equal(repeated.artifact_sha256, generated.artifact_sha256);
  assert.equal(getWrites(), 1);

  const artifact = [...artifacts.values()][0];
  const zip = await JSZip.loadAsync(artifact.buffer);
  assert.deepEqual(Object.keys(zip.files).sort(), [
    'SSS10001.png', 'SSS10002.png', '二维码ID清单.csv'
  ].sort());
  const manifest = await zip.file('二维码ID清单.csv').async('string');
  assert.match(manifest, /SSS10001/);
  assert.match(manifest, /PRINT-/);
  assert.doesNotMatch(manifest, /token-|138\d{8}/);

  const download = await service.download({ batchId: created.id, actor: ACTOR });
  assert.equal(download.sha256, generated.artifact_sha256);
  assert.equal(store.batches.get(created.id).download_count, 1);
  await service.startPrinting({ batchId: created.id, actor: ACTOR });
  const completed = await service.complete({
    batchId: created.id, voidQrIds: ['SSS10002'], voidReason: '裁切损坏', actor: ACTOR
  });
  assert.equal(completed.status, 'completed');
  assert.equal(store.qrs.get('SSS10001').print_status, 'printed');
  assert.equal(store.qrs.get('SSS10002').print_status, 'voided');
  assert.equal(store.qrs.get('SSS10002').print_void_reason, '裁切损坏');
  const postPrintVoid = await service.voidPrintedQrCodes({
    batchId: created.id, qrIds: ['SSS10001'], reason: '质检后发现污损', actor: ACTOR
  });
  assert.deepEqual(postPrintVoid.voided_ids, ['SSS10001']);
  assert.equal(store.qrs.get('SSS10001').print_status, 'voided');
});

test('historical QR classification is explicit, filtered and eligibility checked', async () => {
  const { service, store } = serviceFixture();
  store.qrs.set('OLD10001', {
    id: 'OLD10001', batch_id: 'LEGACY-A', issue_status: 'issued',
    lifecycle_status: 'unactivated', print_batch_id: null,
    print_status: 'legacy_unclassified', print_void_reason: '', created_at: '2026-01-01T00:00:00.000Z'
  });
  store.qrs.set('OLD10002', {
    id: 'OLD10002', batch_id: 'LEGACY-B', issue_status: 'issued',
    lifecycle_status: 'activated', print_batch_id: null,
    print_status: 'legacy_unclassified', print_void_reason: '', created_at: '2026-01-01T00:00:00.000Z'
  });
  const listed = await service.listLegacyQrCodes({ sourceBatchId: 'LEGACY-A' });
  assert.deepEqual(listed.map((qr) => qr.id), ['OLD10001']);
  const available = await service.classifyLegacyQrCodes({
    qrIds: ['OLD10001'], targetStatus: 'available', actor: ACTOR
  });
  assert.deepEqual(available.updated_ids, ['OLD10001']);
  assert.equal(store.qrs.get('OLD10001').print_status, 'available');
  await assert.rejects(service.classifyLegacyQrCodes({
    qrIds: ['OLD10002'], targetStatus: 'available', actor: ACTOR
  }), (error) => error.code === 'PRINT_HISTORY_QR_NOT_AVAILABLE');
  const voided = await service.classifyLegacyQrCodes({
    qrIds: ['OLD10002'], targetStatus: 'voided', reason: '历史测试码', actor: ACTOR
  });
  assert.deepEqual(voided.updated_ids, ['OLD10002']);
  assert.equal(store.qrs.get('OLD10002').print_void_reason, '历史测试码');
});

test('manifest and ZIP generation are deterministic and do not expose access tokens', async () => {
  const batch = {
    id: 'PRINT-TEST', template_name: '模板', template_version_number: 1,
    created_at: '2026-09-02T00:00:00.000Z'
  };
  const qrCodes = [{ id: 'SSS10001', batch_id: 'BATCH-1', access_token: 'secret-token' }];
  assert.doesNotMatch(buildQrManifestCsv({ batch, qrCodes }), /secret-token/);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'print-batch-test-'));
  const paths = [path.join(directory, 'a.zip'), path.join(directory, 'b.zip')];
  try {
    const fakeRender = async ({ qrId }) => ({ buffer: Buffer.from(`png:${qrId}`) });
    const first = await writeFormalZip({
      batch, qrCodes, template: {}, assets: new Map(), outputPath: paths[0],
      baseUrl: 'https://example.invalid', render: fakeRender
    });
    const second = await writeFormalZip({
      batch, qrCodes, template: {}, assets: new Map(), outputPath: paths[1],
      baseUrl: 'https://example.invalid', render: fakeRender
    });
    assert.deepEqual(first, second);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('admin production UI closes the legacy image export bypass', async () => {
  const [html, printJs, adminJs, editorJs, routeSource, adminCss, appSource] = await Promise.all([
    fs.readFile(path.join(__dirname, '../src/admin/index.html'), 'utf8'),
    fs.readFile(path.join(__dirname, '../src/admin/js/print-batch-admin.js'), 'utf8'),
    fs.readFile(path.join(__dirname, '../src/admin/js/admin.js'), 'utf8'),
    fs.readFile(path.join(__dirname, '../src/admin/js/label-template-editor.js'), 'utf8'),
    fs.readFile(path.join(__dirname, '../src/server/routes/admin.js'), 'utf8'),
    fs.readFile(path.join(__dirname, '../src/admin/css/admin.css'), 'utf8'),
    fs.readFile(path.join(__dirname, '../src/server/app.js'), 'utf8')
  ]);
  assert.equal(html.includes('batchQrImagesExportBtn'), false);
  assert.match(html, /历史二维码分类/u);
  assert.match(printJs, /\/print-production\/legacy-qr-codes/u);
  assert.match(printJs, /qr-codes\/void/u);
  assert.equal(adminJs.includes('/api/admin/records/qr-images/export'), false);
  assert.match(editorJs, /el\(id\)\.addEventListener\('input', updateElementProperties\)/u);
  assert.match(editorJs, /syncElementPropertiesFromControls\(\);\s+await api\(/u);
  assert.match(editorJs, /const POINT_TO_MM = 25\.4 \/ 72/u);
  assert.match(editorJs, /canvasFontSize\(element\.fontSizePt, scale\)/u);
  assert.match(adminCss, /font-family: "Label Noto Sans SC"/u);
  assert.match(adminCss, /font-family: "Label IBM Plex Mono"/u);
  assert.match(appSource, /app\.use\('\/admin\/fonts', express\.static/u);
  assert.match(routeSource, /LEGACY_QR_IMAGE_EXPORT_RETIRED/u);
  assert.match(routeSource, /status\(410\)/u);
});
