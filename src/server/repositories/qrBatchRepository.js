'use strict';

const { QR_BATCH_PUBLIC_FIELDS, mapQrBatchPublic } = require('./mappers');
const { assertTransactionContext, executeQuery, oneOrNull } = require('./query');

const COLUMNS = QR_BATCH_PUBLIC_FIELDS.join(', ');

class QrBatchRepository {
  constructor(transactionContext) {
    this.transactionContext = assertTransactionContext(transactionContext);
  }

  async findById(batchId) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT ${COLUMNS} FROM app.qr_batches WHERE id = $1`,
      [batchId]
    );
    return oneOrNull(result, mapQrBatchPublic);
  }
}

module.exports = { QrBatchRepository };
