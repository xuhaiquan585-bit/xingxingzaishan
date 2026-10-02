function parseOrigins(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function validateOptionalInteger(errors, name, {
  minimum = 1,
  maximum = Number.MAX_SAFE_INTEGER
} = {}, environment = process.env) {
  const raw = environment[name];
  if (raw === undefined || String(raw).trim() === '') return;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    errors.push(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
}

function isSafeProductionBaseUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'https:'
      && Boolean(parsed.hostname)
      && !parsed.username
      && !parsed.password
      && parsed.pathname === '/'
      && !parsed.search
      && !parsed.hash;
  } catch (_error) {
    return false;
  }
}

function validateRuntimeConfig(environment = process.env) {
  const errors = [];
  const warnings = [];
  const nodeEnv = String(environment.NODE_ENV || '').trim().toLowerCase();
  if (!['production', 'development', 'test'].includes(nodeEnv)) {
    errors.push('NODE_ENV must be explicitly set to production, development, or test.');
  }

  validateOptionalInteger(errors, 'PORT', { minimum: 1, maximum: 65535 }, environment);
  validateOptionalInteger(errors, 'AUTH_TOKEN_TTL_SECONDS', {}, environment);
  validateOptionalInteger(errors, 'MINIAPP_TOKEN_TTL_SECONDS', {}, environment);
  validateOptionalInteger(errors, 'USER_SESSION_TTL_SECONDS', {}, environment);
  validateOptionalInteger(errors, 'SMS_CODE_TTL_MS', {}, environment);
  validateOptionalInteger(errors, 'SMS_SEND_COOLDOWN_MS', { minimum: 0 }, environment);
  validateOptionalInteger(errors, 'SMS_CODE_MAX_VERIFY_ATTEMPTS', {}, environment);
  validateOptionalInteger(errors, 'RATE_LIMIT_LOGIN_WINDOW_MS', {}, environment);
  validateOptionalInteger(errors, 'RATE_LIMIT_LOGIN_MAX', {}, environment);
  validateOptionalInteger(errors, 'RATE_LIMIT_WRITE_WINDOW_MS', {}, environment);
  validateOptionalInteger(errors, 'RATE_LIMIT_WRITE_MAX', {}, environment);
  validateOptionalInteger(errors, 'OSS_SIGNED_URL_EXPIRES', {}, environment);

  const authSecret = String(environment.AUTH_SECRET || '');
  if (!authSecret || authSecret === 'dev-only-change-me') {
    errors.push('AUTH_SECRET must be set and cannot use the default insecure value.');
  } else if (Buffer.byteLength(authSecret, 'utf8') < 32) {
    errors.push('AUTH_SECRET must contain at least 32 UTF-8 bytes.');
  }

  const uploadProofSecret = String(environment.UPLOAD_PROOF_SECRET || '');
  if (Buffer.byteLength(uploadProofSecret, 'utf8') < 32) {
    errors.push('UPLOAD_PROOF_SECRET must contain at least 32 UTF-8 bytes.');
  } else if (uploadProofSecret === String(authSecret || '')) {
    errors.push('UPLOAD_PROOF_SECRET must not reuse AUTH_SECRET.');
  }

  const mode = String(environment.STORAGE_MODE || 'local').trim();
  if (!['local', 'cloud'].includes(mode)) {
    errors.push('STORAGE_MODE must be local or cloud.');
  }
  if (mode === 'cloud') {
    const required = ['OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET', 'OSS_BUCKET', 'OSS_REGION', 'OSS_ENDPOINT'];
    required.forEach((name) => {
      if (!environment[name]) {
        errors.push(`${name} is required when STORAGE_MODE=cloud.`);
      }
    });
  }

  const origins = parseOrigins(environment.CORS_ORIGINS);
  if (origins.length === 0) {
    warnings.push('CORS_ORIGINS is empty: cross-origin browser requests are disabled by default.');
  }

  const smsProvider = String(environment.SMS_PROVIDER || 'mock').trim().toLowerCase();
  const smsRequired = ['SMS_ACCESS_KEY_ID', 'SMS_ACCESS_KEY_SECRET', 'SMS_SIGN_NAME', 'SMS_TEMPLATE_CODE'];
  if (smsProvider === 'aliyun') {
    smsRequired.forEach((name) => {
      if (!environment[name]) {
        errors.push(`${name} is required when SMS_PROVIDER=aliyun.`);
      }
    });
  }

  if (nodeEnv === 'production' && smsProvider !== 'aliyun') {
    errors.push('SMS_PROVIDER must be aliyun in production.');
  }

  if (nodeEnv === 'production') {
    if (!isSafeProductionBaseUrl(environment.BASE_URL)) {
      errors.push('BASE_URL must be an HTTPS origin without credentials, path, query, or hash in production.');
    }
    if (mode !== 'cloud') {
      errors.push('STORAGE_MODE must be cloud in production.');
    }
    if (String(environment.CLOUD_FALLBACK_TO_LOCAL || '').trim().toLowerCase() === 'true') {
      errors.push('CLOUD_FALLBACK_TO_LOCAL must not be true in production.');
    }
    if (String(environment.USER_LEGACY_LOGIN_ENABLED || '').toLowerCase() !== 'false') {
      errors.push('USER_LEGACY_LOGIN_ENABLED must be false in production.');
    }
    if (String(environment.USER_SESSION_SECURE || '').toLowerCase() !== 'true') {
      errors.push('USER_SESSION_SECURE must be true in production.');
    }
    const sameSite = String(environment.USER_SESSION_SAMESITE || 'Lax').trim().toLowerCase();
    if (!['lax', 'strict'].includes(sameSite)) {
      errors.push('USER_SESSION_SAMESITE must be Lax or Strict in production.');
    }
    ['WECHAT_MINIAPP_APPID', 'WECHAT_MINIAPP_SECRET'].forEach((name) => {
      if (!environment[name]) {
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
  isSafeProductionBaseUrl,
  parseOrigins,
  validateOptionalInteger,
  validateRuntimeConfig,
  assertRuntimeConfig
};
