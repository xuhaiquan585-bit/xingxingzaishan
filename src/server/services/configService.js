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

  const authSecret = process.env.AUTH_SECRET;
  if (!authSecret || authSecret === 'dev-only-change-me') {
    errors.push('AUTH_SECRET must be set and cannot use the default insecure value.');
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
