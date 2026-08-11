'use strict';

const { parseAllowlist } = require('./shadowReadConfig');

const ALLOWLIST_SCOPE = 'allowlist';
const ALL_SCOPE = 'all';

function readPrimarySelectionScope({ scopeValue, allowlistValue, idPattern }) {
  const requestedScope = String(scopeValue || '').trim();
  const scope = requestedScope || ALLOWLIST_SCOPE;

  if (scope !== ALLOWLIST_SCOPE && scope !== ALL_SCOPE) {
    return Object.freeze({ error: 'SCOPE_INVALID' });
  }

  if (scope === ALL_SCOPE) {
    if (String(allowlistValue || '').trim()) {
      return Object.freeze({ error: 'ALLOWLIST_FORBIDDEN_FOR_ALL_SCOPE' });
    }
    return Object.freeze({ scope, allowlist: new Set() });
  }

  const allowlist = parseAllowlist(allowlistValue);
  if (!allowlist) return Object.freeze({ error: 'ALLOWLIST_REQUIRED' });
  if ([...allowlist].some((value) => !idPattern.test(value))) {
    return Object.freeze({ error: 'ALLOWLIST_INVALID' });
  }
  return Object.freeze({ scope, allowlist });
}

function hasValidPrimarySelectionScope(config) {
  if (!config || !(config.allowlist instanceof Set)) return false;
  if (config.scope === ALL_SCOPE) return config.allowlist.size === 0;
  return config.scope === ALLOWLIST_SCOPE && config.allowlist.size > 0;
}

function isSelectedByPrimaryScope(config, value) {
  const normalized = String(value || '').trim();
  if (!normalized || !hasValidPrimarySelectionScope(config)) return false;
  return config.scope === ALL_SCOPE || config.allowlist.has(normalized);
}

module.exports = {
  ALL_SCOPE,
  ALLOWLIST_SCOPE,
  hasValidPrimarySelectionScope,
  isSelectedByPrimaryScope,
  readPrimarySelectionScope
};
