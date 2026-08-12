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

function assertConfig(config, name, baselineDomainHash = null) {
  if (!config || config.enabled !== true) {
    fail(`STABLE_CUTOVER_${name}_${config?.reason || 'INVALID'}`);
  }
  if (config.scope !== 'all') fail(`STABLE_CUTOVER_${name}_SCOPE_INVALID`);
  if (config.allowlist instanceof Set && config.allowlist.size !== 0) {
    fail(`STABLE_CUTOVER_${name}_ALLOWLIST_FORBIDDEN`);
  }
  if (baselineDomainHash && config.baselineDomainHash !== baselineDomainHash) {
    fail(`STABLE_CUTOVER_${name}_BASELINE_DOMAIN_INVALID`);
  }
}

function assertExactSelectors(env, sourceHash, domainHash, baselineDomainHash) {
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
    RECORD_PROOF_RUNTIME_ENABLED: 'false',
    PUBLIC_QR_SHADOW_READ_ENABLED: 'false',
    PERSONAL_RECORD_SHADOW_READ_ENABLED: 'false',
    IDENTITY_SHADOW_READ_ENABLED: 'false',
    POSTGRES_AUTHORITY_BASELINE_DOMAIN_SHA256: baselineDomainHash
  };
  for (const [key, value] of Object.entries(expected)) {
    if (env[key] !== value) fail(`STABLE_CUTOVER_CONFIG_VALUE_INVALID_${key}`);
  }

  if (Object.keys(env).some(key => key.endsWith('_ALLOWLIST'))) {
    fail('STABLE_CUTOVER_ALLOWLIST_FORBIDDEN');
  }

  const knownSelectorKeys = new Set(Object.keys(expected));
  if (Object.keys(env).some(key => !knownSelectorKeys.has(key))) {
    fail('STABLE_CUTOVER_CONFIG_UNKNOWN_KEY');
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const file = text(args.config);
  const sourceHash = text(args['expected-source-sha256']).toLowerCase();
  const domainHash = text(args['expected-domain-sha256']).toLowerCase();
  const baselineDomainHash = text(
    args['expected-baseline-domain-sha256']
  ).toLowerCase();
  if (!file || !sourceHash || !domainHash || !baselineDomainHash) {
    fail('STABLE_CUTOVER_CONFIG_ARGUMENT_REQUIRED');
  }

  const env = parseEnvironment(fs.readFileSync(file, 'utf8'));
  assertExactSelectors(env, sourceHash, domainHash, baselineDomainHash);

  assertConfig(
    readPublicQrPrimaryReadConfig(env),
    'PUBLIC_READ',
    baselineDomainHash
  );
  assertConfig(
    readPersonalRecordPrimaryReadConfig(env),
    'PERSONAL_READ',
    baselineDomainHash
  );
  assertConfig(
    readQrLifecycleWriteConfig(env),
    'LIFECYCLE_WRITE',
    baselineDomainHash
  );
  assertConfig(readIdentityAuthorityConfig(env), 'IDENTITY_AUTHORITY');
  assertConfig(readQrIssuanceAuthorityConfig(env), 'QR_ISSUANCE');

  const result = Object.freeze({
    status: 'READY_FOR_POSTGRES_MAINTENANCE_WINDOW',
    postgres_authority_boundary_count: 5,
    all_scope_count: 5,
    disabled_external_runtime_count: 1,
    allowlist_count: 0,
    source_sha256: sourceHash,
    public_qr_domain_sha256: domainHash,
    json_authority_baseline_domain_sha256: baselineDomainHash,
    record_proof_runtime_enabled: false,
    avata_in_migration_scope: false,
    external_provider_required: false,
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
