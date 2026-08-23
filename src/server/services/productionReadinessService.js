'use strict';

const fs = require('node:fs');

const { checkPostgresHealth } = require('../database/healthCheck');
const { readPostgresConfig } = require('../database/config');
const {
  closePostgresPool,
  createPostgresPool
} = require('../database/connection');

const BACKUP_ATTEMPT_FILE = '/var/lib/xingxingzaishan-production-backup/last-attempt.env';
const BACKUP_STATE_KEYS = Object.freeze([
  'ATTEMPT_STARTED_AT_UTC',
  'ATTEMPT_FINISHED_AT_UTC',
  'STATUS',
  'EXIT_CODE',
  'RUN_ID',
  'LOG_PATH'
]);
const MAX_BACKUP_AGE_MS = 2 * 60 * 60 * 1000;
const MAX_BACKUP_STATE_BYTES = 4096;
const DEFAULT_CACHE_TTL_MS = 30 * 1000;
const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const RUN_ID_PATTERN = /^\d{8}T\d{6}Z-[a-f0-9]{8}$/;
const LOG_PATH_PATTERN = /^\/var\/log\/xingxingzaishan-production-backup\/[^/=\r\n]+\.log$/;

function readinessError() {
  const error = new Error('Production readiness check failed.');
  error.code = 'PRODUCTION_NOT_READY';
  return error;
}

function parseBackupAttemptState(content, { nowMs = Date.now() } = {}) {
  const values = {};
  const lines = String(content || '').split('\n');

  for (const line of lines) {
    if (!line) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) throw readinessError();
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (!BACKUP_STATE_KEYS.includes(key) || Object.hasOwn(values, key)) {
      throw readinessError();
    }
    values[key] = value;
  }

  if (BACKUP_STATE_KEYS.some((key) => !Object.hasOwn(values, key))) {
    throw readinessError();
  }
  if (values.STATUS !== 'PASS'
      || values.EXIT_CODE !== '0'
      || !RUN_ID_PATTERN.test(values.RUN_ID)
      || !UTC_PATTERN.test(values.ATTEMPT_STARTED_AT_UTC)
      || !UTC_PATTERN.test(values.ATTEMPT_FINISHED_AT_UTC)
      || !LOG_PATH_PATTERN.test(values.LOG_PATH)) {
    throw readinessError();
  }

  const startedAt = Date.parse(values.ATTEMPT_STARTED_AT_UTC);
  const finishedAt = Date.parse(values.ATTEMPT_FINISHED_AT_UTC);
  if (!Number.isFinite(nowMs)
      || !Number.isFinite(startedAt)
      || !Number.isFinite(finishedAt)
      || new Date(startedAt).toISOString().replace('.000Z', 'Z') !== values.ATTEMPT_STARTED_AT_UTC
      || new Date(finishedAt).toISOString().replace('.000Z', 'Z') !== values.ATTEMPT_FINISHED_AT_UTC
      || finishedAt < startedAt
      || finishedAt > nowMs
      || nowMs - finishedAt > MAX_BACKUP_AGE_MS) {
    throw readinessError();
  }

  return true;
}

function readProtectedBackupAttempt({
  filePath = BACKUP_ATTEMPT_FILE,
  fsModule = fs,
  platform = process.platform,
  nowMs = Date.now()
} = {}) {
  let descriptor;
  try {
    descriptor = fsModule.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    const stat = fsModule.fstatSync(descriptor);
    if (!stat.isFile()
        || stat.size < 1
        || stat.size > MAX_BACKUP_STATE_BYTES
        || (platform !== 'win32' && (stat.uid !== 0 || (stat.mode & 0o777) !== 0o600))) {
      throw readinessError();
    }
    return parseBackupAttemptState(fsModule.readFileSync(descriptor, 'utf8'), { nowMs });
  } catch (_error) {
    throw readinessError();
  } finally {
    if (descriptor !== undefined) {
      try { fsModule.closeSync(descriptor); } catch (_error) {}
    }
  }
}

async function checkProductionPostgres({
  env = process.env,
  readConfig = readPostgresConfig,
  createPool = createPostgresPool,
  closePool = closePostgresPool,
  checkHealth = checkPostgresHealth
} = {}) {
  let pool;
  try {
    const config = readConfig(env);
    pool = createPool({
      config: {
        ...config,
        poolMax: 1,
        connectionTimeoutMillis: Math.min(config.connectionTimeoutMillis, 3000),
        statementTimeoutMillis: Math.min(config.statementTimeoutMillis || 3000, 3000),
        applicationName: 'xingxingzaishan-readiness'
      }
    });
    const result = await checkHealth(pool);
    return result && result.connected === true;
  } catch (_error) {
    return false;
  } finally {
    if (pool) {
      try { await closePool(pool); } catch (_error) {}
    }
  }
}

function createProductionReadinessChecker({
  env = process.env,
  now = Date.now,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  readBackup = readProtectedBackupAttempt,
  checkPostgres = checkProductionPostgres
} = {}) {
  let cachedUntil = 0;
  let cachedPromise = null;

  return function checkReadiness() {
    if (String(env.NODE_ENV || '').trim().toLowerCase() !== 'production') {
      return Promise.resolve(true);
    }

    const nowMs = Number(now());
    if (cachedPromise && nowMs < cachedUntil) return cachedPromise;

    cachedUntil = nowMs + cacheTtlMs;
    cachedPromise = (async () => {
      try {
        readBackup({ nowMs });
        return await checkPostgres({ env });
      } catch (_error) {
        return false;
      }
    })();
    return cachedPromise;
  };
}

module.exports = {
  BACKUP_ATTEMPT_FILE,
  DEFAULT_CACHE_TTL_MS,
  MAX_BACKUP_AGE_MS,
  checkProductionPostgres,
  createProductionReadinessChecker,
  parseBackupAttemptState,
  readProtectedBackupAttempt
};
