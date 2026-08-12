'use strict';

const { readPrimarySelectionScope } = require('./primarySelectionScope');
const {
  DOMAIN_HASH_PATTERN,
  readAuthorityBaselineDomain
} = require('./authorityBaselineDomain');

const DEFAULT_TIMEOUT_MS = 500;
const SOURCE_HASH_PATTERN = DOMAIN_HASH_PATTERN;
const PUBLIC_QR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

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

  const selection = readPrimarySelectionScope({
    scopeValue: env.PUBLIC_QR_POSTGRES_READ_SCOPE,
    allowlistValue: env.PUBLIC_QR_POSTGRES_READ_ALLOWLIST,
    idPattern: PUBLIC_QR_ID_PATTERN
  });
  if (selection.error) return disabled(selection.error, { requested: true });

  const domainHash = String(env.PUBLIC_QR_POSTGRES_READ_DOMAIN_SHA256 || '').trim();
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
  DEFAULT_TIMEOUT_MS,
  PUBLIC_QR_ID_PATTERN,
  SOURCE_HASH_PATTERN,
  readPublicQrPrimaryReadConfig
};
