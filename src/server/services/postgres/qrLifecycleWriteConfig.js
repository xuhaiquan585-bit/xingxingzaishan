'use strict';

const { readPrimarySelectionScope } = require('./primarySelectionScope');
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
    scope: null,
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

  const selection = readPrimarySelectionScope({
    scopeValue: env.QR_LIFECYCLE_POSTGRES_WRITE_SCOPE,
    allowlistValue: env.QR_LIFECYCLE_POSTGRES_WRITE_ALLOWLIST,
    idPattern: PUBLIC_QR_ID_PATTERN
  });
  if (selection.error) return disabled(selection.error, { requested: true });

  const domainHash = String(env.QR_LIFECYCLE_POSTGRES_WRITE_DOMAIN_SHA256 || '').trim();
  if (!SOURCE_HASH_PATTERN.test(domainHash)) {
    return disabled('DOMAIN_SHA256_REQUIRED', { requested: true });
  }

  return Object.freeze({
    enabled: true,
    requested: true,
    reason: 'ENABLED',
    scope: selection.scope,
    allowlist: selection.allowlist,
    domainHash,
    timeoutMs: DEFAULT_TIMEOUT_MS
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  readQrLifecycleWriteConfig
};
