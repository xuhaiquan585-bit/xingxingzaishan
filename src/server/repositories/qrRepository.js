'use strict';

const { QR_FIELDS, mapQr } = require('./mappers');
const { assertTransactionContext, executeQuery, oneOrNull } = require('./query');

const COLUMNS = QR_FIELDS.join(', ');

class QrRepository {
  constructor(transactionContext) {
    this.transactionContext = assertTransactionContext(transactionContext);
  }

  async findById(qrId) {
    return this.#findExact('id', qrId, false);
  }

  async findByIdForUpdate(qrId) {
    return this.#findExact('id', qrId, true);
  }

  async findByAccessToken(accessToken) {
    return this.#findExact('access_token', accessToken, false);
  }

  async findByAccessTokenForUpdate(accessToken) {
    return this.#findExact('access_token', accessToken, true);
  }

  async findByKey(key) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT ${COLUMNS} FROM app.qr_codes
       WHERE access_token = $1
          OR (id = $1 AND NOT EXISTS (
            SELECT 1 FROM app.qr_codes token_match WHERE token_match.access_token = $1
          ))
       LIMIT 2`,
      [key]
    );
    return oneOrNull(result, mapQr, 'DUPLICATE_QR_KEY');
  }

  async findByKeyForUpdate(key) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT ${COLUMNS} FROM app.qr_codes
       WHERE access_token = $1
          OR (id = $1 AND NOT EXISTS (
            SELECT 1 FROM app.qr_codes token_match WHERE token_match.access_token = $1
          ))
       LIMIT 2 FOR UPDATE`,
      [key]
    );
    return oneOrNull(result, mapQr, 'DUPLICATE_QR_KEY');
  }

  async updateLifecycle({ qr_id, expected_status, next_status, updated_at }) {
    const result = await executeQuery(
      this.transactionContext,
      `UPDATE app.qr_codes
       SET lifecycle_status = $2, updated_at = $3
       WHERE id = $1 AND lifecycle_status = $4
       RETURNING ${COLUMNS}`,
      [qr_id, next_status, updated_at, expected_status]
    );
    return oneOrNull(result, mapQr);
  }

  async #findExact(column, value, forUpdate) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT ${COLUMNS} FROM app.qr_codes WHERE ${column} = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [value]
    );
    return oneOrNull(result, mapQr);
  }
}

module.exports = { QrRepository };
