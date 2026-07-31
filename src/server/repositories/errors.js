'use strict';

class RepositoryError extends Error {
  constructor(code, message, cause) {
    super(message || code, cause ? { cause } : undefined);
    this.name = 'RepositoryError';
    this.code = code;
  }
}

const CONSTRAINT_ERROR_CODES = Object.freeze({
  '23505': 'REPOSITORY_UNIQUE_CONFLICT',
  '23503': 'REPOSITORY_FOREIGN_KEY_CONFLICT',
  '23514': 'REPOSITORY_CHECK_CONFLICT'
});

function translateRepositoryError(error, codeOverrides = {}) {
  if (error instanceof RepositoryError) return error;

  const providerCode = error && (error.postgresCode || error.code);
  const stableCode = codeOverrides[providerCode] || CONSTRAINT_ERROR_CODES[providerCode];
  if (stableCode) {
    return new RepositoryError(stableCode, 'Database constraint rejected the operation.', error);
  }

  if (typeof providerCode === 'string' && (providerCode.startsWith('08') || providerCode === '57P01')) {
    return new RepositoryError(
      'REPOSITORY_DATABASE_UNAVAILABLE',
      'The database is unavailable.',
      error
    );
  }

  return new RepositoryError('REPOSITORY_QUERY_FAILED', 'The repository operation failed.', error);
}

module.exports = {
  RepositoryError,
  translateRepositoryError
};
