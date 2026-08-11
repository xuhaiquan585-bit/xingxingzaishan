'use strict';

const { parseAllowlist } = require('./shadowReadConfig');
const { SOURCE_HASH_PATTERN } = require('./publicQrPrimaryReadConfig');

const DEFAULT_TIMEOUT_MS = 500;
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

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

function readPersonalRecordPrimaryReadConfig(env = process.env) {
  const enabledValue = env && env.PERSONAL_RECORD_POSTGRES_READ_ENABLED;
  const normalizedEnabled = enabledValue === undefined || enabledValue === null
    ? ''
    : String(enabledValue).trim();

  if (!normalizedEnabled) return disabled('DISABLED_BY_DEFAULT');
  if (normalizedEnabled === 'false') return disabled('EXPLICITLY_DISABLED');
  if (normalizedEnabled !== 'true') {
    return disabled('INVALID_ENABLED_VALUE', { requested: true });
  }

  const allowlist = parseAllowlist(env.PERSONAL_RECORD_POSTGRES_READ_ALLOWLIST);
  if (!allowlist) return disabled('ALLOWLIST_REQUIRED', { requested: true });
  if ([...allowlist].some((value) => !ACCOUNT_ID_PATTERN.test(value))) {
    return disabled('ALLOWLIST_INVALID', { requested: true });
  }

  const domainHash = String(env.PERSONAL_RECORD_POSTGRES_READ_DOMAIN_SHA256 || '').trim();
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
  ACCOUNT_ID_PATTERN,
  DEFAULT_TIMEOUT_MS,
  readPersonalRecordPrimaryReadConfig
};
