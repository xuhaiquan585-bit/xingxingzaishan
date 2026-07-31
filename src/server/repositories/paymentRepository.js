'use strict';

const {
  PAYMENT_EVENT_FIELDS,
  PAYMENT_FIELDS,
  mapPayment,
  mapPaymentEvent
} = require('./mappers');
const { assertTransactionContext, executeQuery, many, oneOrNull } = require('./query');

const PAYMENT_COLUMNS = PAYMENT_FIELDS.join(', ');
const EVENT_COLUMNS = PAYMENT_EVENT_FIELDS.join(', ');

class PaymentRepository {
  constructor(transactionContext) {
    this.transactionContext = assertTransactionContext(transactionContext);
  }

  async findByProviderTransactionId(provider, providerTransactionId) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT ${PAYMENT_COLUMNS} FROM app.payment_transactions
       WHERE provider = $1 AND provider_transaction_id = $2`,
      [provider, providerTransactionId]
    );
    return oneOrNull(result, mapPayment);
  }

  async findByMerchantOrderNo(provider, merchantOrderNo) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT ${PAYMENT_COLUMNS} FROM app.payment_transactions
       WHERE provider = $1 AND merchant_order_no = $2`,
      [provider, merchantOrderNo]
    );
    return oneOrNull(result, mapPayment);
  }

  async listEventsByOrderId(orderId) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT ${EVENT_COLUMNS} FROM app.payment_events
       WHERE order_id = $1 ORDER BY created_at ASC, id ASC`,
      [orderId]
    );
    return many(result, mapPaymentEvent);
  }

  async insertTransaction(payment) {
    const placeholders = PAYMENT_FIELDS.map((_, index) => `$${index + 1}`).join(', ');
    const result = await executeQuery(
      this.transactionContext,
      `INSERT INTO app.payment_transactions (${PAYMENT_COLUMNS})
       VALUES (${placeholders}) RETURNING ${PAYMENT_COLUMNS}`,
      PAYMENT_FIELDS.map((field) => payment[field])
    );
    return oneOrNull(result, mapPayment, 'REPOSITORY_INSERT_RESULT_INVALID');
  }

  async appendEvent(event) {
    const insertFields = PAYMENT_EVENT_FIELDS.filter((field) => field !== 'id');
    const columns = insertFields.join(', ');
    const placeholders = insertFields.map((_, index) => `$${index + 1}`).join(', ');
    const result = await executeQuery(
      this.transactionContext,
      `INSERT INTO app.payment_events (${columns}) VALUES (${placeholders}) RETURNING ${EVENT_COLUMNS}`,
      insertFields.map((field) => (
        field === 'sanitized_metadata' ? JSON.stringify(event[field] || {}) : event[field]
      ))
    );
    return oneOrNull(result, mapPaymentEvent, 'REPOSITORY_INSERT_RESULT_INVALID');
  }
}

module.exports = { PaymentRepository };
