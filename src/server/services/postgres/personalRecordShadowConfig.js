'use strict';

const { readStrictShadowConfig } = require('./shadowReadConfig');

function readPersonalRecordShadowConfig(env = process.env, options = {}) {
  return readStrictShadowConfig({
    env,
    ...options,
    enabledName: 'PERSONAL_RECORD_SHADOW_READ_ENABLED',
    allowlistName: 'PERSONAL_RECORD_SHADOW_READ_ALLOWLIST',
    logDirectoryName: 'PERSONAL_RECORD_SHADOW_READ_LOG_DIR'
  });
}

module.exports = { readPersonalRecordShadowConfig };
