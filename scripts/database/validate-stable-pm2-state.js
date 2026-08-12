'use strict';

const fs = require('node:fs');

const BOUNDARY_FLAGS = [
  'PUBLIC_QR_POSTGRES_READ_ENABLED',
  'PERSONAL_RECORD_POSTGRES_READ_ENABLED',
  'QR_LIFECYCLE_POSTGRES_WRITE_ENABLED',
  'IDENTITY_POSTGRES_AUTHORITY_ENABLED',
  'QR_ISSUANCE_POSTGRES_AUTHORITY_ENABLED'
];
const SCOPE_FLAGS = [
  'PUBLIC_QR_POSTGRES_READ_SCOPE',
  'PERSONAL_RECORD_POSTGRES_READ_SCOPE',
  'QR_LIFECYCLE_POSTGRES_WRITE_SCOPE',
  'IDENTITY_POSTGRES_AUTHORITY_SCOPE',
  'QR_ISSUANCE_POSTGRES_AUTHORITY_SCOPE'
];
const FORBIDDEN_SECRET_KEYS = new Set([
  'DATABASE_URL',
  'PGPASSWORD',
  'AVATA_API_KEY',
  'AVATA_API_SECRET'
]);
const AVATA_CONFIGURATION_KEYS = [
  'AVATA_API_KEY',
  'AVATA_API_SECRET',
  'AVATA_IDENTITY_NAME',
  'AVATA_IDENTITY_NUM',
  'AVATA_API_BASE',
  'AVATA_ENV',
  'CHAIN_CALLBACK_URL'
];

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function parseArguments(argv) {
  const options = {};
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(argument);
    if (!match || !match[2]) fail('STABLE_PM2_STATE_ARGUMENT_INVALID');
    options[match[1]] = match[2];
  }
  const required = [
    'dump',
    'app',
    'expected-password-file',
    'expected-database',
    'expected-authority',
    'expected-freeze'
  ];
  if (Object.keys(options).length !== required.length) {
    fail('STABLE_PM2_STATE_ARGUMENT_COUNT_INVALID');
  }
  for (const key of required) {
    if (!options[key]) fail('STABLE_PM2_STATE_ARGUMENT_MISSING');
  }
  if (!['true', 'false'].includes(options['expected-freeze'])) {
    fail('STABLE_PM2_STATE_FREEZE_ARGUMENT_INVALID');
  }
  if (!['postgres', 'json'].includes(options['expected-authority'])) {
    fail('STABLE_PM2_STATE_AUTHORITY_ARGUMENT_INVALID');
  }
  return options;
}

function readDump(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    fail('STABLE_PM2_STATE_DUMP_INVALID');
  }
  if (!Array.isArray(parsed)) fail('STABLE_PM2_STATE_DUMP_INVALID');
  return parsed;
}

function processEnvironment(entry) {
  const processState = entry && entry.pm2_env && typeof entry.pm2_env === 'object'
    ? entry.pm2_env
    : entry;
  const env = entry && entry.env && typeof entry.env === 'object'
    ? entry.env
    : processState && processState.env && typeof processState.env === 'object'
      ? processState.env
      : processState;
  const name = String(
    (entry && entry.name) ||
    (processState && processState.name) ||
    (env && env.name) ||
    ''
  );
  return { env, name };
}

function findApplication(dump, name) {
  const matches = dump.filter((entry) => {
    return processEnvironment(entry).name === name;
  });
  if (matches.length !== 1) fail('STABLE_PM2_STATE_APP_COUNT_INVALID');
  return processEnvironment(matches[0]).env;
}

function assertNoSecrets(value) {
  if (!value || typeof value !== 'object') return;
  for (const [childKey, childValue] of Object.entries(value)) {
    if (
      FORBIDDEN_SECRET_KEYS.has(childKey) &&
      childValue !== undefined &&
      childValue !== null &&
      String(childValue) !== ''
    ) {
      fail('STABLE_PM2_STATE_SECRET_PERSISTED');
    }
    assertNoSecrets(childValue);
  }
}

function validateStablePm2State({
  dump,
  app,
  passwordFile,
  database,
  authority,
  freeze
}) {
  assertNoSecrets(dump);
  const env = findApplication(dump, app);
  if (authority === 'postgres') {
    for (const key of BOUNDARY_FLAGS) {
      if (String(env[key] || '') !== 'true') {
        fail('STABLE_PM2_STATE_BOUNDARY_INVALID');
      }
    }
    for (const key of SCOPE_FLAGS) {
      if (String(env[key] || '') !== 'all') {
        fail('STABLE_PM2_STATE_SCOPE_INVALID');
      }
    }
    if (String(env.PGDATABASE || '') !== database) {
      fail('STABLE_PM2_STATE_DATABASE_INVALID');
    }
    for (const key of ['PGHOST', 'PGPORT', 'PGUSER']) {
      if (String(env[key] || '') === '') {
        fail('STABLE_PM2_STATE_CONNECTION_FIELD_INVALID');
      }
    }
    if (String(env.PGPASSWORD_FILE || '') !== passwordFile) {
      fail('STABLE_PM2_STATE_PASSWORD_FILE_INVALID');
    }
  } else {
    for (const key of BOUNDARY_FLAGS) {
      if (!['', 'false'].includes(String(env[key] || ''))) {
        fail('STABLE_PM2_STATE_BOUNDARY_INVALID');
      }
    }
    if (String(env.PGPASSWORD_FILE || '') !== '') {
      fail('STABLE_PM2_STATE_PASSWORD_FILE_INVALID');
    }
    for (const key of ['PGHOST', 'PGPORT', 'PGUSER', 'PGDATABASE']) {
      if (String(env[key] || '') !== '') {
        fail('STABLE_PM2_STATE_CONNECTION_FIELD_INVALID');
      }
    }
  }
  const persistedFreeze = String(
    env.POSTGRES_CUTOVER_WRITE_FREEZE_ENABLED || ''
  );
  if (
    persistedFreeze !== freeze &&
    !(authority === 'json' && freeze === 'false' && persistedFreeze === '')
  ) {
    fail('STABLE_PM2_STATE_FREEZE_INVALID');
  }
  const proofRuntime = String(env.RECORD_PROOF_RUNTIME_ENABLED || '');
  if (
    proofRuntime !== 'false' &&
    !(authority === 'json' && proofRuntime === '')
  ) {
    fail('STABLE_PM2_STATE_PROOF_RUNTIME_INVALID');
  }
  for (const key of AVATA_CONFIGURATION_KEYS) {
    if (String(env[key] || '') !== '') {
      fail('STABLE_PM2_STATE_AVATA_CONFIGURATION_INVALID');
    }
  }
  if (!['', 'false'].includes(String(env.CHAIN_ENABLED || ''))) {
    fail('STABLE_PM2_STATE_AVATA_CONFIGURATION_INVALID');
  }
  return {
    status: 'PASS',
    authority,
    postgres_authority_boundary_count:
      authority === 'postgres' ? BOUNDARY_FLAGS.length : 0,
    all_scope_count: authority === 'postgres' ? SCOPE_FLAGS.length : 0,
    database: authority === 'postgres' ? database : null,
    password_file_reference_present: authority === 'postgres',
    database_secret_persisted: false,
    provider_secret_persisted: false,
    record_proof_runtime_enabled: false,
    write_freeze_enabled: freeze === 'true'
  };
}

function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const dump = readDump(options.dump);
  const report = validateStablePm2State({
    dump,
    app: options.app,
    passwordFile: options['expected-password-file'],
    database: options['expected-database'],
    authority: options['expected-authority'],
    freeze: options['expected-freeze']
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.code || 'STABLE_PM2_STATE_FAILED'}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  main,
  parseArguments,
  validateStablePm2State
};
