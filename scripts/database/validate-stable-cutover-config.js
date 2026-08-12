'use strict';

const fs = require('node:fs');

const {
  readIdentityAuthorityConfig
} = require('../../src/server/services/postgres/identityAuthorityConfig');
const {
  readPersonalRecordPrimaryReadConfig
} = require('../../src/server/services/postgres/personalRecordPrimaryReadConfig');
const {
  readPublicQrPrimaryReadConfig
} = require('../../src/server/services/postgres/publicQrPrimaryReadConfig');
const {
  readQrIssuanceAuthorityConfig
} = require('../../src/server/services/postgres/qrIssuanceAuthorityConfig');
const {
  readQrLifecycleWriteConfig
} = require('../../src/server/services/postgres/qrLifecycleWriteConfig');
const {
  readRecordProofRuntimeConfig
} = require('../../src/server/services/postgres/recordProofRuntimeConfig');

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function text(value) {
  return String(value || '').trim();
}

function parseArgs(argv) {
  const args = {};
  for (const entry of argv) {
    if (!entry.startsWith('--') || !entry.includes('=')) {
      fail('STABLE_CUTOVER_CONFIG_ARGUMENT_INVALID');
    }
    const [key, ...parts] = entry.slice(2).split('=');
    if (!key || Object.hasOwn(args, key)) {
      fail('STABLE_CUTOVER_CONFIG_ARGUMENT_INVALID');
    }
    args[key] = parts.join('=');
  }
  return args;
}

function parseEnvironment(bytes) {
  const env = {};
  for (const rawLine of bytes.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/u);
    if (!match || Object.hasOwn(env, match[1])) {
      fail('STABLE_CUTOVER_CONFIG_FILE_INVALID');
    }
    env[match[1]] = match[2];
  }
  return env;
}

function assertConfig(config, name) {
  if (!config || config.enabled !== true) {
    fail(`STABLE_CUTOVER_${name}_${config?.reason || 'INVALID'}`);
  }
  if (config.scope !== 'all') fail(`STABLE_CUTOVER_${name}_SCOPE_INVALID`);
  if (config.allowlist instanceof Set && config.allowlist.size !== 0) {
    fail(`STABLE_CUTOVER_${name}_ALLOWLIST_FORBIDDEN`);
  }
}

function normalizeProviderEnvironment(value) {
  const normalized = text(value).toLowerCase();
  if (normalized === 'production') return 'prod';
  if (normalized === 'staging') return 'stage';
  if (normalized === 'prod' || normalized === 'stage') return normalized;
  fail('STABLE_CUTOVER_PROVIDER_ENVIRONMENT_INVALID');
}

function assertProviderOrigin(processEnv, expectedEnvironment, expectedOriginValue) {
  const actualEnvironment = normalizeProviderEnvironment(processEnv.AVATA_ENV);
  if (actualEnvironment !== expectedEnvironment) {
    fail('STABLE_CUTOVER_PROVIDER_ENVIRONMENT_MISMATCH');
  }
  const fallback = actualEnvironment === 'prod'
    ? 'https://apis.avata.bianjie.ai'
    : 'https://stage.apis.avata.bianjie.ai';
  let actual;
  let expected;
  try {
    actual = new URL(text(processEnv.AVATA_API_BASE) || fallback);
    expected = new URL(expectedOriginValue);
  } catch (_error) {
    fail('STABLE_CUTOVER_PROVIDER_ORIGIN_INVALID');
  }
  if (actual.protocol !== 'https:' || actual.username || actual.password
      || expected.protocol !== 'https:' || expected.username || expected.password
      || expected.pathname !== '/' || expected.search || expected.hash
      || actual.origin !== expected.origin) {
    fail('STABLE_CUTOVER_PROVIDER_ORIGIN_MISMATCH');
  }
}

function assertExactSelectors(env, sourceHash, domainHash) {
  const expected = {
    PUBLIC_QR_POSTGRES_READ_ENABLED: 'true',
    PUBLIC_QR_POSTGRES_READ_SCOPE: 'all',
    PUBLIC_QR_POSTGRES_READ_DOMAIN_SHA256: domainHash,
    PERSONAL_RECORD_POSTGRES_READ_ENABLED: 'true',
    PERSONAL_RECORD_POSTGRES_READ_SCOPE: 'all',
    PERSONAL_RECORD_POSTGRES_READ_DOMAIN_SHA256: domainHash,
    QR_LIFECYCLE_POSTGRES_WRITE_ENABLED: 'true',
    QR_LIFECYCLE_POSTGRES_WRITE_SCOPE: 'all',
    QR_LIFECYCLE_POSTGRES_WRITE_DOMAIN_SHA256: domainHash,
    IDENTITY_POSTGRES_AUTHORITY_ENABLED: 'true',
    IDENTITY_POSTGRES_AUTHORITY_SCOPE: 'all',
    IDENTITY_POSTGRES_AUTHORITY_SOURCE_SHA256: sourceHash,
    IDENTITY_POSTGRES_AUTHORITY_DOMAIN_SHA256: domainHash,
    QR_ISSUANCE_POSTGRES_AUTHORITY_ENABLED: 'true',
    QR_ISSUANCE_POSTGRES_AUTHORITY_SCOPE: 'all',
    QR_ISSUANCE_POSTGRES_AUTHORITY_SOURCE_SHA256: sourceHash,
    QR_ISSUANCE_POSTGRES_AUTHORITY_DOMAIN_SHA256: domainHash,
    RECORD_PROOF_RUNTIME_ENABLED: 'true',
    RECORD_PROOF_RUNTIME_SCOPE: 'all',
    RECORD_PROOF_RUNTIME_SOURCE_SHA256: sourceHash,
    RECORD_PROOF_RUNTIME_DOMAIN_SHA256: domainHash,
    PUBLIC_QR_SHADOW_READ_ENABLED: 'false',
    PERSONAL_RECORD_SHADOW_READ_ENABLED: 'false',
    IDENTITY_SHADOW_READ_ENABLED: 'false'
  };
  for (const [key, value] of Object.entries(expected)) {
    if (env[key] !== value) fail(`STABLE_CUTOVER_CONFIG_VALUE_INVALID_${key}`);
  }

  if (Object.keys(env).some(key => key.endsWith('_ALLOWLIST'))) {
    fail('STABLE_CUTOVER_ALLOWLIST_FORBIDDEN');
  }

  const knownSelectorKeys = new Set([
    ...Object.keys(expected),
    'RECORD_PROOF_WORKER_ID',
    'RECORD_PROOF_WORKER_INTERVAL_MS',
    'RECORD_PROOF_WORKER_BATCH_SIZE',
    'RECORD_PROOF_WORKER_MAX_ATTEMPTS',
    'RECORD_PROOF_WORKER_RETRY_BASE_MS',
    'RECORD_PROOF_WORKER_LOCK_TIMEOUT_MS'
  ]);
  if (Object.keys(env).some(key => !knownSelectorKeys.has(key))) {
    fail('STABLE_CUTOVER_CONFIG_UNKNOWN_KEY');
  }
}

function main(argv = process.argv.slice(2), processEnv = process.env) {
  const args = parseArgs(argv);
  const file = text(args.config);
  const sourceHash = text(args['expected-source-sha256']).toLowerCase();
  const domainHash = text(args['expected-domain-sha256']).toLowerCase();
  if (!file || !sourceHash || !domainHash) {
    fail('STABLE_CUTOVER_CONFIG_ARGUMENT_REQUIRED');
  }

  const env = parseEnvironment(fs.readFileSync(file, 'utf8'));
  assertExactSelectors(env, sourceHash, domainHash);

  assertConfig(readPublicQrPrimaryReadConfig(env), 'PUBLIC_READ');
  assertConfig(readPersonalRecordPrimaryReadConfig(env), 'PERSONAL_READ');
  assertConfig(readQrLifecycleWriteConfig(env), 'LIFECYCLE_WRITE');
  assertConfig(readIdentityAuthorityConfig(env), 'IDENTITY_AUTHORITY');
  assertConfig(readQrIssuanceAuthorityConfig(env), 'QR_ISSUANCE');

  const providerKeys = [
    'AVATA_API_KEY',
    'AVATA_API_SECRET',
    'AVATA_IDENTITY_NAME',
    'AVATA_IDENTITY_NUM',
    'CHAIN_CALLBACK_URL'
  ];
  const providerPresence = providerKeys.map(key => Boolean(text(processEnv[key])));
  if (providerPresence.some(Boolean) && !providerPresence.every(Boolean)) {
    fail('STABLE_CUTOVER_PROVIDER_CONFIG_PARTIAL');
  }
  const providerConfigured = providerPresence.every(Boolean);
  if (providerConfigured) {
    const expectedProviderEnvironment = text(
      args['expected-provider-environment']
    ).toLowerCase();
    const expectedProviderOrigin = text(args['expected-provider-origin']);
    if (!['stage', 'prod'].includes(expectedProviderEnvironment)
        || !expectedProviderOrigin) {
      fail('STABLE_CUTOVER_PROVIDER_CONFIRMATION_REQUIRED');
    }
    assertProviderOrigin(
      processEnv,
      expectedProviderEnvironment,
      expectedProviderOrigin
    );
    assertConfig(
      readRecordProofRuntimeConfig({
        ...processEnv,
        ...env,
        CHAIN_ENABLED: 'true'
      }),
      'PROOF_RUNTIME'
    );
  }

  const result = Object.freeze({
    status: providerConfigured ? 'READY' : 'READY_PENDING_PROVIDER_CONFIG',
    selector_count: 6,
    all_scope_count: 6,
    allowlist_count: 0,
    source_sha256: sourceHash,
    public_qr_domain_sha256: domainHash,
    provider_configuration_validated: providerConfigured,
    provider_environment: providerConfigured
      ? normalizeProviderEnvironment(processEnv.AVATA_ENV)
      : null,
    contains_database_secret: false,
    contains_provider_secret: false
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.code || error.message || 'STABLE_CUTOVER_CONFIG_FAILED'}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  main,
  parseEnvironment
};
