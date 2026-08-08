'use strict';

const { IDENTITY_FIELDS, mapIdentity } = require('./mappers');
const { RepositoryError } = require('./errors');
const { assertTransactionContext, executeQuery, many, oneOrNull } = require('./query');

const COLUMNS = IDENTITY_FIELDS.join(', ');

class IdentityRepository {
  constructor(transactionContext) {
    this.transactionContext = assertTransactionContext(transactionContext);
  }

  async findById(identityId) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT ${COLUMNS} FROM app.users WHERE id = $1`,
      [identityId]
    );
    return oneOrNull(result, mapIdentity);
  }

  async findByIdForUpdate(identityId) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT ${COLUMNS} FROM app.users WHERE id = $1 FOR UPDATE`,
      [identityId]
    );
    return oneOrNull(result, mapIdentity);
  }

  async findUniqueByPhone(phone) {
    return this.#findUnique('phone', phone, false, 'DUPLICATE_PHONE_IDENTITY');
  }

  async findUniqueByPhoneForUpdate(phone) {
    return this.#findUnique('phone', phone, true, 'DUPLICATE_PHONE_IDENTITY');
  }

  async findUniqueByOpenid(openid) {
    return this.#findUnique('openid', openid, false, 'DUPLICATE_OPENID_IDENTITY');
  }

  async findUniqueByOpenidForUpdate(openid) {
    return this.#findUnique('openid', openid, true, 'DUPLICATE_OPENID_IDENTITY');
  }

  async listByAccountId(accountId) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT ${COLUMNS} FROM app.users WHERE account_id = $1 ORDER BY id ASC`,
      [accountId]
    );
    return many(result, mapIdentity);
  }

  async countByAccountId(accountId) {
    const result = await executeQuery(
      this.transactionContext,
      'SELECT COUNT(*)::integer AS count FROM app.users WHERE account_id = $1',
      [accountId]
    );
    return Number(result.rows[0] ? result.rows[0].count : 0);
  }

  async lockIdentityKeys(keys) {
    const normalizedKeys = [...new Set(
      (Array.isArray(keys) ? keys : [])
        .map((key) => String(key || '').trim())
        .filter(Boolean)
    )].sort();
    if (normalizedKeys.length === 0) {
      throw new RepositoryError(
        'REPOSITORY_IDENTITY_LOCK_KEY_REQUIRED',
        'At least one identity lock key is required.'
      );
    }
    for (const key of normalizedKeys) {
      await executeQuery(
        this.transactionContext,
        'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
        [key]
      );
    }
  }

  async insert(identity) {
    const insertFields = IDENTITY_FIELDS.filter((field) => field !== 'id');
    const columns = insertFields.join(', ');
    const placeholders = insertFields.map((_, index) => `$${index + 1}`).join(', ');
    const result = await executeQuery(
      this.transactionContext,
      `INSERT INTO app.users (${columns}) VALUES (${placeholders}) RETURNING ${COLUMNS}`,
      insertFields.map((field) => identity[field])
    );
    return oneOrNull(result, mapIdentity, 'REPOSITORY_INSERT_RESULT_INVALID');
  }

  async updateIdentity(identityId, identity) {
    const mutableFields = ['phone', 'openid', 'unionid', 'source', 'updated_at'];
    const assignments = mutableFields
      .map((field, index) => `${field} = $${index + 2}`)
      .join(', ');
    const result = await executeQuery(
      this.transactionContext,
      `UPDATE app.users SET ${assignments} WHERE id = $1 RETURNING ${COLUMNS}`,
      [identityId, ...mutableFields.map((field) => identity[field])]
    );
    return oneOrNull(result, mapIdentity);
  }

  async deleteById(identityId) {
    const result = await executeQuery(
      this.transactionContext,
      `DELETE FROM app.users WHERE id = $1 RETURNING ${COLUMNS}`,
      [identityId]
    );
    return oneOrNull(result, mapIdentity);
  }

  async #findUnique(column, value, forUpdate, duplicateCode) {
    const lockClause = forUpdate ? ' FOR UPDATE' : '';
    const result = await executeQuery(
      this.transactionContext,
      `SELECT ${COLUMNS} FROM app.users WHERE ${column} = $1 ORDER BY id ASC LIMIT 2${lockClause}`,
      [value]
    );
    return oneOrNull(result, mapIdentity, duplicateCode);
  }
}

module.exports = { IdentityRepository };
