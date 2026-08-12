'use strict';

const { readPrimarySelectionScope } = require('./primarySelectionScope');
const { SOURCE_HASH_PATTERN } = require('./publicQrPrimaryReadConfig');
const {
  readAuthorityBaselineDomain
} = require('./authorityBaselineDomain');

const DEFAULT_TIMEOUT_MS = 500;
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function disabled(reason, { requested = false } = {}) {
  return Object.freeze({
    enabled: false,
    requested,
    reason,
    scope: null,
    allowlist: new Set(),
    domainHash: null,
    baselineDomainHash: null,
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

  const selection = readPrimarySelectionScope({
    scopeValue: env.PERSONAL_RECORD_POSTGRES_READ_SCOPE,
    allowlistValue: env.PERSONAL_RECORD_POSTGRES_READ_ALLOWLIST,
    idPattern: ACCOUNT_ID_PATTERN
  });
  if (selection.error) return disabled(selection.error, { requested: true });

  const domainHash = String(env.PERSONAL_RECORD_POSTGRES_READ_DOMAIN_SHA256 || '').trim();
  if (!SOURCE_HASH_PATTERN.test(domainHash)) {
    return disabled('DOMAIN_SHA256_REQUIRED', { requested: true });
  }
  const baseline = readAuthorityBaselineDomain(env, domainHash);
  if (baseline.error) return disabled(baseline.error, { requested: true });

  return Object.freeze({
    enabled: true,
    requested: true,
    reason: 'ENABLED',
    scope: selection.scope,
    allowlist: selection.allowlist,
    domainHash,
    baselineDomainHash: baseline.baselineDomainHash,
    timeoutMs: DEFAULT_TIMEOUT_MS
  });
}

module.exports = {
  ACCOUNT_ID_PATTERN,
  DEFAULT_TIMEOUT_MS,
  readPersonalRecordPrimaryReadConfig
};
