'use strict';

const {
  PUBLIC_QR_ID_PATTERN,
  SOURCE_HASH_PATTERN
} = require('./publicQrPrimaryReadConfig');
const { readPrimarySelectionScope } = require('./primarySelectionScope');
const {
  REQUEST_TIMEOUT_MS,
  hasValidAvataRecordContractConfig
} = require('../avataService');

const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_MS = 5000;
const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_QUERY_MIN_AGE_MS = 60 * 1000;
const DEFAULT_QUERY_MAX_AGE_MS = 30 * 60 * 1000;
const DEFAULT_QUERY_BATCH_SIZE = 5;
const QUERY_LEASE_SAFETY_MARGIN_MS = 5000;
const MINIMUM_SAFE_LOCK_TIMEOUT_MS = REQUEST_TIMEOUT_MS
  + QUERY_LEASE_SAFETY_MARGIN_MS
  + 1;
const PRODUCTION_AVATA_BASE = 'https://apis.avata.bianjie.ai';
const AMBIGUOUS_NOT_FOUND_CODES = new Set(['NOT_FOUND']);

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
    lockTimeoutMs: DEFAULT_LOCK_TIMEOUT_MS,
    queryMinAgeMs: DEFAULT_QUERY_MIN_AGE_MS,
    queryMaxAgeMs: DEFAULT_QUERY_MAX_AGE_MS,
    queryBatchSize: DEFAULT_QUERY_BATCH_SIZE,
    operationNotFoundCode: null,
    callbackFeature: Object.freeze({ enabled: false, reason: 'CORE_DISABLED' }),
    certificateFeature: Object.freeze({ enabled: false, reason: 'CORE_DISABLED' }),
    certificateHostAllowlist: new Set()
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
    'AVATA_API_SECRET'
  ].every((key) => text(env[key]));
}

function providerRecordConfiguration(env) {
  return {
    recordType: Number(text(env.AVATA_RECORD_TYPE) || 1),
    hashType: Number(text(env.AVATA_HASH_TYPE) || 1)
  };
}

function hasValidProviderNumericConfiguration(env) {
  return hasValidAvataRecordContractConfig(providerRecordConfiguration(env));
}

function hasSecureCallbackUrl(value) {
  try {
    const parsed = new URL(text(value));
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
  } catch (_error) {
    return false;
  }
}

function readCertificateHostAllowlist(value) {
  const entries = text(value).split(',').map((entry) => entry.trim()).filter(Boolean);
  if (!entries.length || entries.length > 20) return null;
  const normalized = new Set();
  for (const entry of entries) {
    if (
      entry !== entry.toLowerCase()
      || entry === 'localhost'
      || entry.includes('*')
      || entry.includes('/')
      || entry.includes(':')
      || entry.length > 253
      || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(entry)
    ) return null;
    normalized.add(entry);
  }
  return normalized;
}

function hasProductionProviderConfiguration(source) {
  if (text(source.NODE_ENV) !== 'production') return true;
  if (!['prod', 'production'].includes(text(source.AVATA_ENV))) return false;
  const configuredBase = text(source.AVATA_API_BASE).replace(/\/$/, '');
  return !configuredBase || configuredBase === PRODUCTION_AVATA_BASE;
}

function readOperationNotFoundCode(value) {
  const normalized = text(value);
  if (
    !/^[A-Z][A-Z0-9_]{1,63}$/.test(normalized)
    || AMBIGUOUS_NOT_FOUND_CODES.has(normalized)
  ) return null;
  return normalized;
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
  if (!hasValidProviderNumericConfiguration(source)) {
    return disabled('CHAIN_PROVIDER_NUMERIC_CONFIG_INVALID');
  }
  if (!hasProductionProviderConfiguration(source)) {
    return disabled('PRODUCTION_CHAIN_PROVIDER_REQUIRED');
  }
  const operationNotFoundCode = readOperationNotFoundCode(
    source.AVATA_OPERATION_NOT_FOUND_CODE
  );
  const callbackUrl = text(source.CHAIN_CALLBACK_URL);
  const callbackFeature = Object.freeze({
    enabled: Boolean(callbackUrl) && hasSecureCallbackUrl(callbackUrl),
    reason: !callbackUrl
      ? 'NOT_CONFIGURED'
      : (hasSecureCallbackUrl(callbackUrl) ? 'ENABLED' : 'INVALID_CALLBACK_URL')
  });
  const certificateHosts = text(source.AVATA_CERTIFICATE_HOST_ALLOWLIST);
  const certificateHostAllowlist = readCertificateHostAllowlist(
    certificateHosts
  );
  const certificateFeature = Object.freeze({
    enabled: Boolean(certificateHostAllowlist),
    reason: !certificateHosts
      ? 'NOT_CONFIGURED'
      : (certificateHostAllowlist ? 'ENABLED' : 'INVALID_HOST_ALLOWLIST')
  });

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
    MINIMUM_SAFE_LOCK_TIMEOUT_MS,
    24 * 60 * 60 * 1000
  );
  const queryMinAgeMs = parseInteger(
    source.RECORD_PROOF_QUERY_MIN_AGE_MS,
    DEFAULT_QUERY_MIN_AGE_MS,
    10 * 1000,
    24 * 60 * 60 * 1000
  );
  const queryMaxAgeMs = parseInteger(
    source.RECORD_PROOF_QUERY_MAX_AGE_MS,
    DEFAULT_QUERY_MAX_AGE_MS,
    60 * 1000,
    7 * 24 * 60 * 60 * 1000
  );
  const queryBatchSize = parseInteger(
    source.RECORD_PROOF_QUERY_BATCH_SIZE,
    DEFAULT_QUERY_BATCH_SIZE,
    1,
    50
  );
  if ([
    intervalMs,
    batchSize,
    maxAttempts,
    retryBaseMs,
    lockTimeoutMs,
    queryMinAgeMs,
    queryMaxAgeMs,
    queryBatchSize
  ].includes(null)) {
    return disabled('WORKER_LIMIT_INVALID');
  }
  if (queryMaxAgeMs <= queryMinAgeMs) {
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
    lockTimeoutMs,
    queryMinAgeMs,
    queryMaxAgeMs,
    queryBatchSize,
    operationNotFoundCode,
    callbackFeature,
    certificateFeature,
    certificateHostAllowlist: certificateHostAllowlist || new Set()
  });
}

module.exports = {
  DEFAULT_BATCH_SIZE,
  DEFAULT_INTERVAL_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY_BASE_MS,
  DEFAULT_QUERY_BATCH_SIZE,
  DEFAULT_QUERY_MAX_AGE_MS,
  DEFAULT_QUERY_MIN_AGE_MS,
  QUERY_LEASE_SAFETY_MARGIN_MS,
  MINIMUM_SAFE_LOCK_TIMEOUT_MS,
  PRODUCTION_AVATA_BASE,
  readCertificateHostAllowlist,
  readOperationNotFoundCode,
  readRecordProofRuntimeConfig
};
