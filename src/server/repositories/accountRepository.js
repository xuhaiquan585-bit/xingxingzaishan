'use strict';

const { ACCOUNT_FIELDS, mapAccount } = require('./mappers');
const { assertTransactionContext, executeQuery, oneOrNull } = require('./query');

const COLUMNS = ACCOUNT_FIELDS.join(', ');

class AccountRepository {
  constructor(transactionContext) {
    this.transactionContext = assertTransactionContext(transactionContext);
  }

  async findById(accountId) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT ${COLUMNS} FROM app.accounts WHERE id = $1`,
      [accountId]
    );
    return oneOrNull(result, mapAccount);
  }

  async findByIdForUpdate(accountId) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT ${COLUMNS} FROM app.accounts WHERE id = $1 FOR UPDATE`,
      [accountId]
    );
    return oneOrNull(result, mapAccount);
  }

  async exists(accountId) {
    const result = await executeQuery(
      this.transactionContext,
      'SELECT EXISTS (SELECT 1 FROM app.accounts WHERE id = $1) AS exists',
      [accountId]
    );
    return Boolean(result.rows[0] && result.rows[0].exists);
  }

  async insert(account) {
    const values = ACCOUNT_FIELDS.map((field) => account[field]);
    const placeholders = ACCOUNT_FIELDS.map((_, index) => `$${index + 1}`).join(', ');
    const result = await executeQuery(
      this.transactionContext,
      `INSERT INTO app.accounts (${COLUMNS}) VALUES (${placeholders}) RETURNING ${COLUMNS}`,
      values
    );
    return oneOrNull(result, mapAccount);
  }
}

module.exports = { AccountRepository };
