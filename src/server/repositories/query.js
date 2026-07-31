'use strict';

const { RepositoryError, translateRepositoryError } = require('./errors');

function assertTransactionContext(transactionContext) {
  if (!transactionContext || typeof transactionContext.query !== 'function') {
    throw new RepositoryError(
      'REPOSITORY_TRANSACTION_CONTEXT_REQUIRED',
      'A transaction context with query capability is required.'
    );
  }
  return transactionContext;
}

async function executeQuery(transactionContext, sql, params = [], options = {}) {
  const context = assertTransactionContext(transactionContext);
  try {
    return await context.query(sql, params);
  } catch (error) {
    throw translateRepositoryError(error, options.codeOverrides);
  }
}

function oneOrNull(result, mapper, duplicateCode = 'REPOSITORY_NON_UNIQUE_RESULT') {
  const rows = result && Array.isArray(result.rows) ? result.rows : [];
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    throw new RepositoryError(duplicateCode, 'Expected a unique repository result.');
  }
  return mapper(rows[0]);
}

function many(result, mapper) {
  const rows = result && Array.isArray(result.rows) ? result.rows : [];
  return rows.map(mapper);
}

function normalizeLimit(value, { defaultValue = 50, maximum = 100 } = {}) {
  const candidate = value === undefined ? defaultValue : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < 1) {
    throw new RepositoryError('REPOSITORY_LIMIT_INVALID', 'Repository limit must be a positive integer.');
  }
  return Math.min(candidate, maximum);
}

module.exports = {
  assertTransactionContext,
  executeQuery,
  many,
  normalizeLimit,
  oneOrNull
};
