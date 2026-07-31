'use strict';

const { sanitizePostgresError, postgresConnectionError } = require('./connection');

const ISOLATION_LEVELS = new Map([
  ['read committed', 'READ COMMITTED'],
  ['repeatable read', 'REPEATABLE READ'],
  ['serializable', 'SERIALIZABLE']
]);

function transactionOptionsSql({ isolationLevel = 'read committed', readOnly = false } = {}) {
  const normalizedLevel = String(isolationLevel || '').trim().toLowerCase();
  const sqlLevel = ISOLATION_LEVELS.get(normalizedLevel);
  if (!sqlLevel) {
    throw postgresConnectionError(
      'POSTGRES_TRANSACTION_OPTIONS_INVALID',
      'Unsupported PostgreSQL transaction isolation level.'
    );
  }
  return `SET TRANSACTION ISOLATION LEVEL ${sqlLevel}${readOnly ? ' READ ONLY' : ''}`;
}

function createTransactionContext(client) {
  return Object.freeze({
    query: async (...args) => {
      try {
        return await client.query(...args);
      } catch (error) {
        throw sanitizePostgresError(error, 'POSTGRES_QUERY_FAILED');
      }
    }
  });
}

async function rollbackTransaction(client, originalError) {
  try {
    await client.query('ROLLBACK');
  } catch (rollbackFailure) {
    const rollbackError = sanitizePostgresError(
      rollbackFailure,
      'POSTGRES_TRANSACTION_ROLLBACK_FAILED'
    );
    rollbackError.originalErrorCode = originalError && originalError.code
      ? originalError.code
      : 'POSTGRES_TRANSACTION_FAILED';
    throw rollbackError;
  }
}

async function withTransaction(pool, callback, options = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw postgresConnectionError('POSTGRES_POOL_REQUIRED', 'A PostgreSQL pool is required.');
  }
  if (typeof callback !== 'function') {
    throw postgresConnectionError('POSTGRES_TRANSACTION_CALLBACK_REQUIRED', 'A transaction callback is required.');
  }

  let client;
  try {
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query(transactionOptionsSql(options));
    } catch (error) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch (_rollbackError) {
          throw sanitizePostgresError(_rollbackError, 'POSTGRES_TRANSACTION_ROLLBACK_FAILED');
        }
      }
      throw sanitizePostgresError(error, 'POSTGRES_TRANSACTION_START_FAILED');
    }

    let result;
    try {
      result = await callback(createTransactionContext(client));
    } catch (error) {
      await rollbackTransaction(client, error);
      throw error;
    }

    try {
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await rollbackTransaction(client, error);
      throw sanitizePostgresError(error, 'POSTGRES_TRANSACTION_COMMIT_FAILED');
    }
  } finally {
    if (client && typeof client.release === 'function') {
      client.release();
    }
  }
}

module.exports = {
  createTransactionContext,
  transactionOptionsSql,
  withTransaction
};
