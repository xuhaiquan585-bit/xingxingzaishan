'use strict';

const { parseAllowlist } = require('./shadowReadConfig');
const {
  PUBLIC_QR_ID_PATTERN,
  SOURCE_HASH_PATTERN
} = require('./publicQrPrimaryReadConfig');

const DEFAULT_TIMEOUT_MS = 2_000;

function disabled(reason, { requested = false } = {}) {
  return Object.freeze({
    enabled: false,
    requested,
    reason,
    allowlist: new Set(),
    domainHash: null,
    timeoutMs: DEFAULT_TIMEOUT_MS
  });
}

function readQrLifecycleWriteConfig(env = process.env) {
  const enabledValue = env && env.QR_LIFECYCLE_POSTGRES_WRITE_ENABLED;
  const normalizedEnabled = enabledValue === undefined || enabledValue === null
    ? ''
    : String(enabledValue).trim();

  if (!normalizedEnabled) return disabled('DISABLED_BY_DEFAULT');
  if (normalizedEnabled === 'false') return disabled('EXPLICITLY_DISABLED');
  if (normalizedEnabled !== 'true') {
    return disabled('INVALID_ENABLED_VALUE', { requested: true });
  }

  const allowlist = parseAllowlist(env.QR_LIFECYCLE_POSTGRES_WRITE_ALLOWLIST);
  if (!allowlist) return disabled('ALLOWLIST_REQUIRED', { requested: true });
  if ([...allowlist].some((value) => !PUBLIC_QR_ID_PATTERN.test(value))) {
    return disabled('ALLOWLIST_INVALID', { requested: true });
  }

  const domainHash = String(env.QR_LIFECYCLE_POSTGRES_WRITE_DOMAIN_SHA256 || '').trim();
  if (!SOURCE_HASH_PATTERN.test(domainHash)) {
    return disabled('DOMAIN_SHA256_REQUIRED', { requested: true });
  }

  return Object.freeze({
    enabled: true,
    requested: true,
    reason: 'ENABLED',
    allowlist,
    domainHash,
    timeoutMs: DEFAULT_TIMEOUT_MS
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  readQrLifecycleWriteConfig
};
