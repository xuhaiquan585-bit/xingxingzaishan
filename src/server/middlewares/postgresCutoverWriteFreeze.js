'use strict';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

class PostgresCutoverWriteFreezeError extends Error {
  constructor(code) {
    super(code);
    this.name = 'PostgresCutoverWriteFreezeError';
    this.code = code;
  }
}

function normalizedText(value) {
  return String(value || '').trim();
}

function readPostgresCutoverWriteFreezeConfig(env = process.env) {
  const value = normalizedText(
    env && env.POSTGRES_CUTOVER_WRITE_FREEZE_ENABLED
  );
  if (!value || value === 'false') {
    return Object.freeze({ enabled: false });
  }
  if (value === 'true') {
    return Object.freeze({ enabled: true });
  }
  throw new PostgresCutoverWriteFreezeError(
    'POSTGRES_CUTOVER_WRITE_FREEZE_CONFIG_INVALID'
  );
}

function createPostgresCutoverWriteFreeze(config) {
  if (!config || typeof config.enabled !== 'boolean') {
    throw new PostgresCutoverWriteFreezeError(
      'POSTGRES_CUTOVER_WRITE_FREEZE_CONFIG_INVALID'
    );
  }

  return (req, res, next) => {
    if (!config.enabled || SAFE_METHODS.has(req.method)) {
      return next();
    }

    res.setHeader('Retry-After', '60');
    return res.status(503).json({
      status: 'error',
      code: 'POSTGRES_CUTOVER_WRITE_FROZEN',
      message: '系统维护中，请稍后重试。'
    });
  };
}

module.exports = {
  PostgresCutoverWriteFreezeError,
  createPostgresCutoverWriteFreeze,
  readPostgresCutoverWriteFreezeConfig
};
