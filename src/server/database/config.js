'use strict';

const DATABASE_URL_PROTOCOLS = new Set(['postgres:', 'postgresql:']);
const DISCRETE_CONNECTION_KEYS = ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE'];

function postgresConfigError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function optionalString(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function parseBoolean(value, fallback, key) {
  const normalized = optionalString(value).toLowerCase();
  if (!normalized) return fallback;
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  throw postgresConfigError('POSTGRES_CONFIG_INVALID', `${key} must be true, false, 1, or 0.`);
}

function parseInteger(value, fallback, { key, min, max }) {
  const normalized = optionalString(value);
  if (!normalized) return fallback;
  if (!/^\d+$/.test(normalized)) {
    throw postgresConfigError('POSTGRES_CONFIG_INVALID', `${key} must be an integer.`);
  }

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw postgresConfigError('POSTGRES_CONFIG_INVALID', `${key} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function parseDatabaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_error) {
    throw postgresConfigError('POSTGRES_CONFIG_INVALID', 'DATABASE_URL must be a valid PostgreSQL URL.');
  }
  if (!DATABASE_URL_PROTOCOLS.has(parsed.protocol)) {
    throw postgresConfigError('POSTGRES_CONFIG_INVALID', 'DATABASE_URL must use postgres:// or postgresql://.');
  }
  if (!parsed.hostname || !parsed.pathname || parsed.pathname === '/') {
    throw postgresConfigError('POSTGRES_CONFIG_INVALID', 'DATABASE_URL must include a host and database name.');
  }
  return parsed;
}

function readPostgresConfig(env = process.env) {
  const sourceEnv = env && typeof env === 'object' ? env : {};
  const databaseUrl = optionalString(sourceEnv.DATABASE_URL);
  const hasDiscreteConnectionValue = DISCRETE_CONNECTION_KEYS.some((key) => optionalString(sourceEnv[key]));

  if (databaseUrl && hasDiscreteConnectionValue) {
    throw postgresConfigError(
      'POSTGRES_CONFIG_AMBIGUOUS',
      'Use DATABASE_URL or the PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE fields, not both.'
    );
  }

  const production = optionalString(sourceEnv.NODE_ENV).toLowerCase() === 'production';
  const sslEnabled = parseBoolean(sourceEnv.PGSSL, production, 'PGSSL');
  const rejectUnauthorized = parseBoolean(
    sourceEnv.PGSSL_REJECT_UNAUTHORIZED,
    sslEnabled,
    'PGSSL_REJECT_UNAUTHORIZED'
  );
  const common = {
    poolMax: parseInteger(sourceEnv.PGPOOL_MAX, 10, {
      key: 'PGPOOL_MAX', min: 1, max: 100
    }),
    idleTimeoutMillis: parseInteger(sourceEnv.PGIDLE_TIMEOUT_MS, 30000, {
      key: 'PGIDLE_TIMEOUT_MS', min: 0, max: 3600000
    }),
    connectionTimeoutMillis: parseInteger(sourceEnv.PGCONNECT_TIMEOUT_MS, 10000, {
      key: 'PGCONNECT_TIMEOUT_MS', min: 1, max: 300000
    }),
    statementTimeoutMillis: parseInteger(sourceEnv.PGSTATEMENT_TIMEOUT_MS, 15000, {
      key: 'PGSTATEMENT_TIMEOUT_MS', min: 0, max: 3600000
    }),
    applicationName: optionalString(sourceEnv.PGAPPLICATION_NAME) || 'xingxingzaishan',
    ssl: sslEnabled ? { rejectUnauthorized } : false
  };

  if (databaseUrl) {
    parseDatabaseUrl(databaseUrl);
    return {
      source: 'database_url',
      connectionString: databaseUrl,
      ...common
    };
  }

  const host = optionalString(sourceEnv.PGHOST);
  const user = optionalString(sourceEnv.PGUSER);
  const database = optionalString(sourceEnv.PGDATABASE);
  if (!host || !user || !database) {
    throw postgresConfigError(
      'POSTGRES_CONFIG_REQUIRED',
      'Set DATABASE_URL or provide PGHOST, PGUSER, and PGDATABASE.'
    );
  }

  return {
    source: 'discrete',
    host,
    port: parseInteger(sourceEnv.PGPORT, 5432, {
      key: 'PGPORT', min: 1, max: 65535
    }),
    user,
    password: sourceEnv.PGPASSWORD === undefined || sourceEnv.PGPASSWORD === null
      ? ''
      : String(sourceEnv.PGPASSWORD),
    database,
    ...common
  };
}

function redactPostgresConfig(config) {
  if (!config || typeof config !== 'object') return null;

  const redacted = {
    source: config.source,
    poolMax: config.poolMax,
    idleTimeoutMillis: config.idleTimeoutMillis,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    statementTimeoutMillis: config.statementTimeoutMillis,
    applicationName: config.applicationName,
    ssl: config.ssl === false
      ? false
      : { rejectUnauthorized: config.ssl && config.ssl.rejectUnauthorized !== false }
  };

  if (config.source === 'database_url' && config.connectionString) {
    try {
      const parsed = parseDatabaseUrl(config.connectionString);
      return {
        ...redacted,
        host: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : 5432,
        database: decodeURIComponent(parsed.pathname.slice(1)),
        user: parsed.username ? decodeURIComponent(parsed.username) : ''
      };
    } catch (_error) {
      return redacted;
    }
  }

  return {
    ...redacted,
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user
  };
}

module.exports = {
  readPostgresConfig,
  redactPostgresConfig
};
