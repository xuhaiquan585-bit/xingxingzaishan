'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { closePostgresPool, createPostgresPool } = require('../src/server/database/connection');
const { readPostgresConfig } = require('../src/server/database/config');
const { withTransaction } = require('../src/server/database/transaction');
const {
  CoCreationRepository,
  ProofRepository,
  QrBatchRepository,
  QrRepository,
  RecordRepository
} = require('../src/server/repositories');
const {
  PublicQrReadAdapter
} = require('../src/server/services/postgres/publicQrReadAdapter');
const {
  comparePublicQrDtos
} = require('../src/server/services/postgres/publicQrDtoComparator');
const { generateMiniappToken } = require('../src/server/services/miniappAuthService');
const { executeStagingImport } = require('../scripts/database/import-staging');
const { runMigrations } = require('../scripts/database/migrate');
const { analyzeSourceSnapshot } = require('../scripts/database/importer');
const { readSourceSnapshot, sha256 } = require('../scripts/database/importer/reader');

const RUN_INTEGRATION = process.env.RUN_POSTGRES_INTEGRATION === 'true';
const CREATED_AT = '2026-07-01T10:00:00.000Z';
const LATER_AT = '2026-07-01T11:00:00.000Z';

function baseQr(id, activationStatus, overrides = {}) {
  return {
    id,
    issue_status: 'issued',
    activation_status: activationStatus,
    hidden: false,
    batch_id: 'BATCH_PUBLIC',
    print_batch_id: null,
    quality_check: {
      checked: false,
      checked_at: null,
      checked_by: null,
      result: null
    },
    content: null,
    image_url: null,
    image_object_key: null,
    image_sha256: null,
    phone: null,
    account_id: null,
    activated_at: null,
    blockchain_hash: null,
    chain_provider: 'avata_wenchang',
    chain_status: 'not_started',
    chain_operation_id: null,
    manifest_object_key: null,
    manifest_hash: null,
    chain_tx_hash: null,
    chain_block_height: null,
    chain_record_id: null,
    chain_certificate_url: null,
    chain_certificate_object_key: null,
    chain_certificate_object_url: null,
    chain_confirmed_at: null,
    chain_callback_received_at: null,
    chain_last_error: '',
    chain_retry_count: 0,
    legacy_manifest_object_key: null,
    archive_index_object_key: null,
    archive_status: 'not_started',
    archive_last_error: '',
    archive_updated_at: null,
    co_creation_enabled: false,
    co_creation_owner_phone: null,
    co_creation_owner_account_id: null,
    co_creation_comments: [],
    co_creation_started_at: null,
    show_brand_disclosure: false,
    brand_disclosure_text_snapshot: '',
    qr_image_url: null,
    qr_access_token: `token-${id.toLowerCase()}`,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    ...overrides
  };
}

function buildFixture() {
  const accounts = [1, 2, 3].map((number) => ({
    id: `ACC00000${number}`,
    status: 'active',
    display_name: '',
    avatar_url: '',
    created_from: 'migration',
    created_at: CREATED_AT,
    updated_at: CREATED_AT
  }));
  const users = [1, 2, 3].map((number) => ({
    id: number,
    phone: `1380000000${number}`,
    openid: `openid-fixture-${number}`,
    unionid: null,
    source: 'web+miniapp',
    created_at: CREATED_AT,
    account_id: `ACC00000${number}`
  }));

  return {
    meta: {
      next_user_id: 4,
      next_account_id: 4,
      accounts_migration_version: 'accounts_foundation_v1'
    },
    accounts,
    users,
    admins: [],
    batches: [{
      id: 'BATCH_PUBLIC',
      name: 'Public fixture batch',
      brand_name: 'Fixture brand',
      note: '',
      brand_disclosure_text: 'Fixture disclosure',
      brand_disclosure_default: true,
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
      created_by: null
    }],
    qr_codes: [
      baseQr('QR_UNACTIVATED', 'unactivated'),
      baseQr('QR_CO_CREATING', 'co_creating', {
        content: 'Co-creation fixture',
        image_url: 'https://fixture.invalid/co-creating.jpg',
        phone: '13800000002',
        account_id: 'ACC000002',
        co_creation_enabled: true,
        co_creation_owner_phone: '13800000002',
        co_creation_owner_account_id: 'ACC000002',
        co_creation_comments: [{
          id: 'CO_ONLY',
          phone: '13800000001',
          account_id: 'ACC000001',
          author_name: 'Fixture participant',
          content: 'Fixture comment',
          status: 'kept',
          created_at: LATER_AT
        }],
        co_creation_started_at: CREATED_AT,
        show_brand_disclosure: true,
        brand_disclosure_text_snapshot: 'Fixture disclosure'
      }),
      baseQr('QR_ACTIVATED_DIRECT', 'activated', {
        content: 'Activated fixture',
        image_url: 'https://fixture.invalid/activated.jpg',
        phone: '13800000001',
        account_id: 'ACC000001',
        activated_at: LATER_AT,
        blockchain_hash: 'a'.repeat(64),
        chain_status: 'confirmed',
        chain_operation_id: 'operation-fixture',
        manifest_hash: 'a'.repeat(64),
        chain_tx_hash: 'transaction-fixture',
        chain_record_id: 'record-fixture',
        chain_certificate_url: 'https://fixture.invalid/certificate.pdf',
        chain_confirmed_at: LATER_AT,
        show_brand_disclosure: true,
        brand_disclosure_text_snapshot: 'Fixture disclosure',
        updated_at: LATER_AT
      }),
      baseQr('QR_ACTIVATED_COMMENTS', 'activated', {
        content: 'Comment ordering fixture',
        image_url: 'https://fixture.invalid/comments.jpg',
        phone: '13800000001',
        account_id: 'ACC000001',
        activated_at: LATER_AT,
        co_creation_enabled: true,
        co_creation_owner_phone: '13800000001',
        co_creation_owner_account_id: 'ACC000001',
        co_creation_comments: [
          {
            id: 'COMMENT_ALPHA',
            phone: '13800000002',
            account_id: 'ACC000002',
            author_name: 'First source comment',
            content: 'First source content',
            status: 'kept',
            created_at: LATER_AT
          },
          {
            id: 'COMMENT_BETA',
            phone: '13800000003',
            account_id: 'ACC000003',
            author_name: 'Second source comment',
            content: 'Second source content',
            status: 'kept',
            created_at: LATER_AT
          },
          {
            id: 'COMMENT_DELETED',
            phone: '13800000001',
            account_id: 'ACC000001',
            author_name: 'Deleted source comment',
            content: 'Deleted source content',
            status: 'deleted',
            created_at: LATER_AT,
            deleted_at: LATER_AT
          }
        ],
        co_creation_started_at: CREATED_AT,
        updated_at: LATER_AT
      })
    ],
    quality_check_logs: [],
    products: [],
    content_pages: [],
    banners: [],
    orders: [],
    payment_logs: [],
    miniapp_content: {
      home_title: 'Fixture title',
      home_subtitle: 'Fixture subtitle',
      logo_image: '',
      home_banner_image: '',
      home_slides: [],
      scene_cards: [],
      project_title: 'Fixture project',
      project_body: 'Fixture body',
      brand_story_title: 'Fixture story',
      brand_story_body: 'Fixture story body',
      consult_label: 'Fixture consult',
      consult_url: '',
      share_title: 'Fixture share',
      share_description: 'Fixture share body',
      updated_at: CREATED_AT,
      updated_by: null
    }
  };
}

function writeFixture(directory, fixture) {
  const inputPath = path.join(directory, 'public-qr-fixture.json');
  const bytes = Buffer.from(JSON.stringify(fixture, null, 2), 'utf8');
  fs.writeFileSync(inputPath, bytes);
  return {
    inputPath,
    sourceHash: sha256(bytes)
  };
}

function analyzeFixture(inputPath, sourceHash) {
  const snapshot = readSourceSnapshot({
    inputPath,
    expectedSha256: sourceHash
  });
  return {
    snapshot,
    ...analyzeSourceSnapshot(snapshot)
  };
}

function requestJson(port, requestPath, token = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          body: raw ? JSON.parse(raw) : null
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readCandidate(pool, { key, channel, viewer }) {
  return withTransaction(pool, async (transactionContext) => {
    const queries = [];
    const observedContext = Object.freeze({
      async query(...args) {
        queries.push(String(args[0]).replace(/\s+/g, ' ').trim());
        return transactionContext.query(...args);
      }
    });
    const adapter = new PublicQrReadAdapter({
      qrRepository: new QrRepository(observedContext),
      recordRepository: new RecordRepository(observedContext),
      coCreationRepository: new CoCreationRepository(observedContext),
      proofRepository: new ProofRepository(observedContext),
      batchReader: new QrBatchRepository(observedContext),
      assetResolver: null,
      publicRuntimeMetadata: { storage_mode: 'local' }
    });
    const dto = await adapter.read({ key, channel, viewer });
    return { dto, queries };
  }, { isolationLevel: 'repeatable read', readOnly: true });
}

function assertDtoMatch(label, baseline, candidate, channel) {
  const report = comparePublicQrDtos({ baseline, candidate, channel });
  assert.equal(report.matches, true, `${label}: ${JSON.stringify(report)}`);
}

async function verifySourcePositionMigrationGuard(pool, directory) {
  await pool.query('DROP SCHEMA IF EXISTS app CASCADE');
  const legacyMigrations = path.join(directory, 'legacy-migrations');
  fs.mkdirSync(legacyMigrations);
  fs.copyFileSync(
    path.join(__dirname, '..', 'database', 'migrations', '001_init_schema.sql'),
    path.join(legacyMigrations, '001_init_schema.sql')
  );
  await runMigrations({
    pool,
    apply: true,
    target: 'test',
    migrationsDirectory: legacyMigrations
  });
  const at = '2026-07-01T10:00:00.000Z';
  await pool.query(
    `INSERT INTO app.accounts
       (id, status, display_name, avatar_url, created_from, created_at, updated_at)
     VALUES ('ACC_GUARD', 'active', '', '', 'migration', $1, $1)`,
    [at]
  );
  await pool.query(
    `INSERT INTO app.qr_codes
       (id, issue_status, lifecycle_status, created_at, updated_at)
     VALUES ('QR_GUARD', 'issued', 'co_creating', $1, $1)`,
    [at]
  );
  await pool.query(
    `INSERT INTO app.co_creations
       (id, qr_id, owner_account_id, status, started_at, created_at, updated_at)
     VALUES
       ('00000000-0000-0000-0000-000000000901', 'QR_GUARD', 'ACC_GUARD',
        'active', $1, $1, $1)`,
    [at]
  );
  await pool.query(
    `INSERT INTO app.co_creation_comments
       (id, co_creation_id, account_id, legacy_comment_id, content, status, created_at)
     VALUES
       ('00000000-0000-0000-0000-000000000902',
        '00000000-0000-0000-0000-000000000901',
        'ACC_GUARD', 'GUARD_COMMENT', 'guard comment', 'kept', $1)`,
    [at]
  );

  await assert.rejects(
    runMigrations({ pool, apply: true, target: 'test' }),
    (error) => error.code === 'POSTGRES_MIGRATION_FAILED'
  );
  const column = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'app'
       AND table_name = 'co_creation_comments'
       AND column_name = 'source_position'`
  );
  assert.equal(column.rowCount, 0);
  const versions = await pool.query(
    'SELECT version FROM app.schema_migrations ORDER BY version'
  );
  assert.deepEqual(
    versions.rows.map((row) => row.version),
    ['001_init_schema.sql']
  );
  await pool.query('DROP SCHEMA app CASCADE');
}

test('manual PostgreSQL public QR adapter integration', {
  skip: RUN_INTEGRATION ? false : 'Set RUN_POSTGRES_INTEGRATION=true and an explicit _test database.'
}, async () => {
  assert.notEqual(String(process.env.NODE_ENV || '').toLowerCase(), 'production');
  assert.match(String(process.env.PGDATABASE || ''), /_test$/i);
  assert.equal(Boolean(process.env.DATABASE_URL), false);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingxing-public-qr-pg-'));
  const fixture = buildFixture();
  const source = writeFixture(directory, fixture);
  const analysis = analyzeFixture(source.inputPath, source.sourceHash);
  assert.equal(analysis.report.status, 'READY');
  assert.equal(analysis.report.can_import, true);

  process.env.NODE_ENV = 'test';
  process.env.DB_FILE = analysis.snapshot.sourcePath;
  process.env.AUTH_SECRET = 'public-qr-integration-secret';
  process.env.STORAGE_MODE = 'local';

  const config = readPostgresConfig(process.env);
  const pool = createPostgresPool({ config });
  let server;
  let port;
  try {
    await verifySourcePositionMigrationGuard(pool, directory);
    const migration = await runMigrations({ pool, apply: true, target: 'test' });
    assert.deepEqual(
      migration.applied.map((item) => item.version),
      ['001_init_schema.sql', '002_add_comment_source_position.sql']
    );
    const repeatedMigration = await runMigrations({ pool, apply: true, target: 'test' });
    assert.deepEqual(repeatedMigration.applied, []);
    const imported = await executeStagingImport({
      pool,
      snapshot: analysis.snapshot,
      report: analysis.report,
      plan: analysis.plan
    });
    assert.equal(imported.status, 'PASSED');

    const { createApp } = require('../src/server/app');
    ({ server, port } = await startServer(createApp()));
    const owner = fixture.users[1];
    const participant = fixture.users[1];
    const ownerToken = generateMiniappToken(owner);
    const participantToken = generateMiniappToken(participant);

    const exactCases = [
      {
        label: 'h5 unactivated',
        path: '/api/qr/token-qr_unactivated',
        key: 'token-qr_unactivated',
        channel: 'h5',
        viewer: null,
        expectedQueries: 2
      },
      {
        label: 'miniapp unactivated',
        path: '/api/miniapp/qr/token-qr_unactivated',
        key: 'token-qr_unactivated',
        channel: 'miniapp',
        viewer: null,
        expectedQueries: 2
      },
      {
        label: 'miniapp co-creating unbound',
        path: '/api/miniapp/qr/token-qr_co_creating',
        key: 'token-qr_co_creating',
        channel: 'miniapp',
        viewer: null,
        expectedQueries: 2
      },
      {
        label: 'miniapp co-creating owner',
        path: '/api/miniapp/qr/token-qr_co_creating',
        key: 'token-qr_co_creating',
        channel: 'miniapp',
        token: ownerToken,
        viewer: { account_id: owner.account_id, phone_bound: true },
        expectedQueries: 5
      },
      {
        label: 'h5 activated proof',
        path: '/api/qr/token-qr_activated_direct',
        key: 'token-qr_activated_direct',
        channel: 'h5',
        viewer: null,
        expectedQueries: 5
      },
      {
        label: 'miniapp activated comments',
        path: '/api/miniapp/qr/token-qr_activated_comments',
        key: 'token-qr_activated_comments',
        channel: 'miniapp',
        token: participantToken,
        viewer: { account_id: participant.account_id, phone_bound: true },
        expectedQueries: 6
      }
    ];

    for (const current of exactCases) {
      const baselineResponse = await requestJson(port, current.path, current.token);
      assert.equal(baselineResponse.status, 200);
      const candidate = await readCandidate(pool, current);
      assert.equal(candidate.queries.length, current.expectedQueries);
      assertDtoMatch(
        current.label,
        baselineResponse.body.data,
        candidate.dto,
        current.channel
      );
    }

    const importedPositions = await pool.query(
      `SELECT comment.legacy_comment_id, comment.source_position, comment.status
       FROM app.co_creation_comments comment
       JOIN app.co_creations creation ON creation.id = comment.co_creation_id
       WHERE creation.qr_id = 'QR_ACTIVATED_COMMENTS'
       ORDER BY comment.source_position`
    );
    assert.deepEqual(importedPositions.rows, [
      { legacy_comment_id: 'COMMENT_ALPHA', source_position: 0, status: 'kept' },
      { legacy_comment_id: 'COMMENT_BETA', source_position: 1, status: 'kept' },
      { legacy_comment_id: 'COMMENT_DELETED', source_position: 2, status: 'deleted' }
    ]);

    const indexes = await pool.query(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'app'
         AND tablename IN (
           'qr_codes', 'qr_batches', 'records', 'co_creations',
           'co_creation_comments', 'record_proofs'
         )`
    );
    const indexNames = new Set(indexes.rows.map((row) => row.indexname));
    [
      'qr_codes_pkey',
      'qr_codes_access_token_uq',
      'qr_batches_pkey',
      'records_pkey',
      'co_creations_qr_uq',
      'co_creation_comments_public_source_order_idx',
      'record_proofs_record_provider_uq'
    ].forEach((name) => assert.equal(indexNames.has(name), true));
  } finally {
    if (server) await stopServer(server);
    await pool.query('DROP SCHEMA IF EXISTS app CASCADE');
    await closePostgresPool(pool);
    fs.rmSync(directory, { recursive: true, force: true });
    delete process.env.DB_FILE;
    delete process.env.AUTH_SECRET;
    delete process.env.STORAGE_MODE;
  }
});
