'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  LabelTemplateServiceError,
  createLabelTemplateService
} = require('../src/server/services/postgres/labelTemplateService');
const { defaultLabelTemplateSchema } = require('../src/server/services/labelTemplateSchema');

function createStore() {
  return {
    templates: new Map(), versions: new Map(), assets: new Map(), audits: []
  };
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

class MemoryLabelTemplateRepository {
  constructor(store) {
    this.store = store;
  }

  templateView(row) {
    if (!row) return null;
    const versions = [...this.store.versions.values()].filter(
      (version) => version.template_id === row.id
    );
    const draft = versions.find((version) => version.status === 'draft');
    const published = row.current_published_version_id
      ? this.store.versions.get(row.current_published_version_id) : null;
    return {
      ...clone(row),
      current_published_version_number: published && published.version_number,
      draft_version_id: draft && draft.id,
      draft_version_number: draft && draft.version_number,
      print_batch_count: 0
    };
  }

  async listTemplates() {
    return [...this.store.templates.values()].map((row) => this.templateView(row));
  }

  async findTemplate(id) {
    return this.templateView(this.store.templates.get(id));
  }

  async listVersions(templateId) {
    return [...this.store.versions.values()]
      .filter((version) => version.template_id === templateId)
      .sort((left, right) => right.version_number - left.version_number)
      .map(clone);
  }

  async findVersion(id) {
    return clone(this.store.versions.get(id));
  }

  async findDraft(templateId) {
    return clone([...this.store.versions.values()].find(
      (version) => version.template_id === templateId && version.status === 'draft'
    ));
  }

  async nextVersionNumber(templateId) {
    return Math.max(0, ...[...this.store.versions.values()]
      .filter((version) => version.template_id === templateId)
      .map((version) => version.version_number)) + 1;
  }

  async insertTemplate(input) {
    const row = {
      ...clone(input), current_published_version_id: null, archived_at: null,
      updated_at: input.created_at
    };
    this.store.templates.set(row.id, row);
    return clone(row);
  }

  async insertVersion(input) {
    const row = {
      ...clone(input), updated_at: input.created_at,
      published_at: null, published_by_snapshot: ''
    };
    this.store.versions.set(row.id, row);
    return clone(row);
  }

  async updateDraft(id, schema, updatedAt) {
    const row = this.store.versions.get(id);
    if (!row || row.status !== 'draft') return null;
    Object.assign(row, {
      template_schema: clone(schema), width_mm: schema.canvas.widthMm,
      height_mm: schema.canvas.heightMm, dpi: schema.canvas.dpi,
      schema_version: schema.schemaVersion, updated_at: updatedAt
    });
    return clone(row);
  }

  async touchTemplate(id, updatedAt) {
    const row = this.store.templates.get(id);
    if (row) row.updated_at = updatedAt;
  }

  async publishVersion(id, operator, publishedAt) {
    const row = this.store.versions.get(id);
    if (!row || row.status !== 'draft') return null;
    Object.assign(row, {
      status: 'published', published_at: publishedAt,
      published_by_operator_id: operator.operatorId,
      published_by_snapshot: operator.username, updated_at: publishedAt
    });
    return clone(row);
  }

  async setCurrentPublishedVersion(templateId, versionId, updatedAt) {
    const row = this.store.templates.get(templateId);
    if (!row) return null;
    Object.assign(row, {
      status: 'published', current_published_version_id: versionId, updated_at: updatedAt
    });
    return clone(row);
  }

  async archiveTemplate(templateId, archivedAt) {
    const row = this.store.templates.get(templateId);
    if (!row || row.status === 'archived') return null;
    Object.assign(row, { status: 'archived', archived_at: archivedAt, updated_at: archivedAt });
    return this.templateView(row);
  }

  async listAssets(templateId) {
    return [...this.store.assets.values()]
      .filter((asset) => asset.template_id === templateId).map(clone);
  }

  async insertAsset(input) {
    const row = clone(input);
    this.store.assets.set(row.id, row);
    return clone(row);
  }

  async appendAudit(input) {
    this.store.audits.push(clone(input));
  }
}

function serviceFixture() {
  const store = createStore();
  let clockIndex = 0;
  let uuidIndex = 0;
  const service = createLabelTemplateService({
    pool: { connect() {} },
    repositoryType: MemoryLabelTemplateRepository,
    transactionRunner: async (_pool, callback) => callback(store),
    clock: () => new Date(Date.UTC(2026, 8, 1, 0, 0, clockIndex++)),
    uuid: () => `00000000-0000-4000-8000-${String(++uuidIndex).padStart(12, '0')}`,
    readAssetBuffer: async () => Buffer.from('asset')
  });
  return { service, store };
}

test('template lifecycle preserves published versions and requires a new draft', async () => {
  const { service, store } = serviceFixture();
  const actor = { operatorId: 7, username: 'admin' };
  const created = await service.createTemplate({ name: '80x20 默认款', actor });
  assert.equal(created.template.status, 'draft');
  assert.equal(created.draft.version_number, 1);

  const schema = defaultLabelTemplateSchema();
  const legacyQr = schema.elements.find((element) => element.type === 'qr');
  const legacyId = schema.elements.find((element) => element.type === 'id');
  Object.assign(legacyQr, { xMm: 2, yMm: 2, widthMm: 16, heightMm: 16 });
  Object.assign(legacyId, {
    xMm: 1.5, yMm: 18.8, widthMm: 17, heightMm: 3.6,
    fontSizePt: 8, linkedToQr: false
  });
  schema.elements.find((element) => element.id === 'prompt').text = '第一版提示';
  await service.saveDraft({ templateId: created.template.id, schema, actor });
  const published = await service.publish({ templateId: created.template.id, actor });
  assert.equal(published.status, 'published');
  assert.equal(published.template_schema.elements.find((item) => item.id === 'prompt').text,
    '第一版提示');

  await assert.rejects(
    service.saveDraft({ templateId: created.template.id, schema, actor }),
    (error) => error instanceof LabelTemplateServiceError
      && error.code === 'TEMPLATE_DRAFT_NOT_FOUND'
  );
  const second = await service.createVersion({ templateId: created.template.id, actor });
  assert.equal(second.version_number, 2);
  assert.equal(second.template_schema.elements.find((item) => item.type === 'qr').widthMm, 17);
  assert.equal(second.template_schema.elements.find((item) => item.type === 'id').yMm, 19.1);
  assert.equal(second.template_schema.elements.find((item) => item.type === 'id').fontSizePt, 6.5);
  assert.equal(second.template_schema.elements.find((item) => item.type === 'id').linkedToQr, true);
  second.template_schema.elements.find((item) => item.id === 'prompt').text = '本地篡改';
  const original = store.versions.get(published.id);
  assert.equal(original.template_schema.elements.find((item) => item.id === 'prompt').text,
    '第一版提示');
  assert.equal(original.template_schema.elements.find((item) => item.type === 'qr').widthMm, 16);
  assert.equal(original.template_schema.elements.find((item) => item.type === 'id').linkedToQr, false);
});

test('copy remaps private assets and archived templates reject edits', async () => {
  const { service, store } = serviceFixture();
  const actor = { operatorId: 7, username: 'admin' };
  const created = await service.createTemplate({ name: '带图款', actor });
  const asset = await service.registerAsset({
    templateId: created.template.id,
    assetId: '10000000-0000-4000-8000-000000000001',
    assetType: 'logo', objectKey: 'private/logo.jpg', mimeType: 'image/jpeg',
    pixelWidth: 2400, pixelHeight: 2400, sizeBytes: 1024, actor
  });
  const schema = defaultLabelTemplateSchema();
  schema.elements.push({
    id: 'logo-1', type: 'image', assetId: asset.id, fit: 'contain',
    xMm: 2, yMm: 35, widthMm: 4, heightMm: 4, zIndex: 8
  });
  await service.saveDraft({ templateId: created.template.id, schema, actor });
  const copied = await service.copyTemplate({
    templateId: created.template.id, name: '带图款副本', actor
  });
  const copiedAssets = [...store.assets.values()].filter(
    (item) => item.template_id === copied.template_id
  );
  assert.equal(copiedAssets.length, 1);
  assert.notEqual(copiedAssets[0].id, asset.id);
  assert.equal(copied.draft.template_schema.elements.find(
    (item) => item.id === 'logo-1'
  ).assetId, copiedAssets[0].id);

  await service.archive({ templateId: copied.template_id, actor });
  await assert.rejects(
    service.saveDraft({ templateId: copied.template_id, schema, actor }),
    (error) => error instanceof LabelTemplateServiceError && error.code === 'TEMPLATE_ARCHIVED'
  );
});
