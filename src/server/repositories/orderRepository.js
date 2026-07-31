'use strict';

const { ORDER_FIELDS, mapOrder } = require('./mappers');
const {
  assertTransactionContext,
  executeQuery,
  many,
  normalizeLimit,
  oneOrNull
} = require('./query');

const COLUMNS = ORDER_FIELDS.join(', ');

class OrderRepository {
  constructor(transactionContext) {
    this.transactionContext = assertTransactionContext(transactionContext);
  }

  async findById(orderId) {
    return this.#findExact('id', orderId, false);
  }

  async findByIdForUpdate(orderId) {
    return this.#findExact('id', orderId, true);
  }

  async findByOrderNo(orderNo) {
    return this.#findExact('order_no', orderNo, false);
  }

  async findByOrderNoForUpdate(orderNo) {
    return this.#findExact('order_no', orderNo, true);
  }

  async listByAccountId(accountId, { limit = 50 } = {}) {
    const safeLimit = normalizeLimit(limit);
    const result = await executeQuery(
      this.transactionContext,
      `SELECT ${COLUMNS} FROM app.orders
       WHERE account_id = $1
       ORDER BY created_at DESC, id ASC
       LIMIT $2`,
      [accountId, safeLimit]
    );
    return many(result, mapOrder);
  }

  async insert(order) {
    const placeholders = ORDER_FIELDS.map((_, index) => `$${index + 1}`).join(', ');
    const result = await executeQuery(
      this.transactionContext,
      `INSERT INTO app.orders (${COLUMNS}) VALUES (${placeholders}) RETURNING ${COLUMNS}`,
      ORDER_FIELDS.map((field) => order[field])
    );
    return oneOrNull(result, mapOrder, 'REPOSITORY_INSERT_RESULT_INVALID');
  }

  async #findExact(column, value, forUpdate) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT ${COLUMNS} FROM app.orders WHERE ${column} = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [value]
    );
    return oneOrNull(result, mapOrder);
  }
}

module.exports = { OrderRepository };
