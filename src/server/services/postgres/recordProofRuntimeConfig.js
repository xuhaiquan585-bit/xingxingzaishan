'use strict';

const {
  PUBLIC_QR_ID_PATTERN,
  SOURCE_HASH_PATTERN
} = require('./publicQrPrimaryReadConfig');
const { readPrimarySelectionScope } = require('./primarySelectionScope');

const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_MS = 5000;
const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60 * 1000;

function disabled(reason) {
  return Object.freeze({
    enabled: false,
    reason,
    scope: null,
    allowlist: new Set(),
    sourceSha256: null,
    domainSha256: null,
    workerId: null,
    intervalMs: DEFAULT_INTERVAL_MS,
    batchSize: DEFAULT_BATCH_SIZE,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    retryBaseMs: DEFAULT_RETRY_BASE_MS,
    lockTimeoutMs: DEFAULT_LOCK_TIMEOUT_MS
  });
}

function text(value) {
  return String(value || '').trim();
}

function parseInteger(value, fallback, minimum, maximum) {
  const normalized = text(value);
  if (!normalized) return fallback;
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : null;
}

function hasProviderConfiguration(env) {
  return [
    'AVATA_API_KEY',
    'AVATA_API_SECRET',
    'AVATA_IDENTITY_NAME',
    'AVATA_IDENTITY_NUM'
  ].every((key) => text(env[key]));
}

function hasSecureCallbackUrl(value) {
  try {
    const parsed = new URL(text(value));
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
  } catch (_error) {
    return false;
  }
}

function readRecordProofRuntimeConfig(env = process.env) {
  const source = env && typeof env === 'object' ? env : {};
  const enabled = text(source.RECORD_PROOF_RUNTIME_ENABLED);
  if (!enabled) return disabled('DISABLED_BY_DEFAULT');
  if (enabled === 'false') return disabled('DISABLED_BY_CONFIGURATION');
  if (enabled !== 'true') return disabled('INVALID_ENABLED_VALUE');

  const selection = readPrimarySelectionScope({
    scopeValue: source.RECORD_PROOF_RUNTIME_SCOPE,
    allowlistValue: source.RECORD_PROOF_RUNTIME_ALLOWLIST,
    idPattern: PUBLIC_QR_ID_PATTERN
  });
  if (selection.error) return disabled(selection.error);

  const sourceSha256 = text(source.RECORD_PROOF_RUNTIME_SOURCE_SHA256).toLowerCase();
  if (!SOURCE_HASH_PATTERN.test(sourceSha256)) {
    return disabled('SOURCE_SHA256_REQUIRED');
  }
  const domainSha256 = text(source.RECORD_PROOF_RUNTIME_DOMAIN_SHA256).toLowerCase();
  if (!SOURCE_HASH_PATTERN.test(domainSha256)) {
    return disabled('DOMAIN_SHA256_REQUIRED');
  }

  const workerId = text(source.RECORD_PROOF_WORKER_ID);
  if (!workerId || workerId.length > 160 || /[\r\n\0]/.test(workerId)) {
    return disabled('WORKER_ID_REQUIRED');
  }
  if (text(source.CHAIN_ENABLED) !== 'true') {
    return disabled('CHAIN_PROVIDER_REQUIRED');
  }
  if (!hasProviderConfiguration(source)) {
    return disabled('CHAIN_PROVIDER_CONFIG_REQUIRED');
  }
  if (!hasSecureCallbackUrl(source.CHAIN_CALLBACK_URL)) {
    return disabled('SECURE_CALLBACK_URL_REQUIRED');
  }

  const intervalMs = parseInteger(
    source.RECORD_PROOF_WORKER_INTERVAL_MS,
    DEFAULT_INTERVAL_MS,
    1000,
    5 * 60 * 1000
  );
  const batchSize = parseInteger(
    source.RECORD_PROOF_WORKER_BATCH_SIZE,
    DEFAULT_BATCH_SIZE,
    1,
    50
  );
  const maxAttempts = parseInteger(
    source.RECORD_PROOF_WORKER_MAX_ATTEMPTS,
    DEFAULT_MAX_ATTEMPTS,
    1,
    100
  );
  const retryBaseMs = parseInteger(
    source.RECORD_PROOF_WORKER_RETRY_BASE_MS,
    DEFAULT_RETRY_BASE_MS,
    1000,
    60 * 60 * 1000
  );
  const lockTimeoutMs = parseInteger(
    source.RECORD_PROOF_WORKER_LOCK_TIMEOUT_MS,
    DEFAULT_LOCK_TIMEOUT_MS,
    1000,
    24 * 60 * 60 * 1000
  );
  if ([intervalMs, batchSize, maxAttempts, retryBaseMs, lockTimeoutMs].includes(null)) {
    return disabled('WORKER_LIMIT_INVALID');
  }

  return Object.freeze({
    enabled: true,
    reason: 'ENABLED',
    scope: selection.scope,
    allowlist: selection.allowlist,
    sourceSha256,
    domainSha256,
    workerId,
    intervalMs,
    batchSize,
    maxAttempts,
    retryBaseMs,
    lockTimeoutMs
  });
}

module.exports = {
  DEFAULT_BATCH_SIZE,
  DEFAULT_INTERVAL_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY_BASE_MS,
  readRecordProofRuntimeConfig
};
