'use strict';

const { RECORD_FIELDS, mapRecord } = require('./mappers');
const {
  assertTransactionContext,
  executeQuery,
  many,
  normalizeLimit,
  oneOrNull
} = require('./query');

const COLUMNS = RECORD_FIELDS.join(', ');

class RecordRepository {
  constructor(transactionContext) {
    this.transactionContext = assertTransactionContext(transactionContext);
  }

  async findByQrId(qrId) {
    return this.#findByQrId(qrId, false);
  }

  async findByQrIdForUpdate(qrId) {
    return this.#findByQrId(qrId, true);
  }

  async listByAccountId(accountId, { limit = 50 } = {}) {
    const safeLimit = normalizeLimit(limit);
    const result = await executeQuery(
      this.transactionContext,
      `SELECT ${COLUMNS} FROM app.records
       WHERE account_id = $1
       ORDER BY created_at DESC, qr_id ASC
       LIMIT $2`,
      [accountId, safeLimit]
    );
    return many(result, mapRecord);
  }

  async listPersonalByAccountId(accountId, { limit = 1001 } = {}) {
    const safeLimit = normalizeLimit(limit, { maximum: 1001 });
    const result = await executeQuery(
      this.transactionContext,
      `SELECT
         q.id AS qr_id,
         q.lifecycle_status,
         r.content,
         r.image_url_snapshot,
         r.image_object_key,
         r.sealed_at,
         r.created_at,
         c.started_at AS co_creation_started_at
       FROM app.qr_codes q
       JOIN app.records r ON r.qr_id = q.id
       LEFT JOIN app.co_creations c ON c.qr_id = q.id
       WHERE (q.lifecycle_status = 'activated' AND r.account_id = $1)
          OR (q.lifecycle_status = 'co_creating' AND c.owner_account_id = $1)
       ORDER BY COALESCE(r.sealed_at, c.started_at, r.created_at, q.created_at) DESC,
                q.id ASC
       LIMIT $2`,
      [accountId, safeLimit]
    );
    return many(result, (row) => Object.freeze({
      qr_id: row.qr_id,
      lifecycle_status: row.lifecycle_status,
      content: row.content,
      image_url_snapshot: row.image_url_snapshot,
      image_object_key: row.image_object_key,
      sealed_at: row.sealed_at,
      created_at: row.created_at,
      co_creation_started_at: row.co_creation_started_at
    }));
  }

  async findOwnedByAccountId(accountId, qrId) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT ${COLUMNS} FROM app.records WHERE account_id = $1 AND qr_id = $2`,
      [accountId, qrId]
    );
    return oneOrNull(result, mapRecord);
  }

  async insertSealed(record) {
    return this.insert(record);
  }

  async insert(record) {
    const placeholders = RECORD_FIELDS.map((_, index) => `$${index + 1}`).join(', ');
    const result = await executeQuery(
      this.transactionContext,
      `INSERT INTO app.records (${COLUMNS}) VALUES (${placeholders}) RETURNING ${COLUMNS}`,
      RECORD_FIELDS.map((field) => record[field])
    );
    return oneOrNull(result, mapRecord, 'REPOSITORY_INSERT_RESULT_INVALID');
  }

  async seal({ qr_id, sealed_at, updated_at }) {
    const result = await executeQuery(
      this.transactionContext,
      `UPDATE app.records
       SET sealed_at = $2, updated_at = $3
       WHERE qr_id = $1 AND sealed_at IS NULL
       RETURNING ${COLUMNS}`,
      [qr_id, sealed_at, updated_at]
    );
    return oneOrNull(result, mapRecord);
  }

  async #findByQrId(qrId, forUpdate) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT ${COLUMNS} FROM app.records WHERE qr_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [qrId]
    );
    return oneOrNull(result, mapRecord);
  }
}

module.exports = { RecordRepository };
