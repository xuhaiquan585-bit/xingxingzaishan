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

  async findOwnedByAccountId(accountId, qrId) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT ${COLUMNS} FROM app.records WHERE account_id = $1 AND qr_id = $2`,
      [accountId, qrId]
    );
    return oneOrNull(result, mapRecord);
  }

  async insertSealed(record) {
    const placeholders = RECORD_FIELDS.map((_, index) => `$${index + 1}`).join(', ');
    const result = await executeQuery(
      this.transactionContext,
      `INSERT INTO app.records (${COLUMNS}) VALUES (${placeholders}) RETURNING ${COLUMNS}`,
      RECORD_FIELDS.map((field) => record[field])
    );
    return oneOrNull(result, mapRecord, 'REPOSITORY_INSERT_RESULT_INVALID');
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
