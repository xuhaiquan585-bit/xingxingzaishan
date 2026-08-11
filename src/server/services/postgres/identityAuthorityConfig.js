'use strict';

const { SOURCE_HASH_PATTERN } = require('./publicQrPrimaryReadConfig');

const DEFAULT_TIMEOUT_MS = 2_000;

function disabled(reason, { requested = false } = {}) {
  return Object.freeze({
    enabled: false,
    requested,
    reason,
    scope: null,
    sourceHash: null,
    domainHash: null,
    timeoutMs: DEFAULT_TIMEOUT_MS
  });
}

function text(value) {
  return String(value || '').trim();
}

function readIdentityAuthorityConfig(env = process.env) {
  const source = env && typeof env === 'object' ? env : {};
  const enabled = text(source.IDENTITY_POSTGRES_AUTHORITY_ENABLED);

  if (!enabled) return disabled('DISABLED_BY_DEFAULT');
  if (enabled === 'false') return disabled('EXPLICITLY_DISABLED');
  if (enabled !== 'true') return disabled('INVALID_ENABLED_VALUE', { requested: true });

  if (text(source.IDENTITY_POSTGRES_AUTHORITY_SCOPE) !== 'all') {
    return disabled('SCOPE_ALL_REQUIRED', { requested: true });
  }
  if (text(source.IDENTITY_POSTGRES_AUTHORITY_ALLOWLIST)) {
    return disabled('ALLOWLIST_FORBIDDEN', { requested: true });
  }

  const sourceHash = text(source.IDENTITY_POSTGRES_AUTHORITY_SOURCE_SHA256).toLowerCase();
  if (!SOURCE_HASH_PATTERN.test(sourceHash)) {
    return disabled('SOURCE_SHA256_REQUIRED', { requested: true });
  }

  const domainHash = text(source.IDENTITY_POSTGRES_AUTHORITY_DOMAIN_SHA256).toLowerCase();
  if (!SOURCE_HASH_PATTERN.test(domainHash)) {
    return disabled('DOMAIN_SHA256_REQUIRED', { requested: true });
  }

  return Object.freeze({
    enabled: true,
    requested: true,
    reason: 'ENABLED',
    scope: 'all',
    sourceHash,
    domainHash,
    timeoutMs: DEFAULT_TIMEOUT_MS
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  readIdentityAuthorityConfig
};
