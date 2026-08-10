'use strict';

const { parseAllowlist } = require('./shadowReadConfig');

const DEFAULT_TIMEOUT_MS = 500;
const SOURCE_HASH_PATTERN = /^[a-f0-9]{64}$/;
const PUBLIC_QR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function disabled(reason, { requested = false } = {}) {
  return Object.freeze({
    enabled: false,
    requested,
    reason,
    allowlist: new Set(),
    sourceHash: null,
    timeoutMs: DEFAULT_TIMEOUT_MS
  });
}

function readPublicQrPrimaryReadConfig(env = process.env) {
  const enabledValue = env && env.PUBLIC_QR_POSTGRES_READ_ENABLED;
  const normalizedEnabled = enabledValue === undefined || enabledValue === null
    ? ''
    : String(enabledValue).trim();

  if (!normalizedEnabled) return disabled('DISABLED_BY_DEFAULT');
  if (normalizedEnabled === 'false') return disabled('EXPLICITLY_DISABLED');
  if (normalizedEnabled !== 'true') {
    return disabled('INVALID_ENABLED_VALUE', { requested: true });
  }

  const allowlist = parseAllowlist(env.PUBLIC_QR_POSTGRES_READ_ALLOWLIST);
  if (!allowlist) return disabled('ALLOWLIST_REQUIRED', { requested: true });
  if ([...allowlist].some((value) => !PUBLIC_QR_ID_PATTERN.test(value))) {
    return disabled('ALLOWLIST_INVALID', { requested: true });
  }

  const sourceHash = String(env.PUBLIC_QR_POSTGRES_READ_SOURCE_SHA256 || '').trim();
  if (!SOURCE_HASH_PATTERN.test(sourceHash)) {
    return disabled('SOURCE_SHA256_REQUIRED', { requested: true });
  }

  return Object.freeze({
    enabled: true,
    requested: true,
    reason: 'ENABLED',
    allowlist,
    sourceHash,
    timeoutMs: DEFAULT_TIMEOUT_MS
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  PUBLIC_QR_ID_PATTERN,
  SOURCE_HASH_PATTERN,
  readPublicQrPrimaryReadConfig
};
