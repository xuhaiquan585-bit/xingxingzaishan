'use strict';

const { Pool } = require('pg');
const { readPostgresConfig } = require('./config');

const poolClosePromises = new WeakMap();

function postgresConnectionError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function sanitizePostgresError(error, fallbackCode = 'POSTGRES_CONNECTION_FAILED') {
  if (error && typeof error === 'object' && String(error.code || '').startsWith('POSTGRES_')) {
    return error;
  }

  const sanitized = postgresConnectionError(fallbackCode, 'PostgreSQL operation failed.');
  const providerCode = error && typeof error.code === 'string' ? error.code : '';
  if (/^[A-Z0-9]{5}$/.test(providerCode)) {
    sanitized.postgresCode = providerCode;
  }
  return sanitized;
}

function buildPoolOptions(config) {
  if (!config || typeof config !== 'object') {
    throw postgresConnectionError('POSTGRES_CONFIG_REQUIRED', 'PostgreSQL configuration is required.');
  }

  const common = {
    max: config.poolMax,
    idleTimeoutMillis: config.idleTimeoutMillis,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    statement_timeout: config.statementTimeoutMillis,
    application_name: config.applicationName,
    ssl: config.ssl
  };

  if (config.source === 'database_url') {
    return {
      connectionString: config.connectionString,
      ...common
    };
  }

  if (config.source === 'discrete') {
    return {
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      ...common
    };
  }

  throw postgresConnectionError('POSTGRES_CONFIG_INVALID', 'Unknown PostgreSQL configuration source.');
}

function createPostgresPool({
  config = readPostgresConfig(),
  PoolClass = Pool,
  onBackgroundError
} = {}) {
  const pool = new PoolClass(buildPoolOptions(config));

  if (pool && typeof pool.on === 'function') {
    pool.on('error', (error) => {
      if (typeof onBackgroundError === 'function') {
        onBackgroundError(sanitizePostgresError(error));
      }
    });
  }

  return pool;
}

function closePostgresPool(pool) {
  if (!pool || typeof pool.end !== 'function') {
    return Promise.resolve();
  }
  if (poolClosePromises.has(pool)) {
    return poolClosePromises.get(pool);
  }

  const closePromise = Promise.resolve().then(() => pool.end());
  poolClosePromises.set(pool, closePromise);
  return closePromise;
}

module.exports = {
  buildPoolOptions,
  closePostgresPool,
  createPostgresPool,
  postgresConnectionError,
  sanitizePostgresError
};
