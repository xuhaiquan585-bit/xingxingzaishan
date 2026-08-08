'use strict';

const { readStrictShadowConfig } = require('./shadowReadConfig');

function readIdentityShadowConfig(env = process.env, options = {}) {
  return readStrictShadowConfig({
    env,
    ...options,
    enabledName: 'IDENTITY_SHADOW_READ_ENABLED',
    allowlistName: 'IDENTITY_SHADOW_READ_ALLOWLIST',
    logDirectoryName: 'IDENTITY_SHADOW_READ_LOG_DIR'
  });
}

module.exports = { readIdentityShadowConfig };
