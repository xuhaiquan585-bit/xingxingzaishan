function parseOrigins(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function validateRuntimeConfig() {
  const errors = [];
  const warnings = [];
  const nodeEnv = String(process.env.NODE_ENV || '').trim().toLowerCase();
  if (!['production', 'development', 'test'].includes(nodeEnv)) {
    errors.push('NODE_ENV must be explicitly set to production, development, or test.');
  }

  const authSecret = process.env.AUTH_SECRET;
  if (!authSecret || authSecret === 'dev-only-change-me') {
    errors.push('AUTH_SECRET must be set and cannot use the default insecure value.');
  }

  const uploadProofSecret = String(process.env.UPLOAD_PROOF_SECRET || '');
  if (Buffer.byteLength(uploadProofSecret, 'utf8') < 32) {
    errors.push('UPLOAD_PROOF_SECRET must contain at least 32 UTF-8 bytes.');
  } else if (uploadProofSecret === String(authSecret || '')) {
    errors.push('UPLOAD_PROOF_SECRET must not reuse AUTH_SECRET.');
  }

  const mode = process.env.STORAGE_MODE || 'local';
  if (mode === 'cloud') {
    const required = ['OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET', 'OSS_BUCKET', 'OSS_REGION', 'OSS_ENDPOINT'];
    required.forEach((name) => {
      if (!process.env[name]) {
        errors.push(`${name} is required when STORAGE_MODE=cloud.`);
      }
    });
  }

  const origins = parseOrigins(process.env.CORS_ORIGINS);
  if (origins.length === 0) {
    warnings.push('CORS_ORIGINS is empty: cross-origin browser requests are disabled by default.');
  }

  const smsProvider = String(process.env.SMS_PROVIDER || 'mock').trim().toLowerCase();
  const smsRequired = ['SMS_ACCESS_KEY_ID', 'SMS_ACCESS_KEY_SECRET', 'SMS_SIGN_NAME', 'SMS_TEMPLATE_CODE'];
  if (smsProvider === 'aliyun') {
    smsRequired.forEach((name) => {
      if (!process.env[name]) {
        errors.push(`${name} is required when SMS_PROVIDER=aliyun.`);
      }
    });
  }

  if (nodeEnv === 'production' && smsProvider !== 'aliyun') {
    errors.push('SMS_PROVIDER must be aliyun in production.');
  }

  if (nodeEnv === 'production') {
    if (String(process.env.USER_LEGACY_LOGIN_ENABLED || '').toLowerCase() !== 'false') {
      errors.push('USER_LEGACY_LOGIN_ENABLED must be false in production.');
    }
    if (String(process.env.USER_SESSION_SECURE || '').toLowerCase() !== 'true') {
      errors.push('USER_SESSION_SECURE must be true in production.');
    }
    ['WECHAT_MINIAPP_APPID', 'WECHAT_MINIAPP_SECRET'].forEach((name) => {
      if (!process.env[name]) {
        errors.push(`${name} is required in production for miniapp login and content safety.`);
      }
    });
  }

  return {
    errors,
    warnings
  };
}

function assertRuntimeConfig() {
  const result = validateRuntimeConfig();
  if (result.errors.length > 0) {
    const message = `CONFIG_VALIDATION_FAILED\n- ${result.errors.join('\n- ')}`;
    const error = new Error(message);
    error.code = 'CONFIG_VALIDATION_FAILED';
    throw error;
  }
  return result;
}

module.exports = {
  parseOrigins,
  validateRuntimeConfig,
  assertRuntimeConfig
};
