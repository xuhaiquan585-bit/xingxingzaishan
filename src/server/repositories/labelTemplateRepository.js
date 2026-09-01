'use strict';

const { assertTransactionContext, executeQuery, oneOrNull } = require('./query');

class LabelTemplateRepository {
  constructor(transactionContext) {
    this.transactionContext = assertTransactionContext(transactionContext);
  }

  async listTemplates() {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT
         template.*,
         published.version_number AS current_published_version_number,
         draft.id AS draft_version_id,
         draft.version_number AS draft_version_number,
         count(batch.id)::integer AS print_batch_count
       FROM app.label_templates template
       LEFT JOIN app.label_template_versions published
         ON published.id = template.current_published_version_id
       LEFT JOIN app.label_template_versions draft
         ON draft.template_id = template.id AND draft.status = 'draft'
       LEFT JOIN app.print_batches batch
         ON batch.template_version_id = published.id
       GROUP BY template.id, published.version_number, draft.id, draft.version_number
       ORDER BY template.updated_at DESC, template.name`
    );
    return result.rows;
  }

  async findTemplate(templateId, { forUpdate = false } = {}) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT template.*,
         (SELECT version_number FROM app.label_template_versions
          WHERE id = template.current_published_version_id)
           AS current_published_version_number,
         (SELECT id FROM app.label_template_versions
          WHERE template_id = template.id AND status = 'draft') AS draft_version_id,
         (SELECT version_number FROM app.label_template_versions
          WHERE template_id = template.id AND status = 'draft') AS draft_version_number,
         (SELECT count(*)::integer FROM app.print_batches
          WHERE template_version_id = template.current_published_version_id) AS print_batch_count
       FROM app.label_templates template
       WHERE template.id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [templateId]
    );
    return oneOrNull(result, (row) => row);
  }

  async listVersions(templateId) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT * FROM app.label_template_versions
       WHERE template_id = $1
       ORDER BY version_number DESC`,
      [templateId]
    );
    return result.rows;
  }

  async findVersion(versionId, { forUpdate = false } = {}) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT * FROM app.label_template_versions WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [versionId]
    );
    return oneOrNull(result, (row) => row);
  }

  async findDraft(templateId, { forUpdate = false } = {}) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT * FROM app.label_template_versions
       WHERE template_id = $1 AND status = 'draft'${forUpdate ? ' FOR UPDATE' : ''}`,
      [templateId]
    );
    return oneOrNull(result, (row) => row);
  }

  async nextVersionNumber(templateId) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT coalesce(max(version_number), 0)::integer + 1 AS next_version
       FROM app.label_template_versions WHERE template_id = $1`,
      [templateId]
    );
    return Number(result.rows[0].next_version);
  }

  async insertTemplate(row) {
    const result = await executeQuery(
      this.transactionContext,
      `INSERT INTO app.label_templates
         (id, name, status, created_by_operator_id, created_by_snapshot,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       RETURNING *`,
      [row.id, row.name, row.status, row.created_by_operator_id,
        row.created_by_snapshot, row.created_at]
    );
    return oneOrNull(result, (value) => value);
  }

  async insertVersion(row) {
    const result = await executeQuery(
      this.transactionContext,
      `INSERT INTO app.label_template_versions
         (id, template_id, version_number, status, width_mm, height_mm, dpi,
          schema_version, template_schema, created_by_operator_id,
          created_by_snapshot, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $12)
       RETURNING *`,
      [row.id, row.template_id, row.version_number, row.status, row.width_mm,
        row.height_mm, row.dpi, row.schema_version, JSON.stringify(row.template_schema),
        row.created_by_operator_id, row.created_by_snapshot, row.created_at]
    );
    return oneOrNull(result, (value) => value);
  }

  async updateDraft(versionId, schema, updatedAt) {
    const result = await executeQuery(
      this.transactionContext,
      `UPDATE app.label_template_versions
       SET width_mm = $2, height_mm = $3, dpi = $4,
           schema_version = $5, template_schema = $6::jsonb, updated_at = $7
       WHERE id = $1 AND status = 'draft'
       RETURNING *`,
      [versionId, schema.canvas.widthMm, schema.canvas.heightMm, schema.canvas.dpi,
        schema.schemaVersion, JSON.stringify(schema), updatedAt]
    );
    return oneOrNull(result, (value) => value);
  }

  async touchTemplate(templateId, updatedAt) {
    await executeQuery(
      this.transactionContext,
      'UPDATE app.label_templates SET updated_at = $2 WHERE id = $1',
      [templateId, updatedAt]
    );
  }

  async publishVersion(versionId, actor, publishedAt) {
    const result = await executeQuery(
      this.transactionContext,
      `UPDATE app.label_template_versions
       SET status = 'published', published_by_operator_id = $2,
           published_by_snapshot = $3, published_at = $4, updated_at = $4
       WHERE id = $1 AND status = 'draft'
       RETURNING *`,
      [versionId, actor.operatorId, actor.username, publishedAt]
    );
    return oneOrNull(result, (value) => value);
  }

  async setCurrentPublishedVersion(templateId, versionId, updatedAt) {
    const result = await executeQuery(
      this.transactionContext,
      `UPDATE app.label_templates
       SET status = 'published', current_published_version_id = $2,
           updated_at = $3, archived_at = NULL
       WHERE id = $1 AND status <> 'archived'
       RETURNING *`,
      [templateId, versionId, updatedAt]
    );
    return oneOrNull(result, (value) => value);
  }

  async archiveTemplate(templateId, archivedAt) {
    const result = await executeQuery(
      this.transactionContext,
      `UPDATE app.label_templates
       SET status = 'archived', archived_at = $2, updated_at = $2
       WHERE id = $1 AND status <> 'archived'
       RETURNING *`,
      [templateId, archivedAt]
    );
    return oneOrNull(result, (value) => value);
  }

  async listAssets(templateId) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT * FROM app.label_template_assets
       WHERE template_id = $1 ORDER BY created_at, id`,
      [templateId]
    );
    return result.rows;
  }

  async insertAsset(row) {
    const result = await executeQuery(
      this.transactionContext,
      `INSERT INTO app.label_template_assets
         (id, template_id, asset_type, object_key, mime_type, pixel_width,
          pixel_height, size_bytes, created_by_operator_id, created_by_snapshot,
          created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [row.id, row.template_id, row.asset_type, row.object_key, row.mime_type,
        row.pixel_width, row.pixel_height, row.size_bytes, row.created_by_operator_id,
        row.created_by_snapshot, row.created_at]
    );
    return oneOrNull(result, (value) => value);
  }

  async appendAudit(event) {
    await executeQuery(
      this.transactionContext,
      `INSERT INTO app.audit_events
         (actor_type, actor_reference, action, entity_type, entity_id,
          result_status, metadata, created_at)
       VALUES ('operator', $1, $2, $3, $4, 'success', $5::jsonb, $6)`,
      [event.actor, event.action, event.entityType, event.entityId,
        JSON.stringify(event.metadata || {}), event.createdAt]
    );
  }
}

module.exports = { LabelTemplateRepository };
