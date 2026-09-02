'use strict';

const crypto = require('node:crypto');
const {
  defaultLabelTemplateSchema,
  synchronizeQrIdComponent,
  validateTemplateSchema
} = require('../labelTemplateSchema');
const { renderLabelPreview } = require('../labelRenderer');

class LabelTemplateServiceError extends Error {
  constructor(code) {
    super(code);
    this.name = 'LabelTemplateServiceError';
    this.code = code;
  }
}

function actor(input = {}) {
  return Object.freeze({
    operatorId: Number.isSafeInteger(Number(input.operatorId)) ? Number(input.operatorId) : null,
    username: String(input.username || '').trim() || 'admin'
  });
}

function templateName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 160) throw new LabelTemplateServiceError('TEMPLATE_NAME_INVALID');
  return name;
}

function assetSummary(row) {
  return Object.freeze({
    id: row.id,
    asset_type: row.asset_type,
    mime_type: row.mime_type,
    pixel_width: Number(row.pixel_width),
    pixel_height: Number(row.pixel_height),
    size_bytes: Number(row.size_bytes),
    created_at: row.created_at
  });
}

function versionSummary(row, { includeSchema = true } = {}) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    template_id: row.template_id,
    version_number: Number(row.version_number),
    status: row.status,
    width_mm: Number(row.width_mm),
    height_mm: Number(row.height_mm),
    dpi: Number(row.dpi),
    schema_version: Number(row.schema_version),
    ...(includeSchema ? { template_schema: row.template_schema } : {}),
    created_by: row.created_by_snapshot || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
    published_by: row.published_by_snapshot || '',
    published_at: row.published_at
  });
}

function templateSummary(row) {
  return Object.freeze({
    id: row.id,
    name: row.name,
    status: row.status,
    current_published_version_id: row.current_published_version_id,
    current_published_version_number: row.current_published_version_number
      ? Number(row.current_published_version_number) : null,
    draft_version_id: row.draft_version_id || null,
    draft_version_number: row.draft_version_number ? Number(row.draft_version_number) : null,
    print_batch_count: Number(row.print_batch_count || 0),
    created_by: row.created_by_snapshot || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at
  });
}

function schemaWithRemappedAssets(schema, assetIdMap) {
  const copy = JSON.parse(JSON.stringify(schema));
  copy.elements = copy.elements.map((element) => (
    element.assetId && assetIdMap.has(element.assetId)
      ? { ...element, assetId: assetIdMap.get(element.assetId) }
      : element
  ));
  return copy;
}

function createLabelTemplateService({
  pool,
  transactionRunner,
  repositoryType,
  beforeOperation,
  readAssetBuffer,
  clock = () => new Date(),
  uuid = () => crypto.randomUUID()
} = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new LabelTemplateServiceError('POSTGRES_POOL_REQUIRED');
  }
  const runTransaction = transactionRunner
    || require('../../database/transaction').withTransaction;
  const Repository = repositoryType
    || require('../../repositories').LabelTemplateRepository;
  const assetReader = readAssetBuffer
    || require('../storageService').readObjectBuffer;

  async function run(operation, callback, { readOnly = false } = {}) {
    return runTransaction(pool, async (transactionContext) => {
      if (typeof beforeOperation === 'function') {
        await beforeOperation({ transactionContext, operation });
      }
      return callback(new Repository(transactionContext));
    }, { isolationLevel: 'read committed', readOnly });
  }

  function timestamp() {
    const value = clock();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  }

  async function audit(repository, action, entityId, operator, metadata = {}) {
    await repository.appendAudit({
      actor: operator.username,
      action,
      entityType: 'label_template',
      entityId,
      metadata,
      createdAt: timestamp()
    });
  }

  async function createTemplate(input = {}) {
    const name = templateName(input.name);
    const operator = actor(input.actor);
    const schema = validateTemplateSchema(input.schema || defaultLabelTemplateSchema());
    return run('create_template', async (repository) => {
      const now = timestamp();
      const templateId = uuid();
      const versionId = uuid();
      const template = await repository.insertTemplate({
        id: templateId,
        name,
        status: 'draft',
        created_by_operator_id: operator.operatorId,
        created_by_snapshot: operator.username,
        created_at: now
      });
      const version = await repository.insertVersion({
        id: versionId,
        template_id: templateId,
        version_number: 1,
        status: 'draft',
        width_mm: schema.canvas.widthMm,
        height_mm: schema.canvas.heightMm,
        dpi: schema.canvas.dpi,
        schema_version: schema.schemaVersion,
        template_schema: schema,
        created_by_operator_id: operator.operatorId,
        created_by_snapshot: operator.username,
        created_at: now
      });
      await audit(repository, 'label_template_created', templateId, operator, { version: 1 });
      return Object.freeze({ template: templateSummary(template), draft: versionSummary(version) });
    });
  }

  async function listTemplates() {
    return run(
      'list_templates',
      async (repository) => Object.freeze((await repository.listTemplates()).map(templateSummary)),
      { readOnly: true }
    );
  }

  async function getTemplate(input = {}) {
    const templateId = String(input.templateId || '').trim();
    return run('get_template', async (repository) => {
      const template = await repository.findTemplate(templateId);
      if (!template) return null;
      const versions = await repository.listVersions(templateId);
      const assets = await repository.listAssets(templateId);
      return Object.freeze({
        template: templateSummary(template),
        versions: Object.freeze(versions.map(versionSummary)),
        assets: Object.freeze(assets.map(assetSummary))
      });
    }, { readOnly: true });
  }

  async function saveDraft(input = {}) {
    const templateId = String(input.templateId || '').trim();
    const operator = actor(input.actor);
    return run('save_template_draft', async (repository) => {
      const template = await repository.findTemplate(templateId, { forUpdate: true });
      if (!template) throw new LabelTemplateServiceError('TEMPLATE_NOT_FOUND');
      if (template.status === 'archived') throw new LabelTemplateServiceError('TEMPLATE_ARCHIVED');
      const draft = await repository.findDraft(templateId, { forUpdate: true });
      if (!draft) throw new LabelTemplateServiceError('TEMPLATE_DRAFT_NOT_FOUND');
      const schema = validateTemplateSchema(synchronizeQrIdComponent(input.schema));
      const now = timestamp();
      const saved = await repository.updateDraft(draft.id, schema, now);
      if (!saved) throw new LabelTemplateServiceError('TEMPLATE_DRAFT_NOT_FOUND');
      await repository.touchTemplate(templateId, now);
      await audit(repository, 'label_template_draft_saved', templateId, operator, {
        version: Number(saved.version_number)
      });
      return versionSummary(saved);
    });
  }

  async function createVersion(input = {}) {
    const templateId = String(input.templateId || '').trim();
    const operator = actor(input.actor);
    return run('create_template_version', async (repository) => {
      const template = await repository.findTemplate(templateId, { forUpdate: true });
      if (!template) throw new LabelTemplateServiceError('TEMPLATE_NOT_FOUND');
      if (template.status !== 'published') throw new LabelTemplateServiceError('TEMPLATE_NOT_PUBLISHED');
      if (await repository.findDraft(templateId, { forUpdate: true })) {
        throw new LabelTemplateServiceError('TEMPLATE_DRAFT_ALREADY_EXISTS');
      }
      const source = await repository.findVersion(template.current_published_version_id);
      if (!source || source.status !== 'published') {
        throw new LabelTemplateServiceError('TEMPLATE_PUBLISHED_VERSION_INVALID');
      }
      const schema = validateTemplateSchema(synchronizeQrIdComponent(
        source.template_schema,
        { upgradeStandardQr: true }
      ));
      const now = timestamp();
      const version = await repository.insertVersion({
        id: uuid(),
        template_id: templateId,
        version_number: await repository.nextVersionNumber(templateId),
        status: 'draft',
        width_mm: Number(schema.canvas.widthMm),
        height_mm: Number(schema.canvas.heightMm),
        dpi: Number(schema.canvas.dpi),
        schema_version: Number(schema.schemaVersion),
        template_schema: schema,
        created_by_operator_id: operator.operatorId,
        created_by_snapshot: operator.username,
        created_at: now
      });
      await repository.touchTemplate(templateId, now);
      await audit(repository, 'label_template_version_created', templateId, operator, {
        version: Number(version.version_number)
      });
      return versionSummary(version);
    });
  }

  async function copyTemplate(input = {}) {
    const sourceTemplateId = String(input.templateId || '').trim();
    const name = templateName(input.name);
    const operator = actor(input.actor);
    return run('copy_template', async (repository) => {
      const sourceTemplate = await repository.findTemplate(sourceTemplateId, { forUpdate: true });
      if (!sourceTemplate) throw new LabelTemplateServiceError('TEMPLATE_NOT_FOUND');
      const sourceVersion = await repository.findDraft(sourceTemplateId)
        || (sourceTemplate.current_published_version_id
          ? await repository.findVersion(sourceTemplate.current_published_version_id) : null);
      if (!sourceVersion) throw new LabelTemplateServiceError('TEMPLATE_SOURCE_VERSION_NOT_FOUND');
      const now = timestamp();
      const newTemplateId = uuid();
      const assetIdMap = new Map();
      const sourceAssets = await repository.listAssets(sourceTemplateId);
      await repository.insertTemplate({
        id: newTemplateId,
        name,
        status: 'draft',
        created_by_operator_id: operator.operatorId,
        created_by_snapshot: operator.username,
        created_at: now
      });
      for (const sourceAsset of sourceAssets) {
        const newAssetId = uuid();
        assetIdMap.set(sourceAsset.id, newAssetId);
        await repository.insertAsset({
          ...sourceAsset,
          id: newAssetId,
          template_id: newTemplateId,
          created_by_operator_id: operator.operatorId,
          created_by_snapshot: operator.username,
          created_at: now
        });
      }
      const schema = schemaWithRemappedAssets(sourceVersion.template_schema, assetIdMap);
      const version = await repository.insertVersion({
        id: uuid(), template_id: newTemplateId, version_number: 1, status: 'draft',
        width_mm: Number(sourceVersion.width_mm), height_mm: Number(sourceVersion.height_mm),
        dpi: Number(sourceVersion.dpi), schema_version: Number(sourceVersion.schema_version),
        template_schema: schema, created_by_operator_id: operator.operatorId,
        created_by_snapshot: operator.username, created_at: now
      });
      await audit(repository, 'label_template_copied', newTemplateId, operator, {
        source_template_id: sourceTemplateId
      });
      return Object.freeze({ template_id: newTemplateId, draft: versionSummary(version) });
    });
  }

  async function assetMaps(repository, templateId, { includeBuffers = false } = {}) {
    const rows = await repository.listAssets(templateId);
    const metadata = new Map(rows.map((row) => [row.id, {
      pixelWidth: Number(row.pixel_width),
      pixelHeight: Number(row.pixel_height)
    }]));
    if (!includeBuffers) return { rows, metadata };
    const buffers = new Map();
    for (const row of rows) {
      const buffer = await assetReader(row.object_key);
      if (!buffer) throw new LabelTemplateServiceError('TEMPLATE_ASSET_READ_FAILED');
      buffers.set(row.id, {
        buffer,
        pixelWidth: Number(row.pixel_width),
        pixelHeight: Number(row.pixel_height)
      });
    }
    return { rows, metadata, buffers };
  }

  async function preview(input = {}) {
    const templateId = String(input.templateId || '').trim();
    return run('preview_template', async (repository) => {
      const template = await repository.findTemplate(templateId);
      if (!template) throw new LabelTemplateServiceError('TEMPLATE_NOT_FOUND');
      const version = input.versionId
        ? await repository.findVersion(String(input.versionId))
        : await repository.findDraft(templateId)
          || await repository.findVersion(template.current_published_version_id);
      if (!version || version.template_id !== templateId) {
        throw new LabelTemplateServiceError('TEMPLATE_VERSION_NOT_FOUND');
      }
      const assets = await assetMaps(repository, templateId, { includeBuffers: true });
      const schema = validateTemplateSchema(input.schema || version.template_schema, {
        assets: assets.metadata,
        requireAssets: true
      });
      const rendered = await renderLabelPreview({
        template: schema,
        qrId: String(input.qrId || 'SSS00001').trim().toUpperCase(),
        qrPayload: 'https://xingxingzaishan.top/q/template-preview-not-a-live-token',
        assets: assets.buffers,
        requireAssets: true
      });
      return rendered.buffer;
    }, { readOnly: true });
  }

  async function publish(input = {}) {
    const templateId = String(input.templateId || '').trim();
    const operator = actor(input.actor);
    return run('publish_template', async (repository) => {
      const template = await repository.findTemplate(templateId, { forUpdate: true });
      if (!template) throw new LabelTemplateServiceError('TEMPLATE_NOT_FOUND');
      if (template.status === 'archived') throw new LabelTemplateServiceError('TEMPLATE_ARCHIVED');
      const draft = await repository.findDraft(templateId, { forUpdate: true });
      if (!draft) throw new LabelTemplateServiceError('TEMPLATE_DRAFT_NOT_FOUND');
      const assets = await assetMaps(repository, templateId, { includeBuffers: true });
      const schema = validateTemplateSchema(draft.template_schema, {
        assets: assets.metadata,
        requireAssets: true
      });
      await renderLabelPreview({
        template: schema,
        qrId: 'SSS00001',
        qrPayload: 'https://xingxingzaishan.top/q/template-publish-check-not-live',
        assets: assets.buffers,
        requireAssets: true
      });
      const now = timestamp();
      const published = await repository.publishVersion(draft.id, operator, now);
      if (!published) throw new LabelTemplateServiceError('TEMPLATE_DRAFT_NOT_FOUND');
      if (!(await repository.setCurrentPublishedVersion(templateId, published.id, now))) {
        throw new LabelTemplateServiceError('TEMPLATE_PUBLISH_FAILED');
      }
      await audit(repository, 'label_template_published', templateId, operator, {
        version: Number(published.version_number)
      });
      return versionSummary(published);
    });
  }

  async function archive(input = {}) {
    const templateId = String(input.templateId || '').trim();
    const operator = actor(input.actor);
    return run('archive_template', async (repository) => {
      if (!(await repository.findTemplate(templateId, { forUpdate: true }))) {
        throw new LabelTemplateServiceError('TEMPLATE_NOT_FOUND');
      }
      const archived = await repository.archiveTemplate(templateId, timestamp());
      if (!archived) throw new LabelTemplateServiceError('TEMPLATE_ALREADY_ARCHIVED');
      await audit(repository, 'label_template_archived', templateId, operator);
      return templateSummary(archived);
    });
  }

  async function registerAsset(input = {}) {
    const templateId = String(input.templateId || '').trim();
    const operator = actor(input.actor);
    const assetType = String(input.assetType || '').trim();
    if (!['logo', 'background'].includes(assetType)) {
      throw new LabelTemplateServiceError('TEMPLATE_ASSET_TYPE_INVALID');
    }
    return run('register_template_asset', async (repository) => {
      const template = await repository.findTemplate(templateId, { forUpdate: true });
      if (!template) throw new LabelTemplateServiceError('TEMPLATE_NOT_FOUND');
      if (template.status === 'archived') throw new LabelTemplateServiceError('TEMPLATE_ARCHIVED');
      const row = await repository.insertAsset({
        id: input.assetId,
        template_id: templateId,
        asset_type: assetType,
        object_key: input.objectKey,
        mime_type: input.mimeType,
        pixel_width: input.pixelWidth,
        pixel_height: input.pixelHeight,
        size_bytes: input.sizeBytes,
        created_by_operator_id: operator.operatorId,
        created_by_snapshot: operator.username,
        created_at: timestamp()
      });
      await audit(repository, 'label_template_asset_uploaded', templateId, operator, {
        asset_id: row.id,
        asset_type: row.asset_type
      });
      return assetSummary(row);
    });
  }

  async function readAsset(input = {}) {
    const templateId = String(input.templateId || '').trim();
    const assetId = String(input.assetId || '').trim();
    return run('read_template_asset', async (repository) => {
      if (!(await repository.findTemplate(templateId))) {
        throw new LabelTemplateServiceError('TEMPLATE_NOT_FOUND');
      }
      const asset = (await repository.listAssets(templateId))
        .find((row) => String(row.id) === assetId);
      if (!asset) throw new LabelTemplateServiceError('TEMPLATE_ASSET_NOT_FOUND');
      const buffer = await assetReader(asset.object_key);
      if (!buffer) throw new LabelTemplateServiceError('TEMPLATE_ASSET_READ_FAILED');
      return Object.freeze({ buffer, mimeType: asset.mime_type });
    }, { readOnly: true });
  }

  return Object.freeze({
    archive,
    copyTemplate,
    createTemplate,
    createVersion,
    getTemplate,
    listTemplates,
    preview,
    publish,
    readAsset,
    registerAsset,
    saveDraft
  });
}

module.exports = {
  LabelTemplateServiceError,
  createLabelTemplateService,
  schemaWithRemappedAssets,
  templateSummary,
  versionSummary
};
