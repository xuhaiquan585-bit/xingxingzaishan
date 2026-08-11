'use strict';

const { QR_FIELDS, mapQr } = require('./mappers');
const { assertTransactionContext, executeQuery, oneOrNull } = require('./query');

const COLUMNS = QR_FIELDS.join(', ');

class QrIssuanceRepository {
  constructor(transactionContext) {
    this.transactionContext = assertTransactionContext(transactionContext);
  }

  async lockPrefix(prefix) {
    await executeQuery(
      this.transactionContext,
      "SELECT pg_advisory_xact_lock(hashtextextended('qr-issuance:' || $1, 0))",
      [prefix]
    );
  }

  async findMaxSequence(prefix) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT coalesce(max(right(id, 5)::integer), 0)::integer AS max_sequence
       FROM app.qr_codes
       WHERE left(id, char_length($1)) = $1
         AND char_length(id) = char_length($1) + 5
         AND right(id, 5) ~ '^[0-9]{5}$'`,
      [prefix]
    );
    const value = Number(result.rows && result.rows[0] && result.rows[0].max_sequence);
    return Number.isInteger(value) && value >= 0 ? value : null;
  }

  async batchExists(batchId) {
    if (!batchId) return true;
    const result = await executeQuery(
      this.transactionContext,
      'SELECT id FROM app.qr_batches WHERE id = $1 FOR KEY SHARE',
      [batchId]
    );
    return result.rowCount === 1;
  }

  async insertIssued(input) {
    const result = await executeQuery(
      this.transactionContext,
      `INSERT INTO app.qr_codes
         (id, issue_status, lifecycle_status, hidden, batch_id, print_batch_id,
          qr_image_url_snapshot, access_token, created_at, updated_at)
       VALUES ($1, 'issued', 'unactivated', false, $2, NULL, $3, $4, $5, $5)
       RETURNING ${COLUMNS}`,
      [
        input.id,
        input.batch_id || null,
        input.qr_image_url_snapshot || '',
        input.access_token,
        input.created_at
      ]
    );
    return oneOrNull(result, mapQr);
  }
}

module.exports = { QrIssuanceRepository };
