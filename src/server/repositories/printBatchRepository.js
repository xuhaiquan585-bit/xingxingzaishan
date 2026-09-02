'use strict';

const { assertTransactionContext, executeQuery, oneOrNull } = require('./query');

class PrintBatchRepository {
  constructor(transactionContext) {
    this.transactionContext = assertTransactionContext(transactionContext);
  }

  async list(input = {}) {
    const params = [];
    const where = [];
    if (input.status) {
      params.push(input.status);
      where.push(`batch.status = $${params.length}`);
    }
    if (input.search) {
      params.push(`${input.search}%`);
      where.push(`(batch.id LIKE $${params.length} OR batch.name ILIKE $${params.length})`);
    }
    const result = await executeQuery(
      this.transactionContext,
      `SELECT batch.*, template.name AS template_name,
         version.version_number AS template_version_number
       FROM app.print_batches batch
       JOIN app.label_template_versions version ON version.id = batch.template_version_id
       JOIN app.label_templates template ON template.id = version.template_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY batch.created_at DESC, batch.id DESC
       LIMIT 200`,
      params
    );
    return result.rows;
  }

  async find(batchId, { forUpdate = false } = {}) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT batch.*, template.name AS template_name,
         version.version_number AS template_version_number,
         version.template_id, version.template_schema
       FROM app.print_batches batch
       JOIN app.label_template_versions version ON version.id = batch.template_version_id
       JOIN app.label_templates template ON template.id = version.template_id
       WHERE batch.id = $1${forUpdate ? ' FOR UPDATE OF batch' : ''}`,
      [batchId]
    );
    return oneOrNull(result, (row) => row);
  }

  async findByIdempotencyKey(idempotencyKey) {
    const result = await executeQuery(
      this.transactionContext,
      'SELECT * FROM app.print_batches WHERE idempotency_key = $1',
      [idempotencyKey]
    );
    return oneOrNull(result, (row) => row);
  }

  async findPublishedTemplateVersion(versionId) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT version.*, template.name AS template_name,
         template.status AS template_status
       FROM app.label_template_versions version
       JOIN app.label_templates template ON template.id = version.template_id
       WHERE version.id = $1 AND version.status = 'published'
       FOR KEY SHARE OF version, template`,
      [versionId]
    );
    return oneOrNull(result, (row) => row);
  }

  async lockQrCodes(qrIds) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT id, issue_status, lifecycle_status, batch_id, print_batch_id,
         print_status, access_token
       FROM app.qr_codes
       WHERE id = ANY($1::text[])
       ORDER BY id
       FOR UPDATE`,
      [qrIds]
    );
    return result.rows;
  }

  async insert(input) {
    const result = await executeQuery(
      this.transactionContext,
      `INSERT INTO app.print_batches
         (id, name, template_version_id, status, qr_count, vendor_name, note,
          idempotency_key, created_by_operator_id, created_by_snapshot,
          created_at, updated_at)
       VALUES ($1, $2, $3, 'reserved', $4, $5, $6, $7, $8, $9, $10, $10)
       RETURNING *`,
      [input.id, input.name, input.template_version_id, input.qr_count,
        input.vendor_name, input.note, input.idempotency_key,
        input.created_by_operator_id, input.created_by_snapshot, input.created_at]
    );
    return oneOrNull(result, (row) => row);
  }

  async reserveQrCodes(batchId, qrIds, updatedAt) {
    const result = await executeQuery(
      this.transactionContext,
      `UPDATE app.qr_codes
       SET print_batch_id = $1, print_status = 'reserved',
           print_status_updated_at = $3, updated_at = $3
       WHERE id = ANY($2::text[])
         AND print_status = 'available' AND print_batch_id IS NULL
       RETURNING id`,
      [batchId, qrIds, updatedAt]
    );
    return result.rows.map((row) => row.id);
  }

  async listQrCodes(batchId, { forUpdate = false } = {}) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT qr.id, qr.batch_id, qr.print_status, qr.print_void_reason,
         qr.access_token, qr.issue_status, qr.lifecycle_status
       FROM app.qr_codes qr
       WHERE qr.print_batch_id = $1
       ORDER BY qr.id${forUpdate ? ' FOR UPDATE OF qr' : ''}`,
      [batchId]
    );
    return result.rows;
  }

  async listLegacyQrCodes(input = {}) {
    const params = [];
    const where = ["qr.print_status = 'legacy_unclassified'"];
    if (input.sourceBatchId) {
      params.push(input.sourceBatchId);
      where.push(`qr.batch_id = $${params.length}`);
    }
    if (input.idPrefix) {
      params.push(`${input.idPrefix}%`);
      where.push(`qr.id LIKE $${params.length}`);
    }
    params.push(input.limit || 500);
    const result = await executeQuery(
      this.transactionContext,
      `SELECT qr.id, qr.batch_id, qr.issue_status, qr.lifecycle_status,
         qr.print_status, qr.print_status_updated_at, qr.created_at
       FROM app.qr_codes qr
       WHERE ${where.join(' AND ')}
       ORDER BY qr.batch_id NULLS FIRST, qr.id
       LIMIT $${params.length}`,
      params
    );
    return result.rows;
  }

  async classifyLegacyQrCodes(qrIds, targetStatus, reason, updatedAt) {
    const result = await executeQuery(
      this.transactionContext,
      `UPDATE app.qr_codes
       SET print_status = $2::varchar,
           print_void_reason = CASE WHEN $2::varchar = 'voided'::varchar THEN $3 ELSE '' END,
           print_status_updated_at = $4, updated_at = $4
       WHERE id = ANY($1::text[]) AND print_status = 'legacy_unclassified'
       RETURNING id`,
      [qrIds, targetStatus, reason, updatedAt]
    );
    return result.rows.map((row) => row.id);
  }

  async listTemplateAssets(templateId) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT * FROM app.label_template_assets
       WHERE template_id = $1 ORDER BY created_at, id`,
      [templateId]
    );
    return result.rows;
  }

  async startGeneration(batchId, updatedAt) {
    const result = await executeQuery(
      this.transactionContext,
      `UPDATE app.print_batches
       SET status = 'generating', generation_attempt_count = generation_attempt_count + 1,
           generation_error_code = '', updated_at = $2
       WHERE id = $1 AND status IN ('reserved', 'generation_failed')
       RETURNING *`,
      [batchId, updatedAt]
    );
    return oneOrNull(result, (row) => row);
  }

  async failGeneration(batchId, errorCode, updatedAt) {
    const result = await executeQuery(
      this.transactionContext,
      `UPDATE app.print_batches
       SET status = 'generation_failed', generation_error_code = $2, updated_at = $3
       WHERE id = $1 AND status = 'generating'
       RETURNING *`,
      [batchId, errorCode, updatedAt]
    );
    return oneOrNull(result, (row) => row);
  }

  async completeArtifact(batchId, artifact, updatedAt) {
    const result = await executeQuery(
      this.transactionContext,
      `UPDATE app.print_batches
       SET status = 'artifact_ready', artifact_object_key = $2,
           artifact_sha256 = $3, artifact_size_bytes = $4,
           generated_at = $5, generation_error_code = '', updated_at = $5
       WHERE id = $1 AND status = 'generating'
       RETURNING *`,
      [batchId, artifact.objectKey, artifact.sha256, artifact.size, updatedAt]
    );
    return oneOrNull(result, (row) => row);
  }

  async markQrArtifactGenerated(batchId, updatedAt) {
    const result = await executeQuery(
      this.transactionContext,
      `UPDATE app.qr_codes
       SET print_status = 'artifact_generated', print_status_updated_at = $2,
           updated_at = $2
       WHERE print_batch_id = $1 AND print_status = 'reserved'
       RETURNING id`,
      [batchId, updatedAt]
    );
    return result.rows.map((row) => row.id);
  }

  async cancel(batchId, updatedAt) {
    const result = await executeQuery(
      this.transactionContext,
      `UPDATE app.print_batches
       SET status = 'canceled', canceled_at = $2, updated_at = $2
       WHERE id = $1 AND status IN ('reserved', 'generation_failed')
       RETURNING *`,
      [batchId, updatedAt]
    );
    return oneOrNull(result, (row) => row);
  }

  async releaseQrCodes(batchId, updatedAt) {
    const result = await executeQuery(
      this.transactionContext,
      `UPDATE app.qr_codes
       SET print_batch_id = NULL, print_status = 'available',
           print_status_updated_at = $2, updated_at = $2
       WHERE print_batch_id = $1 AND print_status = 'reserved'
       RETURNING id`,
      [batchId, updatedAt]
    );
    return result.rows.map((row) => row.id);
  }

  async recordDownload(batchId, actorSnapshot, updatedAt) {
    const result = await executeQuery(
      this.transactionContext,
      `UPDATE app.print_batches
       SET download_count = download_count + 1,
           first_downloaded_at = coalesce(first_downloaded_at, $3),
           last_downloaded_at = $3, last_downloaded_by_snapshot = $2,
           updated_at = $3
       WHERE id = $1 AND status IN ('artifact_ready', 'printing', 'completed')
       RETURNING *`,
      [batchId, actorSnapshot, updatedAt]
    );
    return oneOrNull(result, (row) => row);
  }

  async transition(batchId, fromStatuses, status, timestampColumn, updatedAt, reason = '') {
    const result = await executeQuery(
      this.transactionContext,
      `UPDATE app.print_batches
       SET status = $3::varchar, ${timestampColumn} = $4, updated_at = $4,
           void_reason = CASE WHEN $3::varchar = 'voided'::varchar THEN $5 ELSE void_reason END
       WHERE id = $1 AND status = ANY($2::text[])
       RETURNING *`,
      [batchId, fromStatuses, status, updatedAt, reason]
    );
    return oneOrNull(result, (row) => row);
  }

  async markQrPrinted(batchId, updatedAt) {
    const result = await executeQuery(
      this.transactionContext,
      `UPDATE app.qr_codes
       SET print_status = 'printed', print_status_updated_at = $2, updated_at = $2
       WHERE print_batch_id = $1 AND print_status = 'artifact_generated'
       RETURNING id`,
      [batchId, updatedAt]
    );
    return result.rows.map((row) => row.id);
  }

  async voidQrCodes(batchId, qrIds, reason, updatedAt) {
    const result = await executeQuery(
      this.transactionContext,
      `UPDATE app.qr_codes
       SET print_status = 'voided', print_void_reason = $3,
           print_status_updated_at = $4, updated_at = $4
       WHERE print_batch_id = $1 AND id = ANY($2::text[])
         AND print_status IN ('artifact_generated', 'printed')
       RETURNING id`,
      [batchId, qrIds, reason, updatedAt]
    );
    return result.rows.map((row) => row.id);
  }

  async appendAudit(event) {
    await executeQuery(
      this.transactionContext,
      `INSERT INTO app.audit_events
         (actor_type, actor_reference, action, entity_type, entity_id,
          result_status, metadata, created_at)
       VALUES ('operator', $1, $2, $3, $4, 'success', $5::jsonb, $6)`,
      [event.actor, event.action, event.entityType || 'print_batch', event.entityId,
        JSON.stringify(event.metadata || {}), event.createdAt]
    );
  }
}

module.exports = { PrintBatchRepository };
