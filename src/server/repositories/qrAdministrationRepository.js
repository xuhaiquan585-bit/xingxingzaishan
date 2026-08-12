'use strict';

const { assertTransactionContext, executeQuery } = require('./query');

const ADMIN_QR_SELECT = `
  SELECT
    qr.id, qr.issue_status, qr.lifecycle_status, qr.hidden,
    qr.batch_id, qr.print_batch_id, qr.qr_image_url_snapshot,
    qr.access_token, qr.created_at, qr.updated_at,
    record.content, record.image_url_snapshot, record.image_object_key,
    record.image_sha256, record.phone_snapshot, record.sealed_at,
    record.show_brand_disclosure, record.brand_disclosure_text_snapshot,
    creation.id AS co_creation_id,
    creation.owner_account_id AS co_creation_owner_account_id,
    creation.owner_phone_snapshot AS co_creation_owner_phone,
    creation.started_at AS co_creation_started_at,
    COALESCE(comments.items, '[]'::jsonb) AS co_creation_comments,
    proof.provider AS chain_provider, proof.status AS chain_status,
    proof.operation_id AS chain_operation_id,
    proof.manifest_object_key, proof.manifest_hash,
    proof.legacy_hash_snapshot, proof.transaction_hash AS chain_tx_hash,
    proof.block_height AS chain_block_height,
    proof.provider_record_id AS chain_record_id,
    proof.provider_certificate_url AS chain_certificate_url,
    proof.certificate_object_key AS chain_certificate_object_key,
    proof.certificate_object_url_snapshot AS chain_certificate_object_url,
    proof.confirmed_at AS chain_confirmed_at,
    proof.callback_received_at AS chain_callback_received_at,
    proof.last_error AS chain_last_error,
    proof.retry_count AS chain_retry_count,
    archive.manifest_object_key AS archive_manifest_object_key,
    archive.legacy_manifest_object_key,
    archive.index_object_key AS archive_index_object_key,
    archive.status AS archive_status,
    archive.last_error AS archive_last_error,
    archive.updated_at AS archive_updated_at,
    passed_qc.checked_at AS quality_checked_at,
    passed_qc.checked_by_snapshot AS quality_checked_by
  FROM app.qr_codes qr
  LEFT JOIN app.records record ON record.qr_id = qr.id
  LEFT JOIN app.co_creations creation ON creation.qr_id = qr.id
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
      jsonb_build_object(
        'id', COALESCE(comment.legacy_comment_id, comment.id::text),
        'phone', comment.phone_snapshot,
        'account_id', comment.account_id,
        'author_name', comment.author_name,
        'content', comment.content,
        'status', comment.status,
        'created_at', comment.created_at,
        'deleted_at', comment.deleted_at
      ) ORDER BY comment.source_position ASC
    ) AS items
    FROM app.co_creation_comments comment
    WHERE comment.co_creation_id = creation.id
  ) comments ON true
  LEFT JOIN app.record_proofs proof ON proof.record_qr_id = qr.id
  LEFT JOIN app.record_archives archive ON archive.record_qr_id = qr.id
  LEFT JOIN LATERAL (
    SELECT checked_at, checked_by_snapshot
    FROM app.quality_check_logs
    WHERE qr_id = qr.id AND result = 'pass'
    ORDER BY checked_at DESC, id DESC
    LIMIT 1
  ) passed_qc ON true`;

function rows(result) {
  return result && Array.isArray(result.rows) ? result.rows : [];
}

class QrAdministrationRepository {
  constructor(transactionContext) {
    this.transactionContext = assertTransactionContext(transactionContext);
  }

  async lockBatchDay(dayKey) {
    await executeQuery(
      this.transactionContext,
      "SELECT pg_advisory_xact_lock(hashtext('qr-batch:' || $1))",
      [dayKey]
    );
  }

  async listBatchIdsForDay(dayKey) {
    const result = await executeQuery(
      this.transactionContext,
      'SELECT id FROM app.qr_batches WHERE id LIKE $1 ORDER BY id',
      [`BATCH_${dayKey}_%`]
    );
    return rows(result).map((row) => row.id);
  }

  async insertBatch(batch) {
    const result = await executeQuery(
      this.transactionContext,
      `INSERT INTO app.qr_batches (
         id, name, brand_name, note, disclosure_text,
         show_brand_disclosure_default, created_by_operator_id,
         created_by_snapshot, created_at, updated_at
       )
       VALUES (
         $1, $2, $3, $4, $5, $6,
         (SELECT id FROM app.operators WHERE username = $7 LIMIT 1),
         $7, $8, $8
       )
       RETURNING *`,
      [
        batch.id,
        batch.name,
        batch.brand_name,
        batch.note,
        batch.disclosure_text,
        batch.show_brand_disclosure_default,
        batch.created_by_snapshot,
        batch.created_at
      ]
    );
    return rows(result)[0] || null;
  }

  async listBatches() {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT
         batch.*,
         count(qr.id)::integer AS total_codes,
         count(qr.id) FILTER (
           WHERE qr.lifecycle_status = 'activated'
         )::integer AS activated_codes
       FROM app.qr_batches batch
       LEFT JOIN app.qr_codes qr ON qr.batch_id = batch.id
       GROUP BY batch.id
       ORDER BY batch.created_at DESC, batch.id DESC`
    );
    return rows(result);
  }

  async findBatch(batchId) {
    const result = await executeQuery(
      this.transactionContext,
      'SELECT * FROM app.qr_batches WHERE id = $1',
      [batchId]
    );
    return rows(result)[0] || null;
  }

  async assignBatch(batchId, ids, updatedAt) {
    const result = await executeQuery(
      this.transactionContext,
      `UPDATE app.qr_codes
       SET batch_id = $1, updated_at = $3
       WHERE id = ANY($2::text[])
       RETURNING id`,
      [batchId, ids, updatedAt]
    );
    return rows(result).map((row) => row.id);
  }

  async listAdminRecords(filters, { limit, offset } = {}) {
    const params = [];
    const predicates = [];
    const add = (sql, value) => {
      params.push(value);
      predicates.push(sql.replace('?', `$${params.length}`));
    };

    if (filters.issueStatus) add('qr.issue_status = ?', filters.issueStatus);
    if (filters.activationStatus === 'content') {
      predicates.push("qr.lifecycle_status IN ('activated', 'co_creating')");
    } else if (filters.activationStatus) {
      add('qr.lifecycle_status = ?', filters.activationStatus);
    }
    if (typeof filters.hidden === 'boolean') add('qr.hidden = ?', filters.hidden);
    if (filters.idPrefix) add('upper(qr.id) LIKE ?', `${filters.idPrefix}%`);
    if (filters.batchId) add('qr.batch_id = ?', filters.batchId);
    if (filters.dateFrom) {
      add(
        'COALESCE(record.sealed_at, creation.started_at, qr.created_at) >= ?',
        filters.dateFrom
      );
    }
    if (filters.dateTo) {
      add(
        'COALESCE(record.sealed_at, creation.started_at, qr.created_at) <= ?',
        filters.dateTo
      );
    }
    if (filters.ids) add('qr.id = ANY(?::text[])', filters.ids);

    const where = predicates.length > 0 ? `WHERE ${predicates.join(' AND ')}` : '';
    const countResult = await executeQuery(
      this.transactionContext,
      `SELECT count(*)::integer AS total
       FROM app.qr_codes qr
       LEFT JOIN app.records record ON record.qr_id = qr.id
       LEFT JOIN app.co_creations creation ON creation.qr_id = qr.id
       ${where}`,
      params
    );
    const pageParams = [...params, limit, offset];
    const result = await executeQuery(
      this.transactionContext,
      `${ADMIN_QR_SELECT}
       ${where}
       ORDER BY COALESCE(
         record.sealed_at, creation.started_at, qr.created_at
       ) DESC, qr.id ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      pageParams
    );
    return {
      total: Number(rows(countResult)[0]?.total || 0),
      records: rows(result)
    };
  }

  async findAdminRecord(qrId) {
    const result = await executeQuery(
      this.transactionContext,
      `${ADMIN_QR_SELECT} WHERE qr.id = $1`,
      [qrId]
    );
    return rows(result)[0] || null;
  }

  async setHidden(ids, hidden, updatedAt) {
    const result = await executeQuery(
      this.transactionContext,
      `UPDATE app.qr_codes
       SET hidden = $2, updated_at = $3
       WHERE id = ANY($1::text[])
       RETURNING id`,
      [ids, hidden, updatedAt]
    );
    return rows(result).map((row) => row.id);
  }

  async findQrForQualityCheck(qrId) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT
         qr.id, qr.lifecycle_status,
         EXISTS (
           SELECT 1 FROM app.quality_check_logs log WHERE log.qr_id = qr.id
         ) AS has_quality_log
       FROM app.qr_codes qr
       WHERE qr.id = $1
       FOR UPDATE`,
      [qrId]
    );
    return rows(result)[0] || null;
  }

  async insertQualityCheckLog({ qrId, checkedBy, result, checkedAt }) {
    const queryResult = await executeQuery(
      this.transactionContext,
      `INSERT INTO app.quality_check_logs (
         legacy_id, qr_id, operator_id, checked_by_snapshot, result, checked_at
       )
       VALUES (
         NULL, $1,
         (SELECT id FROM app.operators WHERE username = $2 LIMIT 1),
         $2, $3, $4
       )
       RETURNING id, qr_id, checked_by_snapshot, result, checked_at`,
      [qrId, checkedBy, result, checkedAt]
    );
    return rows(queryResult)[0] || null;
  }

  async listQualityCheckLogs({ limit, offset }) {
    const countResult = await executeQuery(
      this.transactionContext,
      'SELECT count(*)::integer AS total FROM app.quality_check_logs'
    );
    const result = await executeQuery(
      this.transactionContext,
      `SELECT id, qr_id, checked_by_snapshot, result, checked_at
       FROM app.quality_check_logs
       ORDER BY checked_at DESC, id DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return {
      total: Number(rows(countResult)[0]?.total || 0),
      logs: rows(result)
    };
  }

  async qualityCheckStats({ dayStart, dayEnd }) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT
         count(*)::integer AS total_checked,
         count(*) FILTER (
           WHERE checked_at >= $1 AND checked_at < $2
         )::integer AS today_checked,
         count(*) FILTER (
           WHERE checked_at >= $1 AND checked_at < $2 AND result <> 'pass'
         )::integer AS today_abnormal
       FROM app.quality_check_logs`,
      [dayStart, dayEnd]
    );
    return rows(result)[0] || {
      total_checked: 0,
      today_checked: 0,
      today_abnormal: 0
    };
  }

  async dashboardStats({ dayStart, dayEnd, dateFrom, dateTo }) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT
         count(*) FILTER (WHERE qr.issue_status = 'issued')::integer
           AS total_issued,
         count(*) FILTER (WHERE qr.lifecycle_status = 'activated')::integer
           AS total_activated,
         count(*) FILTER (WHERE qr.lifecycle_status = 'co_creating')::integer
           AS total_co_creating,
         count(*) FILTER (
           WHERE qr.issue_status = 'issued'
             AND qr.lifecycle_status = 'unactivated'
         )::integer AS circulating_pending,
         count(*) FILTER (WHERE qr.hidden)::integer AS hidden_records,
         count(*) FILTER (
           WHERE qr.lifecycle_status IN ('activated', 'co_creating')
             AND COALESCE(record.sealed_at, creation.started_at) >= $1
             AND COALESCE(record.sealed_at, creation.started_at) < $2
         )::integer AS today_new_records,
         count(*) FILTER (
           WHERE qr.issue_status = 'issued'
             AND ($3::timestamptz IS NULL OR qr.created_at >= $3)
             AND ($4::timestamptz IS NULL OR qr.created_at <= $4)
         )::integer AS period_issued,
         count(*) FILTER (
           WHERE qr.lifecycle_status = 'activated'
             AND ($3::timestamptz IS NULL OR record.sealed_at >= $3)
             AND ($4::timestamptz IS NULL OR record.sealed_at <= $4)
         )::integer AS period_activated,
         count(*) FILTER (
           WHERE qr.lifecycle_status = 'activated'
             AND COALESCE(proof.status, 'not_started') IN (
               'not_started', 'manifest_ready'
             )
         )::integer AS chain_pending,
         count(*) FILTER (
           WHERE proof.status IN ('submitting', 'submitted', 'retrying')
         )::integer AS chain_processing,
         count(*) FILTER (WHERE proof.status = 'confirmed')::integer
           AS chain_confirmed,
         count(*) FILTER (WHERE proof.status = 'failed')::integer
           AS chain_failed
       FROM app.qr_codes qr
       LEFT JOIN app.records record ON record.qr_id = qr.id
       LEFT JOIN app.co_creations creation ON creation.qr_id = qr.id
       LEFT JOIN app.record_proofs proof ON proof.record_qr_id = qr.id`,
      [dayStart, dayEnd, dateFrom, dateTo]
    );
    return rows(result)[0] || {};
  }
}

module.exports = { QrAdministrationRepository };
