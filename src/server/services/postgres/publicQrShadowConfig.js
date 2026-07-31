'use strict';

const path = require('path');

const DEFAULT_TIMEOUT_MS = 250;
const DEFAULT_MAX_CONCURRENCY = 2;
const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_QUEUE_LIMIT = 100;

function disabled(reason) {
  return Object.freeze({
    enabled: false,
    reason,
    allowlist: new Set(),
    logDirectory: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    maxLogBytes: DEFAULT_MAX_LOG_BYTES,
    retentionDays: DEFAULT_RETENTION_DAYS,
    queueLimit: DEFAULT_QUEUE_LIMIT
  });
}

function parseAllowlist(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const entries = raw.split(',').map((item) => item.trim()).filter(Boolean);
  if (entries.length === 0 || entries.length > 1000) return null;
  if (entries.some((entry) => entry.length > 160 || /[\r\n\0]/.test(entry))) return null;
  return new Set(entries);
}

function isOutsideRepository(target, repositoryRoot) {
  const relative = path.relative(repositoryRoot, target);
  if (!relative) return false;
  if (path.isAbsolute(relative)) return true;
  return relative === '..' || relative.startsWith(`..${path.sep}`);
}

function readPublicQrShadowConfig(env = process.env, {
  repositoryRoot = path.resolve(__dirname, '..', '..', '..', '..')
} = {}) {
  const enabledValue = env && env.PUBLIC_QR_SHADOW_READ_ENABLED;
  if (enabledValue === undefined || enabledValue === null || String(enabledValue).trim() === '') {
    return disabled('DISABLED_BY_DEFAULT');
  }
  if (String(enabledValue).trim() !== 'true') {
    return disabled('INVALID_ENABLED_VALUE');
  }

  const allowlist = parseAllowlist(env.PUBLIC_QR_SHADOW_READ_ALLOWLIST);
  if (!allowlist) return disabled('ALLOWLIST_REQUIRED');

  const rawLogDirectory = String(env.PUBLIC_QR_SHADOW_READ_LOG_DIR || '').trim();
  if (!rawLogDirectory || !path.isAbsolute(rawLogDirectory)) {
    return disabled('ABSOLUTE_LOG_DIRECTORY_REQUIRED');
  }
  const logDirectory = path.resolve(rawLogDirectory);
  const normalizedRoot = path.resolve(repositoryRoot);
  if (!isOutsideRepository(logDirectory, normalizedRoot)) {
    return disabled('LOG_DIRECTORY_MUST_BE_OUTSIDE_REPOSITORY');
  }

  return Object.freeze({
    enabled: true,
    reason: 'ENABLED',
    allowlist,
    logDirectory,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    maxLogBytes: DEFAULT_MAX_LOG_BYTES,
    retentionDays: DEFAULT_RETENTION_DAYS,
    queueLimit: DEFAULT_QUEUE_LIMIT
  });
}

module.exports = {
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MAX_LOG_BYTES,
  DEFAULT_QUEUE_LIMIT,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_TIMEOUT_MS,
  parseAllowlist,
  readPublicQrShadowConfig
};
