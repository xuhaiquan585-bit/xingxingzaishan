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
  AccountRepository,
  AuditRepository,
  CoCreationRepository,
  IdentityRepository,
  OrderRepository,
  PaymentRepository,
  ProofRepository,
  PublicQrProvenanceRepository,
  QrBatchRepository,
  QrRepository,
  RecordRepository
} = require('../src/server/repositories');
const { executeQuery } = require('../src/server/repositories/query');
const {
  COMMENT_FIELDS,
  PROOF_FIELDS
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

test('comment compatibility migrations are additive and leave migration 001 unchanged', () => {
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

  const migrations = loadMigrations({ migrationsDirectory });
  assert.deepEqual(
    migrations.map((item) => item.version),
    [
      '001_init_schema.sql',
      '002_add_comment_source_position.sql',
      '003_preserve_legacy_import_evidence.sql'
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
  assert.equal(result.sequence_values.users, '2');
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

test('public QR provenance repository checks exact source hashes and canonical migrations', async () => {
  const sourceHash = 'a'.repeat(64);
  const harness = createRepositoryContext([
    {
      rows: [{ source_sha256: sourceHash, status: 'passed', completed_at: '2026-01-01T00:00:00Z' }],
      rowCount: 1
    },
    { rows: [{ version: '001_init_schema.sql', checksum: 'b'.repeat(64) }], rowCount: 1 }
  ]);
  const repository = new PublicQrProvenanceRepository(harness.context);
  const importRun = await repository.findPassedImportBySourceHash(sourceHash);
  const migrations = await repository.listAppliedMigrations();
  assert.equal(importRun.source_sha256, sourceHash);
  assert.deepEqual(harness.calls[0].params, [sourceHash]);
  assert.equal(harness.calls[0].sql.includes(sourceHash), false);
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
  const harness = createRepositoryContext([{ rows: [] }, { rows: [] }, { rows: [] }]);
  const records = new RecordRepository(harness.context);
  const orders = new OrderRepository(harness.context);
  await records.findOwnedByAccountId('ACC_TEST', 'QR_TEST');
  await records.listByAccountId('ACC_TEST', { limit: 5000 });
  await orders.listByAccountId('ACC_TEST', { limit: 5000 });

  harness.calls.forEach(({ sql }) => {
    assert.doesNotMatch(sql, /\b(?:phone|openid)\b/i);
  });
  assert.deepEqual(harness.calls[0].params, ['ACC_TEST', 'QR_TEST']);
  assert.deepEqual(harness.calls[1].params, ['ACC_TEST', 100]);
  assert.deepEqual(harness.calls[2].params, ['ACC_TEST', 100]);
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
  const harness = createRepositoryContext(Array.from({ length: 10 }, () => ({ rows: [] })));
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

  assert.equal(harness.calls.length, 10);
  harness.calls.forEach(({ sql }) => {
    assert.doesNotMatch(sql, /ON\s+CONFLICT/i);
  });
  assert.equal(harness.calls[9].params.includes('{}'), true);
});
