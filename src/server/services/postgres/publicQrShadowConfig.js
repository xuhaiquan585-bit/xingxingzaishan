'use strict';

const {
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MAX_LOG_BYTES,
  DEFAULT_QUEUE_LIMIT,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_TIMEOUT_MS,
  parseAllowlist,
  readStrictShadowConfig
} = require('./shadowReadConfig');

function readPublicQrShadowConfig(env = process.env, options = {}) {
  return readStrictShadowConfig({
    env,
    ...options,
    enabledName: 'PUBLIC_QR_SHADOW_READ_ENABLED',
    allowlistName: 'PUBLIC_QR_SHADOW_READ_ALLOWLIST',
    logDirectoryName: 'PUBLIC_QR_SHADOW_READ_LOG_DIR'
  });
}

module.exports = {
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MAX_LOG_BYTES,
  DEFAULT_QUEUE_LIMIT,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_TIMEOUT_MS,
  parseAllowlist,
  readPublicQrShadowConfig
};
