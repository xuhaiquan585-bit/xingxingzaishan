'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { readPostgresConfig, redactPostgresConfig } = require('../src/server/database/config');
const {
  buildPoolOptions,
  closePostgresPool,
  createPostgresPool
} = require('../src/server/database/connection');
const { checkPostgresHealth } = require('../src/server/database/healthCheck');
const { withTransaction } = require('../src/server/database/transaction');
const {
  applyMigration,
  assertSafeMigrationTarget,
  inspectMigrationState,
  loadMigrations,
  runMigrations
} = require('../scripts/database/migrate');
const { main: runImporterCli, parseArguments: parseImporterArguments } = require('../scripts/database/import-dry-run');
const { analyzeSourceSnapshot, runDryRun } = require('../scripts/database/importer');
const {
  PUBLIC_QR_DOMAIN_CHECKSUM_KEY,
  publicQrDomainSha256,
  publicQrDomainSha256FromSource
} = require('../scripts/database/importer/domain-markers');
const { mapSourceToPlan } = require('../scripts/database/importer/mapping');
const { validateImportSource } = require('../scripts/database/importer/validator');
const {
  assertSourceUnchanged,
  readSourceSnapshot,
  sha256
} = require('../scripts/database/importer/reader');
const {
  IMPORT_ORDER,
  importPlanToPostgres,
  planSha256
} = require('../scripts/database/importer/writer');
const { verifyImportedPlan } = require('../scripts/database/importer/verify-import');
const {
  assertAnalysisReady,
  assertStagingEnvironment,
  executeStagingImport,
  parseArguments: parseStagingImportArguments
} = require('../scripts/database/import-staging');
const {
  assertMarkerAnalysisReady,
  parseArguments: parseDomainMarkerArguments,
  registerPublicQrDomainMarker
} = require('../scripts/database/register-public-qr-domain-marker');
const {
  validateStablePm2State
} = require('../scripts/database/validate-stable-pm2-state');
const {
  AccountRepository,
  ArchiveRepository,
  AuditRepository,
  CoCreationRepository,
  IdentityRepository,
  IdentityReferenceRepository,
  OrderRepository,
  OutboxRepository,
  PaymentRepository,
  ProofRepository,
  PublicQrProvenanceRepository,
  QrAdministrationRepository,
  QrBatchRepository,
  QrIssuanceRepository,
  QrRepository,
  RecordRepository
} = require('../src/server/repositories');
const { executeQuery } = require('../src/server/repositories/query');
const {
  ARCHIVE_FIELDS,
  COMMENT_FIELDS,
  OUTBOX_FIELDS,
  PROOF_ATTEMPT_FIELDS,
  PROOF_FIELDS,
  RECORD_FIELDS
} = require('../src/server/repositories/mappers');

function makeConfig(overrides = {}) {
  return {
    source: 'discrete',
    host: '127.0.0.1',
    port: 5432,
    user: 'app',
    password: 'not-for-logs',
    database: 'app_test',
    poolMax: 4,
    idleTimeoutMillis: 1000,
    connectionTimeoutMillis: 1000,
    statementTimeoutMillis: 2000,
    applicationName: 'database-test',
    ssl: false,
    ...overrides
  };
}

async function withMigrationDirectory(files, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingxing-pg-migrations-'));
  try {
    Object.entries(files).forEach(([name, content]) => {
      fs.writeFileSync(path.join(directory, name), content, 'utf8');
    });
    return await callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

class FakeMigrationClient {
  constructor() {
    this.queries = [];
    this.applied = [];
    this.schemaExists = false;
    this.migrationTableExists = false;
    this.lockAvailable = true;
    this.released = 0;
  }

  async query(sql, params = []) {
    this.queries.push({ sql, params });
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: this.lockAvailable }] };
    if (sql.includes('pg_advisory_unlock')) return { rows: [{ pg_advisory_unlock: true }] };
    if (sql.includes("to_regclass('app.schema_migrations')")) {
      return { rows: [{ relation: this.migrationTableExists ? 'app.schema_migrations' : null }] };
    }
    if (sql.includes('FROM pg_namespace')) {
      return { rows: [{ schema_exists: this.schemaExists }] };
    }
    if (sql.startsWith('SELECT version')) {
      return { rows: this.applied.map((row) => ({ ...row, applied_at: new Date() })) };
    }
    if (sql.startsWith('INSERT INTO app.schema_migrations')) {
      this.applied.push({ version: params[0], checksum: params[1] });
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('CREATE SCHEMA app')) {
      this.schemaExists = true;
      this.migrationTableExists = true;
    }
    return { rows: [], rowCount: 0 };
  }

  release() {
    this.released += 1;
  }
}

test('PostgreSQL config is explicit, validates ambiguity, defaults production TLS, and redacts secrets', () => {
  assert.throws(
    () => readPostgresConfig({}),
    (error) => error.code === 'POSTGRES_CONFIG_REQUIRED'
  );
  assert.throws(
    () => readPostgresConfig({ DATABASE_URL: 'postgres://u:p@db/app', PGHOST: 'db' }),
    (error) => error.code === 'POSTGRES_CONFIG_AMBIGUOUS'
  );

  const config = readPostgresConfig({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://user:private-password@db.example:5433/app'
  });
  assert.deepEqual(config.ssl, { rejectUnauthorized: true });
  const redacted = JSON.stringify(redactPostgresConfig(config));
  assert.equal(redacted.includes('private-password'), false);
  assert.equal(redacted.includes('postgres://'), false);
});

test('PostgreSQL config can load a password from one protected absolute file', () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'xingxing-pg-password-')
  );
  const passwordFile = path.join(temporaryRoot, 'postgres.password');
  fs.writeFileSync(passwordFile, 'file-only-secret', { mode: 0o600 });

  try {
    const config = readPostgresConfig({
      PGHOST: '127.0.0.1',
      PGPORT: '5432',
      PGUSER: 'app',
      PGDATABASE: 'app_test',
      PGPASSWORD_FILE: passwordFile
    });
    assert.equal(config.password, 'file-only-secret');
    assert.equal(JSON.stringify(redactPostgresConfig(config)).includes('file-only-secret'), false);

    assert.throws(
      () => readPostgresConfig({
        PGHOST: '127.0.0.1',
        PGUSER: 'app',
        PGDATABASE: 'app_test',
        PGPASSWORD: 'inline-secret',
        PGPASSWORD_FILE: passwordFile
      }),
      (error) => error.code === 'POSTGRES_CONFIG_AMBIGUOUS'
    );
    assert.throws(
      () => readPostgresConfig({
        PGHOST: '127.0.0.1',
        PGUSER: 'app',
        PGDATABASE: 'app_test',
        PGPASSWORD_FILE: 'relative.password'
      }),
      (error) => error.code === 'POSTGRES_CONFIG_INVALID'
    );

    fs.writeFileSync(passwordFile, 'first\nsecond', { mode: 0o600 });
    assert.throws(
      () => readPostgresConfig({
        PGHOST: '127.0.0.1',
        PGUSER: 'app',
        PGDATABASE: 'app_test',
        PGPASSWORD_FILE: passwordFile
      }),
      (error) => error.code === 'POSTGRES_CONFIG_INVALID'
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('PostgreSQL pool creation is explicit and close is idempotent', async () => {
  let constructorCalls = 0;
  class FakePool {
    constructor(options) {
      constructorCalls += 1;
      this.options = options;
      this.endCalls = 0;
    }
    on() {}
    async end() { this.endCalls += 1; }
  }

  assert.equal(constructorCalls, 0);
  const pool = createPostgresPool({ config: makeConfig(), PoolClass: FakePool });
  assert.equal(constructorCalls, 1);
  assert.equal(pool.options.password, 'not-for-logs');
  await Promise.all([closePostgresPool(pool), closePostgresPool(pool)]);
  assert.equal(pool.endCalls, 1);
  assert.equal(buildPoolOptions(makeConfig()).statement_timeout, 2000);
});

test('stable PM2 state persists file references but never database or provider secrets', () => {
  const stableEnvironment = {
    name: 'xingxingzaishan',
    env: {
      PUBLIC_QR_POSTGRES_READ_ENABLED: 'true',
      PERSONAL_RECORD_POSTGRES_READ_ENABLED: 'true',
      QR_LIFECYCLE_POSTGRES_WRITE_ENABLED: 'true',
      IDENTITY_POSTGRES_AUTHORITY_ENABLED: 'true',
      QR_ISSUANCE_POSTGRES_AUTHORITY_ENABLED: 'true',
      PUBLIC_QR_POSTGRES_READ_SCOPE: 'all',
      PERSONAL_RECORD_POSTGRES_READ_SCOPE: 'all',
      QR_LIFECYCLE_POSTGRES_WRITE_SCOPE: 'all',
      IDENTITY_POSTGRES_AUTHORITY_SCOPE: 'all',
      QR_ISSUANCE_POSTGRES_AUTHORITY_SCOPE: 'all',
      PGHOST: '127.0.0.1',
      PGPORT: '5432',
      PGUSER: 'app',
      PGDATABASE: 'candidate',
      PGPASSWORD_FILE: '/etc/xingxingzaishan/stable.password',
      RECORD_PROOF_RUNTIME_ENABLED: 'false',
      CHAIN_ENABLED: 'false',
      POSTGRES_CUTOVER_WRITE_FREEZE_ENABLED: 'true'
    }
  };
  const expected = {
    dump: [stableEnvironment],
    app: 'xingxingzaishan',
    passwordFile: '/etc/xingxingzaishan/stable.password',
    database: 'candidate',
    authority: 'postgres',
    freeze: 'true'
  };

  const report = validateStablePm2State(expected);
  assert.equal(report.status, 'PASS');
  assert.equal(report.postgres_authority_boundary_count, 5);
  assert.equal(report.database_secret_persisted, false);
  assert.equal(report.write_freeze_enabled, true);

  const jsonReport = validateStablePm2State({
    ...expected,
    authority: 'json',
    freeze: 'false',
    dump: [{
      name: 'xingxingzaishan',
      env: {
        PUBLIC_QR_POSTGRES_READ_ENABLED: 'false',
        PERSONAL_RECORD_POSTGRES_READ_ENABLED: 'false',
        QR_LIFECYCLE_POSTGRES_WRITE_ENABLED: 'false',
        IDENTITY_POSTGRES_AUTHORITY_ENABLED: 'false',
        QR_ISSUANCE_POSTGRES_AUTHORITY_ENABLED: 'false',
        PGHOST: '',
        PGPORT: '',
        PGUSER: '',
        PGDATABASE: '',
        PGPASSWORD_FILE: '',
        RECORD_PROOF_RUNTIME_ENABLED: 'false',
        CHAIN_ENABLED: 'false',
        POSTGRES_CUTOVER_WRITE_FREEZE_ENABLED: 'false'
      }
    }]
  });
  assert.equal(jsonReport.authority, 'json');
  assert.equal(jsonReport.postgres_authority_boundary_count, 0);

  const nestedReport = validateStablePm2State({
    ...expected,
    dump: [{
      name: 'xingxingzaishan',
      pm2_env: { env: stableEnvironment.env }
    }]
  });
  assert.equal(nestedReport.status, 'PASS');

  assert.throws(
    () => validateStablePm2State({
      ...expected,
      dump: [{
        ...stableEnvironment,
        env: { ...stableEnvironment.env, PGPASSWORD: 'must-not-persist' }
      }]
    }),
    (error) => error.code === 'STABLE_PM2_STATE_SECRET_PERSISTED'
  );
  assert.throws(
    () => validateStablePm2State({
      ...expected,
      dump: [{
        ...stableEnvironment,
        env: {
          ...stableEnvironment.env,
          QR_ISSUANCE_POSTGRES_AUTHORITY_ENABLED: 'false'
        }
      }]
    }),
    (error) => error.code === 'STABLE_PM2_STATE_BOUNDARY_INVALID'
  );
  assert.throws(
    () => validateStablePm2State({
      ...expected,
      dump: [{
        ...stableEnvironment,
        env: { ...stableEnvironment.env, PGHOST: '' }
      }]
    }),
    (error) => error.code === 'STABLE_PM2_STATE_CONNECTION_FIELD_INVALID'
  );
  assert.throws(
    () => validateStablePm2State({
      ...expected,
      dump: [{
        ...stableEnvironment,
        env: { ...stableEnvironment.env, AVATA_IDENTITY_NUM: 'loaded' }
      }]
    }),
    (error) => error.code === 'STABLE_PM2_STATE_AVATA_CONFIGURATION_INVALID'
  );
});

test('withTransaction commits success and rolls back failures while always releasing the client', async () => {
  const successfulClient = {
    queries: [],
    async query(sql) { this.queries.push(sql); return { rows: [] }; },
    releaseCalls: 0,
    release() { this.releaseCalls += 1; }
  };
  const successPool = { async connect() { return successfulClient; } };
  const value = await withTransaction(successPool, async (transaction) => {
    await transaction.query('SELECT 1');
    return 'ok';
  });
  assert.equal(value, 'ok');
  assert.deepEqual(successfulClient.queries, [
    'BEGIN',
    'SET TRANSACTION ISOLATION LEVEL READ COMMITTED',
    'SELECT 1',
    'COMMIT'
  ]);
  assert.equal(successfulClient.releaseCalls, 1);

  const failedClient = {
    queries: [],
    async query(sql) { this.queries.push(sql); return { rows: [] }; },
    releaseCalls: 0,
    release() { this.releaseCalls += 1; }
  };
  const failurePool = { async connect() { return failedClient; } };
  await assert.rejects(
    withTransaction(failurePool, async () => {
      const error = new Error('business rule');
      error.code = 'BUSINESS_RULE';
      throw error;
    }),
    (error) => error.code === 'BUSINESS_RULE'
  );
  assert.equal(failedClient.queries.includes('ROLLBACK'), true);
  assert.equal(failedClient.queries.includes('COMMIT'), false);
  assert.equal(failedClient.releaseCalls, 1);
});

test('transaction query failures are sanitized before reaching callers', async () => {
  const client = {
    async query(sql) {
      if (sql === 'SELECT secret') {
        const error = new Error('password=should-not-escape');
        error.code = '08006';
        throw error;
      }
      return { rows: [] };
    },
    release() {}
  };
  await assert.rejects(
    withTransaction({ async connect() { return client; } }, (transaction) => transaction.query('SELECT secret')),
    (error) => error.code === 'POSTGRES_QUERY_FAILED' && !error.message.includes('password')
  );
});

test('health check reports safe status without connection details', async () => {
  const client = {
    async query(sql) {
      if (sql === 'SHOW server_version') return { rows: [{ server_version: '15.8' }] };
      return { rows: [{ connected: 1 }] };
    },
    released: false,
    release() { this.released = true; }
  };
  const result = await checkPostgresHealth({ async connect() { return client; } });
  assert.equal(result.connected, true);
  assert.equal(result.server_version, '15.8');
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'password'), false);
  assert.equal(client.released, true);
});

test('migration loader sorts files, hashes raw bytes, and rejects transaction control', async () => {
  await withMigrationDirectory({
    '002_second.sql': 'CREATE TABLE app.second_table (id bigint);\n',
    '001_first.sql': 'CREATE SCHEMA app;\n'
  }, (directory) => {
    const migrations = loadMigrations({ migrationsDirectory: directory });
    assert.deepEqual(migrations.map((item) => item.version), ['001_first.sql', '002_second.sql']);
    assert.match(migrations[0].checksum, /^[0-9a-f]{64}$/);
  });

  await withMigrationDirectory({
    '001_bad.sql': 'BEGIN;\nCREATE SCHEMA app;\nCOMMIT;\n'
  }, (directory) => {
    assert.throws(
      () => loadMigrations({ migrationsDirectory: directory }),
      (error) => error.code === 'POSTGRES_MIGRATION_TRANSACTION_CONTROL_FORBIDDEN'
    );
  });
});

test('migration runner is dry by default, applies atomically, is idempotent, and detects drift', async () => {
  await withMigrationDirectory({
    '001_init.sql': [
      'CREATE SCHEMA app;',
      'CREATE TABLE app.schema_migrations (version varchar(128) PRIMARY KEY, checksum char(64));'
    ].join('\n')
  }, async (directory) => {
    const client = new FakeMigrationClient();
    const pool = { async connect() { return client; } };
    const dryRun = await runMigrations({
      pool,
      target: 'test',
      migrationsDirectory: directory
    });
    assert.equal(dryRun.mode, 'dry-run');
    assert.equal(dryRun.pending.length, 1);
    assert.equal(client.schemaExists, false);

    const applied = await runMigrations({
      pool,
      apply: true,
      target: 'test',
      migrationsDirectory: directory
    });
    assert.equal(applied.applied.length, 1);
    assert.equal(client.applied.length, 1);
    assert.equal(client.migrationTableExists, true);
    assert.equal(client.queries.some((item) => item.sql === 'BEGIN'), true);
    assert.equal(client.queries.some((item) => item.sql === 'COMMIT'), true);

    const repeat = await runMigrations({
      pool,
      apply: true,
      target: 'test',
      migrationsDirectory: directory
    });
    assert.equal(repeat.applied.length, 0);

    fs.appendFileSync(path.join(directory, '001_init.sql'), '\nCREATE TABLE app.changed (id bigint);\n');
    await assert.rejects(
      runMigrations({ pool, target: 'test', migrationsDirectory: directory }),
      (error) => error.code === 'POSTGRES_MIGRATION_CHECKSUM_MISMATCH'
    );
    assert.equal(client.released, 4);
  });
});

test('migration state rejects dirty schemas, unknown versions, and unavailable advisory locks', async () => {
  const migration = {
    version: '001_init.sql',
    checksum: 'a'.repeat(64),
    sql: 'CREATE SCHEMA app;'
  };

  const dirtyClient = new FakeMigrationClient();
  dirtyClient.schemaExists = true;
  await assert.rejects(
    inspectMigrationState(dirtyClient, [migration]),
    (error) => error.code === 'POSTGRES_MIGRATION_DIRTY_SCHEMA'
  );

  const unknownClient = new FakeMigrationClient();
  unknownClient.schemaExists = true;
  unknownClient.migrationTableExists = true;
  unknownClient.applied.push({ version: '999_unknown.sql', checksum: 'b'.repeat(64) });
  await assert.rejects(
    inspectMigrationState(unknownClient, [migration]),
    (error) => error.code === 'POSTGRES_MIGRATION_UNKNOWN_VERSION'
  );

  await withMigrationDirectory({ '001_init.sql': 'CREATE SCHEMA app;\n' }, async (directory) => {
    const lockedClient = new FakeMigrationClient();
    lockedClient.lockAvailable = false;
    await assert.rejects(
      runMigrations({
        pool: { async connect() { return lockedClient; } },
        apply: true,
        target: 'test',
        migrationsDirectory: directory
      }),
      (error) => error.code === 'POSTGRES_MIGRATION_LOCKED'
    );
    assert.equal(lockedClient.released, 1);
  });
});

test('failed migration rolls back without recording an applied version', async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql === 'BROKEN SQL') {
        const error = new Error('syntax detail must not escape');
        error.code = '42601';
        throw error;
      }
      return { rows: [] };
    }
  };

  await assert.rejects(
    applyMigration(client, {
      version: '002_broken.sql',
      checksum: 'c'.repeat(64),
      sql: 'BROKEN SQL'
    }),
    (error) => error.code === 'POSTGRES_MIGRATION_FAILED'
      && error.postgresCode === '42601'
      && !error.message.includes('syntax detail')
  );
  assert.deepEqual(queries, ['BEGIN', 'BROKEN SQL', 'ROLLBACK']);
});

test('migration target rejects production and the initial schema remains runner-managed', () => {
  assert.throws(
    () => assertSafeMigrationTarget('production'),
    (error) => error.code === 'POSTGRES_MIGRATION_PRODUCTION_FORBIDDEN'
  );

  const migration = fs.readFileSync(
    path.join(__dirname, '..', 'database', 'migrations', '001_init_schema.sql'),
    'utf8'
  );
  assert.equal(/^\s*BEGIN\s*;/im.test(migration), false);
  assert.equal(/^\s*COMMIT\s*;/im.test(migration), false);
  assert.equal((migration.match(/^CREATE TABLE app\./gm) || []).length, 24);
  assert.equal(migration.includes('CREATE DATABASE'), false);
  assert.equal(migration.includes('CREATE EXTENSION'), false);
});

test('initial schema and importer agree on full SHA-256 audit reference hashes', () => {
  const migration = fs.readFileSync(
    path.join(__dirname, '..', 'database', 'migrations', '001_init_schema.sql'),
    'utf8'
  );
  assert.match(migration, /actor_reference_hash char\(64\)/);
  assert.match(migration, /entity_reference_hash char\(64\)/);
  assert.match(migration, /audit_events_actor_reference_hash_format_chk/);
  assert.match(migration, /audit_events_entity_reference_hash_format_chk/);
  assert.doesNotMatch(migration, /(?:actor|entity)_reference_hash varchar\(32\)/);

  const fixture = makeImporterFixture();
  fixture.payment_logs.push({
    id: 'AUDIT_HASH_FIXTURE', order_id: '', order_no: '', method: 'wechat',
    status: 'notify_rejected', amount_cents: 0, transaction_id: '', raw: {},
    error: 'fixture', created_at: fixture.accounts[0].created_at
  });
  const { report, plan } = analyzeImporterFixture(fixture);
  assert.equal(report.status, 'READY');
  assert.match(plan.audit_events[0].entity_reference_hash, /^[0-9a-f]{64}$/);
});

test('compatibility migrations are additive and leave migration 001 unchanged', () => {
  const migrationsDirectory = path.join(__dirname, '..', 'database', 'migrations');
  const initialBytes = fs.readFileSync(
    path.join(migrationsDirectory, '001_init_schema.sql')
  );
  const sourcePositionMigration = fs.readFileSync(
    path.join(migrationsDirectory, '002_add_comment_source_position.sql'),
    'utf8'
  );
  const legacyEvidenceMigration = fs.readFileSync(
    path.join(migrationsDirectory, '003_preserve_legacy_import_evidence.sql'),
    'utf8'
  );
  const legacyProductBuyTypeMigration = fs.readFileSync(
    path.join(migrationsDirectory, '004_allow_legacy_product_buy_type.sql'),
    'utf8'
  );
  const accountIdSequenceMigration = fs.readFileSync(
    path.join(migrationsDirectory, '005_add_account_id_sequence.sql'),
    'utf8'
  );
  const issuedLifecycleMigration = fs.readFileSync(
    path.join(migrationsDirectory, '006_guard_unissued_qr_lifecycle.sql'),
    'utf8'
  );
  assert.equal(
    crypto.createHash('sha256').update(initialBytes).digest('hex'),
    'c827cd85e9552805690d6837383fb6d23c043d32be359ce61b99f743ba477d18'
  );
  assert.match(sourcePositionMigration, /IF EXISTS \(SELECT 1 FROM app\.co_creation_comments LIMIT 1\)/);
  assert.match(sourcePositionMigration, /ADD COLUMN source_position integer NOT NULL/);
  assert.match(sourcePositionMigration, /CHECK \(source_position >= 0\)/);
  assert.match(
    sourcePositionMigration,
    /UNIQUE \(co_creation_id, source_position\)/
  );
  assert.match(sourcePositionMigration, /WHERE status = 'kept'/);
  assert.doesNotMatch(sourcePositionMigration, /\bDEFAULT\b/i);
  assert.match(legacyEvidenceMigration, /ADD COLUMN legacy_hash_snapshot text/);
  assert.match(legacyEvidenceMigration, /ADD COLUMN legacy_duplicate boolean NOT NULL DEFAULT false/);
  assert.match(legacyEvidenceMigration, /DROP INDEX app\.co_creation_comments_effective_account_uq/);
  assert.match(
    legacyEvidenceMigration,
    /WHERE status = 'kept' AND legacy_duplicate = false/
  );
  assert.match(
    legacyEvidenceMigration,
    /CHECK \(manifest_hash IS NULL OR legacy_hash_snapshot IS NULL\)/
  );
  assert.match(legacyProductBuyTypeMigration, /DROP CONSTRAINT products_buy_type_chk/);
  assert.match(
    legacyProductBuyTypeMigration,
    /CHECK \(buy_type IN \('miniapp_order', 'copy_link'\)\)/
  );
  assert.match(accountIdSequenceMigration, /CREATE SEQUENCE app\.account_id_seq/);
  assert.match(accountIdSequenceMigration, /WHERE id !~ '\^ACC\[0-9\]\+\$'/);
  assert.match(accountIdSequenceMigration, /max\(substring\(id FROM 4\)::bigint\) \+ 1/);
  assert.match(accountIdSequenceMigration, /false\s*\n\);/);
  assert.match(issuedLifecycleMigration, /qr_codes_issued_lifecycle_chk/);
  assert.match(
    issuedLifecycleMigration,
    /issue_status = 'issued'[\s\S]*lifecycle_status = 'unactivated'/
  );
  assert.match(issuedLifecycleMigration, /NOT VALID/);

  const migrations = loadMigrations({ migrationsDirectory });
  assert.deepEqual(
    migrations.map((item) => item.version),
    [
      '001_init_schema.sql',
      '002_add_comment_source_position.sql',
      '003_preserve_legacy_import_evidence.sql',
      '004_allow_legacy_product_buy_type.sql',
      '005_add_account_id_sequence.sql',
      '006_guard_unissued_qr_lifecycle.sql'
    ]
  );
});

function makeImporterFixture() {
  const createdAt = '2026-01-02T03:04:05.000Z';
  return {
    meta: { next_user_id: 3, next_account_id: 3, accounts_migration_version: 'accounts_foundation_v1' },
    accounts: [
      { id: 'ACC000001', status: 'active', display_name: '', avatar_url: '', created_from: 'migration', created_at: createdAt, updated_at: createdAt },
      { id: 'ACC000002', status: 'active', display_name: '', avatar_url: '', created_from: 'migration', created_at: createdAt, updated_at: createdAt }
    ],
    users: [
      { id: 1, phone: '13800000001', openid: 'openid-fixture-1', unionid: null, source: 'web+miniapp', created_at: createdAt, account_id: 'ACC000001' },
      { id: 2, phone: '13800000002', openid: 'openid-fixture-2', unionid: null, source: 'web+miniapp', created_at: createdAt, account_id: 'ACC000002' }
    ],
    qr_codes: [
      {
        id: 'STAR0001', issue_status: 'issued', activation_status: 'activated', hidden: false,
        batch_id: null, print_batch_id: null, quality_check: { checked: false, checked_at: null, checked_by: null, result: null },
        content: 'fixture memory text', image_url: 'https://fixture.invalid/image.jpg', image_object_key: 'records/fixture.jpg',
        image_sha256: 'a'.repeat(64), phone: '13800000001', account_id: 'ACC000001', activated_at: createdAt,
        blockchain_hash: null, chain_provider: 'avata_wenchang', chain_status: 'not_started', chain_operation_id: null,
        manifest_object_key: null, manifest_hash: null, chain_tx_hash: null, chain_block_height: null,
        chain_record_id: null, chain_certificate_url: null, chain_certificate_object_key: null,
        chain_certificate_object_url: null, chain_confirmed_at: null, chain_callback_received_at: null,
        chain_last_error: '', chain_retry_count: 0, legacy_manifest_object_key: null,
        archive_index_object_key: null, archive_status: 'not_started', archive_last_error: '', archive_updated_at: null,
        co_creation_enabled: false, co_creation_owner_phone: null, co_creation_owner_account_id: null,
        co_creation_comments: [], co_creation_started_at: null, show_brand_disclosure: false,
        brand_disclosure_text_snapshot: '', qr_image_url: null, qr_access_token: 'fixture-token-1', created_at: createdAt
      },
      {
        id: 'STAR0002', issue_status: 'issued', activation_status: 'co_creating', hidden: false,
        batch_id: null, print_batch_id: null, quality_check: { checked: false, checked_at: null, checked_by: null, result: null },
        content: 'fixture draft', image_url: '', image_object_key: null, image_sha256: null,
        phone: '13800000002', account_id: 'ACC000002', activated_at: null,
        blockchain_hash: null, chain_provider: 'avata_wenchang', chain_status: 'not_started', chain_operation_id: null,
        manifest_object_key: null, manifest_hash: null, chain_tx_hash: null, chain_block_height: null,
        chain_record_id: null, chain_certificate_url: null, chain_certificate_object_key: null,
        chain_certificate_object_url: null, chain_confirmed_at: null, chain_callback_received_at: null,
        chain_last_error: '', chain_retry_count: 0, legacy_manifest_object_key: null,
        archive_index_object_key: null, archive_status: 'not_started', archive_last_error: '', archive_updated_at: null,
        co_creation_enabled: true, co_creation_owner_phone: '13800000002', co_creation_owner_account_id: 'ACC000002',
        co_creation_comments: [{ id: 1, phone: '13800000001', account_id: 'ACC000001', author_name: 'fixture', content: 'fixture comment', status: 'kept', created_at: createdAt }],
        co_creation_started_at: createdAt, show_brand_disclosure: false, brand_disclosure_text_snapshot: '',
        qr_image_url: null, qr_access_token: 'fixture-token-2', created_at: createdAt
      }
    ],
    admins: [],
    quality_check_logs: [],
    batches: [],
    products: [],
    content_pages: [],
    banners: [],
    orders: [],
    payment_logs: [],
    miniapp_content: {
      home_title: 'fixture title', home_subtitle: 'fixture subtitle', logo_image: '', home_banner_image: '',
      home_slides: [], scene_cards: [], project_title: 'fixture project', project_body: 'fixture body',
      brand_story_title: 'fixture story', brand_story_body: 'fixture story body', consult_label: 'fixture consult',
      consult_url: '', share_title: 'fixture share', share_description: 'fixture share body', updated_at: createdAt, updated_by: null
    }
  };
}

function withImporterFile(content, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingxing-importer-'));
  const inputPath = path.join(directory, 'fixture.json');
  try {
    fs.writeFileSync(inputPath, content);
    return callback(inputPath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('importer CLI requires the fixed explicit dry-run contract', () => {
  assert.throws(() => parseImporterArguments([]), (error) => error.code === 'IMPORT_DRY_RUN_REQUIRED');
  assert.throws(() => parseImporterArguments(['--dry-run']), (error) => error.code === 'IMPORT_INPUT_REQUIRED');
  assert.throws(
    () => parseImporterArguments(['--dry-run', '--input=fixture.json']),
    (error) => error.code === 'IMPORT_EXPECTED_SHA256_REQUIRED'
  );
  assert.throws(
    () => parseImporterArguments(['--dry-run', '--input=x', `--expected-source-sha256=${'a'.repeat(64)}`, '--apply']),
    (error) => error.code === 'IMPORT_UNKNOWN_ARGUMENT'
  );

  const readerPath = path.join(__dirname, '..', 'scripts', 'database', 'importer', 'reader.js');
  const liveDatabasePath = path.join(__dirname, '..', 'src', 'server', 'data', 'db.json');
  const childScript = `
    const fs = require('node:fs');
    const path = require('node:path');
    const readerPath = ${JSON.stringify(readerPath)};
    const liveDatabasePath = path.resolve(${JSON.stringify(liveDatabasePath)});
    const originalExistsSync = fs.existsSync.bind(fs);
    const originalRealpathSync = fs.realpathSync.bind(fs);
    fs.existsSync = (value) => path.resolve(String(value)) === liveDatabasePath
      || originalExistsSync(value);
    fs.realpathSync = (value) => path.resolve(String(value)) === liveDatabasePath
      ? liveDatabasePath
      : originalRealpathSync(value);
    const { readSourceSnapshot } = require(readerPath);
    try {
      readSourceSnapshot({ inputPath: liveDatabasePath, expectedSha256: '${'a'.repeat(64)}' });
      process.exitCode = 2;
    } catch (error) {
      process.stdout.write(JSON.stringify({ code: error && error.code }));
      process.exitCode = error && error.code === 'IMPORT_LIVE_DATABASE_FORBIDDEN' ? 0 : 3;
    }
  `;
  const child = spawnSync(process.execPath, ['-e', childScript], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  assert.deepEqual(JSON.parse(child.stdout), { code: 'IMPORT_LIVE_DATABASE_FORBIDDEN' });
});

test('importer reader handles BOM, verifies hash, and never mutates its source', () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(makeImporterFixture()))]);
  withImporterFile(bytes, (inputPath) => {
    const before = fs.statSync(inputPath, { bigint: true });
    const snapshot = readSourceSnapshot({ inputPath, expectedSha256: sha256(bytes) });
    assert.equal(snapshot.data.accounts.length, 2);
    const { report } = runDryRun({ inputPath, expectedSha256: sha256(bytes) });
    const after = fs.statSync(inputPath, { bigint: true });
    assert.equal(report.status, 'READY');
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.equal(sha256(fs.readFileSync(inputPath)), sha256(bytes));
    assert.throws(
      () => readSourceSnapshot({ inputPath, expectedSha256: 'f'.repeat(64) }),
      (error) => error.code === 'IMPORT_SOURCE_HASH_MISMATCH'
    );
  });
});

test('importer rejects invalid UTF-8 and invalid JSON without exposing source content', () => {
  withImporterFile(Buffer.from([0xc3, 0x28]), (inputPath) => {
    const bytes = fs.readFileSync(inputPath);
    assert.throws(
      () => readSourceSnapshot({ inputPath, expectedSha256: sha256(bytes) }),
      (error) => error.code === 'IMPORT_INVALID_UTF8' && !error.message.includes(inputPath)
    );
  });
  withImporterFile('{invalid-json', (inputPath) => {
    const bytes = fs.readFileSync(inputPath);
    assert.throws(
      () => readSourceSnapshot({ inputPath, expectedSha256: sha256(bytes) }),
      (error) => error.code === 'IMPORT_INVALID_JSON' && !error.message.includes('invalid-json')
    );
  });
});

test('importer builds a deterministic in-memory QR split plan with count conservation', () => {
  const fixture = makeImporterFixture();
  const snapshot = {
    data: fixture,
    sourcePath: path.join(os.tmpdir(), 'synthetic-fixture.json'),
    sourceHash: sha256(Buffer.from(JSON.stringify(fixture))),
    sourceSize: Buffer.byteLength(JSON.stringify(fixture)),
    sourceMtimeNs: '1'
  };
  const first = analyzeSourceSnapshot(snapshot);
  const second = analyzeSourceSnapshot(snapshot);
  assert.deepEqual(first, second);
  assert.equal(first.report.status, 'READY');
  assert.equal(first.plan.qr_codes.length, 2);
  assert.equal(first.plan.records.length, 2);
  assert.equal(first.plan.co_creations.length, 1);
  assert.equal(first.plan.co_creation_comments.length, 1);
  assert.equal(first.plan.co_creation_comments[0].source_position, 0);
  assert.equal(first.report.count_conservation.passed, true);
  assert.deepEqual(first.report.count_conservation.expected, first.report.count_conservation.actual);
});

test('importer preserves kept and deleted JSON comment positions and blocks invalid plans', () => {
  const fixture = makeImporterFixture();
  fixture.qr_codes[1].co_creation_comments.push({
    id: 2,
    phone: '13800000002',
    account_id: 'ACC000002',
    author_name: 'deleted fixture',
    content: 'deleted fixture comment',
    status: 'deleted',
    created_at: '2026-01-02T03:04:05.000Z',
    deleted_at: '2026-01-02T03:05:05.000Z'
  });
  const { plan, qrSplits } = mapSourceToPlan(fixture);
  assert.deepEqual(
    plan.co_creation_comments.map((comment) => ({
      legacy_comment_id: comment.legacy_comment_id,
      source_position: comment.source_position,
      status: comment.status
    })),
    [
      { legacy_comment_id: '1', source_position: 0, status: 'kept' },
      { legacy_comment_id: '2', source_position: 1, status: 'deleted' }
    ]
  );

  const invalidPlan = JSON.parse(JSON.stringify(plan));
  invalidPlan.co_creation_comments[1].source_position = 0;
  const validation = validateImportSource(fixture, {
    plan: invalidPlan,
    qrSplits
  });
  assert.equal(
    validation.anomalies.some((item) => item.category === 'DUPLICATE_SOURCE_POSITION'),
    true
  );
  assert.equal(
    validation.anomalies.some((item) => item.category === 'SOURCE_POSITION_MISMATCH'),
    true
  );
});

test('importer preserves audited legacy proof, account, and duplicate-comment evidence', () => {
  const fixture = makeImporterFixture();
  const legacyProofHash = 'legacy-proof-marker-1';
  fixture.qr_codes[0].account_id = null;
  fixture.qr_codes[0].blockchain_hash = legacyProofHash;
  fixture.qr_codes[0].manifest_hash = legacyProofHash;
  fixture.qr_codes[0].chain_status = 'confirmed';
  fixture.qr_codes[1].co_creation_comments[0].account_id = null;
  fixture.qr_codes[1].co_creation_comments.push({
    id: 2,
    phone: '13800000001',
    account_id: 'ACC000001',
    author_name: 'second historical author',
    content: 'second historical comment',
    status: 'kept',
    created_at: '2026-01-02T03:06:05.000Z'
  });

  const { report, plan } = analyzeImporterFixture(fixture);
  assert.equal(report.status, 'READY');
  assert.equal(report.can_import, true);
  assert.deepEqual(report.blocked_reasons, []);
  assert.equal(report.anomaly_counts.LEGACY_NON_SHA_HASH_PRESERVED, 1);
  assert.equal(report.anomaly_counts.LEGACY_ACCOUNT_LINK_RECOVERED, 2);
  assert.equal(report.anomaly_counts.LEGACY_DUPLICATE_COMMENT_ACCOUNT_PRESERVED, 1);
  assert.equal(plan.records[0].account_id, 'ACC000001');
  assert.equal(plan.record_proofs[0].manifest_hash, null);
  assert.equal(plan.record_proofs[0].legacy_hash_snapshot, legacyProofHash);
  assert.deepEqual(
    plan.co_creation_comments.map((comment) => ({
      account_id: comment.account_id,
      source_position: comment.source_position,
      legacy_duplicate: comment.legacy_duplicate
    })),
    [
      { account_id: 'ACC000001', source_position: 0, legacy_duplicate: false },
      { account_id: 'ACC000001', source_position: 1, legacy_duplicate: true }
    ]
  );
  const serializedReport = JSON.stringify(report);
  [legacyProofHash, '13800000001', 'second historical comment'].forEach((value) => {
    assert.equal(serializedReport.includes(value), false);
  });
});

test('importer preserves the audited legacy product buy type and blocks unknown values', () => {
  const legacyFixture = makeImporterFixture();
  const createdAt = legacyFixture.accounts[0].created_at;
  legacyFixture.products.push({
    id: 'PROD_LEGACY_BUY', title: 'fixture', subtitle: '', cover_image: '', images: [],
    price_text: '1.00', price_cents: 100, description: '', status: 'published',
    product_type: 'wine_sticker', sticker_count: 1, stock: 1, is_customizable: false,
    shipping_note: '', after_sale_note: '', buy_type: 'copy_link', buy_url: '',
    scene_tags: ['free'], sort_order: 0, created_at: createdAt, updated_at: createdAt
  });

  const legacyAnalysis = analyzeImporterFixture(legacyFixture);
  assert.equal(legacyAnalysis.report.status, 'READY');
  assert.equal(legacyAnalysis.plan.products[0].buy_type, 'copy_link');

  const invalidFixture = structuredClone(legacyFixture);
  invalidFixture.products[0].buy_type = 'unreviewed_mode';
  const invalidAnalysis = analyzeImporterFixture(invalidFixture);
  assert.equal(invalidAnalysis.report.status, 'BLOCKED');
  assert.equal(
    invalidAnalysis.report.anomalies.some((item) => (
      item.category === 'INVALID_STATUS'
        && item.entity_type === 'products'
        && item.field === 'buy_type'
    )),
    true
  );
});

test('importer blocks unknown source fields, duplicate identities, broken references, and invalid QR lifecycle', () => {
  const fixture = makeImporterFixture();
  fixture.qr_codes[0].unexpected_secret = 'must not be ignored';
  delete fixture.qr_codes[0].issue_status;
  fixture.users.push({ ...fixture.users[0], id: 3, account_id: 'ACC404404' });
  fixture.qr_codes[1].activation_status = 'activated_pending_chain';
  const snapshot = {
    data: fixture,
    sourcePath: path.join(os.tmpdir(), 'blocked-fixture.json'),
    sourceHash: sha256(Buffer.from(JSON.stringify(fixture))),
    sourceSize: Buffer.byteLength(JSON.stringify(fixture)),
    sourceMtimeNs: '1'
  };
  const { report } = analyzeSourceSnapshot(snapshot);
  assert.equal(report.status, 'BLOCKED');
  assert.equal(report.blocked_reasons.includes('UNKNOWN_FIELD'), true);
  assert.equal(report.blocked_reasons.includes('MISSING_REQUIRED_FIELD'), true);
  assert.equal(report.blocked_reasons.includes('DUPLICATE_IDENTITY'), true);
  assert.equal(report.blocked_reasons.includes('MISSING_REFERENCE'), true);
  assert.equal(report.blocked_reasons.includes('INVALID_QR_LIFECYCLE'), true);
});

test('importer blocks unissued QR codes that advanced beyond unactivated', () => {
  const fixture = makeImporterFixture();
  fixture.qr_codes[0].issue_status = 'unissued';

  const analysis = analyzeImporterFixture(fixture);

  assert.equal(analysis.report.status, 'BLOCKED');
  assert.equal(
    analysis.report.anomalies.some((item) => (
      item.category === 'INVALID_QR_ISSUE_LIFECYCLE'
        && item.entity_type === 'qr_codes'
        && item.field === 'issue_status'
    )),
    true
  );
});

test('importer groups payment events by order transaction and keeps rejected unlinked callbacks auditable', () => {
  const fixture = makeImporterFixture();
  const createdAt = '2026-01-02T03:04:05.000Z';
  fixture.products.push({
    id: 'PROD_1', title: 'fixture product', subtitle: '', cover_image: '', images: [], price_text: '1.00',
    price_cents: 100, description: '', status: 'published', product_type: 'wine_sticker', sticker_count: 1,
    stock: 2, is_customizable: false, shipping_note: '', after_sale_note: '', buy_type: 'miniapp_order',
    buy_url: '', scene_tags: ['free'], sort_order: 1, created_at: createdAt, updated_at: createdAt
  });
  fixture.orders.push({
    id: 'ORDER_1', order_no: 'JS1', openid: 'openid-fixture-1', phone: '13800000001', account_id: 'ACC000001',
    product_id: 'PROD_1', product_snapshot: { id: 'PROD_1' }, quantity: 1, unit_price_cents: 100,
    total_amount_cents: 100, status: 'paid', payment_status: 'paid', payment_method: 'wechat', payment_mock: false,
    wechat_transaction_id: 'WX_TX_1', paid_at: createdAt, receiver_name: 'fixture', receiver_phone: '13800000001',
    region: 'fixture', address: 'fixture address', remark: '', express_company: '', express_no: '', shipped_at: null,
    refund_status: '', admin_note: '', created_at: createdAt, updated_at: createdAt
  });
  fixture.payment_logs.push(
    { id: 'PAY_1', order_id: 'ORDER_1', order_no: 'JS1', method: 'wechat', status: 'pending', amount_cents: 100, transaction_id: '', raw: {}, created_at: createdAt },
    { id: 'PAY_2', order_id: 'ORDER_1', order_no: 'JS1', method: 'wechat', status: 'paid', amount_cents: 100, transaction_id: 'WX_TX_1', raw: {}, created_at: createdAt },
    { id: 'PAY_3', order_id: '', order_no: '', method: 'wechat', status: 'notify_rejected', amount_cents: 0, transaction_id: '', raw: {}, error: 'fixture', created_at: createdAt }
  );
  const serialized = JSON.stringify(fixture);
  const { report, plan } = analyzeSourceSnapshot({
    data: fixture,
    sourcePath: path.join(os.tmpdir(), 'payment-fixture.json'),
    sourceHash: sha256(Buffer.from(serialized)),
    sourceSize: Buffer.byteLength(serialized),
    sourceMtimeNs: '1'
  });
  assert.equal(report.status, 'READY');
  assert.equal(plan.payment_transactions.length, 1);
  assert.equal(plan.payment_events.length, 2);
  assert.equal(plan.audit_events.length, 1);
  assert.equal(plan.payment_transactions[0].status, 'paid');
});

test('importer report and CLI never serialize the sensitive in-memory plan', () => {
  const fixture = makeImporterFixture();
  const sensitiveValues = [
    fixture.users[0].phone,
    fixture.users[0].openid,
    fixture.qr_codes[0].content,
    fixture.qr_codes[0].image_url,
    fixture.qr_codes[0].image_object_key
  ];
  const bytes = Buffer.from(JSON.stringify(fixture));
  withImporterFile(bytes, (inputPath) => {
    let stdout = '';
    let stderr = '';
    const exitCode = runImporterCli([
      '--dry-run',
      `--input=${inputPath}`,
      `--expected-source-sha256=${sha256(bytes)}`,
      '--format=json'
    ], {
      stdout: { write(value) { stdout += value; } },
      stderr: { write(value) { stderr += value; } }
    });
    assert.equal(exitCode, 0);
    assert.equal(stderr, '');
    assert.equal(stdout.includes('"plan"'), false);
    sensitiveValues.forEach((value) => assert.equal(stdout.includes(value), false));
    const report = JSON.parse(stdout);
    assert.equal(report.postgres_connected, false);
    assert.equal(report.read_only, true);
  });
});

test('importer CLI returns exit code 2 for a completed blocked audit', () => {
  const fixture = makeImporterFixture();
  fixture.qr_codes[0].unknown_field = 'sensitive-value';
  const bytes = Buffer.from(JSON.stringify(fixture));
  withImporterFile(bytes, (inputPath) => {
    let stdout = '';
    const exitCode = runImporterCli([
      '--dry-run', `--input=${inputPath}`, `--expected-source-sha256=${sha256(bytes)}`
    ], {
      stdout: { write(value) { stdout += value; } },
      stderr: { write() {} }
    });
    assert.equal(exitCode, 2);
    assert.equal(JSON.parse(stdout).status, 'BLOCKED');
    assert.equal(stdout.includes('sensitive-value'), false);
  });
});

test('importer detects a source changed after its snapshot', () => {
  const bytes = Buffer.from(JSON.stringify(makeImporterFixture()));
  withImporterFile(bytes, (inputPath) => {
    const snapshot = readSourceSnapshot({ inputPath, expectedSha256: sha256(bytes) });
    fs.appendFileSync(inputPath, ' ');
    assert.throws(() => assertSourceUnchanged(snapshot), (error) => error.code === 'IMPORT_SOURCE_CHANGED');
  });
});

test('importer code has no PostgreSQL, migration-runner, or business-runtime dependency', () => {
  const importerDirectory = path.join(__dirname, '..', 'scripts', 'database', 'importer');
  const files = fs.readdirSync(importerDirectory).filter((name) => name.endsWith('.js'))
    .map((name) => fs.readFileSync(path.join(importerDirectory, name), 'utf8'));
  files.push(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'database', 'import-dry-run.js'), 'utf8'));
  const source = files.join('\n');
  assert.equal(/require\(['"]pg['"]\)/.test(source), false);
  assert.equal(source.includes('src/server/database'), false);
  assert.equal(source.includes("require('../migrate')"), false);
  assert.equal(source.includes('dbService'), false);
});

function analyzeImporterFixture(fixture = makeImporterFixture()) {
  const serialized = JSON.stringify(fixture);
  const snapshot = {
    data: fixture,
    sourcePath: path.join(os.tmpdir(), 'phase-2b-2-fixture.json'),
    sourceHash: sha256(Buffer.from(serialized)),
    sourceSize: Buffer.byteLength(serialized),
    sourceMtimeNs: '1'
  };
  return { snapshot, ...analyzeSourceSnapshot(snapshot) };
}

function addCompleteImporterDomains(fixture) {
  const createdAt = fixture.accounts[0].created_at;
  fixture.admins.push({
    id: 1, username: 'fixture-admin', password: 'scrypt$fixture', role: 'admin',
    name: 'fixture', enabled: true, created_at: createdAt, updated_at: createdAt
  });
  fixture.batches.push({
    id: 'BATCH_1', name: 'fixture batch', brand_name: '', note: '',
    brand_disclosure_text: '', brand_disclosure_default: false,
    created_at: createdAt, updated_at: createdAt, created_by: 'fixture-admin'
  });
  fixture.qr_codes[0].batch_id = 'BATCH_1';
  fixture.quality_check_logs.push({
    id: 1, qr_id: 'STAR0001', checked_at: createdAt, checked_by: 'fixture-admin', result: 'pass'
  });
  fixture.products.push({
    id: 'PROD_1', title: 'fixture product', subtitle: '', cover_image: '',
    images: ['fixture.jpg'], price_text: '1.00', price_cents: 100, description: '',
    status: 'published', product_type: 'wine_sticker', sticker_count: 1, stock: 2,
    is_customizable: false, shipping_note: '', after_sale_note: '', buy_type: 'miniapp_order',
    buy_url: '', scene_tags: ['free'], sort_order: 1, created_at: createdAt, updated_at: createdAt
  });
  fixture.orders.push({
    id: 'ORDER_1', order_no: 'JS1', openid: 'openid-fixture-1', phone: '13800000001',
    account_id: 'ACC000001', product_id: 'PROD_1', product_snapshot: { id: 'PROD_1' },
    quantity: 1, unit_price_cents: 100, total_amount_cents: 100, status: 'paid',
    payment_status: 'paid', payment_method: 'wechat', payment_mock: false,
    wechat_transaction_id: 'WX_TX_1', paid_at: createdAt, receiver_name: 'fixture',
    receiver_phone: '13800000001', region: 'fixture', address: 'fixture address', remark: '',
    express_company: '', express_no: '', shipped_at: null, refund_status: '', admin_note: '',
    created_at: createdAt, updated_at: createdAt
  });
  fixture.payment_logs.push(
    {
      id: 'PAY_1', order_id: 'ORDER_1', order_no: 'JS1', method: 'wechat', status: 'paid',
      amount_cents: 100, transaction_id: 'WX_TX_1', raw: {}, created_at: createdAt
    },
    {
      id: 'PAY_2', order_id: '', order_no: '', method: 'wechat', status: 'notify_rejected',
      amount_cents: 0, transaction_id: '', raw: {}, error: 'fixture', created_at: createdAt
    }
  );
  Object.assign(fixture.qr_codes[0], {
    blockchain_hash: 'b'.repeat(64),
    chain_status: 'confirmed',
    chain_operation_id: 'fixture-operation',
    manifest_object_key: 'manifests/fixture.json',
    manifest_hash: 'b'.repeat(64),
    chain_tx_hash: 'fixture-transaction',
    chain_block_height: 1,
    chain_record_id: 'fixture-record',
    chain_certificate_url: 'https://fixture.invalid/certificate',
    chain_certificate_object_key: 'certificates/fixture.pdf',
    chain_certificate_object_url: 'https://fixture.invalid/certificate-object',
    chain_confirmed_at: createdAt,
    chain_callback_received_at: createdAt,
    archive_index_object_key: 'archives/fixture.json',
    archive_status: 'ready',
    archive_updated_at: createdAt
  });
  return fixture;
}

function createStagingTransactionHarness({ failOnCollection = null } = {}) {
  let committed = {
    tables: Object.fromEntries([...IMPORT_ORDER, 'outbox_jobs'].map((table) => [table, []])),
    importRuns: [],
    importAnomalies: [],
    sequences: {}
  };
  let failedOnce = false;
  const queryLog = [];
  const jsonColumns = new Set([
    'product_snapshot', 'provider_transaction_snapshot', 'sanitized_metadata',
    'home_slides', 'scene_cards', 'metadata'
  ]);

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function contextFor(state) {
    return {
      async query(sql, params = []) {
        const normalized = String(sql).replace(/\s+/g, ' ').trim();
        queryLog.push({ sql: normalized, params: clone(params) });

        if (normalized.includes("to_regclass('app.schema_migrations')")) {
          return { rows: [{ relation: 'app.schema_migrations' }] };
        }
        if (normalized.startsWith('SELECT version, trim(checksum) AS checksum')) {
          return { rows: [] };
        }
        if (normalized.startsWith('SELECT id FROM app.import_runs WHERE source_sha256')) {
          return { rows: state.importRuns.filter((run) => run.source_sha256 === params[0]).map((run) => ({ id: run.id })) };
        }
        if (normalized.startsWith('INSERT INTO app.import_runs')) {
          state.importRuns.push({
            id: params[0],
            source_sha256: params[1],
            source_label: params[2],
            importer_version: params[3],
            status: 'running',
            source_counts: JSON.parse(params[4]),
            imported_counts: {},
            checksum_summary: JSON.parse(params[5])
          });
          return { rows: [] };
        }
        if (normalized.startsWith('SELECT status FROM app.import_runs')) {
          const run = state.importRuns.find((item) => item.id === params[0]);
          return { rows: run ? [{ status: run.status }] : [] };
        }
        if (normalized.startsWith("UPDATE app.import_runs SET status = 'passed'")) {
          const run = state.importRuns.find((item) => item.id === params[0]);
          if (run && run.status === 'running') {
            run.status = 'passed';
            run.imported_counts = JSON.parse(params[1]);
            run.checksum_summary = JSON.parse(params[2]);
          }
          return { rows: [] };
        }
        if (normalized.startsWith("UPDATE app.import_runs SET status = 'failed'")) {
          const run = state.importRuns.find((item) => item.id === params[0]);
          if (run && run.status === 'running') run.status = 'failed';
          return { rows: [] };
        }
        if (normalized.startsWith('INSERT INTO app.import_anomalies')) {
          state.importAnomalies.push({ import_run_id: params[0], category: params[1] });
          return { rows: [] };
        }
        if (normalized.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [{}] };

        const countMatch = /^SELECT COUNT\(\*\)::text AS row_count FROM app\.([a-z_]+)$/.exec(normalized);
        if (countMatch) {
          return { rows: [{ row_count: String(state.tables[countMatch[1]].length) }] };
        }

        const insertMatch = /^INSERT INTO app\.([a-z_]+) \(([^)]+)\) VALUES/.exec(normalized);
        if (insertMatch) {
          const collection = insertMatch[1];
          if (collection === failOnCollection && !failedOnce) {
            failedOnce = true;
            const error = new Error('simulated constraint failure');
            error.code = 'POSTGRES_QUERY_FAILED';
            error.postgresCode = '23503';
            throw error;
          }
          const columns = insertMatch[2].split(',').map((column) => column.trim());
          const row = {};
          columns.forEach((column, index) => {
            const value = params[index];
            row[column] = jsonColumns.has(column) && typeof value === 'string'
              ? JSON.parse(value)
              : value;
          });
          state.tables[collection].push(row);
          return { rows: [] };
        }

        const sequenceMatch = /MAX\(id\) FROM app\.([a-z_]+)/.exec(normalized);
        if (normalized.startsWith('SELECT setval(') && sequenceMatch) {
          const ids = state.tables[sequenceMatch[1]]
            .map((row) => Number(row.id))
            .filter(Number.isSafeInteger);
          const value = ids.length ? Math.max(...ids) : 1;
          state.sequences[sequenceMatch[1]] = { last_value: value, is_called: ids.length > 0 };
          return { rows: [{ sequence_value: value }] };
        }

        if (normalized.includes("'app.account_id_seq'") && normalized.includes('FROM app.accounts')) {
          const ids = state.tables.accounts
            .map((row) => /^ACC(\d+)$/.exec(String(row.id || '')))
            .filter(Boolean)
            .map((match) => Number(match[1]));
          const value = ids.length ? Math.max(...ids) + 1 : 1;
          state.sequences.accounts = { last_value: value, is_called: false };
          return { rows: [{ sequence_value: value }] };
        }

        const maximumMatch = /^SELECT COALESCE\(MAX\(id\), 0\)::text AS max_id FROM app\.([a-z_]+)$/.exec(normalized);
        if (maximumMatch) {
          const ids = state.tables[maximumMatch[1]]
            .map((row) => Number(row.id))
            .filter(Number.isSafeInteger);
          return { rows: [{ max_id: String(ids.length ? Math.max(...ids) : 0) }] };
        }

        const sequenceStateMatch = /^SELECT last_value::text AS last_value, is_called FROM app\.([a-z_]+)_id_seq$/.exec(normalized);
        if (sequenceStateMatch) {
          const sequence = state.sequences[sequenceStateMatch[1]] || { last_value: 1, is_called: false };
          return { rows: [{ last_value: String(sequence.last_value), is_called: sequence.is_called }] };
        }

        const explicitIdMatch = /^SELECT id::text AS id FROM app\.([a-z_]+) WHERE id = ANY/.exec(normalized);
        if (explicitIdMatch) {
          const expected = new Set((params[0] || []).map(String));
          return {
            rows: state.tables[explicitIdMatch[1]]
              .filter((row) => expected.has(String(row.id)))
              .map((row) => ({ id: String(row.id) }))
              .sort((left, right) => left.id.localeCompare(right.id))
          };
        }

        if (normalized.includes('AS violation_count')) {
          return { rows: [{ violation_count: '0' }] };
        }

        const selectRowsMatch = /^SELECT (.+) FROM app\.([a-z_]+)$/.exec(normalized);
        if (selectRowsMatch) {
          const columns = selectRowsMatch[1].split(',').map((column) => column.trim());
          return {
            rows: state.tables[selectRowsMatch[2]].map((stored) => Object.fromEntries(
              columns.map((column) => [column, stored[column] === undefined ? null : stored[column]])
            ))
          };
        }

        throw new Error(`Unhandled staging test query: ${normalized}`);
      }
    };
  }

  async function transactionRunner(_pool, callback) {
    const working = clone(committed);
    const result = await callback(contextFor(working));
    committed = working;
    return result;
  }

  return {
    get state() { return clone(committed); },
    queryLog,
    transactionRunner
  };
}

test('staging import CLI and environment require explicit non-production staging gates', () => {
  const hash = 'a'.repeat(64);
  assert.throws(
    () => parseStagingImportArguments([]),
    (error) => error.code === 'POSTGRES_IMPORT_INPUT_REQUIRED'
  );
  assert.throws(
    () => parseStagingImportArguments([
      '--input=fixture.json', `--expected-source-sha256=${hash}`, '--target=staging'
    ]),
    (error) => error.code === 'POSTGRES_IMPORT_STAGING_CONFIRMATION_REQUIRED'
  );
  assert.deepEqual(parseStagingImportArguments([
    '--input=fixture.json', `--expected-source-sha256=${hash}`, '--target=staging',
    '--apply-staging', '--staging-confirmed'
  ]), {
    inputPath: 'fixture.json', expectedSha256: hash, target: 'staging'
  });
  assert.throws(
    () => assertStagingEnvironment({ config: makeConfig(), env: { NODE_ENV: 'production' }, target: 'staging' }),
    (error) => error.code === 'POSTGRES_IMPORT_PRODUCTION_FORBIDDEN'
  );
  assert.throws(
    () => assertStagingEnvironment({
      config: makeConfig({ database: 'xingxing_production' }), env: {}, target: 'staging'
    }),
    (error) => error.code === 'POSTGRES_IMPORT_DATABASE_NOT_STAGING'
  );
  assert.deepEqual(
    assertStagingEnvironment({ config: makeConfig(), env: {}, target: 'staging' }),
    { database: 'app_test', schema: 'app' }
  );
});

test('writer accepts only an injected transaction context and preserves plan values and order', async () => {
  const { report, plan } = analyzeImporterFixture(addCompleteImporterDomains(makeImporterFixture()));
  assert.equal(report.status, 'READY');
  const inserted = [];
  await importPlanToPostgres({
    plan,
    transactionContext: {
      async query(sql, params) {
        inserted.push({ sql, params });
        return { rows: [] };
      }
    }
  });
  const insertedCollections = inserted.map((item) => /^INSERT INTO app\.([a-z_]+)/.exec(item.sql)[1]);
  const expectedCollections = IMPORT_ORDER.flatMap((collection) => (
    plan[collection].map(() => collection)
  ));
  assert.deepEqual(insertedCollections, expectedCollections);
  assert.equal(inserted.some((item) => /CURRENT_TIMESTAMP|NOW\(\)/i.test(item.sql)), false);
  assert.equal(inserted.some((item) => item.params.includes(plan.accounts[0].created_at)), true);
  assert.match(planSha256(plan), /^[0-9a-f]{64}$/);

  const writerSource = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'database', 'importer', 'writer.js'),
    'utf8'
  );
  assert.equal(/\b(?:Pool|Client|createPostgresPool)\b/.test(writerSource), false);
  assert.equal(/['"](?:BEGIN|COMMIT|ROLLBACK)['"]/.test(writerSource), false);
});

test('public QR domain marker ignores unrelated identity fields and detects QR changes', () => {
  const fixture = makeImporterFixture();
  const baseline = publicQrDomainSha256FromSource(fixture);
  const reordered = JSON.parse(JSON.stringify(fixture));
  reordered.qr_codes.reverse();
  assert.equal(publicQrDomainSha256FromSource(reordered), baseline);

  const unrelated = JSON.parse(JSON.stringify(fixture));
  unrelated.accounts[0].display_name = 'unrelated identity edit';
  unrelated.miniapp_content.home_title = 'unrelated content edit';
  assert.equal(publicQrDomainSha256FromSource(unrelated), baseline);

  const changed = JSON.parse(JSON.stringify(fixture));
  changed.qr_codes[0].content = 'changed public QR content';
  assert.notEqual(publicQrDomainSha256FromSource(changed), baseline);

  const analysis = analyzeImporterFixture(fixture);
  assert.equal(publicQrDomainSha256(analysis.plan), baseline);
  assert.equal(
    analysis.report.domain_checksums[PUBLIC_QR_DOMAIN_CHECKSUM_KEY],
    baseline
  );
});

test('public QR domain marker registration requires explicit gates and verified parity', async () => {
  const hash = 'a'.repeat(64);
  assert.throws(
    () => parseDomainMarkerArguments([]),
    (error) => error.code === 'PUBLIC_QR_DOMAIN_MARKER_SHA256_REQUIRED'
  );
  assert.deepEqual(parseDomainMarkerArguments([
    '--input=fixture.json',
    `--expected-source-sha256=${hash}`,
    `--expected-domain-sha256=${hash}`,
    '--target=staging',
    '--apply-staging',
    '--staging-confirmed'
  ]), {
    inputPath: 'fixture.json',
    expectedSourceSha256: hash,
    expectedDomainSha256: hash,
    target: 'staging',
    preservedUnissuedLifecycleIds: []
  });

  assert.deepEqual(parseDomainMarkerArguments([
    '--input=fixture.json',
    `--expected-source-sha256=${hash}`,
    `--expected-domain-sha256=${hash}`,
    '--target=staging',
    '--apply-staging',
    '--staging-confirmed',
    '--allow-preserved-unissued-lifecycle-ids=STAR0002,STAR0001'
  ]).preservedUnissuedLifecycleIds, ['STAR0001', 'STAR0002']);
  assert.throws(
    () => parseDomainMarkerArguments([
      '--input=fixture.json',
      `--expected-source-sha256=${hash}`,
      `--expected-domain-sha256=${hash}`,
      '--target=staging',
      '--apply-staging',
      '--staging-confirmed',
      '--allow-preserved-unissued-lifecycle-ids=STAR0001,STAR0001'
    ]),
    (error) => error.code === 'PUBLIC_QR_DOMAIN_MARKER_LEGACY_ALLOWLIST_INVALID'
  );

  const fixture = makeImporterFixture();
  const { plan } = analyzeImporterFixture(fixture);
  const domainHash = publicQrDomainSha256(plan);
  const calls = [];
  const transactionContext = {
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      if (String(sql).includes('FROM app.import_runs')) {
        return { rows: [{ id: 'import-run', current_domain_sha256: null }] };
      }
      return { rows: [], rowCount: 1 };
    }
  };
  const result = await registerPublicQrDomainMarker({
    pool: {},
    snapshot: { sourceHash: 'b'.repeat(64) },
    plan,
    expectedDomainSha256: domainHash,
    migrations: [],
    transactionRunner: async (_pool, callback, options) => {
      assert.deepEqual(options, { isolationLevel: 'serializable' });
      return callback(transactionContext);
    },
    sourceUnchanged() {},
    migrationInspector: async () => ({ pending: [] }),
    verifyPlan: async () => ({ integrity: { orphan_count: 0 } })
  });
  assert.equal(result.updated, true);
  assert.equal(result.public_qr_domain_sha256, domainHash);
  assert.deepEqual(result.preserved_unissued_lifecycle_ids, []);
  assert.equal(calls.some((call) => call.sql.includes('jsonb_set')), true);
});

test('public QR domain marker accepts only an exact migration-protected legacy lifecycle allowlist', async () => {
  const fixture = makeImporterFixture();
  fixture.qr_codes[0].issue_status = 'unissued';
  const analysis = analyzeImporterFixture(fixture);

  assert.equal(analysis.report.status, 'BLOCKED');
  assert.throws(
    () => assertMarkerAnalysisReady(analysis.report, analysis.plan),
    (error) => error.code === 'PUBLIC_QR_DOMAIN_MARKER_LEGACY_ALLOWLIST_MISMATCH'
  );
  assert.throws(
    () => assertMarkerAnalysisReady(
      analysis.report,
      analysis.plan,
      ['STAR9999']
    ),
    (error) => error.code === 'PUBLIC_QR_DOMAIN_MARKER_LEGACY_ALLOWLIST_MISMATCH'
  );
  assert.deepEqual(
    assertMarkerAnalysisReady(
      analysis.report,
      analysis.plan,
      ['STAR0001']
    ),
    ['STAR0001']
  );

  const additionallyBlocked = makeImporterFixture();
  additionallyBlocked.qr_codes[0].issue_status = 'unissued';
  additionallyBlocked.qr_codes[0].activated_at = null;
  const additionallyBlockedAnalysis = analyzeImporterFixture(additionallyBlocked);
  assert.throws(
    () => assertMarkerAnalysisReady(
      additionallyBlockedAnalysis.report,
      additionallyBlockedAnalysis.plan,
      ['STAR0001']
    ),
    (error) => error.code === 'PUBLIC_QR_DOMAIN_MARKER_SOURCE_BLOCKED'
  );

  const domainHash = publicQrDomainSha256(analysis.plan);
  const calls = [];
  const transactionContext = {
    async query(sql) {
      calls.push(String(sql));
      if (String(sql).includes('FROM pg_constraint')) {
        return { rows: [{ convalidated: false }], rowCount: 1 };
      }
      if (String(sql).includes('FROM app.import_runs')) {
        return { rows: [{ id: 'import-run', current_domain_sha256: null }] };
      }
      return { rows: [], rowCount: 1 };
    }
  };
  const result = await registerPublicQrDomainMarker({
    pool: {},
    snapshot: { sourceHash: 'b'.repeat(64) },
    plan: analysis.plan,
    expectedDomainSha256: domainHash,
    preservedUnissuedLifecycleIds: ['STAR0001'],
    migrations: [],
    transactionRunner: async (_pool, callback) => callback(transactionContext),
    sourceUnchanged() {},
    migrationInspector: async () => ({ pending: [] }),
    verifyPlan: async () => ({ integrity: { orphan_count: 0 } })
  });

  assert.deepEqual(result.preserved_unissued_lifecycle_ids, ['STAR0001']);
  assert.equal(calls.some((sql) => sql.includes('FROM pg_constraint')), true);

  transactionContext.query = async (sql) => {
    if (String(sql).includes('FROM pg_constraint')) {
      return { rows: [{ convalidated: true }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  };
  await assert.rejects(
    registerPublicQrDomainMarker({
      pool: {},
      snapshot: { sourceHash: 'b'.repeat(64) },
      plan: analysis.plan,
      expectedDomainSha256: domainHash,
      preservedUnissuedLifecycleIds: ['STAR0001'],
      migrations: [],
      transactionRunner: async (_pool, callback) => callback(transactionContext),
      migrationInspector: async () => ({ pending: [] })
    }),
    (error) => error.code === 'PUBLIC_QR_DOMAIN_MARKER_LEGACY_CONSTRAINT_REQUIRED'
  );
});

test('mapping gives child rows historical timestamps and maps audit metadata to the SQL column', () => {
  const fixture = makeImporterFixture();
  const createdAt = fixture.accounts[0].created_at;
  fixture.products.push({
    id: 'PROD_TIME', title: 'fixture', subtitle: '', cover_image: '', images: ['fixture.jpg'],
    price_text: '1.00', price_cents: 100, description: '', status: 'published',
    product_type: 'wine_sticker', sticker_count: 1, stock: 1, is_customizable: false,
    shipping_note: '', after_sale_note: '', buy_type: 'miniapp_order', buy_url: '',
    scene_tags: ['free'], sort_order: 0, created_at: createdAt, updated_at: createdAt
  });
  fixture.payment_logs.push({
    id: 'UNLINKED', order_id: '', order_no: '', method: 'wechat', status: 'notify_rejected',
    amount_cents: 0, transaction_id: '', raw: {}, error: 'fixture', created_at: createdAt
  });
  const { report, plan } = analyzeImporterFixture(fixture);
  assert.equal(report.status, 'READY');
  assert.equal(plan.product_images[0].created_at, createdAt);
  assert.equal(plan.product_scene_tags[0].created_at, createdAt);
  assert.deepEqual(plan.audit_events[0].metadata, {
    status: 'notify_rejected', payload_sha256: sha256(Buffer.from('{}'))
  });
  assert.equal(Object.prototype.hasOwnProperty.call(plan.audit_events[0], 'sanitized_metadata'), false);
});

test('staging import commits one verified business transaction and blocks a repeated source hash', async () => {
  const analysis = analyzeImporterFixture();
  const harness = createStagingTransactionHarness();
  assertAnalysisReady(analysis.report, analysis.plan);
  const result = await executeStagingImport({
    pool: {},
    ...analysis,
    migrations: [],
    transactionRunner: harness.transactionRunner,
    sourceUnchanged() {}
  });
  assert.equal(result.status, 'PASSED');
  assert.equal(harness.state.importRuns.length, 1);
  assert.equal(harness.state.importRuns[0].status, 'passed');
  assert.equal(
    harness.state.importRuns[0].checksum_summary[PUBLIC_QR_DOMAIN_CHECKSUM_KEY],
    analysis.report.domain_checksums[PUBLIC_QR_DOMAIN_CHECKSUM_KEY]
  );
  assert.equal(
    result.public_qr_domain_sha256,
    analysis.report.domain_checksums[PUBLIC_QR_DOMAIN_CHECKSUM_KEY]
  );
  assert.equal(result.sequence_values.users, '2');
  assert.equal(result.sequence_values.accounts, '3');
  IMPORT_ORDER.forEach((collection) => {
    assert.equal(harness.state.tables[collection].length, analysis.plan[collection].length);
  });
  assert.deepEqual(result.imported_counts, Object.fromEntries(
    IMPORT_ORDER.map((collection) => [collection, analysis.plan[collection].length])
  ));
  await assert.rejects(
    executeStagingImport({
      pool: {},
      ...analysis,
      migrations: [],
      transactionRunner: harness.transactionRunner,
      sourceUnchanged() {}
    }),
    (error) => error.code === 'POSTGRES_IMPORT_SOURCE_ALREADY_IMPORTED'
  );
  assert.equal(harness.state.importRuns.length, 1);
});

test('staging import rolls back all business rows when a writer query fails', async () => {
  const analysis = analyzeImporterFixture();
  const harness = createStagingTransactionHarness({ failOnCollection: 'records' });
  await assert.rejects(
    executeStagingImport({
      pool: {},
      ...analysis,
      migrations: [],
      transactionRunner: harness.transactionRunner,
      sourceUnchanged() {}
    }),
    (error) => error.code === 'POSTGRES_QUERY_FAILED' && error.postgresCode === '23503'
  );
  IMPORT_ORDER.forEach((collection) => {
    assert.equal(harness.state.tables[collection].length, 0);
  });
  assert.equal(harness.state.importRuns.length, 1);
  assert.equal(harness.state.importRuns[0].status, 'failed');
  assert.equal(harness.state.importAnomalies.length, 1);
  assert.equal(harness.state.importAnomalies[0].category, 'POSTGRES_QUERY_FAILED');
});

test('import verification fails closed on count or row differences without logging row values', async () => {
  const { plan } = analyzeImporterFixture();
  await assert.rejects(
    verifyImportedPlan({
      plan,
      transactionContext: {
        async query(sql) {
          if (String(sql).includes('FROM app.accounts')) return { rows: [] };
          return { rows: [{ violation_count: '0' }] };
        }
      }
    }),
    (error) => error.code === 'POSTGRES_IMPORT_COUNT_MISMATCH'
      && !error.message.includes(plan.accounts[0].id)
  );
});

function createRepositoryContext(responses = []) {
  const calls = [];
  return {
    calls,
    context: {
      async query(sql, params = []) {
        calls.push({ sql: String(sql), params: [...params] });
        const response = responses.length > 0 ? responses.shift() : { rows: [], rowCount: 0 };
        if (response instanceof Error) throw response;
        return response;
      }
    }
  };
}

function repositorySource() {
  const directory = path.join(__dirname, '..', 'src', 'server', 'repositories');
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith('.js'))
    .map((name) => fs.readFileSync(path.join(directory, name), 'utf8'))
    .join('\n');
}

test('repositories require injected transaction context and never own connections or transactions', () => {
  assert.throws(
    () => new AccountRepository(),
    (error) => error.code === 'REPOSITORY_TRANSACTION_CONTEXT_REQUIRED'
  );

  const source = repositorySource();
  assert.equal(source.includes("require('pg')"), false);
  assert.equal(source.includes("require('../database/connection')"), false);
  assert.equal(source.includes('createPostgresPool'), false);
  assert.equal(source.includes('process.env'), false);
  assert.equal(/['"](?:BEGIN|COMMIT|ROLLBACK)['"]/.test(source), false);
});

test('repository queries parameterize input and explicitly map rows to domain records', async () => {
  const accountRow = {
    id: 'ACC_TEST', status: 'active', display_name: '', avatar_url: '',
    created_from: 'migration', created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z', ignored_database_column: 'not-domain-data'
  };
  const maliciousId = "ACC_TEST' OR 1=1 --";
  const harness = createRepositoryContext([{ rows: [accountRow], rowCount: 1 }]);
  const result = await new AccountRepository(harness.context).findById(maliciousId);

  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].sql.includes(maliciousId), false);
  assert.deepEqual(harness.calls[0].params, [maliciousId]);
  assert.equal(result.id, 'ACC_TEST');
  assert.equal(result.ignored_database_column, undefined);
  assert.notEqual(result, accountRow);
  assert.equal(Object.isFrozen(result), true);
});

test('account repository allocates canonical IDs from the database sequence', async () => {
  const harness = createRepositoryContext([
    { rows: [{ account_number: '29' }], rowCount: 1 }
  ]);
  const accountId = await new AccountRepository(harness.context).allocateId();

  assert.equal(accountId, 'ACC000029');
  assert.match(harness.calls[0].sql, /nextval\('app\.account_id_seq'\)/);
  assert.deepEqual(harness.calls[0].params, []);

  const invalidHarness = createRepositoryContext([
    { rows: [{ account_number: '0' }], rowCount: 1 }
  ]);
  await assert.rejects(
    new AccountRepository(invalidHarness.context).allocateId(),
    (error) => error.code === 'REPOSITORY_ACCOUNT_ID_SEQUENCE_INVALID'
  );
});

test('identity write repositories lock canonical keys and expose bounded mutations', async () => {
  const identityRow = {
    id: 32, legacy_id: null, account_id: 'ACC000029', phone: '13800000029',
    openid: 'openid-29', unionid: null, source: 'web+miniapp',
    created_at: '2026-08-08T08:00:00.000Z',
    updated_at: '2026-08-08T08:01:00.000Z'
  };
  const harness = createRepositoryContext([
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 1 },
    { rows: [identityRow], rowCount: 1 },
    { rows: [identityRow], rowCount: 1 }
  ]);
  const repository = new IdentityRepository(harness.context);

  await repository.lockIdentityKeys(['phone:z', 'openid:a', 'phone:z']);
  await repository.updateIdentity(identityRow.id, identityRow);
  await repository.deleteById(identityRow.id);

  assert.deepEqual(harness.calls.slice(0, 2).map((call) => call.params), [
    ['openid:a'],
    ['phone:z']
  ]);
  assert.match(harness.calls[0].sql, /pg_advisory_xact_lock/);
  assert.match(harness.calls[2].sql, /^UPDATE app\.users SET/);
  assert.deepEqual(harness.calls[2].params, [
    32, identityRow.phone, identityRow.openid, identityRow.unionid,
    identityRow.source, identityRow.updated_at
  ]);
  assert.match(harness.calls[3].sql, /^DELETE FROM app\.users/);
  await assert.rejects(
    repository.lockIdentityKeys([]),
    (error) => error.code === 'REPOSITORY_IDENTITY_LOCK_KEY_REQUIRED'
  );
});

test('identity repository checks cross-account phone references without returning identities', async () => {
  const content = 'private fixture content';
  const harness = createRepositoryContext([
    { rows: [{ has_reference: true }], rowCount: 1 }
  ]);
  const result = await new IdentityRepository(harness.context)
    .hasCrossAccountPhoneReference({ accountId: 'ACC_OWNER', content });

  assert.equal(result, true);
  assert.deepEqual(harness.calls[0].params, ['ACC_OWNER', content]);
  assert.match(harness.calls[0].sql, /SELECT EXISTS/);
  assert.match(harness.calls[0].sql, /account_id <> \$1/);
  assert.match(harness.calls[0].sql, /position\(phone IN \$2\) > 0/);
  assert.equal(harness.calls[0].sql.includes(content), false);
});

test('identity reference repository checks account and nested identity references', async () => {
  const harness = createRepositoryContext([
    { rows: [{ has_references: true }], rowCount: 1 }
  ]);
  const hasReferences = await new IdentityReferenceRepository(harness.context)
    .hasBusinessReferences({ accountId: 'ACC000029', openid: 'openid-29' });

  assert.equal(hasReferences, true);
  assert.deepEqual(harness.calls[0].params, ['ACC000029', 'openid-29']);
  assert.match(harness.calls[0].sql, /FROM app\.records WHERE account_id = \$1/);
  assert.match(
    harness.calls[0].sql,
    /jsonb_build_object\('identity', to_jsonb\(\$1::text\)\)/
  );
  assert.match(
    harness.calls[0].sql,
    /jsonb_build_object\('identity', to_jsonb\(\$2::text\)\)/
  );
  assert.equal(harness.calls[0].sql.includes('openid-29'), false);
});

test('public QR batch repository exposes only the fields required by the public adapter', async () => {
  const row = {
    id: 'BATCH_PUBLIC',
    brand_name: 'Public brand',
    disclosure_text: 'Public disclosure',
    show_brand_disclosure_default: true,
    name: 'Internal batch name',
    note: 'Internal note',
    created_by_snapshot: 'internal operator'
  };
  const harness = createRepositoryContext([{ rows: [row], rowCount: 1 }]);
  const result = await new QrBatchRepository(harness.context).findById('BATCH_PUBLIC');

  assert.deepEqual(harness.calls[0].params, ['BATCH_PUBLIC']);
  assert.match(harness.calls[0].sql, /FROM app\.qr_batches WHERE id = \$1/);
  assert.doesNotMatch(harness.calls[0].sql, /\b(?:note|created_by|SELECT \*)\b/i);
  assert.deepEqual(result, {
    id: 'BATCH_PUBLIC',
    brand_name: 'Public brand',
    disclosure_text: 'Public disclosure',
    show_brand_disclosure_default: true
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(result.name, undefined);
  assert.equal(result.note, undefined);
});

test('QR issuance repository locks prefixes and inserts only issued unactivated rows', async () => {
  const row = {
    id: 'NEW00008',
    issue_status: 'issued',
    lifecycle_status: 'unactivated',
    hidden: false,
    batch_id: 'BATCH_PUBLIC',
    print_batch_id: null,
    qr_image_url_snapshot: '/api/qr/image/token',
    access_token: 'token',
    created_at: '2026-08-12T01:02:03.000Z',
    updated_at: '2026-08-12T01:02:03.000Z'
  };
  const harness = createRepositoryContext([
    { rows: [], rowCount: 1 },
    { rows: [{ max_sequence: 7 }], rowCount: 1 },
    { rows: [{ id: 'BATCH_PUBLIC' }], rowCount: 1 },
    { rows: [row], rowCount: 1 }
  ]);
  const repository = new QrIssuanceRepository(harness.context);
  await repository.lockPrefix('NEW');
  assert.equal(await repository.findMaxSequence('NEW'), 7);
  assert.equal(await repository.batchExists('BATCH_PUBLIC'), true);
  assert.deepEqual(await repository.insertIssued({
    id: row.id,
    batch_id: row.batch_id,
    qr_image_url_snapshot: row.qr_image_url_snapshot,
    access_token: row.access_token,
    created_at: row.created_at
  }), row);

  assert.match(harness.calls[0].sql, /pg_advisory_xact_lock/);
  assert.deepEqual(harness.calls[0].params, ['NEW']);
  assert.match(harness.calls[1].sql, /right\(id, 5\)/);
  assert.doesNotMatch(harness.calls[1].sql, /NEW/);
  assert.match(harness.calls[2].sql, /FOR KEY SHARE/);
  assert.match(harness.calls[3].sql, /'issued', 'unactivated'/);
  assert.deepEqual(harness.calls[3].params, [
    row.id,
    row.batch_id,
    row.qr_image_url_snapshot,
    row.access_token,
    row.created_at
  ]);
});

test('QR administration repository keeps management reads and writes transaction-scoped', async () => {
  const harness = createRepositoryContext([
    { rows: [], rowCount: 1 },
    { rows: [{ id: 'BATCH_20260813_001' }], rowCount: 1 },
    { rows: [{ id: 'QR_TEST' }], rowCount: 1 }
  ]);
  const repository = new QrAdministrationRepository(harness.context);
  await repository.lockBatchDay('20260813');
  assert.deepEqual(
    await repository.listBatchIdsForDay('20260813'),
    ['BATCH_20260813_001']
  );
  assert.deepEqual(
    await repository.setHidden(
      ['QR_TEST'], true, '2026-08-13T00:00:00.000Z'
    ),
    ['QR_TEST']
  );
  assert.match(harness.calls[0].sql, /pg_advisory_xact_lock/);
  assert.deepEqual(harness.calls[0].params, ['20260813']);
  assert.match(harness.calls[1].sql, /WHERE id LIKE \$1/);
  assert.deepEqual(harness.calls[2].params, [
    ['QR_TEST'], true, '2026-08-13T00:00:00.000Z'
  ]);
});

test('admin, quality, and NFT QR routes share the issuance authority boundary', () => {
  const readRoute = (name) => fs.readFileSync(
    path.join(__dirname, `../src/server/routes/${name}.js`),
    'utf8'
  );
  const adminRoute = readRoute('admin');
  const qualityRoute = readRoute('qc');
  const nftRoute = readRoute('nft');

  assert.match(adminRoute, /administerQrs/);
  assert.match(adminRoute, /selectQrAdministration/);
  assert.match(adminRoute, /OPERATION_DISABLED_DURING_POSTGRES_AUTHORITY/);
  assert.match(qualityRoute, /administerQrs/);
  assert.match(qualityRoute, /selectQualityOperation/);
  assert.match(nftRoute, /administerQrs\('getRecord'/);
});

test('co-creation repository exposes stable source position without UUID ordering', async () => {
  const row = {
    id: '00000000-0000-0000-0000-000000000201',
    co_creation_id: '00000000-0000-0000-0000-000000000101',
    account_id: 'ACC_TEST',
    legacy_comment_id: 'COMMENT_1',
    source_position: 4,
    phone_snapshot: '',
    author_name: 'Fixture',
    content: 'Fixture comment',
    status: 'kept',
    created_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null
  };
  const harness = createRepositoryContext([{ rows: [row], rowCount: 1 }]);
  const comments = await new CoCreationRepository(harness.context)
    .listEffectiveComments(row.co_creation_id);

  assert.deepEqual(harness.calls[0].params, [row.co_creation_id]);
  assert.match(harness.calls[0].sql, /ORDER BY source_position ASC/);
  assert.doesNotMatch(harness.calls[0].sql, /ORDER BY[^;]*\bid\b/i);
  assert.equal(comments[0].source_position, 4);
  assert.equal(Object.isFrozen(comments[0]), true);

  const candidateHarness = createRepositoryContext([{ rows: [row], rowCount: 1 }]);
  await new CoCreationRepository(candidateHarness.context)
    .listPublicCommentsCandidate(row.co_creation_id, { limit: 13 });
  assert.deepEqual(candidateHarness.calls[0].params, [row.co_creation_id, 13]);
  assert.match(
    candidateHarness.calls[0].sql,
    /ORDER BY created_at DESC, source_position ASC\s+LIMIT \$2/
  );
});

test('repository writes cannot create importer-only legacy exceptions', async () => {
  const commentHarness = createRepositoryContext();
  await new CoCreationRepository(commentHarness.context).insertComment({
    legacy_duplicate: true
  });
  assert.equal(
    commentHarness.calls[0].params[COMMENT_FIELDS.indexOf('legacy_duplicate')],
    false
  );

  const proofHarness = createRepositoryContext();
  await new ProofRepository(proofHarness.context).insertPending({
    legacy_hash_snapshot: 'must-not-enter-runtime-write'
  });
  assert.equal(
    proofHarness.calls[0].params[PROOF_FIELDS.indexOf('legacy_hash_snapshot')],
    null
  );
});

test('outbox repository fixes lifecycle state and serializes only the supplied job payload', async () => {
  const row = Object.fromEntries(OUTBOX_FIELDS.map((field) => [field, null]));
  row.id = '00000000-0000-0000-0000-000000000901';
  row.job_type = 'record_proof_prepare_submit';
  row.aggregate_type = 'record';
  row.aggregate_id = 'QR_WRITE';
  row.idempotency_key = 'record-proof:QR_WRITE';
  row.payload = { record_qr_id: 'QR_WRITE' };
  row.status = 'pending';
  row.attempt_count = 0;
  row.last_error = '';
  const harness = createRepositoryContext([{ rows: [row], rowCount: 1 }]);

  const result = await new OutboxRepository(harness.context).insertPending({
    ...row,
    payload: row.payload,
    status: 'succeeded',
    attempt_count: 99,
    locked_at: '2026-08-09T01:00:00.000Z',
    locked_by: 'untrusted-worker',
    last_error: 'untrusted-error'
  });

  const params = harness.calls[0].params;
  assert.equal(params[OUTBOX_FIELDS.indexOf('status')], 'pending');
  assert.equal(params[OUTBOX_FIELDS.indexOf('attempt_count')], 0);
  assert.equal(params[OUTBOX_FIELDS.indexOf('locked_at')], null);
  assert.equal(params[OUTBOX_FIELDS.indexOf('locked_by')], null);
  assert.equal(params[OUTBOX_FIELDS.indexOf('last_error')], '');
  assert.equal(
    params[OUTBOX_FIELDS.indexOf('payload')],
    JSON.stringify({ record_qr_id: 'QR_WRITE' })
  );
  assert.deepEqual(result.payload, { record_qr_id: 'QR_WRITE' });
  assert.equal(Object.isFrozen(result), true);
});

test('outbox repository recovers stale work, claims with skip-locked, and enforces ownership', async () => {
  const row = Object.fromEntries(OUTBOX_FIELDS.map((field) => [field, null]));
  row.id = '00000000-0000-0000-0000-000000000902';
  row.job_type = 'record_proof_prepare_submit';
  row.aggregate_type = 'record';
  row.aggregate_id = 'QR_WRITE';
  row.idempotency_key = 'record-proof:QR_WRITE';
  row.payload = { record_qr_id: 'QR_WRITE' };
  row.status = 'processing';
  row.attempt_count = 1;
  row.locked_by = 'worker-test';
  const harness = createRepositoryContext(Array.from({ length: 5 }, () => ({
    rows: [row], rowCount: 1
  })));
  const repository = new OutboxRepository(harness.context);

  await repository.recoverStale({
    stale_before: '2026-08-09T08:55:00.000Z',
    recovered_at: '2026-08-09T09:00:00.000Z',
    limit: 1000,
    job_types: ['record_proof_prepare_submit'],
    aggregate_ids: ['QR_WRITE']
  });
  await repository.claimPending({
    worker_id: 'worker-test',
    claimed_at: '2026-08-09T09:00:00.000Z',
    limit: 1000,
    job_types: ['record_proof_prepare_submit'],
    aggregate_ids: ['QR_WRITE']
  });
  await repository.markSucceeded({
    id: row.id,
    worker_id: 'worker-test',
    updated_at: '2026-08-09T09:01:00.000Z'
  });
  await repository.releaseForRetry({
    id: row.id,
    worker_id: 'worker-test',
    available_at: '2026-08-09T09:02:00.000Z',
    last_error: 'PROVIDER_TIMEOUT',
    updated_at: '2026-08-09T09:01:00.000Z'
  });
  await repository.markFailed({
    id: row.id,
    worker_id: 'worker-test',
    last_error: 'PROVIDER_REJECTED',
    updated_at: '2026-08-09T09:03:00.000Z'
  });

  assert.match(harness.calls[0].sql, /status = 'processing' AND locked_at <= \$1/);
  assert.match(harness.calls[0].sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(harness.calls[0].sql, /RETURNING job\.id, job\.job_type/);
  assert.match(harness.calls[0].sql, /OUTBOX_STALE_LOCK_RECOVERED/);
  assert.deepEqual(harness.calls[0].params, [
    '2026-08-09T08:55:00.000Z',
    '2026-08-09T09:00:00.000Z',
    50,
    ['record_proof_prepare_submit'],
    ['QR_WRITE']
  ]);
  assert.match(harness.calls[0].sql, /job_type = ANY\(\$4::text\[\]\)/);
  assert.match(harness.calls[0].sql, /aggregate_id = ANY\(\$5::text\[\]\)/);
  assert.match(harness.calls[1].sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(harness.calls[1].sql, /status = 'pending'/);
  assert.match(harness.calls[1].sql, /RETURNING job\.id, job\.job_type/);
  assert.deepEqual(harness.calls[1].params, [
    'worker-test',
    '2026-08-09T09:00:00.000Z',
    50,
    ['record_proof_prepare_submit'],
    ['QR_WRITE']
  ]);
  for (const call of harness.calls.slice(2)) {
    assert.match(call.sql, /status = 'processing' AND locked_by = \$2/);
    assert.doesNotMatch(call.sql, /FOR UPDATE/);
  }
});

test('outbox repository reports value-free scoped backlog counts', async () => {
  const harness = createRepositoryContext([{
    rows: [{
      pending_count: 3,
      ready_count: 2,
      processing_count: 1,
      stale_processing_count: 1,
      failed_count: 4,
      succeeded_count: 9,
      maximum_attempt_count: 5
    }],
    rowCount: 1
  }]);
  const status = await new OutboxRepository(harness.context).inspectStatus({
    inspected_at: '2026-08-12T02:00:00.000Z',
    stale_before: '2026-08-12T01:55:00.000Z',
    job_types: ['record_proof_prepare_submit'],
    aggregate_ids: null
  });

  assert.deepEqual(status, {
    pending: 3,
    ready: 2,
    processing: 1,
    stale_processing: 1,
    failed: 4,
    succeeded: 9,
    maximum_attempt_count: 5
  });
  assert.equal(Object.isFrozen(status), true);
  assert.match(harness.calls[0].sql, /stale_processing_count/);
  assert.doesNotMatch(harness.calls[0].sql, /payload/);
  assert.deepEqual(harness.calls[0].params, [
    '2026-08-12T02:00:00.000Z',
    '2026-08-12T01:55:00.000Z',
    ['record_proof_prepare_submit'],
    null
  ]);
});

test('archive repository persists only ready metadata or a sanitized preparation failure', async () => {
  const row = Object.fromEntries(ARCHIVE_FIELDS.map((field) => [field, null]));
  Object.assign(row, {
    record_qr_id: 'QR_PROOF',
    manifest_object_key: 'records/QR_PROOF/record_manifest.json',
    index_object_key: 'indexes/by-star/QR_PROOF.json',
    status: 'ready',
    last_error: '',
    created_at: '2026-08-09T10:00:00.000Z',
    updated_at: '2026-08-09T10:00:00.000Z'
  });
  const harness = createRepositoryContext([
    { rows: [row], rowCount: 1 },
    { rows: [{ ...row, status: 'failed', last_error: 'RECORD_PROOF_PREPARATION_FAILED' }], rowCount: 1 },
    { rows: [row], rowCount: 1 }
  ]);
  const repository = new ArchiveRepository(harness.context);

  await repository.upsertReady({
    record_qr_id: row.record_qr_id,
    manifest_object_key: row.manifest_object_key,
    legacy_manifest_object_key: null,
    index_object_key: row.index_object_key,
    created_at: row.created_at,
    updated_at: row.updated_at
  });
  await repository.markFailed({
    record_qr_id: row.record_qr_id,
    last_error: 'RECORD_PROOF_PREPARATION_FAILED',
    updated_at: row.updated_at
  });
  await repository.findByRecordIdForUpdate(row.record_qr_id);

  assert.match(harness.calls[0].sql, /ON CONFLICT \(record_qr_id\) DO UPDATE/);
  assert.match(harness.calls[0].sql, /status = 'ready'/);
  assert.match(harness.calls[1].sql, /status = 'failed'/);
  assert.match(harness.calls[1].sql, /record_archives\.status <> 'ready'/);
  assert.match(harness.calls[2].sql, /FOR UPDATE/);
  assert.deepEqual(harness.calls[1].params, [
    'QR_PROOF',
    'RECORD_PROOF_PREPARATION_FAILED',
    '2026-08-09T10:00:00.000Z'
  ]);
});

test('proof repository enforces guarded progression and closes attempt history', async () => {
  const proofRow = Object.fromEntries(PROOF_FIELDS.map((field) => [field, null]));
  Object.assign(proofRow, {
    id: '00000000-0000-0000-0000-000000000801',
    record_qr_id: 'QR_PROOF',
    provider: 'avata_wenchang',
    status: 'submitting',
    retry_count: 1,
    last_error: ''
  });
  const attemptRow = Object.fromEntries(PROOF_ATTEMPT_FIELDS.map((field) => [field, null]));
  Object.assign(attemptRow, {
    id: 1,
    proof_id: proofRow.id,
    attempt_number: 1,
    request_state: 'sent',
    result_status: 'succeeded',
    sanitized_error: ''
  });
  const harness = createRepositoryContext([
    ...Array.from({ length: 5 }, () => ({ rows: [proofRow], rowCount: 1 })),
    { rows: [], rowCount: 2 },
    { rows: [attemptRow], rowCount: 1 }
  ]);
  const repository = new ProofRepository(harness.context);
  const timestamp = '2026-08-09T10:00:00.000Z';

  await repository.markManifestReady({
    id: proofRow.id,
    operation_id: 'record_QR_PROOF_aaaaaaaaaaaaaaaa',
    manifest_object_key: 'records/QR_PROOF/record_manifest.json',
    manifest_hash: 'a'.repeat(64),
    updated_at: timestamp
  });
  await repository.markSubmitting({
    id: proofRow.id,
    retry_count: 1,
    updated_at: timestamp
  });
  await repository.markSubmitted({ id: proofRow.id, updated_at: timestamp });
  await repository.markConfirmed({
    id: proofRow.id,
    confirmed_at: timestamp,
    updated_at: timestamp
  });
  await repository.markFailed({
    id: proofRow.id,
    last_error: 'RECORD_PROOF_SUBMISSION_FAILED',
    updated_at: timestamp
  });
  assert.equal(await repository.failPendingAttempts({
    proof_id: proofRow.id,
    sanitized_error: 'RECORD_PROOF_ATTEMPT_INTERRUPTED',
    completed_at: timestamp
  }), 2);
  await repository.completeAttempt({
    proof_id: proofRow.id,
    attempt_number: 1,
    result_status: 'succeeded',
    sanitized_error: '',
    completed_at: timestamp
  });

  assert.match(harness.calls[0].sql, /status IN \('not_started', 'manifest_ready', 'failed', 'retrying'\)/);
  assert.match(harness.calls[1].sql, /operation_id IS NOT NULL/);
  assert.match(harness.calls[1].sql, /manifest_hash IS NOT NULL/);
  assert.match(harness.calls[2].sql, /status IN \('submitting', 'submitted'\)/);
  assert.match(harness.calls[3].sql, /status IN \('submitting', 'submitted'\)/);
  assert.match(harness.calls[4].sql, /status IN \('not_started', 'manifest_ready', 'submitting', 'failed', 'retrying'\)/);
  assert.match(harness.calls[5].sql, /result_status = 'pending'/);
  assert.match(harness.calls[6].sql, /attempt_number = \$2/);
  assert.match(harness.calls[6].sql, /result_status = 'pending'/);
});

test('proof repository locks operations and applies guarded provider events', async () => {
  const row = Object.fromEntries(PROOF_FIELDS.map((field) => [field, null]));
  Object.assign(row, {
    id: '00000000-0000-0000-0000-000000000951',
    provider: 'avata_wenchang',
    operation_id: 'record_QR_RESULT_aaaaaaaaaaaaaaaa',
    status: 'confirmed',
    callback_received_at: '2026-08-09T14:00:00.000Z'
  });
  const harness = createRepositoryContext([
    { rows: [row], rowCount: 1 },
    { rows: [row], rowCount: 1 }
  ]);
  const repository = new ProofRepository(harness.context);

  await repository.findByOperationIdForUpdate(
    row.provider,
    row.operation_id
  );
  await repository.applyProviderEvent({
    id: row.id,
    status: 'confirmed',
    transaction_hash: 'tx-result',
    block_height: 99,
    provider_record_id: 'provider-result',
    provider_certificate_url: 'https://example.test/certificate.pdf',
    confirmed_at: row.callback_received_at,
    callback_received_at: row.callback_received_at,
    last_error: '',
    updated_at: row.callback_received_at
  });

  assert.match(harness.calls[0].sql, /operation_id = \$2 FOR UPDATE/);
  assert.match(harness.calls[1].sql, /callback_received_at = COALESCE/);
  assert.match(
    harness.calls[1].sql,
    /provider_certificate_url = COALESCE\(provider_certificate_url, \$6\)/
  );
  assert.match(harness.calls[1].sql, /\$2 = 'confirmed'/);
  assert.match(harness.calls[1].sql, /status IN \(/);
  assert.deepEqual(harness.calls[1].params, [
    row.id,
    'confirmed',
    'tx-result',
    99,
    'provider-result',
    'https://example.test/certificate.pdf',
    row.callback_received_at,
    row.callback_received_at,
    '',
    row.callback_received_at
  ]);
});

test('QR lifecycle repositories expose only transaction-scoped state transitions', async () => {
  const record = Object.fromEntries(RECORD_FIELDS.map((field) => [field, null]));
  record.qr_id = 'QR_WRITE';
  const comment = Object.fromEntries(COMMENT_FIELDS.map((field) => [field, null]));
  comment.id = '00000000-0000-0000-0000-000000000201';
  comment.co_creation_id = '00000000-0000-0000-0000-000000000101';
  comment.status = 'kept';
  const creation = {
    id: '00000000-0000-0000-0000-000000000101',
    qr_id: 'QR_WRITE', owner_account_id: 'ACC_OWNER', owner_phone_snapshot: '',
    status: 'active', started_at: '2026-08-09T00:00:00.000Z', finalized_at: null,
    created_at: '2026-08-09T00:00:00.000Z', updated_at: '2026-08-09T00:00:00.000Z'
  };
  const harness = createRepositoryContext([
    { rows: [record], rowCount: 1 },
    { rows: [{ source_position: 4 }], rowCount: 1 },
    { rows: [comment], rowCount: 1 },
    { rows: [{ ...comment, status: 'deleted' }], rowCount: 1 },
    { rows: [{ ...creation, status: 'finalized' }], rowCount: 1 }
  ]);
  const records = new RecordRepository(harness.context);
  const creations = new CoCreationRepository(harness.context);

  await records.seal({
    qr_id: 'QR_WRITE',
    sealed_at: '2026-08-09T01:00:00.000Z',
    updated_at: '2026-08-09T01:00:00.000Z'
  });
  assert.equal(await creations.nextCommentSourcePosition(creation.id), 4);
  await creations.findEffectiveCommentByPublicIdForUpdate(creation.id, 'legacy-comment');
  await creations.deleteEffectiveComment({
    id: comment.id,
    deleted_at: '2026-08-09T01:00:00.000Z'
  });
  await creations.finalize({
    id: creation.id,
    finalized_at: '2026-08-09T01:00:00.000Z',
    updated_at: '2026-08-09T01:00:00.000Z'
  });

  assert.match(harness.calls[0].sql, /sealed_at IS NULL/);
  assert.deepEqual(harness.calls[0].params, [
    'QR_WRITE',
    '2026-08-09T01:00:00.000Z',
    '2026-08-09T01:00:00.000Z'
  ]);
  assert.match(harness.calls[1].sql, /MAX\(source_position\)/);
  assert.deepEqual(harness.calls[1].params, [creation.id]);
  assert.match(harness.calls[2].sql, /legacy_comment_id = \$2/);
  assert.match(harness.calls[2].sql, /FOR UPDATE/);
  assert.deepEqual(harness.calls[2].params, [creation.id, 'legacy-comment']);
  assert.match(harness.calls[3].sql, /status = 'deleted'/);
  assert.match(harness.calls[4].sql, /status = 'finalized'/);
  harness.calls.forEach(({ sql }) => {
    assert.doesNotMatch(sql, /\b(?:BEGIN|COMMIT|ROLLBACK)\b/);
  });
});

test('public QR provenance repository checks exact source hashes and canonical migrations', async () => {
  const sourceHash = 'a'.repeat(64);
  const domainHash = 'c'.repeat(64);
  const harness = createRepositoryContext([
    {
      rows: [{
        source_sha256: sourceHash,
        public_qr_domain_sha256: domainHash,
        status: 'passed',
        completed_at: '2026-01-01T00:00:00Z'
      }],
      rowCount: 1
    },
    {
      rows: [{
        source_sha256: sourceHash,
        public_qr_domain_sha256: domainHash,
        status: 'passed',
        completed_at: '2026-01-01T00:00:00Z'
      }],
      rowCount: 1
    },
    { rows: [{ version: '001_init_schema.sql', checksum: 'b'.repeat(64) }], rowCount: 1 }
  ]);
  const repository = new PublicQrProvenanceRepository(harness.context);
  const importRun = await repository.findPassedImportBySourceHash(sourceHash);
  const domainImportRun = await repository.findPassedImportByPublicQrDomainHash(domainHash);
  const migrations = await repository.listAppliedMigrations();
  assert.equal(importRun.source_sha256, sourceHash);
  assert.equal(importRun.public_qr_domain_sha256, domainHash);
  assert.equal(domainImportRun.public_qr_domain_sha256, domainHash);
  assert.deepEqual(
    harness.calls[0].params,
    [sourceHash, PUBLIC_QR_DOMAIN_CHECKSUM_KEY]
  );
  assert.equal(harness.calls[0].sql.includes(sourceHash), false);
  assert.deepEqual(harness.calls[1].params, [domainHash, PUBLIC_QR_DOMAIN_CHECKSUM_KEY]);
  assert.deepEqual(migrations, [{ version: '001_init_schema.sql', checksum: 'b'.repeat(64) }]);
  await assert.rejects(
    repository.findPassedImportBySourceHash('not-a-hash'),
    (error) => error.code === 'PUBLIC_QR_SOURCE_HASH_INVALID'
  );
});

test('public QR repository key lookup gives access tokens precedence over legacy ids', async () => {
  const harness = createRepositoryContext([{ rows: [], rowCount: 0 }]);
  await new QrRepository(harness.context).findByKey('ambiguous-public-key');
  assert.match(harness.calls[0].sql, /WHERE access_token = \$1/);
  assert.match(harness.calls[0].sql, /NOT EXISTS/);
  assert.match(harness.calls[0].sql, /token_match\.access_token = \$1/);
  assert.deepEqual(harness.calls[0].params, ['ambiguous-public-key']);
});

test('unique identity lookups fail closed and do not select the first duplicate', async () => {
  const row = {
    id: 1, legacy_id: '1', account_id: 'ACC_TEST', phone: 'masked', openid: null,
    unionid: null, source: 'web', created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z'
  };
  const phoneHarness = createRepositoryContext([{ rows: [row, { ...row, id: 2 }] }]);
  await assert.rejects(
    new IdentityRepository(phoneHarness.context).findUniqueByPhone('masked'),
    (error) => error.code === 'DUPLICATE_PHONE_IDENTITY'
  );
  assert.match(phoneHarness.calls[0].sql, /LIMIT 2/);
  assert.deepEqual(phoneHarness.calls[0].params, ['masked']);

  const openidHarness = createRepositoryContext([{ rows: [row, { ...row, id: 2 }] }]);
  await assert.rejects(
    new IdentityRepository(openidHarness.context).findUniqueByOpenid('masked-openid'),
    (error) => error.code === 'DUPLICATE_OPENID_IDENTITY'
  );
});

test('repository locking methods are explicit and never issue transaction control SQL', async () => {
  const harness = createRepositoryContext();
  const repositories = [
    () => new AccountRepository(harness.context).findByIdForUpdate('ACC_TEST'),
    () => new IdentityRepository(harness.context).findByIdForUpdate(1),
    () => new QrRepository(harness.context).findByIdForUpdate('QR_TEST'),
    () => new RecordRepository(harness.context).findByQrIdForUpdate('QR_TEST'),
    () => new CoCreationRepository(harness.context).findByQrIdForUpdate('QR_TEST'),
    () => new OrderRepository(harness.context).findByIdForUpdate('ORDER_TEST'),
    () => new ProofRepository(harness.context).findForUpdate('00000000-0000-0000-0000-000000000001')
  ];
  for (const operation of repositories) await operation();

  assert.equal(harness.calls.length, repositories.length);
  harness.calls.forEach(({ sql }) => {
    assert.match(sql, /FOR UPDATE/);
    assert.doesNotMatch(sql, /\b(?:BEGIN|COMMIT|ROLLBACK)\b/);
  });
});

test('ownership repositories use account IDs only and enforce bounded parameterized limits', async () => {
  const harness = createRepositoryContext([
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] }
  ]);
  const records = new RecordRepository(harness.context);
  const orders = new OrderRepository(harness.context);
  await records.findOwnedByAccountId('ACC_TEST', 'QR_TEST');
  await records.listByAccountId('ACC_TEST', { limit: 5000 });
  await records.listPersonalByAccountId('ACC_TEST', { limit: 5000 });
  await orders.listByAccountId('ACC_TEST', { limit: 5000 });

  harness.calls.forEach(({ sql }) => {
    assert.doesNotMatch(sql, /\b(?:phone|openid)\b/i);
  });
  assert.deepEqual(harness.calls[0].params, ['ACC_TEST', 'QR_TEST']);
  assert.deepEqual(harness.calls[1].params, ['ACC_TEST', 100]);
  assert.deepEqual(harness.calls[2].params, ['ACC_TEST', 1001]);
  assert.deepEqual(harness.calls[3].params, ['ACC_TEST', 100]);
  await assert.rejects(
    records.listByAccountId('ACC_TEST', { limit: 0 }),
    (error) => error.code === 'REPOSITORY_LIMIT_INVALID'
  );
});

test('repository errors map constraints and unknown failures without leaking provider details', async () => {
  const uniqueFailure = Object.assign(new Error('sensitive duplicate detail'), { postgresCode: '23505' });
  await assert.rejects(
    executeQuery(createRepositoryContext([uniqueFailure]).context, 'SELECT $1', ['secret']),
    (error) => error.code === 'REPOSITORY_UNIQUE_CONFLICT'
      && !error.message.includes('sensitive duplicate detail')
  );

  const unknownFailure = Object.assign(new Error('sensitive SQL text'), { code: 'POSTGRES_QUERY_FAILED' });
  await assert.rejects(
    executeQuery(createRepositoryContext([unknownFailure]).context, 'SELECT $1', ['secret']),
    (error) => error.code === 'REPOSITORY_QUERY_FAILED'
      && !error.message.includes('sensitive SQL text')
  );
});

test('all Phase 2C-1 repositories execute through the injected context with parameterized SQL', async () => {
  const harness = createRepositoryContext(Array.from({ length: 12 }, () => ({ rows: [] })));
  await new AccountRepository(harness.context).findById('ACC_TEST');
  await new IdentityRepository(harness.context).findById(1);
  await new QrRepository(harness.context).findByKey('QR_TEST');
  await new QrBatchRepository(harness.context).findById('BATCH_TEST');
  await new RecordRepository(harness.context).findByQrId('QR_TEST');
  await new CoCreationRepository(harness.context).findByQrId('QR_TEST');
  await new OrderRepository(harness.context).findByOrderNo('ORDER_TEST');
  await new PaymentRepository(harness.context).findByMerchantOrderNo('wechat', 'ORDER_TEST');
  await new ProofRepository(harness.context).findByOperationId('provider', 'operation-test');
  await new AuditRepository(harness.context).append({
    actor_type: 'system', actor_reference: null, actor_reference_hash: null,
    action: 'repository.test', entity_type: 'repository', entity_id: 'test',
    entity_reference_hash: null, request_method: null, request_path: null,
    result_status: 'success', ip_hash: null, user_agent_family: null,
    duration_ms: 0, metadata: {}, created_at: '2026-01-01T00:00:00.000Z'
  });
  await new OutboxRepository(harness.context).insertPending({
    id: '00000000-0000-0000-0000-000000000901',
    job_type: 'record_proof_prepare_submit',
    aggregate_type: 'record',
    aggregate_id: 'QR_TEST',
    idempotency_key: 'record-proof:QR_TEST',
    payload: { record_qr_id: 'QR_TEST' },
    available_at: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z'
  });
  await new ArchiveRepository(harness.context).findByRecordId('QR_TEST');

  assert.equal(harness.calls.length, 12);
  harness.calls.forEach(({ sql }) => {
    assert.doesNotMatch(sql, /ON\s+CONFLICT/i);
  });
  assert.equal(harness.calls[9].params.includes('{}'), true);
  assert.equal(
    harness.calls[10].params.includes(JSON.stringify({ record_qr_id: 'QR_TEST' })),
    true
  );
  assert.deepEqual(harness.calls[11].params, ['QR_TEST']);
});

test('stable-scope integration runner is disposable, serialized, and production-safe', () => {
  const scriptPath = path.join(
    __dirname,
    '..',
    'scripts',
    'database',
    'run-stable-scope-integration.sh'
  );
  const source = fs.readFileSync(scriptPath, 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'package.json'),
    'utf8'
  ));

  assert.match(source, /^#!\/usr\/bin\/env bash\nset -Eeuo pipefail/m);
  assert.match(source, /TEST_DB=xingxing_stable_scope_20260812_test/);
  assert.match(source, /PRODUCTION_DB=xingxing_retry_20260803_staging/);
  assert.match(source, /\[ "\$TEST_DB" != "\$PRODUCTION_DB" \]/);
  assert.match(source, /\[\[ "\$TEST_DB" == \*_test \]\]/);
  assert.match(source, /flock -n 9/);
  assert.match(source, /trap cleanup EXIT/);
  assert.match(
    source,
    /node --test tests\/postgresql-read-adapter\.integration\.test\.js/
  );
  assert.match(source, /dropdb \\\n+      --if-exists "\$TEST_DB"/);
  assert.doesNotMatch(source, /dropdb[^\n]*PRODUCTION_DB/);
  assert.doesNotMatch(source, /pm2\s+(?:restart|reload|save)/);
  assert.match(source, /PRODUCTION_DATABASE_SELECTED=NO/);
  assert.match(source, /PRODUCTION_JSON_UNCHANGED=YES/);
  assert.match(source, /POSTGRES_ONLY_IDENTITY_AUTHORITY=PASS/);
  assert.match(source, /POSTGRES_ONLY_QR_ISSUANCE=PASS/);
  assert.match(source, /POSTGRES_PROOF_ALL_SCOPE_WORKER=PASS/);
  assert.match(source, /CROSS_ACCOUNT_PHONE_WRITE_GATES=PASS/);
  assert.match(source, /CONTENT_PRIVACY_RESUMABLE_APPLY=PASS/);
  assert.match(source, /CONTENT_PRIVACY_REPROOF_ISOLATED=PASS/);
  assert.match(source, /PGPASSWORD_FILE="\$TEST_PASSWORD_FILE"/);
  assert.match(source, /POSTGRES_PASSWORD_FILE_CONNECTION=PASS/);
  assert.match(source, /rm -f -- "\$TEST_ENV" "\$TEST_PASSWORD_FILE"/);
  assert.match(source, /POSTGRES_PROOF_BACKLOG_MONITOR=PASS/);
  assert.match(source, /IDENTITY_POSTGRES_AUTHORITY_ENABLED/);
  assert.match(source, /IDENTITY_POSTGRES_AUTHORITY_SOURCE_SHA256/);
  assert.match(source, /IDENTITY_POSTGRES_AUTHORITY_DOMAIN_SHA256/);
  assert.match(source, /QR_ISSUANCE_POSTGRES_AUTHORITY_SOURCE_SHA256/);
  assert.match(source, /QR_ISSUANCE_POSTGRES_AUTHORITY_DOMAIN_SHA256/);
  assert.match(source, /RECORD_PROOF_RUNTIME_DOMAIN_SHA256/);
  assert.match(source, /NEXT_ACTION=RUN_CLEAN_POSTGRES_BASELINE_PLAN/);
  assert.equal(
    packageJson.scripts['test:postgres:stable-scope'],
    'bash scripts/database/run-stable-scope-integration.sh'
  );
});

test('clean PostgreSQL baseline planner is exact-scope, read-only, and value-free', () => {
  const packageJson = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'package.json'),
    'utf8'
  ));
  const planner = fs.readFileSync(
    path.join(
      __dirname,
      '../scripts/database/plan-clean-postgres-baseline.js'
    ),
    'utf8'
  );
  const runner = fs.readFileSync(
    path.join(
      __dirname,
      '../scripts/database/run-clean-postgres-baseline-plan.sh'
    ),
    'utf8'
  );

  assert.match(planner, /DEFAULT_EXCLUDED_QR_IDS = Object\.freeze\(\['STAR0001'\]\)/);
  assert.match(planner, /'SSS00003',[\s\S]*'SSS00008',[\s\S]*'SSS00009'/);
  assert.match(planner, /CLEAN_BASELINE_PLAN_ONLY_REQUIRED/);
  assert.match(planner, /target_baseline_persisted: false/);
  assert.match(planner, /production_database_access: 'NONE'/);
  assert.match(planner, /external_provider_calls: 'NONE'/);
  assert.doesNotMatch(
    planner,
    /child_process|createPostgresPool|\bpsql\b|ali-oss|avataService|fs\.renameSync/
  );

  assert.match(
    runner,
    /EXPECTED_SOURCE_SHA=f263df13b5c19f91b0f86d93960f6b26896f3ed605318c73dd8546d110b06cfd/
  );
  assert.match(
    runner,
    /EXPECTED_CANDIDATE_SHA=93def24ee6dd4de63fd4ebf776a0a2056d2563df492727231b8f6de08ec0c7ee/
  );
  assert.match(runner, /EXPECTED_EXCLUDED_QR_IDS=STAR0001/);
  assert.match(runner, /EXPECTED_PRIVACY_QR_IDS=SSS00003,SSS00008,SSS00009/);
  assert.match(runner, /--plan-only/);
  assert.match(runner, /target_counts\.qr_codes, 103/);
  assert.match(runner, /PRODUCTION_DATABASE_ACCESS=NONE/);
  assert.match(runner, /PRODUCTION_JSON_WRITE=NONE/);
  assert.match(runner, /EXTERNAL_PROVIDER_CALLS=NONE/);
  assert.match(runner, /NEXT_ACTION=REVIEW_CLEAN_BASELINE_PLAN/);
  assert.doesNotMatch(
    runner,
    /\bpsql\b|pm2\s+(?:stop|restart|reload|save)|dropdb|createdb|AVATA_API_KEY=|AVATA_API_SECRET=/
  );
  assert.equal(
    packageJson.scripts['baseline:plan:clean-postgres'],
    'bash scripts/database/run-clean-postgres-baseline-plan.sh'
  );
});

test('clean PostgreSQL baseline rebuild creates only a new guarded staging database', () => {
  const packageJson = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'package.json'),
    'utf8'
  ));
  const materializer = fs.readFileSync(
    path.join(
      __dirname,
      '../scripts/database/materialize-clean-postgres-baseline.js'
    ),
    'utf8'
  );
  const runner = fs.readFileSync(
    path.join(
      __dirname,
      '../scripts/database/run-clean-postgres-baseline-rebuild.sh'
    ),
    'utf8'
  );

  assert.match(materializer, /CLEAN_BASELINE_MATERIALIZE_CONFIRMATION_REQUIRED/);
  assert.match(materializer, /CLEAN_BASELINE_APPROVED_REPORT_CONTENT_MISMATCH/);
  assert.match(materializer, /fs\.openSync\(filePath, 'wx', 0o600\)/);
  assert.match(materializer, /fs\.fsyncSync/);
  assert.doesNotMatch(
    materializer,
    /child_process|createPostgresPool|\bpsql\b|ali-oss|avataService|fs\.renameSync/
  );

  assert.match(runner, /TARGET_DB=xingxing_clean_baseline_20260812_staging/);
  assert.match(runner, /PRODUCTION_DB=xingxing_retry_20260803_staging/);
  assert.match(runner, /\[ "\$TARGET_DB" != "\$PRODUCTION_DB" \]/);
  assert.match(runner, /TARGET_DATABASE_ALREADY_EXISTS/);
  assert.match(runner, /--expected-approved-plan-report-sha256=/);
  assert.match(runner, /scripts\/database\/migrate\.js --apply/);
  assert.match(runner, /scripts\/database\/import-staging\.js/);
  assert.match(runner, /CLEAN_POSTGRES_BASELINE_REBUILD_RESULT_GATE=PASS/);
  assert.match(runner, /TARGET_DATABASE_READY_FOR_POSTGRES_ONLY_E2E=YES/);
  assert.match(runner, /PRODUCTION_DATABASE_SELECTED=NO/);
  assert.match(runner, /PRODUCTION_DATABASE_WRITE=NONE/);
  assert.match(runner, /PRODUCTION_JSON_WRITE=NONE/);
  assert.doesNotMatch(runner, /pm2\s+(?:stop|restart|reload|save)/);
  assert.doesNotMatch(runner, /dropdb[^\n]*PRODUCTION_DB/);
  assert.doesNotMatch(runner, /AVATA_API_KEY=|AVATA_API_SECRET=/);
  assert.equal(
    packageJson.scripts['baseline:rebuild:clean-postgres'],
    'bash scripts/database/run-clean-postgres-baseline-rebuild.sh'
  );
});

test('clean candidate E2E uses a disposable clone and forbids external providers', () => {
  const packageJson = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'package.json'),
    'utf8'
  ));
  const runner = fs.readFileSync(
    path.join(
      __dirname,
      '../scripts/database/run-clean-postgres-candidate-e2e.sh'
    ),
    'utf8'
  );
  const e2e = fs.readFileSync(
    path.join(
      __dirname,
      'postgresql-clean-candidate.e2e.test.js'
    ),
    'utf8'
  );

  assert.match(runner, /SOURCE_DB=xingxing_clean_baseline_20260812_staging/);
  assert.match(runner, /TEST_DB=xingxing_clean_baseline_e2e_20260812_test/);
  assert.match(runner, /-T "\$SOURCE_DB" "\$TEST_DB"/);
  assert.match(runner, /dropdb \\\n+      --if-exists "\$TEST_DB"/);
  assert.doesNotMatch(runner, /dropdb[^\n]*SOURCE_DB/);
  assert.doesNotMatch(runner, /dropdb[^\n]*PRODUCTION_DB/);
  assert.doesNotMatch(runner, /pm2\s+(?:stop|restart|reload|save)/);
  assert.match(runner, /CANDIDATE_DATABASE_WRITE=NONE/);
  assert.match(runner, /DISPOSABLE_CLONE_REMOVED=YES/);
  assert.match(runner, /EXTERNAL_PROVIDER_CALLS=NONE/);
  assert.match(runner, /CLEAN_CANDIDATE_EXISTING_H5_ROUTES=PASS/);
  assert.match(runner, /CLEAN_CANDIDATE_EXISTING_MINIAPP_ROUTES=PASS/);
  assert.match(runner, /CLEAN_CANDIDATE_EXISTING_DATA_UNCHANGED=PASS/);
  assert.match(runner, /CLEAN_CANDIDATE_POSTGRES_ONLY_BATCH_ADMINISTRATION=PASS/);
  assert.match(runner, /CLEAN_CANDIDATE_POSTGRES_ONLY_QUALITY_CHECK=PASS/);
  assert.match(runner, /CLEAN_CANDIDATE_POSTGRES_ONLY_ADMIN_VISIBILITY=PASS/);
  assert.match(runner, /CLEAN_CANDIDATE_POSTGRES_ONLY_NFT_READ=PASS/);
  assert.match(runner, /POSTGRES_ONLY_BATCH_ADMINISTRATION=PASS/);
  assert.match(runner, /POSTGRES_ONLY_QUALITY_CHECK=PASS/);
  assert.match(runner, /POSTGRES_ONLY_ADMIN_VISIBILITY=PASS/);
  assert.match(runner, /POSTGRES_ONLY_NFT_READ=PASS/);
  assert.match(runner, /json-authority-baseline\.json/);
  assert.match(runner, /POSTGRES_AUTHORITY_BASELINE_DOMAIN_SHA256/);
  assert.match(runner, /HANDOFF_DOMAINS_MUST_DIFFER/);
  assert.match(runner, /NEXT_ACTION=PREPARE_STABLE_CUTOVER_PREFLIGHT/);
  assert.match(e2e, /EXTERNAL_FETCH_FORBIDDEN_IN_CANDIDATE_E2E/);
  assert.match(e2e, /CLEAN_CANDIDATE_EXTERNAL_FETCH_CALLS=0/);
  assert.match(e2e, /CLEAN_CANDIDATE_EXISTING_H5_ROUTES=PASS/);
  assert.match(e2e, /CLEAN_CANDIDATE_EXISTING_MINIAPP_ROUTES=PASS/);
  assert.match(e2e, /CLEAN_CANDIDATE_EXISTING_DATA_UNCHANGED=PASS/);
  assert.match(e2e, /CLEAN_CANDIDATE_POSTGRES_ONLY_BATCH_ADMINISTRATION=PASS/);
  assert.match(e2e, /CLEAN_CANDIDATE_POSTGRES_ONLY_QUALITY_CHECK=PASS/);
  assert.match(e2e, /CLEAN_CANDIDATE_POSTGRES_ONLY_ADMIN_VISIBILITY=PASS/);
  assert.match(e2e, /CLEAN_CANDIDATE_POSTGRES_ONLY_NFT_READ=PASS/);
  assert.match(e2e, /CLEAN_CANDIDATE_COORDINATED_JOINT_REHEARSAL=PASS/);
  assert.match(e2e, /EXPECTED_BASELINE_DOMAIN_SHA256/);
  assert.match(e2e, /qr\.access_token AS qr_access_token/);
  assert.doesNotMatch(e2e, /qr\.qr_access_token/);
  assert.match(e2e, /\/api\/admin\/qr\/generate/);
  assert.match(e2e, /\/api\/miniapp\/auth\/bind-phone/);
  assert.match(runner, /RECORD_PROOF_RUNTIME_ENABLED=false/);
  assert.doesNotMatch(runner, /RECORD_PROOF_RUNTIME_SCOPE=/);
  assert.doesNotMatch(runner, /AVATA_API_KEY=|AVATA_API_SECRET=/);
  assert.match(e2e, /CLEAN_CANDIDATE_POSTGRES_ONLY_PROOF_OUTBOX=PASS/);
  assert.match(e2e, /CLEAN_CANDIDATE_PROOF_WORKER_RUNTIME=DISABLED/);
  assert.doesNotMatch(e2e, /createRecordProofRuntime/);
  assert.equal(
    packageJson.scripts['test:postgres:clean-candidate-e2e'],
    'bash scripts/database/run-clean-postgres-candidate-e2e.sh'
  );
});

test('stable cutover preflight is read-only, unified, and authority-commit safe', () => {
  const packageJson = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'package.json'),
    'utf8'
  ));
  const validator = fs.readFileSync(
    path.join(
      __dirname,
      '../scripts/database/validate-stable-cutover-config.js'
    ),
    'utf8'
  );
  const runner = fs.readFileSync(
    path.join(
      __dirname,
      '../scripts/database/run-stable-cutover-preflight.sh'
    ),
    'utf8'
  );

  assert.match(runner, /CANDIDATE_DB=xingxing_clean_baseline_20260812_staging/);
  assert.match(runner, /EXPECTED_SOURCE_SHA=fc13e36e/);
  assert.match(runner, /EXPECTED_PLAN_SHA=2eadabbe/);
  assert.match(runner, /EXPECTED_DOMAIN_SHA=f55db6ac/);
  assert.match(runner, /pg_dump \\\n+  -Fc --no-owner --no-privileges/);
  assert.match(runner, /pg_restore --list/);
  assert.match(runner, /default_transaction_read_only=on/);
  assert.match(runner, /xingxing_staging_app\|UTF8\|C\.utf8\|C\.utf8/);
  assert.match(runner, /CANDIDATE_CONNECTION_IDENTITY_INVALID/);
  assert.match(runner, /CANDIDATE_DATABASE_CHANGED/);
  assert.match(runner, /PUBLIC_QR_POSTGRES_READ_SCOPE=all/);
  assert.match(runner, /PERSONAL_RECORD_POSTGRES_READ_SCOPE=all/);
  assert.match(runner, /QR_LIFECYCLE_POSTGRES_WRITE_SCOPE=all/);
  assert.match(runner, /IDENTITY_POSTGRES_AUTHORITY_SCOPE=all/);
  assert.match(runner, /QR_ISSUANCE_POSTGRES_AUTHORITY_SCOPE=all/);
  assert.match(runner, /POSTGRES_AUTHORITY_BASELINE_DOMAIN_SHA256=/);
  assert.match(runner, /RECORD_PROOF_RUNTIME_ENABLED=false/);
  assert.doesNotMatch(runner, /RECORD_PROOF_RUNTIME_SCOPE=/);
  assert.doesNotMatch(runner, /RECORD_PROOF_WORKER_ID=/);
  assert.doesNotMatch(runner, /_ALLOWLIST=/);
  assert.match(runner, /READY_FOR_POSTGRES_MAINTENANCE_WINDOW/);
  assert.match(runner, /AVATA_MIGRATION_SCOPE=DEFERRED/);
  assert.match(runner, /EXTERNAL_PROVIDER_CALLS=NONE/);
  assert.match(runner, /JOINT_QR_ADMINISTRATION_GATE=PASS/);
  assert.match(runner, /JOINT_BATCH_ADMINISTRATION_NOT_PASSED/);
  assert.match(runner, /JOINT_QUALITY_CHECK_NOT_PASSED/);
  assert.match(runner, /JOINT_ADMIN_VISIBILITY_NOT_PASSED/);
  assert.match(runner, /JOINT_NFT_READ_NOT_PASSED/);
  assert.doesNotMatch(runner, /STABLE_CUTOVER_PROVIDER_ENV/);
  assert.match(runner, /PM2_CONFIGURATION_LOADED=NO/);
  assert.match(runner, /AUTHORITY_COMMIT_POINT_CROSSED=NO/);
  assert.match(runner, /PRODUCTION_DATABASE_WRITE=NONE/);
  assert.match(runner, /CANDIDATE_DATABASE_WRITE=NONE/);
  assert.doesNotMatch(runner, /pm2\s+(?:stop|restart|reload|save)/);
  assert.doesNotMatch(runner, /dropdb|createdb/);
  assert.doesNotMatch(runner, /AVATA_API_KEY=|AVATA_API_SECRET=/);

  assert.match(validator, /readPublicQrPrimaryReadConfig/);
  assert.match(validator, /readPersonalRecordPrimaryReadConfig/);
  assert.match(validator, /readQrLifecycleWriteConfig/);
  assert.match(validator, /readIdentityAuthorityConfig/);
  assert.match(validator, /readQrIssuanceAuthorityConfig/);
  assert.match(validator, /STABLE_CUTOVER_ALLOWLIST_FORBIDDEN/);
  assert.match(validator, /record_proof_runtime_enabled: false/);
  assert.match(validator, /avata_in_migration_scope: false/);
  assert.doesNotMatch(validator, /AVATA_API_KEY|AVATA_API_SECRET/);
  assert.match(validator, /contains_database_secret: false/);
  assert.match(validator, /contains_provider_secret: false/);
  assert.equal(
    packageJson.scripts['cutover:preflight:stable'],
    'bash scripts/database/run-stable-cutover-preflight.sh'
  );
});

test('stable cutover selector validator requires five database boundaries and disables AVATA', () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'stable-cutover-validator-')
  );
  const configPath = path.join(temporaryRoot, 'stable-selectors.env');
  const sourceHash = 'a'.repeat(64);
  const domainHash = 'b'.repeat(64);
  const baselineDomainHash = 'c'.repeat(64);
  const config = [
    'PUBLIC_QR_SHADOW_READ_ENABLED=false',
    'PERSONAL_RECORD_SHADOW_READ_ENABLED=false',
    'IDENTITY_SHADOW_READ_ENABLED=false',
    `POSTGRES_AUTHORITY_BASELINE_DOMAIN_SHA256=${baselineDomainHash}`,
    'PUBLIC_QR_POSTGRES_READ_ENABLED=true',
    'PUBLIC_QR_POSTGRES_READ_SCOPE=all',
    `PUBLIC_QR_POSTGRES_READ_DOMAIN_SHA256=${domainHash}`,
    'PERSONAL_RECORD_POSTGRES_READ_ENABLED=true',
    'PERSONAL_RECORD_POSTGRES_READ_SCOPE=all',
    `PERSONAL_RECORD_POSTGRES_READ_DOMAIN_SHA256=${domainHash}`,
    'QR_LIFECYCLE_POSTGRES_WRITE_ENABLED=true',
    'QR_LIFECYCLE_POSTGRES_WRITE_SCOPE=all',
    `QR_LIFECYCLE_POSTGRES_WRITE_DOMAIN_SHA256=${domainHash}`,
    'IDENTITY_POSTGRES_AUTHORITY_ENABLED=true',
    'IDENTITY_POSTGRES_AUTHORITY_SCOPE=all',
    `IDENTITY_POSTGRES_AUTHORITY_SOURCE_SHA256=${sourceHash}`,
    `IDENTITY_POSTGRES_AUTHORITY_DOMAIN_SHA256=${domainHash}`,
    'QR_ISSUANCE_POSTGRES_AUTHORITY_ENABLED=true',
    'QR_ISSUANCE_POSTGRES_AUTHORITY_SCOPE=all',
    `QR_ISSUANCE_POSTGRES_AUTHORITY_SOURCE_SHA256=${sourceHash}`,
    `QR_ISSUANCE_POSTGRES_AUTHORITY_DOMAIN_SHA256=${domainHash}`,
    'RECORD_PROOF_RUNTIME_ENABLED=false'
  ].join('\n');
  fs.writeFileSync(configPath, `${config}\n`, { mode: 0o600 });

  const command = path.join(
    __dirname,
    '../scripts/database/validate-stable-cutover-config.js'
  );
  const args = [
    command,
    `--config=${configPath}`,
    `--expected-source-sha256=${sourceHash}`,
    `--expected-domain-sha256=${domainHash}`,
    `--expected-baseline-domain-sha256=${baselineDomainHash}`
  ];
  const ready = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: {}
  });
  assert.equal(ready.status, 0, ready.stderr);
  const readyReport = JSON.parse(ready.stdout);
  assert.equal(readyReport.status, 'READY_FOR_POSTGRES_MAINTENANCE_WINDOW');
  assert.equal(readyReport.postgres_authority_boundary_count, 5);
  assert.equal(readyReport.all_scope_count, 5);
  assert.equal(readyReport.disabled_external_runtime_count, 1);
  assert.equal(readyReport.allowlist_count, 0);
  assert.equal(
    readyReport.json_authority_baseline_domain_sha256,
    baselineDomainHash
  );
  assert.equal(readyReport.record_proof_runtime_enabled, false);
  assert.equal(readyReport.avata_in_migration_scope, false);
  assert.equal(readyReport.external_provider_required, false);

  fs.appendFileSync(configPath, 'PUBLIC_QR_POSTGRES_READ_ALLOWLIST=A00001\n');
  const rejected = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: {}
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /STABLE_CUTOVER_ALLOWLIST_FORBIDDEN/);

  fs.writeFileSync(
    configPath,
    `${config.replace(
      'RECORD_PROOF_RUNTIME_ENABLED=false',
      'RECORD_PROOF_RUNTIME_ENABLED=true'
    )}\n`,
    { mode: 0o600 }
  );
  const proofRuntimeRejected = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: {}
  });
  assert.notEqual(proofRuntimeRejected.status, 0);
  assert.match(
    proofRuntimeRejected.stderr,
    /STABLE_CUTOVER_CONFIG_VALUE_INVALID_RECORD_PROOF_RUNTIME_ENABLED/
  );

  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

test('maintenance cutover preparation is read-only and cannot enter prewrite', () => {
  const packageJson = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../package.json'),
    'utf8'
  ));
  const runner = fs.readFileSync(
    path.join(
      __dirname,
      '../scripts/database/run-stable-cutover-maintenance-prepare.sh'
    ),
    'utf8'
  );

  assert.match(runner, /EXPLICIT_PREPARE_MODE_REQUIRED/);
  assert.match(runner, /START_STATE=JSON_AUTHORITY/);
  assert.match(runner, /TARGET_STATE=POSTGRES_AUTHORITY_PREWRITE/);
  assert.match(runner, /CURRENT_PREFLIGHT_SUMMARY_NOT_FOUND/);
  assert.match(runner, /CURRENT_JOINT_SUMMARY_NOT_FOUND/);
  assert.match(runner, /git merge-base --is-ancestor "\$JOINT_HEAD" HEAD/);
  assert.match(runner, /JOINT_EVIDENCE_STALE/);
  assert.match(runner, /\^\(src\/server\//);
  assert.match(runner, /POSTGRES_ONLY_PROOF_OUTBOX=PASS/);
  assert.match(runner, /JOINT_BATCH_ADMINISTRATION_INVALID/);
  assert.match(runner, /JOINT_QUALITY_CHECK_INVALID/);
  assert.match(runner, /JOINT_ADMIN_VISIBILITY_INVALID/);
  assert.match(runner, /JOINT_NFT_READ_INVALID/);
  assert.match(runner, /PROOF_WORKER_RUNTIME=DISABLED/);
  assert.match(runner, /default_transaction_read_only=on/);
  assert.match(runner, /CANDIDATE_ENVIRONMENT_SHA256=/);
  assert.match(runner, /EXPECTED_BASELINE_DOMAIN_SHA256=/);
  assert.match(runner, /READ_ONLY_TRANSACTION_XID/);
  assert.match(runner, /AUTO_OFF_CAPABILITY=PASS/);
  assert.match(runner, /ROLLBACK_BEFORE_COMMIT=JSON_ALLOWED/);
  assert.match(runner, /AVATA_CONFIGURATION_LOADED=NO/);
  assert.match(runner, /AUTHORITY_COMMIT_POINT_CROSSED=NO/);
  assert.match(runner, /PRODUCTION_RUNTIME_RESTARTED=NO/);
  assert.match(runner, /PRODUCTION_DATABASE_WRITE=NONE/);
  assert.match(runner, /CANDIDATE_DATABASE_WRITE=NONE/);
  assert.match(runner, /NEXT_ACTION=REVIEW_PREWRITE_PLAN_AND_IMPLEMENT_AUTO_OFF_RUNNER/);
  assert.doesNotMatch(runner, /pm2\s+(?:stop|restart|reload|save)/);
  assert.doesNotMatch(runner, /systemd-run\s+--/);
  assert.doesNotMatch(runner, /dropdb|createdb|pg_restore\s+--clean/);
  assert.doesNotMatch(
    runner,
    /-c\s+"(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|GRANT|REVOKE)/
  );
  assert.doesNotMatch(runner, /AVATA_API_KEY=|AVATA_API_SECRET=/);
  assert.equal(
    packageJson.scripts['cutover:prepare:maintenance'],
    'bash scripts/database/run-stable-cutover-maintenance-prepare.sh --prepare'
  );
});

test('stable cutover prewrite is explicit, frozen, fingerprinted, and auto-off', () => {
  const runner = fs.readFileSync(
    path.join(__dirname, '../scripts/database/run-stable-cutover-prewrite.sh'),
    'utf8'
  );
  const autoOff = fs.readFileSync(
    path.join(
      __dirname,
      '../scripts/database/run-stable-cutover-prewrite-auto-off.sh'
    ),
    'utf8'
  );
  const fingerprint = fs.readFileSync(
    path.join(
      __dirname,
      '../scripts/database/capture-stable-cutover-public-fingerprints.js'
    ),
    'utf8'
  );

  assert.match(runner, /ENTER_POSTGRES_AUTHORITY_PREWRITE_WITH_AUTO_OFF/);
  assert.match(runner, /EXPLICIT_PREWRITE_MODE_REQUIRED/);
  assert.match(runner, /EXPLICIT_CONFIRMATION_REQUIRED/);
  assert.match(runner, /systemd-run[\s\S]+--on-active=15m/);
  assert.match(
    runner,
    /systemd-run[\s\S]+AUTO_OFF_ARMED=true[\s\S]+pm2 restart/
  );
  assert.match(runner, /POSTGRES_CUTOVER_WRITE_FREEZE_ENABLED=true/);
  assert.match(runner, /RECORD_PROOF_RUNTIME_ENABLED=false/);
  assert.match(runner, /POSTGRES_AUTHORITY_BOUNDARY_COUNT=5/);
  assert.match(runner, /POSTGRES_AUTHORITY_BASELINE_DOMAIN_SHA256/);
  assert.match(runner, /CANDIDATE_MUTATION_DETECTED_KEEP_POSTGRES_FROZEN/);
  assert.match(runner, /STABLE_CUTOVER_PREWRITE_PUBLIC_PARITY=PASS/);
  assert.match(runner, /PM2_CONFIGURATION_SAVED=NO/);
  assert.match(runner, /AUTHORITY_COMMIT_POINT_CROSSED=NO/);
  assert.doesNotMatch(runner, /\bpm2 save\b/);

  assert.match(autoOff, /EXPECTED_DATABASE_STATE_SHA256/);
  assert.match(autoOff, /CANDIDATE_ENVIRONMENT_SHA256/);
  assert.match(autoOff, /AUTO_OFF_SCRIPT_SHA256/);
  assert.match(autoOff, /CANDIDATE_MUTATION_DETECTED_KEEP_POSTGRES_FROZEN/);
  assert.match(autoOff, /RUNTIME_STATE=PARTIAL_RUNTIME_RECOVERY/);
  assert.match(autoOff, /RUNTIME_STATE=POSTGRES_AUTHORITY_PREWRITE/);
  assert.match(autoOff, /RUNTIME_STATE=JSON_AUTHORITY_FROZEN/);
  assert.match(autoOff, /POSTGRES_CUTOVER_WRITE_FREEZE_ENABLED=true/);
  assert.match(autoOff, /POSTGRES_CUTOVER_WRITE_FREEZE_ENABLED=false/);
  assert.match(autoOff, /PHASE=JSON_AUTHORITY_ABORTED/);
  assert.match(autoOff, /AUTHORITY_COMMIT_POINT_CROSSED=NO/);
  assert.doesNotMatch(autoOff, /\bpm2 save\b/);

  assert.match(fingerprint, /raw_dto_persisted: false/);
  assert.match(fingerprint, /normalized_url_queries: true/);
  assert.match(fingerprint, /127\.0\.0\.1/);
  assert.match(fingerprint, /flag: 'wx'/);
  assert.doesNotMatch(fingerprint, /JSON\.stringify\(body\.data\).*writeFileSync/s);
});

test('stable commit runner protects secrets and distinguishes precommit rollback from forward freeze', () => {
  const runner = fs.readFileSync(
    path.join(__dirname, '../scripts/database/run-stable-cutover-commit.sh'),
    'utf8'
  );
  const validator = fs.readFileSync(
    path.join(__dirname, '../scripts/database/validate-stable-pm2-state.js'),
    'utf8'
  );

  assert.match(runner, /COMMIT_POSTGRES_AUTHORITY_NO_JSON_FALLBACK/);
  assert.match(runner, /EXPLICIT_COMMIT_MODE_REQUIRED/);
  assert.match(runner, /EXPLICIT_CONFIRMATION_REQUIRED/);
  assert.match(runner, /REHEARSAL_STATE_PHASE_INVALID/);
  assert.match(runner, /PLAN_FILE_SHA256/);
  assert.match(runner, /PHASE=\$phase/);
  assert.match(runner, /POSTGRES_AUTHORITY_COMMITTING YES/);
  assert.match(runner, /POSTGRES_AUTHORITY_COMMITTED YES/);
  assert.match(runner, /AUTHORITY_COMMIT_POINT_CROSSED=YES/);
  assert.match(runner, /JSON_FALLBACK_ALLOWED=NO/);
  assert.match(runner, /restore_json_before_commit/);
  assert.match(runner, /freeze_postgres_forward_only/);
  assert.match(runner, /CANDIDATE_MUTATION_DETECTED_KEEP_POSTGRES_FROZEN/);
  assert.match(runner, /PGPASSWORD_FILE=/);
  assert.match(runner, /PM2_DATABASE_PASSWORD_PERSISTED=NO/);
  assert.match(runner, /validate-stable-pm2-state\.js/);
  assert.match(runner, /pm2 save --force/);
  assert.match(runner, /postgres_control_query/);
  assert.match(runner, /\/usr\/bin\/env \\\n+    -u DATABASE_URL/);
  assert.match(runner, /chmod 0600 "\$PM2_DUMP"/);
  assert.match(runner, /RECORD_PROOF_RUNTIME_ENABLED=false/);
  assert.match(runner, /AVATA_CONFIGURATION_LOADED=NO/);
  assert.doesNotMatch(runner, /RECORD_PROOF_RUNTIME_ENABLED=true/);
  assert.doesNotMatch(runner, /AVATA_API_KEY=[^']/);
  assert.doesNotMatch(runner, /AVATA_API_SECRET=[^']/);

  assert.match(validator, /STABLE_PM2_STATE_SECRET_PERSISTED/);
  assert.match(validator, /expected-password-file/);
  assert.match(validator, /expected-authority/);
  assert.match(validator, /POSTGRES_CUTOVER_WRITE_FREEZE_ENABLED/);
  assert.doesNotMatch(validator, /console\.log\([^)]*env/);
});

test('stable forward resume only accepts committed freeze and never restores JSON', () => {
  const runner = fs.readFileSync(
    path.join(__dirname, '../scripts/database/run-stable-cutover-resume.sh'),
    'utf8'
  );

  assert.match(runner, /RESUME_POSTGRES_AUTHORITY_COMMITTED_FORWARD_ONLY/);
  assert.match(runner, /STATE_PHASE_NOT_COMMITTED_FROZEN/);
  assert.match(runner, /AUTHORITY_COMMIT_POINT_CROSSED.*YES/);
  assert.match(runner, /git merge-base --is-ancestor/);
  assert.match(runner, /RECOVERY_CHANGESET_INVALID/);
  assert.match(runner, /EXPECTED_RECOVERY_CHANGED_FILES/);
  assert.match(runner, /ensure_forward_freeze/);
  assert.match(runner, /POSTGRES_AUTHORITY_COMMITTED_FROZEN/);
  assert.match(runner, /POSTGRES_AUTHORITY_COMMITTED/);
  assert.match(runner, /STABLE_CUTOVER_FORWARD_RESUME_PUBLIC_PARITY=PASS/);
  assert.match(
    runner,
    /STABLE_CUTOVER_FORWARD_RESUME_FROZEN_PUBLIC_PARITY=PASS/
  );
  assert.match(runner, /FROZEN_POSTGRES_CONNECTION_MISSING_AFTER_READ/);
  assert.match(runner, /postgres_control_query/);
  assert.match(runner, /\/usr\/bin\/env \\\n+    -u DATABASE_URL/);
  assert.match(runner, /PM2_DATABASE_PASSWORD_PERSISTED=NO/);
  assert.match(runner, /JSON_FALLBACK_ALLOWED=NO/);
  assert.match(runner, /EXPECTED_HEAD=" head/);
  assert.match(runner, /EXPECTED_TREE=" tree/);
  assert.match(runner, /RECORD_PROOF_RUNTIME_ENABLED=false/);
  assert.match(runner, /AVATA_CONFIGURATION_LOADED=NO/);
  assert.doesNotMatch(runner, /load_json_environment/);
  assert.doesNotMatch(runner, /FINAL_STATE=JSON_AUTHORITY/);
  assert.doesNotMatch(runner, /RECORD_PROOF_RUNTIME_ENABLED=true/);
});

test('stable post-commit observation is read-only, multi-cycle, and forward-only', () => {
  const observer = fs.readFileSync(
    path.join(__dirname, '../scripts/database/run-stable-cutover-observation.sh'),
    'utf8'
  );

  assert.match(observer, /OBSERVE_POSTGRES_AUTHORITY_COMMITTED/);
  assert.match(observer, /OBSERVATION_CYCLES=3/);
  assert.match(observer, /OBSERVATION_INTERVAL_SECONDS=10/);
  assert.match(observer, /AUTHORITY_COMMIT_POINT_CROSSED=YES/);
  assert.match(observer, /JSON_FALLBACK_ALLOWED=NO/);
  assert.match(observer, /expected-authority=postgres/);
  assert.match(observer, /expected-freeze=false/);
  assert.match(observer, /default_transaction_read_only=on/);
  assert.match(observer, /PUBLIC_FINGERPRINT_PARITY=PASS/);
  assert.match(observer, /OUTBOX_PROCESSING/);
  assert.match(observer, /OUTBOX_FAILED/);
  assert.match(observer, /DATABASE_CHANGED_DURING_OBSERVATION/);
  assert.match(observer, /RECORD_PROOF_RUNTIME_ENABLED=false/);
  assert.match(observer, /AVATA_CONFIGURATION_LOADED=NO/);
  assert.doesNotMatch(
    observer,
    /\b(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE)\b/
  );
  assert.doesNotMatch(observer, /pm2\s+(?:restart|reload|save|stop)/);
  assert.doesNotMatch(observer, /AVATA_API_KEY=|AVATA_API_SECRET=/);
});

test('production privacy snapshot runner is read-only, exact-targeted, and value-free', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../scripts/database/run-content-privacy-audit.sh'),
    'utf8'
  );
  assert.match(source, /production-db-source\.json/);
  assert.match(source, /EXPECTED_SOURCE_SHA=/);
  assert.match(source, /FINDINGS_CONFIRMED/);
  assert.match(source, /\['SSS00003', 'SSS00008', 'SSS00009'\]/);
  assert.match(source, /CONTENT_PRIVACY_EVIDENCE_DEPENDENCY_COUNT/);
  assert.match(source, /CLASSIFY_PROOF_DEPENDENCIES_BEFORE_REMEDIATION/);
  assert.match(source, /PRODUCTION_DATABASE_ACCESS=NONE/);
  assert.match(source, /PRODUCTION_RUNTIME_RESTARTED=NO/);
  assert.doesNotMatch(source, /\bpsql\b|\bpm2 restart\b|\brm\b|\bsed -i\b/);
});

test('production privacy remediation preparation is protected and write-free', () => {
  const packageJson = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../package.json'),
    'utf8'
  ));
  const source = fs.readFileSync(
    path.join(
      __dirname,
      '../scripts/database/run-content-privacy-remediation-prepare.sh'
    ),
    'utf8'
  );
  assert.match(source, /EXPECTED_QR_IDS=SSS00003,SSS00008,SSS00009/);
  assert.match(source, /PRELAUNCH_TEST_DATA_REDACT_AND_REPROOF/);
  assert.match(source, /CANDIDATE_PRIVACY_FINDINGS=0/);
  assert.match(source, /PRODUCTION_DATABASE_ACCESS=NONE/);
  assert.match(source, /PRODUCTION_JSON_WRITE=NONE/);
  assert.match(source, /OSS_ACCESS=NONE/);
  assert.doesNotMatch(
    source,
    /\bpsql\b|\bpm2 restart\b|\bsed -i\b|src\/server\/data\/db\.json\s*>/
  );
  assert.equal(
    packageJson.scripts['privacy:prepare:production-snapshot'],
    'bash scripts/database/run-content-privacy-remediation-prepare.sh'
  );
});

test('production privacy remediation apply preflight is exact and read-only', () => {
  const packageJson = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../package.json'),
    'utf8'
  ));
  const runner = fs.readFileSync(
    path.join(
      __dirname,
      '../scripts/database/run-content-privacy-remediation-apply-preflight.sh'
    ),
    'utf8'
  );
  const implementation = fs.readFileSync(
    path.join(
      __dirname,
      '../scripts/database/apply-content-privacy-remediation.js'
    ),
    'utf8'
  );

  assert.match(
    runner,
    /EXPECTED_CANDIDATE_SHA=93def24ee6dd4de63fd4ebf776a0a2056d2563df492727231b8f6de08ec0c7ee/
  );
  assert.match(
    runner,
    /EXPECTED_CANDIDATE_DOMAIN_SHA=be64b9b040d8b188b8bae9fb63e87621263bca9d8b76d40bf8c8ed302f08fa9d/
  );
  assert.match(runner, /EXPECTED_QR_IDS=SSS00003,SSS00008,SSS00009/);
  assert.match(runner, /default_transaction_read_only=on/);
  assert.match(runner, /IDENTITY_POSTGRES_AUTHORITY_ENABLED/);
  assert.match(runner, /QR_ISSUANCE_POSTGRES_AUTHORITY_ENABLED/);
  assert.match(runner, /DATABASE_URL\|PGPASSWORD/);
  assert.match(runner, /--preflight/);
  assert.match(runner, /PRODUCTION_JSON_WRITE=NONE/);
  assert.match(runner, /PRODUCTION_DATABASE_WRITE=NONE/);
  assert.match(runner, /OSS_ACCESS=NONE/);
  assert.match(runner, /NEXT_ACTION=BUILD_CONTROLLED_APPLY_AND_REPROOF_RUNNER/);
  assert.doesNotMatch(runner, /pm2\s+(?:stop|restart|reload|save)/);
  assert.doesNotMatch(runner, /--apply-production-snapshot/);

  assert.match(implementation, /pg_advisory_xact_lock/);
  assert.match(implementation, /isolationLevel: 'serializable'/);
  assert.match(implementation, /DELETE FROM app\.record_archives/);
  assert.match(implementation, /DELETE FROM app\.record_proofs/);
  assert.match(implementation, /verifyImportedPlan/);
  assert.match(implementation, /privacy-reproof:/);
  assert.match(implementation, /fs\.renameSync/);
  assert.doesNotMatch(
    implementation,
    /child_process|execSync|spawnSync|ali-oss|avataService/
  );
  assert.equal(
    packageJson.scripts['privacy:apply:preflight:production-snapshot'],
    'bash scripts/database/run-content-privacy-remediation-apply-preflight.sh'
  );
});

test('controlled privacy apply and reproof runner is exact, resumable, and PM2-secret safe', () => {
  const packageJson = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../package.json'),
    'utf8'
  ));
  const runner = fs.readFileSync(
    path.join(
      __dirname,
      '../scripts/database/run-content-privacy-remediation-controlled.sh'
    ),
    'utf8'
  );
  const reproof = fs.readFileSync(
    path.join(__dirname, '../scripts/database/run-content-privacy-reproof.js'),
    'utf8'
  );
  const finalizer = fs.readFileSync(
    path.join(__dirname, '../scripts/database/content-privacy-reproof.js'),
    'utf8'
  );

  assert.match(
    runner,
    /CONTENT_PRIVACY_PRODUCTION_APPLY_CONFIRMATION/
  );
  assert.match(runner, /CONTENT_PRIVACY_PROVIDER_ENV/);
  assert.match(runner, /CONTENT_PRIVACY_EXPECTED_AVATA_ENV/);
  assert.match(runner, /CONTENT_PRIVACY_EXPECTED_AVATA_ORIGIN/);
  assert.match(runner, /PROVIDER_GATE_AVATA_ENV_EXPLICIT_REQUIRED/);
  assert.match(runner, /PROVIDER_GATE_AVATA_ORIGIN_MISMATCH/);
  assert.match(runner, /CONTROLLED_PROVIDER_ENVIRONMENT/);
  assert.match(runner, /CONTROLLED_PROVIDER_ORIGIN/);
  assert.match(runner, /EXPECTED_QR_IDS=SSS00003,SSS00008,SSS00009/);
  assert.match(runner, /EXPECTED_CANDIDATE_SHA=93def24ee6dd4de63fd4ebf776a0a2056d2563df492727231b8f6de08ec0c7ee/);
  assert.match(runner, /PROVIDER_ENV_MODE_INVALID/);
  assert.match(runner, /--apply-production-snapshot/);
  assert.match(runner, /--execute-controlled/);
  assert.match(runner, /trap cleanup EXIT/);
  assert.match(runner, /pm2 stop xingxingzaishan/);
  assert.match(runner, /pm2 restart xingxingzaishan/);
  assert.match(runner, /command -v timeout/);
  assert.match(runner, /timeout --signal=TERM --kill-after=30s 1900s/);
  assert.doesNotMatch(runner, /pm2 (?:save|restart .*--update-env)/);
  assert.match(runner, /AVATA_API_KEY\|AVATA_API_SECRET/);
  assert.match(runner, /PROOF_ATTEMPT_HISTORY_PRESERVED=YES/);

  assert.match(reproof, /createOutboxWorker/);
  assert.match(reproof, /queryProviderOperation/);
  assert.match(reproof, /FINAL_JSON_PENDING/);
  assert.match(reproof, /operational_proof_attempts_preserved: true/);
  assert.doesNotMatch(reproof, /child_process|execSync|spawnSync/);

  assert.match(finalizer, /public_qr_v1_and_operational_evidence_v1/);
  assert.match(finalizer, /operational_proof_attempts_preserved: true/);
  assert.match(finalizer, /verifyPublicDomainParity/);
  assert.match(finalizer, /fs\.renameSync/);
  assert.doesNotMatch(finalizer, /DELETE FROM app\.proof_attempts/);
  assert.equal(
    packageJson.scripts['privacy:apply:controlled:production-snapshot'],
    'bash scripts/database/run-content-privacy-remediation-controlled.sh'
  );
});

test('manual production backup is non-destructive, secret-safe, and manually invoked', () => {
  const packageJson = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../package.json'),
    'utf8'
  ));
  const runner = fs.readFileSync(
    path.join(__dirname, '../scripts/database/run-production-backup.sh'),
    'utf8'
  );
  const implementation = fs.readFileSync(
    path.join(__dirname, '../scripts/database/production-backup.js'),
    'utf8'
  );
  const storage = fs.readFileSync(
    path.join(__dirname, '../src/server/services/storageService.js'),
    'utf8'
  );

  assert.equal(
    packageJson.scripts['backup:production:manual'],
    'bash scripts/database/run-production-backup.sh'
  );
  assert.match(runner, /EXPECTED_DATABASE=xingxing_clean_baseline_20260812_staging/);
  assert.match(runner, /git diff --quiet/);
  assert.match(runner, /git diff --cached --quiet/);
  assert.match(runner, /assert_authority_runtime/);
  assert.match(runner, /POSTGRES_CUTOVER_WRITE_FREEZE_ENABLED/);
  assert.match(runner, /RECORD_PROOF_RUNTIME_ENABLED/);
  assert.match(runner, /OSS_ACCESS_KEY_ID\|OSS_ACCESS_KEY_SECRET/);
  assert.match(runner, /APP_PID_CHANGED/);
  assert.match(runner, /CRON_CONFIGURED=NO/);
  assert.doesNotMatch(runner, /pm2\s+(?:stop|restart|reload|save)/);
  assert.doesNotMatch(runner, /systemctl\s+(?:enable|start)|crontab/);
  assert.doesNotMatch(runner, /dropdb|DROP DATABASE|DELETE FROM|TRUNCATE/);
  assert.doesNotMatch(runner, /--password=|PGPASSWORD=[^'']+/);

  assert.match(implementation, /--format=custom/);
  assert.match(implementation, /--no-owner/);
  assert.match(implementation, /--no-privileges/);
  assert.match(implementation, /PGPASSFILE/);
  assert.match(implementation, /O_NOFOLLOW/);
  assert.match(implementation, /cross_store_transactional_snapshot: false/);
  assert.match(implementation, /REMOTE_PARTIAL_OBJECTS_DELETED=NO/);
  assert.doesNotMatch(
    implementation,
    /deleteObject|deleteMulti|dropdb|DROP DATABASE|DELETE FROM|TRUNCATE/
  );
  assert.doesNotMatch(implementation, /pm2\s+(?:stop|restart|reload|save)/);
  assert.doesNotMatch(implementation, /crontab|systemctl\s+(?:enable|start)/);

  assert.match(storage, /x-oss-forbid-overwrite/);
  assert.match(storage, /getObjectMeta/);
  assert.match(storage, /head\(safeObjectKey\)/);
  assert.match(storage, /meta: \{\s+sha256,/);
  assert.match(storage, /private, max-age=0, no-cache/);
});

test('production restore drill is fixed-source, isolated, retained, and non-destructive', () => {
  const packageJson = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../package.json'),
    'utf8'
  ));
  const runner = fs.readFileSync(
    path.join(__dirname, '../scripts/database/run-production-restore-drill.sh'),
    'utf8'
  );
  const implementation = fs.readFileSync(
    path.join(__dirname, '../scripts/database/production-restore-drill.js'),
    'utf8'
  );
  const storage = fs.readFileSync(
    path.join(__dirname, '../src/server/services/storageService.js'),
    'utf8'
  );

  assert.equal(
    packageJson.scripts['backup:restore:drill'],
    'bash scripts/database/run-production-restore-drill.sh'
  );
  assert.match(runner, /\[ "\$#" = 0 \] \|\| fail RESTORE_ARGUMENT_INVALID/);
  assert.match(runner, /PRODUCTION_DB=xingxing_clean_baseline_20260812_staging/);
  assert.match(runner, /EXPECTED_PRODUCTION_JSON_SHA=f263df13b5c19f91b0f86d93960f6b26896f3ed605318c73dd8546d110b06cfd/);
  assert.match(runner, /PRODUCTION_JSON_BASELINE_MISMATCH/);
  assert.match(runner, /RESTORE_DB="xingxing_restore_drill_\$\{DATE_UTC\}_\$\{NONCE\}"/);
  assert.match(implementation, /--single-transaction/);
  assert.match(implementation, /--exit-on-error/);
  assert.match(implementation, /--no-owner/);
  assert.match(implementation, /--no-privileges/);
  assert.match(runner, /NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT/);
  assert.match(runner, /"\$PSQL" -X -1 -v ON_ERROR_STOP=1/);
  assert.match(runner, /< "\$ROLE_SQL"/);
  assert.doesNotMatch(runner, /-f "\$ROLE_SQL"/);
  assert.match(runner, /ALTER ROLE "\$RESTORE_ROLE" NOLOGIN PASSWORD NULL/);
  assert.match(runner, /ALTER DATABASE "\$RESTORE_DB" CONNECTION LIMIT 0/);
  assert.match(runner, /SELECT rolcanlogin FROM pg_roles/);
  assert.match(runner, /SELECT datconnlimit FROM pg_database/);
  assert.match(runner, /-v restore_role="\$RESTORE_ROLE" <<'SQL'/);
  assert.match(runner, /-v restore_db="\$RESTORE_DB" <<'SQL'/);
  assert.doesNotMatch(
    runner,
    /-c "SELECT (?:rolcanlogin|datconnlimit)[^\n]*:'restore_(?:role|db)'/
  );
  assert.match(runner, /RESTORE_ROLE_NOT_SEALED/);
  assert.match(runner, /RESTORE_DATABASE_NOT_SEALED/);
  assert.match(runner, /RESTORE_RESOURCE_SEAL_FAILED/);
  assert.match(runner, /seal_resources INCOMPLETE \|\| seal_failed=1/);
  assert.match(runner, /SELECT pg_terminate_backend\(pid\)/);
  assert.match(runner, /SELECT count\(\*\) FROM pg_roles WHERE rolname/);
  for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
    assert.match(runner, new RegExp(`has_table_privilege\\([\\s\\S]*?, '${privilege}'\\)`));
  }
  assert.doesNotMatch(runner, /'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'/);
  assert.match(runner, /PRODUCTION_DATABASE_RESTORE_CONNECTIONS=0/);
  assert.match(runner, /TEMPORARY_DATABASE_RETAINED=YES/);
  assert.match(runner, /trap cleanup EXIT/);
  assert.match(runner, /assert_authority_runtime/);
  assert.match(runner, /PM2_DUMP_SHA_BEFORE/);
  assert.match(runner, /JSON_SHA_BEFORE/);
  assert.match(runner, /unset DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE/);
  assert.match(runner, /unset OSS_ACCESS_KEY_ID OSS_ACCESS_KEY_SECRET/);
  assert.match(runner, /\|\| fail POSTGRES_RESTORE_FAILED/);
  assert.doesNotMatch(
    runner,
    /(?:^|\s)(?:dropdb|DROP\s+DATABASE|DELETE\s+FROM|TRUNCATE\s+TABLE)(?:\s|$)/m
  );
  assert.doesNotMatch(runner, /pm2\s+(?:stop|restart|reload|save)/);
  assert.doesNotMatch(runner, /systemctl\s+(?:enable|start)|crontab/);
  assert.doesNotMatch(runner, /--create|--clean|--if-exists/);
  assert.doesNotMatch(runner, /OSS_ACCESS_KEY_SECRET=|AVATA_API_(?:KEY|SECRET)=/);

  assert.match(implementation, /BACKUP_RUN_ID = '20260813T110535Z-6586d9b1'/);
  assert.match(implementation, /ea84e2fe7ff2e26e6c3fd85cdbeab4eb94aae6eeac356253db755a21175cc5f8/);
  assert.match(implementation, /93324cbe855fb811f2ec523e95cc041e2ccc2035c4089aa870979cc4347c5785/);
  assert.match(implementation, /f263df13b5c19f91b0f86d93960f6b26896f3ed605318c73dd8546d110b06cfd/);
  assert.match(implementation, /loadMigrations/);
  assert.match(implementation, /AS relations\(relation_name\)/);
  assert.match(implementation, /'accounts_pkey'/);
  assert.match(implementation, /AS identities/);
  assert.match(implementation, /readOnly: true/);
  assert.match(implementation, /new QrRepository/);
  assert.match(implementation, /new RecordRepository/);
  assert.match(implementation, /new AccountRepository/);
  assert.match(implementation, /new IdentityRepository/);
  assert.match(implementation, /new CoCreationRepository/);
  assert.doesNotMatch(implementation, /uploadProtectedFileToOss|\.put\(|deleteObject|deleteMulti/);
  assert.match(implementation, /spawnSync/);
  assert.doesNotMatch(implementation, /execSync|execFileSync|shell:\s*true/);

  assert.match(storage, /activeClient\.getStream\(safeObjectKey\)/);
  assert.match(storage, /O_EXCL/);
  assert.match(storage, /O_NOFOLLOW/);
  assert.match(storage, /crypto\.createHash\('sha256'\)/);
});
