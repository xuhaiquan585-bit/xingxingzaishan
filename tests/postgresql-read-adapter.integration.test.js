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
  AccountRepository,
  CoCreationRepository,
  IdentityRepository,
  ProofRepository,
  QrBatchRepository,
  QrRepository,
  RecordRepository
} = require('../src/server/repositories');
const {
  PublicQrReadAdapter
} = require('../src/server/services/postgres/publicQrReadAdapter');
const {
  IdentityReadAdapter
} = require('../src/server/services/postgres/identityReadAdapter');
const {
  createIdentityWriteService
} = require('../src/server/services/postgres/identityWriteService');
const {
  createQrLifecycleWriteService
} = require('../src/server/services/postgres/qrLifecycleWriteService');
const {
  createOutboxWorker
} = require('../src/server/services/postgres/outboxWorkerService');
const {
  createRecordProofJobHandler
} = require('../src/server/services/postgres/recordProofJobHandler');
const {
  createRecordProofResultService
} = require('../src/server/services/postgres/recordProofResultService');
const {
  closeRecordProofRuntime,
  createRecordProofRuntime
} = require('../src/server/services/postgres/recordProofRuntime');
const {
  readRecordProofRuntimeConfig
} = require('../src/server/services/postgres/recordProofRuntimeConfig');
const {
  PersonalRecordReadAdapter
} = require('../src/server/services/postgres/personalRecordReadAdapter');
const {
  comparePublicQrDtos
} = require('../src/server/services/postgres/publicQrDtoComparator');
const { createPublicQrAssetResolver } = require('../src/server/services/publicQrAssetResolver');
const {
  closePublicQrShadowRuntime,
  createPublicQrShadowRuntime
} = require('../src/server/services/postgres/publicQrShadowRuntime');
const {
  closePublicQrPrimaryReadRuntime
} = require('../src/server/services/postgres/publicQrPrimaryReadRuntime');
const {
  closeQrLifecycleWriteRuntime
} = require('../src/server/services/postgres/qrLifecycleWriteRuntime');
const {
  closePersonalRecordPrimaryReadRuntime
} = require('../src/server/services/postgres/personalRecordPrimaryReadRuntime');
const {
  closeIdentityAuthorityRuntime
} = require('../src/server/services/postgres/identityAuthorityRuntime');
const {
  closeQrIssuanceAuthorityRuntime
} = require('../src/server/services/postgres/qrIssuanceAuthorityRuntime');
const { generateToken } = require('../src/server/services/authService');
const { generateMiniappToken } = require('../src/server/services/miniappAuthService');
const { signRequest } = require('../src/server/services/avataService');
const {
  createSession,
  getCookieName
} = require('../src/server/services/userSessionService');
const { executeStagingImport } = require('../scripts/database/import-staging');
const { loadMigrations, runMigrations } = require('../scripts/database/migrate');
const { analyzeSourceSnapshot } = require('../scripts/database/importer');
const { readSourceSnapshot, sha256 } = require('../scripts/database/importer/reader');
const {
  executeRemediation,
  validateArtifacts
} = require('../scripts/database/apply-content-privacy-remediation');
const {
  prepareSource
} = require('../scripts/database/prepare-content-privacy-remediation');
const {
  executeReproof,
  preflightReproof
} = require('../scripts/database/run-content-privacy-reproof');

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
        blockchain_hash: 'legacy-proof-marker-1',
        manifest_hash: 'legacy-proof-marker-1',
        chain_status: 'confirmed',
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
          },
          {
            id: 'COMMENT_ALPHA_LEGACY_DUPLICATE',
            phone: '13800000002',
            account_id: 'ACC000002',
            author_name: 'Later historical source comment',
            content: 'Distinct historical content',
            status: 'kept',
            created_at: CREATED_AT
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

function requestJson(port, requestPath, token = '', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      method: 'GET',
      headers: {
        ...headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
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

function postRaw(port, requestPath, body, headers = {}, includeResponseHeaders = false) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const response = {
          status: res.statusCode,
          raw: Buffer.concat(chunks).toString('utf8')
        };
        if (includeResponseHeaders) response.headers = res.headers;
        resolve(response);
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function requestBuffer(port, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      method: 'GET',
      headers
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks)
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function readCandidate(pool, { key, channel, viewer }) {
  const loaded = await withTransaction(pool, async (transactionContext) => {
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
    const snapshot = await adapter.loadSnapshot({ key, channel, viewer });
    return { adapter, snapshot, queries };
  }, { isolationLevel: 'repeatable read', readOnly: true });
  const dto = await loaded.adapter.present(loaded.snapshot);
  return { dto, queries: loaded.queries };
}

async function readPersonalCandidate(pool, {
  readKind,
  accountId,
  recordId = null,
  channel
}) {
  const loaded = await withTransaction(pool, async (transactionContext) => {
    const adapter = new PersonalRecordReadAdapter({
      qrRepository: new QrRepository(transactionContext),
      recordRepository: new RecordRepository(transactionContext),
      coCreationRepository: new CoCreationRepository(transactionContext),
      proofRepository: new ProofRepository(transactionContext),
      batchReader: new QrBatchRepository(transactionContext),
      publicRuntimeMetadata: { storage_mode: 'local' }
    });
    const snapshot = await adapter.loadSnapshot({
      readKind,
      accountId,
      recordId,
      channel
    });
    return { adapter, snapshot };
  }, { isolationLevel: 'repeatable read', readOnly: true });
  return loaded.adapter.present(loaded.snapshot);
}

function assertDtoMatch(label, baseline, candidate, channel) {
  const report = comparePublicQrDtos({ baseline, candidate, channel });
  assert.equal(report.matches, true, `${label}: ${JSON.stringify(report)}`);
}

async function waitForFile(filePath, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('SHADOW_SINK_OUTPUT_TIMEOUT');
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

async function verifyIssuedQrProtectionMigration(pool) {
  const client = await pool.connect();
  const at = '2026-07-01T09:00:00.000Z';
  async function expectProtection(sql, savepoint) {
    await client.query(`SAVEPOINT ${savepoint}`);
    try {
      await assert.rejects(
        client.query(sql),
        (error) => error.code === '23514'
          && error.constraint === 'qr_codes_issued_immutable'
      );
    } finally {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    }
  }

  await client.query('BEGIN');
  try {
    await client.query(
      `INSERT INTO app.qr_codes
         (id, issue_status, lifecycle_status, created_at, updated_at)
       VALUES
         ('QR_ISSUED_IMMUTABLE', 'unissued', 'unactivated', $1, $1),
         ('QR_UNISSUED_DELETABLE', 'unissued', 'unactivated', $1, $1)`,
      [at]
    );
    await client.query(
      `UPDATE app.qr_codes
          SET issue_status = 'issued', updated_at = $1
        WHERE id = 'QR_ISSUED_IMMUTABLE'`,
      [at]
    );
    await client.query(
      `UPDATE app.qr_codes
          SET lifecycle_status = 'activated', updated_at = $1
        WHERE id = 'QR_ISSUED_IMMUTABLE'`,
      [at]
    );

    await expectProtection(
      "DELETE FROM app.qr_codes WHERE id = 'QR_ISSUED_IMMUTABLE'",
      'protect_delete'
    );
    await expectProtection(
      "UPDATE app.qr_codes SET issue_status = 'unissued' WHERE id = 'QR_ISSUED_IMMUTABLE'",
      'protect_status'
    );
    await expectProtection('TRUNCATE app.qr_codes', 'protect_truncate');

    const deleted = await client.query(
      "DELETE FROM app.qr_codes WHERE id = 'QR_UNISSUED_DELETABLE'"
    );
    assert.equal(deleted.rowCount, 1);
    const issued = await client.query(
      `SELECT issue_status, lifecycle_status
         FROM app.qr_codes
        WHERE id = 'QR_ISSUED_IMMUTABLE'`
    );
    assert.deepEqual(issued.rows, [{
      issue_status: 'issued',
      lifecycle_status: 'activated'
    }]);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
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
  const publicQrDomainHash =
    analysis.report.domain_checksums.public_qr_v1_sha256;

  process.env.NODE_ENV = 'test';
  process.env.DB_FILE = analysis.snapshot.sourcePath;
  process.env.AUTH_SECRET = 'public-qr-integration-secret';
  process.env.STORAGE_MODE = 'local';

  const config = readPostgresConfig(process.env);
  const pool = createPostgresPool({ config });
  const originalFetch = global.fetch;
  let externalFetchCalls = 0;
  let shadowRuntime;
  let stableProofRuntime;
  let server;
  let port;
  try {
    await verifySourcePositionMigrationGuard(pool, directory);
    const migration = await runMigrations({ pool, apply: true, target: 'test' });
    assert.deepEqual(
      migration.applied.map((item) => item.version),
      loadMigrations().map((item) => item.version)
    );
    const repeatedMigration = await runMigrations({ pool, apply: true, target: 'test' });
    assert.deepEqual(repeatedMigration.applied, []);
    await verifyIssuedQrProtectionMigration(pool);

    const privacyDirectory = path.join(directory, 'privacy-apply');
    fs.mkdirSync(privacyDirectory);
    const privacyFixture = buildFixture();
    privacyFixture.qr_codes.find(
      (item) => item.id === 'QR_ACTIVATED_DIRECT'
    ).content = `Privacy integration ${privacyFixture.users[1].phone}`;
    const privacySource = writeFixture(privacyDirectory, privacyFixture);
    const privacyAnalysis = analyzeFixture(
      privacySource.inputPath,
      privacySource.sourceHash
    );
    const privacyImported = await executeStagingImport({
      pool,
      snapshot: privacyAnalysis.snapshot,
      report: privacyAnalysis.report,
      plan: privacyAnalysis.plan
    });
    assert.equal(privacyImported.status, 'PASSED');

    const privacyPrepared = prepareSource({
      source: privacyFixture,
      sourceHash: privacySource.sourceHash,
      expectedQrIds: ['QR_ACTIVATED_DIRECT'],
      remediatedAt: '2026-07-01T11:30:00.000Z'
    });
    const privacyCandidatePath = path.join(privacyDirectory, 'candidate.json');
    const privacyReportPath = path.join(privacyDirectory, 'report.json');
    const privacyLivePath = path.join(privacyDirectory, 'live.json');
    fs.writeFileSync(privacyCandidatePath, privacyPrepared.serialized);
    fs.writeFileSync(
      privacyReportPath,
      `${JSON.stringify(privacyPrepared.report, null, 2)}\n`
    );
    fs.copyFileSync(privacySource.inputPath, privacyLivePath);
    const privacyOptions = {
      mode: 'apply',
      sourcePath: privacySource.inputPath,
      candidatePath: privacyCandidatePath,
      reportPath: privacyReportPath,
      liveDatabasePath: privacyLivePath,
      expectedSourceSha256: privacySource.sourceHash,
      expectedCandidateSha256:
        privacyPrepared.report.candidate_source_sha256,
      expectedSourceDomainSha256:
        privacyPrepared.report.source_public_qr_domain_sha256,
      expectedCandidateDomainSha256:
        privacyPrepared.report.candidate_public_qr_domain_sha256,
      expectedQrIds: Object.freeze(['QR_ACTIVATED_DIRECT']),
      expectedDatabase: String(process.env.PGDATABASE)
    };
    const privacyArtifacts = validateArtifacts(privacyOptions);
    const privacyApplied = await executeRemediation({
      options: privacyOptions,
      pool,
      artifacts: privacyArtifacts
    });
    assert.equal(privacyApplied.status, 'APPLIED');
    assert.equal(privacyApplied.postgres_applied, true);
    assert.equal(privacyApplied.json_applied, true);
    assert.equal(privacyApplied.reproof_jobs_enqueued, 1);
    const privacyRepeated = await executeRemediation({
      options: privacyOptions,
      pool,
      artifacts: privacyArtifacts
    });
    assert.equal(privacyRepeated.status, 'ALREADY_APPLIED');
    const privacyState = await pool.query(
      `SELECT
        (SELECT count(*) FROM app.import_runs
          WHERE source_sha256 = $1 AND status = 'passed') AS marker_count,
        (SELECT count(*) FROM app.import_runs
          WHERE source_sha256 = $2 AND status = 'blocked'
            AND checksum_summary ->> 'superseded_by_source_sha256' = $1)
          AS superseded_source_count,
        (SELECT count(*) FROM app.record_proofs
          WHERE record_qr_id = 'QR_ACTIVATED_DIRECT') AS proof_count,
        (SELECT count(*) FROM app.outbox_jobs
          WHERE aggregate_id = 'QR_ACTIVATED_DIRECT'
            AND job_type = 'record_proof_prepare_submit') AS outbox_count,
        (SELECT content FROM app.records
          WHERE qr_id = 'QR_ACTIVATED_DIRECT') AS revised_content`,
      [
        privacyPrepared.report.candidate_source_sha256,
        privacySource.sourceHash
      ]
    );
    assert.equal(Number(privacyState.rows[0].marker_count), 1);
    assert.equal(Number(privacyState.rows[0].superseded_source_count), 1);
    assert.equal(Number(privacyState.rows[0].proof_count), 0);
    assert.equal(Number(privacyState.rows[0].outbox_count), 1);
    assert.match(privacyState.rows[0].revised_content, /138\*\*\*\*0002/);
    assert.equal(
      privacyState.rows[0].revised_content.includes(privacyFixture.users[1].phone),
      false
    );

    const reproofOptions = Object.freeze({
      candidatePath: privacyCandidatePath,
      liveDatabasePath: privacyLivePath,
      candidateHash: privacyPrepared.report.candidate_source_sha256,
      candidateDomainHash:
        privacyPrepared.report.candidate_public_qr_domain_sha256,
      qrIds: Object.freeze(['QR_ACTIVATED_DIRECT']),
      expectedDatabase: String(process.env.PGDATABASE),
      maxSeconds: 5,
      pollMs: 1
    });
    const reproofCandidate = Object.freeze({
      source: JSON.parse(privacyPrepared.serialized),
      plan: privacyArtifacts.candidatePlan
    });
    const controlledProviderEnv = {
      CHAIN_ENABLED: 'true',
      CHAIN_CALLBACK_URL: 'https://fixture.invalid/callback',
      AVATA_API_KEY: 'fixture-key',
      AVATA_API_SECRET: 'fixture-secret',
      AVATA_IDENTITY_NAME: 'fixture-name',
      AVATA_IDENTITY_NUM: 'fixture-number'
    };
    let reproofSubmissions = 0;
    let reproofQueries = 0;
    const externalAdapterFactory = () => ({
      async prepareRecord({ record }) {
        return {
          manifest_hash: sha256(`privacy-manifest:${record.id}`),
          manifest_object_key: `records/${record.id}/privacy-manifest.json`,
          image_sha256: null,
          legacy_manifest_object_key: null,
          index_object_key: `indexes/by-star/${record.id}.json`
        };
      },
      async submitRecord(input) {
        reproofSubmissions += 1;
        return {
          status: 'submitted',
          operation_id: input.operation_id,
          transaction_hash: `privacy-tx-${input.record_qr_id}`,
          block_height: 801,
          provider_record_id: `privacy-provider-${input.record_qr_id}`,
          provider_certificate_url: null
        };
      },
      normalizeRecordResult(value) {
        return value;
      }
    });
    const runReproof = () => executeReproof({
      options: reproofOptions,
      pool,
      candidate: reproofCandidate,
      env: controlledProviderEnv,
      externalAdapterFactory,
      async queryProviderOperation(operationId) {
        reproofQueries += 1;
        return {
          status: 'confirmed',
          operation_id: operationId,
          transaction_hash: 'privacy-tx-QR_ACTIVATED_DIRECT',
          block_height: 801,
          provider_record_id: 'privacy-provider-QR_ACTIVATED_DIRECT',
          provider_certificate_url:
            'https://fixture.invalid/QR_ACTIVATED_DIRECT.pdf'
        };
      },
      wait: () => Promise.resolve()
    });
    const reproofPreflight = await preflightReproof({
      options: reproofOptions,
      pool,
      candidate: reproofCandidate,
      env: controlledProviderEnv
    });
    assert.deepEqual(reproofPreflight, {
      mode: 'preflight',
      status: 'READY',
      phase: 'CANDIDATE_READY',
      affected_qr_ids: ['QR_ACTIVATED_DIRECT'],
      external_calls: 'NONE',
      production_write: 'NONE'
    });
    const reproofCompleted = await runReproof();
    assert.equal(reproofCompleted.status, 'COMPLETED');
    assert.equal(reproofCompleted.final_marker_applied, true);
    assert.equal(reproofCompleted.final_json_applied, true);
    assert.equal(reproofSubmissions, 1);
    assert.equal(reproofQueries, 1);
    const finalPrivacySource = JSON.parse(fs.readFileSync(privacyLivePath, 'utf8'));
    const finalPrivacyQr = finalPrivacySource.qr_codes.find(
      (item) => item.id === 'QR_ACTIVATED_DIRECT'
    );
    assert.equal(finalPrivacyQr.chain_status, 'confirmed');
    assert.equal(
      finalPrivacyQr.chain_certificate_url,
      'https://fixture.invalid/QR_ACTIVATED_DIRECT.pdf'
    );
    assert.match(finalPrivacyQr.chain_proof_id, /^[0-9a-f-]{36}$/);
    const finalPrivacyState = await pool.query(
      `SELECT
         (SELECT count(*)::integer FROM app.import_runs
          WHERE source_sha256 = $1 AND status = 'passed'
            AND checksum_summary ->> 'verification_scope' =
              'public_qr_v1_and_operational_evidence_v1') AS final_marker_count,
         (SELECT count(*)::integer FROM app.import_runs
          WHERE source_sha256 = $2 AND status = 'blocked'
            AND checksum_summary ->> 'superseded_by_source_sha256' = $1)
           AS candidate_superseded_count,
         (SELECT count(*)::integer FROM app.proof_attempts attempt
          JOIN app.record_proofs proof ON proof.id = attempt.proof_id
          WHERE proof.record_qr_id = 'QR_ACTIVATED_DIRECT') AS attempt_count,
         (SELECT count(*)::integer FROM app.outbox_jobs
          WHERE aggregate_id = 'QR_ACTIVATED_DIRECT'
            AND status = 'succeeded') AS succeeded_job_count`,
      [
        reproofCompleted.final_source_sha256,
        privacyPrepared.report.candidate_source_sha256
      ]
    );
    assert.deepEqual(finalPrivacyState.rows, [{
      final_marker_count: 1,
      candidate_superseded_count: 1,
      attempt_count: 1,
      succeeded_job_count: 1
    }]);
    const reproofRepeated = await runReproof();
    assert.equal(reproofRepeated.status, 'ALREADY_COMPLETED');
    assert.equal(reproofRepeated.final_marker_applied, false);
    assert.equal(reproofRepeated.final_json_applied, false);
    assert.equal(reproofSubmissions, 1);
    assert.equal(reproofQueries, 1);
    const completedReproofPreflight = await preflightReproof({
      options: reproofOptions,
      pool,
      candidate: reproofCandidate,
      env: controlledProviderEnv
    });
    assert.equal(completedReproofPreflight.status, 'ALREADY_COMPLETED');
    assert.equal(completedReproofPreflight.phase, 'FINAL_COMPLETE');
    assert.equal(completedReproofPreflight.external_calls, 'NONE');
    assert.equal(completedReproofPreflight.production_write, 'NONE');

    await pool.query('DROP SCHEMA app CASCADE');
    const resetMigration = await runMigrations({ pool, apply: true, target: 'test' });
    assert.deepEqual(
      resetMigration.applied.map((item) => item.version),
      loadMigrations().map((item) => item.version)
    );
    const imported = await executeStagingImport({
      pool,
      snapshot: analysis.snapshot,
      report: analysis.report,
      plan: analysis.plan
    });
    assert.equal(imported.status, 'PASSED');
    assert.equal(imported.sequence_values.accounts, '4');

    const identityCandidate = await withTransaction(pool, async (transactionContext) => {
      const adapter = new IdentityReadAdapter({
        identityRepository: new IdentityRepository(transactionContext),
        accountRepository: new AccountRepository(transactionContext)
      });
      return {
        phone: await adapter.findExistingByPhone(` ${fixture.users[0].phone} `),
        openid: await adapter.findExistingByOpenid(` ${fixture.users[1].openid} `),
        authenticated: await adapter.getAuthenticatedIdentity({
          identityId: fixture.users[2].id,
          accountId: fixture.users[2].account_id,
          openid: fixture.users[2].openid
        }),
        missing: await adapter.getAuthenticatedIdentity({ identityId: 999999 })
      };
    }, { isolationLevel: 'repeatable read', readOnly: true });
    assert.deepEqual(
      {
        id: identityCandidate.phone.id,
        phone: identityCandidate.phone.phone,
        account_id: identityCandidate.phone.account_id
      },
      {
        id: fixture.users[0].id,
        phone: fixture.users[0].phone,
        account_id: fixture.users[0].account_id
      }
    );
    assert.equal(identityCandidate.openid.id, fixture.users[1].id);
    assert.equal(identityCandidate.openid.openid, fixture.users[1].openid);
    assert.equal(identityCandidate.authenticated.data.id, fixture.users[2].id);
    assert.deepEqual(identityCandidate.missing, { error: 'UNAUTHORIZED' });

    const identityWriteService = createIdentityWriteService({
      pool,
      clock: () => new Date('2026-07-01T12:00:00.000Z')
    });
    const concurrentWebIdentities = await Promise.all([
      identityWriteService.createOrGetWebIdentity({ phone: '13800000004' }),
      identityWriteService.createOrGetWebIdentity({ phone: '13800000004' })
    ]);
    assert.deepEqual(concurrentWebIdentities[0], concurrentWebIdentities[1]);
    assert.equal(concurrentWebIdentities[0].account_id, 'ACC000004');

    const temporaryMiniappIdentity = await identityWriteService.createOrGetMiniappIdentity({
      openid: 'openid-merge-fixture',
      unionid: 'unionid-merge-fixture'
    });
    assert.equal(temporaryMiniappIdentity.account_id, 'ACC000005');
    const mergedIdentity = await identityWriteService.bindMiniappPhone({
      openid: temporaryMiniappIdentity.openid,
      phone: concurrentWebIdentities[0].phone,
      unionid: temporaryMiniappIdentity.unionid
    });
    assert.equal(mergedIdentity.data.id, concurrentWebIdentities[0].id);
    assert.equal(mergedIdentity.data.account_id, 'ACC000004');
    assert.equal(mergedIdentity.data.openid, 'openid-merge-fixture');
    assert.equal(mergedIdentity.data.source, 'web+miniapp');

    const blockedWebIdentity = await identityWriteService.createOrGetWebIdentity({
      phone: '13800000005'
    });
    const referencedMiniappIdentity = await identityWriteService.createOrGetMiniappIdentity({
      openid: 'openid-reference-fixture'
    });
    await pool.query(
      `INSERT INTO app.orders
         (id, order_no, account_id, product_id, openid_snapshot, phone_snapshot,
          product_snapshot, quantity, unit_price_cents, total_amount_cents, status,
          payment_status, receiver_name, receiver_phone, region, address, created_at,
          updated_at)
       VALUES
         ('ORDER_IDENTITY_REFERENCE', 'ORDER-NO-IDENTITY-REFERENCE', $1, NULL, '', '',
          '{}'::jsonb, 1, 0, 0, 'cancelled', 'unpaid', '', '', '', '', $2, $2)`,
      [fixture.accounts[0].id, CREATED_AT]
    );
    await pool.query(
      `INSERT INTO app.payment_events
         (order_id, event_type, status, sanitized_metadata, created_at)
       VALUES
         ('ORDER_IDENTITY_REFERENCE', 'identity_reference_fixture', 'received',
          jsonb_build_object(
            'nested', jsonb_build_object('account_id', $1::text)
          ), $2)`,
      [referencedMiniappIdentity.account_id, CREATED_AT]
    );
    const referencedMerge = await identityWriteService.bindMiniappPhone({
      openid: referencedMiniappIdentity.openid,
      phone: blockedWebIdentity.phone
    });
    assert.deepEqual(referencedMerge, { error: 'MINIAPP_ACCOUNT_CONFLICT' });

    const identityWriteState = await pool.query(
      `SELECT
         (SELECT count(*)::integer FROM app.accounts) AS account_count,
         (SELECT count(*)::integer FROM app.users) AS identity_count,
         (SELECT count(*)::integer FROM app.users WHERE phone = $1) AS concurrent_phone_count,
         (SELECT count(*)::integer FROM app.accounts WHERE id = $2) AS merged_temp_account_count,
         (SELECT count(*)::integer FROM app.users WHERE openid = $3) AS referenced_identity_count`,
      [
        concurrentWebIdentities[0].phone,
        temporaryMiniappIdentity.account_id,
        referencedMiniappIdentity.openid
      ]
    );
    assert.deepEqual(identityWriteState.rows, [{
      account_count: 6,
      identity_count: 6,
      concurrent_phone_count: 1,
      merged_temp_account_count: 0,
      referenced_identity_count: 1
    }]);

    await pool.query(
      `INSERT INTO app.qr_codes
         (id, issue_status, lifecycle_status, access_token, created_at, updated_at)
       VALUES
         ('QR_WRITE_DIRECT', 'issued', 'unactivated', 'token-write-direct', $1, $1),
         ('QR_WRITE_CO', 'issued', 'unactivated', 'token-write-co', $1, $1)`,
      [CREATED_AT]
    );
    const qrWriteService = createQrLifecycleWriteService({
      pool,
      clock: () => new Date('2026-07-01T12:30:00.000Z')
    });
    assert.deepEqual(
      await qrWriteService.activateQRByKey('token-write-direct', {
        account_id: concurrentWebIdentities[0].account_id,
        phone: concurrentWebIdentities[0].phone,
        content: `Cross-account phone ${blockedWebIdentity.phone}`,
        image_url: 'https://fixture.invalid/privacy-rejected.jpg',
        show_brand_disclosure: false
      }),
      { error: 'CONTENT_PRIVACY_REJECTED' }
    );
    const directWrite = await qrWriteService.activateQRByKey('token-write-direct', {
      account_id: concurrentWebIdentities[0].account_id,
      phone: concurrentWebIdentities[0].phone,
      content: 'PostgreSQL direct write',
      image_url: 'https://fixture.invalid/write-direct.jpg',
      show_brand_disclosure: false
    });
    assert.equal(directWrite.data.qr.lifecycle_status, 'activated');
    assert.equal(directWrite.data.record.sealed_at.toISOString(), '2026-07-01T12:30:00.000Z');
    assert.deepEqual(
      await qrWriteService.activateQRByKey('token-write-direct', {
        account_id: concurrentWebIdentities[0].account_id
      }),
      { error: 'QR_ALREADY_ACTIVATED' }
    );

    const coWrite = await qrWriteService.startCoCreationByKey('token-write-co', {
      account_id: concurrentWebIdentities[0].account_id,
      phone: concurrentWebIdentities[0].phone,
      content: 'PostgreSQL co-creation write',
      image_url: 'https://fixture.invalid/write-co.jpg',
      show_brand_disclosure: false
    });
    assert.equal(coWrite.data.qr.lifecycle_status, 'co_creating');
    assert.deepEqual(
      await qrWriteService.addCoCreationCommentByKey('token-write-co', {
        account_id: blockedWebIdentity.account_id,
        phone: blockedWebIdentity.phone,
        authorName: 'Integration witness',
        content: `Cross-account phone ${concurrentWebIdentities[0].phone}`
      }),
      { error: 'CONTENT_PRIVACY_REJECTED' }
    );
    const commentWrite = await qrWriteService.addCoCreationCommentByKey(
      'token-write-co',
      {
        account_id: blockedWebIdentity.account_id,
        phone: blockedWebIdentity.phone,
        authorName: 'Integration witness',
        content: 'PostgreSQL comment write'
      }
    );
    assert.equal(commentWrite.data.comment.source_position, 0);
    assert.deepEqual(
      await qrWriteService.addCoCreationCommentByKey('token-write-co', {
        account_id: blockedWebIdentity.account_id,
        content: 'Duplicate comment'
      }),
      { error: 'CO_CREATION_COMMENT_EXISTS' }
    );
    assert.deepEqual(
      await qrWriteService.deleteCoCreationCommentByKey('token-write-co', {
        account_id: blockedWebIdentity.account_id,
        commentId: commentWrite.data.comment.id
      }),
      { error: 'FORBIDDEN' }
    );
    const deletedWrite = await qrWriteService.deleteCoCreationCommentByKey(
      'token-write-co',
      {
        account_id: concurrentWebIdentities[0].account_id,
        commentId: commentWrite.data.comment.id
      }
    );
    assert.equal(deletedWrite.data.comment.status, 'deleted');
    const replacementWrite = await qrWriteService.addCoCreationCommentByKey(
      'token-write-co',
      {
        account_id: blockedWebIdentity.account_id,
        authorName: 'Integration witness',
        content: 'Replacement comment'
      }
    );
    assert.equal(replacementWrite.data.comment.source_position, 1);
    const finalizedWrite = await qrWriteService.finalizeCoCreationByKey(
      'token-write-co',
      { account_id: concurrentWebIdentities[0].account_id }
    );
    assert.equal(finalizedWrite.data.qr.lifecycle_status, 'activated');
    assert.equal(finalizedWrite.data.co_creation.status, 'finalized');

    const routeLifecycleWriteState = await pool.query(
      `SELECT
         (SELECT count(*)::integer FROM app.qr_codes
          WHERE id IN ('QR_WRITE_DIRECT', 'QR_WRITE_CO')
            AND lifecycle_status = 'activated') AS activated_qr_count,
         (SELECT count(*)::integer FROM app.records
          WHERE qr_id IN ('QR_WRITE_DIRECT', 'QR_WRITE_CO')
            AND sealed_at IS NOT NULL) AS sealed_record_count,
         (SELECT count(*)::integer FROM app.co_creations
          WHERE qr_id = 'QR_WRITE_CO' AND status = 'finalized') AS finalized_creation_count,
         (SELECT count(*)::integer FROM app.co_creation_comments comment
          JOIN app.co_creations creation ON creation.id = comment.co_creation_id
          WHERE creation.qr_id = 'QR_WRITE_CO' AND comment.status = 'kept') AS kept_comment_count,
         (SELECT max(comment.source_position)::integer
          FROM app.co_creation_comments comment
          JOIN app.co_creations creation ON creation.id = comment.co_creation_id
          WHERE creation.qr_id = 'QR_WRITE_CO') AS maximum_comment_position,
         (SELECT count(*)::integer FROM app.outbox_jobs
          WHERE job_type = 'record_proof_prepare_submit'
            AND aggregate_id IN ('QR_WRITE_DIRECT', 'QR_WRITE_CO')
            AND status = 'pending') AS pending_proof_job_count,
         (SELECT count(DISTINCT idempotency_key)::integer FROM app.outbox_jobs
          WHERE aggregate_id IN ('QR_WRITE_DIRECT', 'QR_WRITE_CO')) AS proof_job_key_count`
    );
    assert.deepEqual(routeLifecycleWriteState.rows, [{
      activated_qr_count: 2,
      sealed_record_count: 2,
      finalized_creation_count: 1,
      kept_comment_count: 1,
      maximum_comment_position: 1,
      pending_proof_job_count: 2,
      proof_job_key_count: 2
    }]);

    await pool.query(
      `INSERT INTO app.outbox_jobs
         (id, job_type, aggregate_type, aggregate_id, idempotency_key,
          payload, status, attempt_count, available_at, locked_at, locked_by,
          last_error, created_at, updated_at)
       VALUES
         ('00000000-0000-0000-0000-000000000990',
          'record_proof_prepare_submit', 'record', 'QR_OUTSIDE_SCOPE',
          'record-proof:QR_OUTSIDE_SCOPE',
          '{"record_qr_id":"QR_OUTSIDE_SCOPE"}'::jsonb,
          'pending', 0, $1, NULL, NULL, '', $1, $1)`,
      [CREATED_AT]
    );

    const handledProofJobs = [];
    const recordProofJobHandler = createRecordProofJobHandler({
      pool,
      clock: () => new Date('2026-07-01T12:31:30.000Z'),
      async prepareRecord({ record }) {
        handledProofJobs.push(record.id);
        return {
          manifest_hash: sha256(`manifest:${record.id}`),
          manifest_object_key: `records/${record.id}/record_manifest.json`,
          image_sha256: null,
          index_object_key: `indexes/by-star/${record.id}.json`
        };
      },
      async submitRecord(input) {
        return {
          status: input.record_qr_id === 'QR_WRITE_DIRECT'
            ? 'confirmed'
            : 'submitted',
          transaction_hash: `tx-${input.record_qr_id}`,
          block_height: input.record_qr_id === 'QR_WRITE_DIRECT' ? 101 : 102,
          provider_record_id: `provider-${input.record_qr_id}`
        };
      }
    });
    const outboxWorker = createOutboxWorker({
      pool,
      workerId: 'integration-outbox-worker',
      jobTypes: ['record_proof_prepare_submit'],
      aggregateIds: ['QR_WRITE_CO', 'QR_WRITE_DIRECT'],
      clock: () => new Date('2026-07-01T12:31:00.000Z'),
      handlers: {
        record_proof_prepare_submit: recordProofJobHandler
      }
    });
    assert.deepEqual(await outboxWorker.runOnce(), {
      recovered: 0,
      claimed: 2,
      succeeded: 2,
      retried: 0,
      failed: 0
    });
    assert.deepEqual(handledProofJobs.sort(), ['QR_WRITE_CO', 'QR_WRITE_DIRECT']);
    const proofResultService = createRecordProofResultService({
      pool,
      normalizeProviderResult: (value) => value,
      allowedRecordQrIds: ['QR_WRITE_CO', 'QR_WRITE_DIRECT'],
      clock: () => new Date('2026-07-01T12:32:00.000Z')
    });
    assert.deepEqual(await proofResultService.applyCallback({
      status: 'confirmed',
      operation_id: `record_QR_WRITE_CO_${sha256('manifest:QR_WRITE_CO').slice(0, 16)}`,
      transaction_hash: 'tx-QR_WRITE_CO',
      block_height: 102,
      provider_record_id: 'provider-QR_WRITE_CO',
      provider_certificate_url: 'https://fixture.invalid/QR_WRITE_CO.pdf'
    }), {
      outcome: 'applied',
      status: 'confirmed'
    });
    assert.deepEqual(await proofResultService.applyCallback({
      status: 'confirmed',
      operation_id: `record_QR_WRITE_CO_${sha256('manifest:QR_WRITE_CO').slice(0, 16)}`,
      transaction_hash: 'tx-QR_WRITE_CO',
      block_height: 102,
      provider_record_id: 'provider-QR_WRITE_CO',
      provider_certificate_url: 'https://fixture.invalid/QR_WRITE_CO.pdf'
    }), {
      outcome: 'duplicate',
      status: 'confirmed'
    });
    const completedOutboxState = await pool.query(
      `SELECT
         count(*) FILTER (WHERE status = 'succeeded')::integer AS succeeded_job_count,
         count(*) FILTER (WHERE locked_at IS NOT NULL OR locked_by IS NOT NULL)::integer
           AS locked_job_count,
         min(attempt_count)::integer AS minimum_attempt_count,
         max(attempt_count)::integer AS maximum_attempt_count
       FROM app.outbox_jobs
       WHERE aggregate_id IN ('QR_WRITE_DIRECT', 'QR_WRITE_CO')`
    );
    assert.deepEqual(completedOutboxState.rows, [{
      succeeded_job_count: 2,
      locked_job_count: 0,
      minimum_attempt_count: 1,
      maximum_attempt_count: 1
    }]);
    const outsideScopeOutboxState = await pool.query(
      `SELECT status, attempt_count, locked_at, locked_by
       FROM app.outbox_jobs
       WHERE aggregate_id = 'QR_OUTSIDE_SCOPE'`
    );
    assert.deepEqual(outsideScopeOutboxState.rows, [{
      status: 'pending',
      attempt_count: 0,
      locked_at: null,
      locked_by: null
    }]);
    await pool.query(
      "DELETE FROM app.outbox_jobs WHERE aggregate_id = 'QR_OUTSIDE_SCOPE'"
    );
    const completedProofState = await pool.query(
      `SELECT
         (SELECT count(*)::integer FROM app.record_proofs
          WHERE record_qr_id IN ('QR_WRITE_DIRECT', 'QR_WRITE_CO')
            AND status = 'confirmed' AND retry_count = 1) AS confirmed_proof_count,
         (SELECT count(*)::integer FROM app.proof_attempts attempt
          JOIN app.record_proofs proof ON proof.id = attempt.proof_id
          WHERE proof.record_qr_id IN ('QR_WRITE_DIRECT', 'QR_WRITE_CO')
            AND attempt.request_state = 'sent'
            AND attempt.result_status = 'succeeded') AS succeeded_attempt_count,
         (SELECT count(*)::integer FROM app.record_archives
          WHERE record_qr_id IN ('QR_WRITE_DIRECT', 'QR_WRITE_CO')
            AND status = 'ready') AS ready_archive_count,
         (SELECT count(DISTINCT operation_id)::integer FROM app.record_proofs
          WHERE record_qr_id IN ('QR_WRITE_DIRECT', 'QR_WRITE_CO')) AS operation_count,
         (SELECT count(*)::integer FROM app.record_proofs
          WHERE record_qr_id = 'QR_WRITE_CO'
            AND callback_received_at IS NOT NULL
            AND provider_certificate_url =
              'https://fixture.invalid/QR_WRITE_CO.pdf') AS callback_proof_count`
    );
    assert.deepEqual(completedProofState.rows, [{
      confirmed_proof_count: 2,
      succeeded_attempt_count: 2,
      ready_archive_count: 2,
      operation_count: 2,
      callback_proof_count: 1
    }]);

    const shadowDirectory = path.join(directory, 'direct-shadow');
    shadowRuntime = createPublicQrShadowRuntime({
      enabled: true,
      allowlist: new Set([
        'QR_UNACTIVATED',
        'QR_CO_CREATING',
        'QR_ACTIVATED_DIRECT',
        'QR_ACTIVATED_COMMENTS'
      ]),
      logDirectory: shadowDirectory,
      timeoutMs: 250,
      maxConcurrency: 2,
      maxLogBytes: 5 * 1024 * 1024,
      retentionDays: 14,
      queueLimit: 100
    }, { env: process.env });

    Object.assign(process.env, {
      RECORD_PROOF_RUNTIME_ENABLED: 'true',
      RECORD_PROOF_RUNTIME_ALLOWLIST: 'QR_WRITE_DIRECT',
      RECORD_PROOF_RUNTIME_SOURCE_SHA256: source.sourceHash,
      RECORD_PROOF_RUNTIME_DOMAIN_SHA256: publicQrDomainHash,
      RECORD_PROOF_WORKER_ID: 'proof-runtime-route-integration',
      RECORD_PROOF_WORKER_INTERVAL_MS: '300000',
      CHAIN_ENABLED: 'true',
      CHAIN_CALLBACK_URL: 'https://example.test/api/chain/avata/callback',
      AVATA_API_KEY: 'proof-runtime-route-key',
      AVATA_API_SECRET: 'proof-runtime-route-secret',
      AVATA_IDENTITY_NAME: 'proof-runtime-route-name',
      AVATA_IDENTITY_NUM: 'proof-runtime-route-number'
    });

    const { createApp } = require('../src/server/app');
    ({ server, port } = await startServer(createApp()));

    const routeCallbackBody = {
      operation_id:
        `record_QR_WRITE_DIRECT_${sha256('manifest:QR_WRITE_DIRECT').slice(0, 16)}`,
      status: 1,
      tx_hash: 'tx-QR_WRITE_DIRECT',
      block_height: 101,
      record: {
        record_id: 'provider-QR_WRITE_DIRECT',
        certificate_url: 'https://fixture.invalid/QR_WRITE_DIRECT.pdf'
      }
    };
    const callbackTimestamp = String(Date.now());
    const callbackSignature = signRequest({
      path: '/api/chain/avata/callback',
      body: routeCallbackBody,
      timestamp: callbackTimestamp,
      apiSecret: process.env.AVATA_API_SECRET
    });
    const temporaryJsonHashBefore = sha256(fs.readFileSync(process.env.DB_FILE));
    global.fetch = async () => {
      externalFetchCalls += 1;
      throw new Error('EXTERNAL_FETCH_FORBIDDEN_IN_INTEGRATION');
    };
    const routeCallbackResponse = await postRaw(
      port,
      '/api/chain/avata/callback',
      routeCallbackBody,
      {
        'X-Api-Key': process.env.AVATA_API_KEY,
        'X-Timestamp': callbackTimestamp,
        'X-Signature': callbackSignature
      }
    );
    assert.deepEqual(routeCallbackResponse, { status: 200, raw: 'SUCCESS' });
    assert.equal(externalFetchCalls, 0);
    assert.equal(
      sha256(fs.readFileSync(process.env.DB_FILE)),
      temporaryJsonHashBefore
    );
    const routedProofResult = await pool.query(
      `SELECT provider_certificate_url,
              callback_received_at IS NOT NULL AS callback_received
       FROM app.record_proofs
       WHERE record_qr_id = 'QR_WRITE_DIRECT'`
    );
    assert.deepEqual(routedProofResult.rows, [{
      provider_certificate_url: 'https://fixture.invalid/QR_WRITE_DIRECT.pdf',
      callback_received: true
    }]);
    const owner = fixture.users[1];
    const participant = fixture.users[1];
    const ownerToken = generateMiniappToken(owner);
    const participantToken = generateMiniappToken(participant);
    const personalOwner = fixture.users[0];
    const personalOwnerToken = generateMiniappToken(personalOwner);
    const personalOwnerSession = createSession({
      userId: personalOwner.id,
      phone: personalOwner.phone,
      accountId: personalOwner.account_id
    });
    const personalOwnerCookie = `${getCookieName()}=${personalOwnerSession.sid}`;

    const jsonHashBeforeAllScopeRoutes = sha256(
      fs.readFileSync(process.env.DB_FILE)
    );
    delete process.env.PUBLIC_QR_POSTGRES_READ_ALLOWLIST;
    delete process.env.QR_LIFECYCLE_POSTGRES_WRITE_ALLOWLIST;
    delete process.env.PERSONAL_RECORD_POSTGRES_READ_ALLOWLIST;
    Object.assign(process.env, {
      PUBLIC_QR_POSTGRES_READ_ENABLED: 'true',
      PUBLIC_QR_POSTGRES_READ_SCOPE: 'all',
      PUBLIC_QR_POSTGRES_READ_DOMAIN_SHA256: publicQrDomainHash,
      QR_LIFECYCLE_POSTGRES_WRITE_ENABLED: 'true',
      QR_LIFECYCLE_POSTGRES_WRITE_SCOPE: 'all',
      QR_LIFECYCLE_POSTGRES_WRITE_DOMAIN_SHA256: publicQrDomainHash,
      PERSONAL_RECORD_POSTGRES_READ_ENABLED: 'true',
      PERSONAL_RECORD_POSTGRES_READ_SCOPE: 'all',
      PERSONAL_RECORD_POSTGRES_READ_DOMAIN_SHA256: publicQrDomainHash,
      IDENTITY_POSTGRES_AUTHORITY_ENABLED: 'true',
      IDENTITY_POSTGRES_AUTHORITY_SCOPE: 'all',
      IDENTITY_POSTGRES_AUTHORITY_SOURCE_SHA256: source.sourceHash,
      IDENTITY_POSTGRES_AUTHORITY_DOMAIN_SHA256: publicQrDomainHash,
      QR_ISSUANCE_POSTGRES_AUTHORITY_ENABLED: 'true',
      QR_ISSUANCE_POSTGRES_AUTHORITY_SCOPE: 'all',
      QR_ISSUANCE_POSTGRES_AUTHORITY_SOURCE_SHA256: source.sourceHash,
      QR_ISSUANCE_POSTGRES_AUTHORITY_DOMAIN_SHA256: publicQrDomainHash,
      QR_ISSUANCE_TEST_IMAGE_DIR: path.join(directory, 'qrcodes'),
      MINIAPP_MOCK_ENABLED: 'true'
    });

    const adminToken = generateToken({
      id: 1,
      username: 'integration-admin',
      role: 'admin',
      name: 'Integration admin'
    });
    const issuanceResponse = await postRaw(
      port,
      '/api/admin/qr/generate',
      { prefix: 'PGSCOPE', count: 1 },
      { Authorization: `Bearer ${adminToken}` }
    );
    assert.equal(issuanceResponse.status, 200);
    const issued = JSON.parse(issuanceResponse.raw).data.records[0];
    assert.equal(issued.id, 'PGSCOPE00001');
    assert.equal(issued.issue_status, 'issued');
    assert.equal(issued.activation_status, 'unactivated');
    assert.equal(issued.qr_access_token.length, 32);
    const allScopeQrId = issued.id;
    const allScopeAccessToken = issued.qr_access_token;
    const issuedImage = await requestBuffer(
      port,
      `/api/qr/image/${allScopeAccessToken}`
    );
    assert.equal(issuedImage.status, 200);
    assert.equal(issuedImage.headers['content-type'], 'image/png');
    assert.ok(issuedImage.body.length > 0);

    const postgresOnlyPhone = '13900000991';
    const h5IdentityLogin = await postRaw(
      port,
      '/api/user/login',
      { phone: postgresOnlyPhone },
      {},
      true
    );
    assert.equal(h5IdentityLogin.status, 200);
    const h5IdentityCookie = String(
      h5IdentityLogin.headers['set-cookie'][0] || ''
    ).split(';')[0];
    assert.match(h5IdentityCookie, /^user_session_id=/);
    const h5IdentityMe = await requestJson(
      port,
      '/api/user/me',
      '',
      { Cookie: h5IdentityCookie }
    );
    assert.equal(h5IdentityMe.status, 200);
    assert.equal(h5IdentityMe.body.data.phone, postgresOnlyPhone);

    const miniappIdentityLogin = await postRaw(
      port,
      '/api/miniapp/auth/login',
      { code: 'postgres-only-identity' }
    );
    assert.equal(miniappIdentityLogin.status, 200);
    const temporaryMiniappToken = JSON.parse(miniappIdentityLogin.raw).data.token;
    const miniappIdentityBind = await postRaw(
      port,
      '/api/miniapp/auth/bind-phone',
      { code: postgresOnlyPhone },
      { Authorization: `Bearer ${temporaryMiniappToken}` }
    );
    assert.equal(miniappIdentityBind.status, 200);
    const mergedMiniappToken = JSON.parse(miniappIdentityBind.raw).data.token;
    const postgresIdentityState = await pool.query(
      `SELECT legacy_id, account_id, phone, openid, source
       FROM app.users
       WHERE phone = $1 OR openid = $2
       ORDER BY id`,
      [postgresOnlyPhone, 'mock-openid-postgres-only-identity']
    );
    assert.equal(postgresIdentityState.rows.length, 1);
    assert.equal(postgresIdentityState.rows[0].legacy_id, null);
    assert.equal(postgresIdentityState.rows[0].phone, postgresOnlyPhone);
    assert.equal(
      postgresIdentityState.rows[0].openid,
      'mock-openid-postgres-only-identity'
    );
    assert.equal(postgresIdentityState.rows[0].source, 'web+miniapp');
    const postgresOnlyAccountId = postgresIdentityState.rows[0].account_id;
    assert.equal(
      fixture.users.some((item) => (
        item.phone === postgresOnlyPhone
        || item.openid === 'mock-openid-postgres-only-identity'
      )),
      false
    );

    const allScopeWriteResponse = await postRaw(
      port,
      `/api/qr/${allScopeAccessToken}/record`,
      {
        content: 'PostgreSQL-only all-scope route content',
        image_object_key: 'records/scope-all-route.jpg'
      },
      { Cookie: h5IdentityCookie }
    );
    assert.equal(allScopeWriteResponse.status, 200);
    const allScopeWriteBody = JSON.parse(allScopeWriteResponse.raw);
    assert.equal(allScopeWriteBody.data.id, allScopeQrId);
    assert.equal(allScopeWriteBody.data.activation_status, 'activated');
    assert.equal(
      allScopeWriteBody.data.content,
      'PostgreSQL-only all-scope route content'
    );

    for (const requestPath of [
      `/api/qr/${allScopeAccessToken}`,
      `/api/miniapp/qr/${allScopeAccessToken}`
    ]) {
      const response = await requestJson(port, requestPath);
      assert.equal(response.status, 200);
      assert.equal(response.body.data.id, allScopeQrId);
      assert.equal(
        response.body.data.content,
        'PostgreSQL-only all-scope route content'
      );
    }

    const allScopePersonalCases = [
      {
        path: '/api/user/records',
        token: '',
        headers: { Cookie: h5IdentityCookie },
        detail: false
      },
      {
        path: `/api/user/records/${allScopeQrId}`,
        token: '',
        headers: { Cookie: h5IdentityCookie },
        detail: true
      },
      {
        path: '/api/miniapp/user/records',
        token: mergedMiniappToken,
        headers: {},
        detail: false
      },
      {
        path: `/api/miniapp/user/records/${allScopeQrId}`,
        token: mergedMiniappToken,
        headers: {},
        detail: true
      }
    ];
    for (const current of allScopePersonalCases) {
      const response = await requestJson(
        port,
        current.path,
        current.token,
        current.headers
      );
      assert.equal(response.status, 200);
      const record = current.detail
        ? response.body.data
        : response.body.data.records.find(
          (item) => item.id === allScopeQrId
        );
      assert.ok(record);
      assert.equal(record.id, allScopeQrId);
      assert.equal(record.content, 'PostgreSQL-only all-scope route content');
    }

    const allScopeDatabaseState = await pool.query(
      `SELECT
         (SELECT lifecycle_status FROM app.qr_codes
          WHERE id = $1) AS lifecycle_status,
         (SELECT count(*)::integer FROM app.records
          WHERE qr_id = $1) AS record_count,
         (SELECT count(*)::integer FROM app.outbox_jobs
          WHERE aggregate_id = $1
            AND job_type = 'record_proof_prepare_submit') AS outbox_count`,
      [allScopeQrId]
    );
    assert.deepEqual(allScopeDatabaseState.rows, [{
      lifecycle_status: 'activated',
      record_count: 1,
      outbox_count: 1
    }]);
    assert.equal(
      sha256(fs.readFileSync(process.env.DB_FILE)),
      jsonHashBeforeAllScopeRoutes
    );

    const stableProofEnv = {
      ...process.env,
      RECORD_PROOF_RUNTIME_ENABLED: 'true',
      RECORD_PROOF_RUNTIME_SCOPE: 'all',
      RECORD_PROOF_RUNTIME_ALLOWLIST: '',
      RECORD_PROOF_RUNTIME_SOURCE_SHA256: source.sourceHash,
      RECORD_PROOF_RUNTIME_DOMAIN_SHA256: publicQrDomainHash,
      RECORD_PROOF_WORKER_ID: 'stable-proof-runtime-integration'
    };
    const stableProofConfig = readRecordProofRuntimeConfig(stableProofEnv);
    assert.equal(stableProofConfig.enabled, true);
    assert.equal(stableProofConfig.scope, 'all');
    stableProofRuntime = createRecordProofRuntime(stableProofConfig, {
      env: stableProofEnv,
      externalAdapterFactory: () => ({
        async prepareRecord({ record }) {
          return {
            manifest_hash: sha256(`stable-manifest:${record.id}`),
            manifest_object_key: `records/${record.id}/record_manifest.json`,
            image_sha256: null,
            index_object_key: `indexes/by-star/${record.id}.json`
          };
        },
        async submitRecord(input) {
          return {
            status: 'confirmed',
            transaction_hash: `stable-tx-${input.record_qr_id}`,
            block_height: 201,
            provider_record_id: `stable-provider-${input.record_qr_id}`,
            confirmed_at: '2026-08-12T02:00:00.000Z'
          };
        },
        normalizeRecordResult: (value) => value
      })
    });
    assert.deepEqual(await stableProofRuntime.runOnce(), {
      recovered: 0,
      claimed: 1,
      succeeded: 1,
      retried: 0,
      failed: 0
    });
    const stableProofStatus = await stableProofRuntime.status();
    assert.equal(stableProofStatus.scope, 'all');
    assert.equal(stableProofStatus.healthy, true);
    assert.deepEqual(stableProofStatus.outbox, {
      pending: 0,
      ready: 0,
      processing: 0,
      stale_processing: 0,
      failed: 0,
      succeeded: 3,
      maximum_attempt_count: 1
    });
    const stableProofState = await pool.query(
      `SELECT
         (SELECT status FROM app.outbox_jobs
          WHERE aggregate_id = $1) AS outbox_status,
         (SELECT status FROM app.record_proofs
          WHERE record_qr_id = $1) AS proof_status,
         (SELECT count(*)::integer FROM app.proof_attempts attempt
          JOIN app.record_proofs proof ON proof.id = attempt.proof_id
          WHERE proof.record_qr_id = $1
            AND attempt.result_status = 'succeeded') AS succeeded_attempt_count`,
      [allScopeQrId]
    );
    assert.deepEqual(stableProofState.rows, [{
      outbox_status: 'succeeded',
      proof_status: 'confirmed',
      succeeded_attempt_count: 1
    }]);
    await stableProofRuntime.close();
    stableProofRuntime = null;

    process.env.PUBLIC_QR_POSTGRES_READ_ENABLED = 'false';
    process.env.QR_LIFECYCLE_POSTGRES_WRITE_ENABLED = 'false';
    process.env.PERSONAL_RECORD_POSTGRES_READ_ENABLED = 'false';
    process.env.IDENTITY_POSTGRES_AUTHORITY_ENABLED = 'false';
    process.env.QR_ISSUANCE_POSTGRES_AUTHORITY_ENABLED = 'false';
    await pool.query(
      `DELETE FROM app.proof_attempts
       WHERE proof_id IN (
         SELECT id FROM app.record_proofs WHERE record_qr_id = $1
       )`,
      [allScopeQrId]
    );
    await pool.query(
      'DELETE FROM app.record_archives WHERE record_qr_id = $1',
      [allScopeQrId]
    );
    await pool.query(
      'DELETE FROM app.record_proofs WHERE record_qr_id = $1',
      [allScopeQrId]
    );
    await pool.query(
      'DELETE FROM app.outbox_jobs WHERE aggregate_id = $1',
      [allScopeQrId]
    );
    await pool.query('DELETE FROM app.records WHERE qr_id = $1', [allScopeQrId]);
    await pool.query('DELETE FROM app.qr_codes WHERE id = $1', [allScopeQrId]);
    await pool.query('DELETE FROM app.users WHERE account_id = $1', [postgresOnlyAccountId]);
    await pool.query('DELETE FROM app.accounts WHERE id = $1', [postgresOnlyAccountId]);

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

    let mismatchCount = 0;
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
      const observed = await shadowRuntime.observer.observe({
        channel: current.channel,
        endpointTemplate: current.channel === 'miniapp'
          ? '/api/miniapp/qr/:key'
          : '/api/qr/:qrId',
        key: current.key,
        publicQrId: baselineResponse.body.data.id,
        viewer: current.viewer,
        baselineDto: baselineResponse.body.data,
        sourceHash: source.sourceHash,
        assetResolver: createPublicQrAssetResolver()
      });
      assert.equal(observed.outcome, 'MATCH', `${current.label}: ${JSON.stringify(observed)}`);
      mismatchCount += Number(observed.mismatchCount || 0);
    }
    assert.equal(mismatchCount, 0);

    const jsonHashBeforePrimaryRead = sha256(fs.readFileSync(process.env.DB_FILE));
    await pool.query(
      'UPDATE app.records SET content = $2 WHERE qr_id = $1',
      ['QR_ACTIVATED_DIRECT', 'PostgreSQL primary-only route content']
    );
    Object.assign(process.env, {
      PUBLIC_QR_POSTGRES_READ_ENABLED: 'true',
      PUBLIC_QR_POSTGRES_READ_SCOPE: 'allowlist',
      PUBLIC_QR_POSTGRES_READ_ALLOWLIST: 'QR_ACTIVATED_DIRECT',
      PUBLIC_QR_POSTGRES_READ_DOMAIN_SHA256: publicQrDomainHash
    });

    const selectedPrimaryRead = await requestJson(
      port,
      '/api/qr/token-qr_activated_direct'
    );
    assert.equal(selectedPrimaryRead.status, 200);
    assert.equal(
      selectedPrimaryRead.body.data.content,
      'PostgreSQL primary-only route content'
    );

    const unselectedJsonRead = await requestJson(
      port,
      '/api/qr/token-qr_activated_comments'
    );
    assert.equal(unselectedJsonRead.status, 200);
    assert.equal(unselectedJsonRead.body.data.content, 'Comment ordering fixture');

    process.env.PUBLIC_QR_POSTGRES_READ_DOMAIN_SHA256 = 'f'.repeat(64);
    const stalePrimaryRead = await requestJson(
      port,
      '/api/qr/token-qr_activated_direct'
    );
    assert.equal(stalePrimaryRead.status, 503);
    assert.equal(stalePrimaryRead.body.code, 'PUBLIC_QR_READ_UNAVAILABLE');

    process.env.PUBLIC_QR_POSTGRES_READ_ENABLED = 'false';
    const disabledJsonRead = await requestJson(
      port,
      '/api/qr/token-qr_activated_direct'
    );
    assert.equal(disabledJsonRead.status, 200);
    assert.equal(disabledJsonRead.body.data.content, 'Activated fixture');
    assert.equal(
      sha256(fs.readFileSync(process.env.DB_FILE)),
      jsonHashBeforePrimaryRead
    );
    await closePublicQrPrimaryReadRuntime();
    await pool.query(
      'UPDATE app.records SET content = $2 WHERE qr_id = $1',
      ['QR_ACTIVATED_DIRECT', 'Activated fixture']
    );

    const lifecycleWriter = fixture.users[1];
    const lifecycleWriterSession = createSession({
      userId: lifecycleWriter.id,
      phone: lifecycleWriter.phone,
      accountId: lifecycleWriter.account_id
    });
    const lifecycleWriterCookie = `${getCookieName()}=${lifecycleWriterSession.sid}`;
    const jsonHashBeforeLifecycleWrite = sha256(fs.readFileSync(process.env.DB_FILE));
    Object.assign(process.env, {
      QR_LIFECYCLE_POSTGRES_WRITE_ENABLED: 'true',
      QR_LIFECYCLE_POSTGRES_WRITE_SCOPE: 'allowlist',
      QR_LIFECYCLE_POSTGRES_WRITE_ALLOWLIST: 'QR_UNACTIVATED',
      QR_LIFECYCLE_POSTGRES_WRITE_DOMAIN_SHA256: publicQrDomainHash
    });

    const lifecycleWriteResponse = await postRaw(
      port,
      '/api/qr/token-qr_unactivated/record',
      {
        content: 'PostgreSQL route activation',
        image_object_key: 'records/route-activation.jpg'
      },
      { Cookie: lifecycleWriterCookie }
    );
    assert.equal(lifecycleWriteResponse.status, 200);
    const lifecycleWriteBody = JSON.parse(lifecycleWriteResponse.raw);
    assert.equal(lifecycleWriteBody.data.id, 'QR_UNACTIVATED');
    assert.equal(lifecycleWriteBody.data.activation_status, 'activated');
    assert.equal(
      sha256(fs.readFileSync(process.env.DB_FILE)),
      jsonHashBeforeLifecycleWrite
    );
    const lifecycleWriteState = await pool.query(
      `SELECT
        (SELECT lifecycle_status FROM app.qr_codes
          WHERE id = 'QR_UNACTIVATED') AS lifecycle_status,
        (SELECT count(*)::integer FROM app.records
          WHERE qr_id = 'QR_UNACTIVATED') AS record_count,
        (SELECT count(*)::integer FROM app.outbox_jobs
          WHERE aggregate_id = 'QR_UNACTIVATED'
            AND job_type = 'record_proof_prepare_submit') AS outbox_count`
    );
    assert.deepEqual(lifecycleWriteState.rows, [{
      lifecycle_status: 'activated',
      record_count: 1,
      outbox_count: 1
    }]);

    process.env.QR_LIFECYCLE_POSTGRES_WRITE_ENABLED = 'false';
    await closeQrLifecycleWriteRuntime();
    await pool.query(
      "DELETE FROM app.outbox_jobs WHERE aggregate_id = 'QR_UNACTIVATED'"
    );
    await pool.query(
      "DELETE FROM app.records WHERE qr_id = 'QR_UNACTIVATED'"
    );
    await pool.query(
      `UPDATE app.qr_codes
       SET lifecycle_status = 'unactivated', updated_at = $1
       WHERE id = 'QR_UNACTIVATED'`,
      [CREATED_AT]
    );

    const personalListBaseline = await requestJson(
      port,
      '/api/miniapp/user/records',
      personalOwnerToken
    );
    assert.equal(personalListBaseline.status, 200);
    const personalListCandidate = await readPersonalCandidate(pool, {
      readKind: 'list',
      accountId: personalOwner.account_id,
      channel: 'miniapp'
    });
    assertDtoMatch(
      'miniapp personal record list',
      personalListBaseline.body.data,
      personalListCandidate,
      'miniapp'
    );

    const personalDetailBaseline = await requestJson(
      port,
      '/api/miniapp/user/records/QR_ACTIVATED_COMMENTS',
      personalOwnerToken
    );
    assert.equal(personalDetailBaseline.status, 200);
    const personalDetailCandidate = await readPersonalCandidate(pool, {
      readKind: 'detail',
      accountId: personalOwner.account_id,
      recordId: 'QR_ACTIVATED_COMMENTS',
      channel: 'miniapp'
    });
    assertDtoMatch(
      'miniapp personal record detail',
      personalDetailBaseline.body.data,
      personalDetailCandidate,
      'miniapp'
    );

    const h5PersonalListBaseline = await requestJson(
      port,
      '/api/user/records',
      '',
      { Cookie: personalOwnerCookie }
    );
    assert.equal(h5PersonalListBaseline.status, 200);
    const h5PersonalListCandidate = await readPersonalCandidate(pool, {
      readKind: 'list',
      accountId: personalOwner.account_id,
      channel: 'h5'
    });
    assertDtoMatch(
      'h5 personal record list',
      h5PersonalListBaseline.body.data,
      h5PersonalListCandidate,
      'h5'
    );

    const h5PersonalDetailBaseline = await requestJson(
      port,
      '/api/user/records/QR_ACTIVATED_COMMENTS',
      '',
      { Cookie: personalOwnerCookie }
    );
    assert.equal(h5PersonalDetailBaseline.status, 200);
    const h5PersonalDetailCandidate = await readPersonalCandidate(pool, {
      readKind: 'detail',
      accountId: personalOwner.account_id,
      recordId: 'QR_ACTIVATED_COMMENTS',
      channel: 'h5'
    });
    assertDtoMatch(
      'h5 personal record detail',
      h5PersonalDetailBaseline.body.data,
      h5PersonalDetailCandidate,
      'h5'
    );

    const jsonHashBeforePersonalPrimaryRead = sha256(fs.readFileSync(process.env.DB_FILE));
    await pool.query(
      'UPDATE app.records SET content = $2 WHERE qr_id = $1',
      ['QR_ACTIVATED_COMMENTS', 'PostgreSQL personal primary-only content']
    );
    Object.assign(process.env, {
      PERSONAL_RECORD_POSTGRES_READ_ENABLED: 'true',
      PERSONAL_RECORD_POSTGRES_READ_SCOPE: 'allowlist',
      PERSONAL_RECORD_POSTGRES_READ_ALLOWLIST: personalOwner.account_id,
      PERSONAL_RECORD_POSTGRES_READ_DOMAIN_SHA256: publicQrDomainHash
    });

    const selectedPersonalList = await requestJson(
      port,
      '/api/miniapp/user/records',
      personalOwnerToken
    );
    assert.equal(selectedPersonalList.status, 200);
    assert.equal(
      selectedPersonalList.body.data.records.find(
        (record) => record.id === 'QR_ACTIVATED_COMMENTS'
      ).content,
      'PostgreSQL personal primary-only content'
    );

    const selectedPersonalDetail = await requestJson(
      port,
      '/api/user/records/QR_ACTIVATED_COMMENTS',
      '',
      { Cookie: personalOwnerCookie }
    );
    assert.equal(selectedPersonalDetail.status, 200);
    assert.equal(
      selectedPersonalDetail.body.data.content,
      'PostgreSQL personal primary-only content'
    );
    assert.equal(
      sha256(fs.readFileSync(process.env.DB_FILE)),
      jsonHashBeforePersonalPrimaryRead
    );

    process.env.PERSONAL_RECORD_POSTGRES_READ_DOMAIN_SHA256 = 'f'.repeat(64);
    const stalePersonalPrimaryRead = await requestJson(
      port,
      '/api/miniapp/user/records',
      personalOwnerToken
    );
    assert.equal(stalePersonalPrimaryRead.status, 503);
    assert.equal(
      stalePersonalPrimaryRead.body.code,
      'PERSONAL_RECORD_READ_UNAVAILABLE'
    );

    process.env.PERSONAL_RECORD_POSTGRES_READ_ENABLED = 'false';
    await closePersonalRecordPrimaryReadRuntime();
    await pool.query(
      'UPDATE app.records SET content = $2 WHERE qr_id = $1',
      ['QR_ACTIVATED_COMMENTS', 'Comment ordering fixture']
    );

    await assert.rejects(
      readPersonalCandidate(pool, {
        readKind: 'detail',
        accountId: 'ACC000002',
        recordId: 'QR_ACTIVATED_COMMENTS',
        channel: 'miniapp'
      }),
      (error) => error.code === 'PERSONAL_RECORD_NOT_FOUND'
    );

    const stale = await shadowRuntime.observer.observe({
      channel: 'h5',
      endpointTemplate: '/api/qr/:qrId',
      key: 'token-qr_activated_direct',
      publicQrId: 'QR_ACTIVATED_DIRECT',
      viewer: null,
      baselineDto: { id: 'QR_ACTIVATED_DIRECT' },
      sourceHash: '0'.repeat(64),
      assetResolver: createPublicQrAssetResolver()
    });
    assert.equal(stale.outcome, 'STALE_SOURCE');

    process.env.PUBLIC_QR_SHADOW_READ_ENABLED = 'true';
    process.env.PUBLIC_QR_SHADOW_READ_ALLOWLIST = 'QR_ACTIVATED_DIRECT';
    process.env.PUBLIC_QR_SHADOW_READ_LOG_DIR = path.join(directory, 'route-shadow');
    await pool.query(
      'UPDATE app.records SET content = $2 WHERE qr_id = $1',
      ['QR_ACTIVATED_DIRECT', 'candidate-only mismatch text']
    );
    const baselineAfterCandidateDrift = await requestJson(
      port,
      '/api/qr/token-qr_activated_direct'
    );
    assert.equal(baselineAfterCandidateDrift.status, 200);
    assert.equal(baselineAfterCandidateDrift.body.data.content, 'Activated fixture');
    const routeSinkFile = path.join(
      process.env.PUBLIC_QR_SHADOW_READ_LOG_DIR,
      'public-qr-shadow-current.jsonl'
    );
    await waitForFile(routeSinkFile);
    const sinkOutput = fs.readFileSync(routeSinkFile, 'utf8');
    assert.match(sinkOutput, /\$\.content/);
    assert.doesNotMatch(sinkOutput, /Activated fixture|candidate-only mismatch text|token-qr/);
    await closePublicQrShadowRuntime();

    const importedPositions = await pool.query(
      `SELECT comment.legacy_comment_id, comment.source_position,
              comment.legacy_duplicate, comment.status
       FROM app.co_creation_comments comment
       JOIN app.co_creations creation ON creation.id = comment.co_creation_id
       WHERE creation.qr_id = 'QR_ACTIVATED_COMMENTS'
       ORDER BY comment.source_position`
    );
    assert.deepEqual(importedPositions.rows, [
      {
        legacy_comment_id: 'COMMENT_ALPHA', source_position: 0,
        legacy_duplicate: false, status: 'kept'
      },
      {
        legacy_comment_id: 'COMMENT_BETA', source_position: 1,
        legacy_duplicate: false, status: 'kept'
      },
      {
        legacy_comment_id: 'COMMENT_DELETED', source_position: 2,
        legacy_duplicate: false, status: 'deleted'
      },
      {
        legacy_comment_id: 'COMMENT_ALPHA_LEGACY_DUPLICATE', source_position: 3,
        legacy_duplicate: true, status: 'kept'
      }
    ]);

    const legacyProof = await pool.query(
      `SELECT proof.manifest_hash, proof.legacy_hash_snapshot
       FROM app.record_proofs proof
       WHERE proof.record_qr_id = 'QR_ACTIVATED_COMMENTS'`
    );
    assert.deepEqual(legacyProof.rows, [{
      manifest_hash: null,
      legacy_hash_snapshot: 'legacy-proof-marker-1'
    }]);

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
      'co_creation_comments_effective_account_uq',
      'record_proofs_record_provider_uq'
    ].forEach((name) => assert.equal(indexNames.has(name), true));
  } finally {
    global.fetch = originalFetch;
    if (shadowRuntime) await shadowRuntime.close();
    await closePublicQrShadowRuntime();
    await closePublicQrPrimaryReadRuntime();
    await closeQrLifecycleWriteRuntime();
    await closePersonalRecordPrimaryReadRuntime();
    await closeIdentityAuthorityRuntime();
    await closeQrIssuanceAuthorityRuntime();
    if (stableProofRuntime) await stableProofRuntime.close();
    if (server) await stopServer(server);
    await closeRecordProofRuntime();
    await pool.query('DROP SCHEMA IF EXISTS app CASCADE');
    await closePostgresPool(pool);
    fs.rmSync(directory, { recursive: true, force: true });
    delete process.env.DB_FILE;
    delete process.env.AUTH_SECRET;
    delete process.env.STORAGE_MODE;
    delete process.env.PUBLIC_QR_SHADOW_READ_ENABLED;
    delete process.env.PUBLIC_QR_SHADOW_READ_ALLOWLIST;
    delete process.env.PUBLIC_QR_SHADOW_READ_LOG_DIR;
    delete process.env.PUBLIC_QR_POSTGRES_READ_ENABLED;
    delete process.env.PUBLIC_QR_POSTGRES_READ_SCOPE;
    delete process.env.PUBLIC_QR_POSTGRES_READ_ALLOWLIST;
    delete process.env.PUBLIC_QR_POSTGRES_READ_DOMAIN_SHA256;
    delete process.env.QR_LIFECYCLE_POSTGRES_WRITE_ENABLED;
    delete process.env.QR_LIFECYCLE_POSTGRES_WRITE_SCOPE;
    delete process.env.QR_LIFECYCLE_POSTGRES_WRITE_ALLOWLIST;
    delete process.env.QR_LIFECYCLE_POSTGRES_WRITE_DOMAIN_SHA256;
    delete process.env.PERSONAL_RECORD_POSTGRES_READ_ENABLED;
    delete process.env.PERSONAL_RECORD_POSTGRES_READ_SCOPE;
    delete process.env.PERSONAL_RECORD_POSTGRES_READ_ALLOWLIST;
    delete process.env.PERSONAL_RECORD_POSTGRES_READ_DOMAIN_SHA256;
    delete process.env.IDENTITY_POSTGRES_AUTHORITY_ENABLED;
    delete process.env.IDENTITY_POSTGRES_AUTHORITY_SCOPE;
    delete process.env.IDENTITY_POSTGRES_AUTHORITY_ALLOWLIST;
    delete process.env.IDENTITY_POSTGRES_AUTHORITY_SOURCE_SHA256;
    delete process.env.IDENTITY_POSTGRES_AUTHORITY_DOMAIN_SHA256;
    delete process.env.QR_ISSUANCE_POSTGRES_AUTHORITY_ENABLED;
    delete process.env.QR_ISSUANCE_POSTGRES_AUTHORITY_SCOPE;
    delete process.env.QR_ISSUANCE_POSTGRES_AUTHORITY_ALLOWLIST;
    delete process.env.QR_ISSUANCE_POSTGRES_AUTHORITY_SOURCE_SHA256;
    delete process.env.QR_ISSUANCE_POSTGRES_AUTHORITY_DOMAIN_SHA256;
    delete process.env.QR_ISSUANCE_TEST_IMAGE_DIR;
    delete process.env.MINIAPP_MOCK_ENABLED;
    delete process.env.RECORD_PROOF_RUNTIME_ENABLED;
    delete process.env.RECORD_PROOF_RUNTIME_ALLOWLIST;
    delete process.env.RECORD_PROOF_RUNTIME_SOURCE_SHA256;
    delete process.env.RECORD_PROOF_RUNTIME_DOMAIN_SHA256;
    delete process.env.RECORD_PROOF_RUNTIME_SCOPE;
    delete process.env.RECORD_PROOF_WORKER_ID;
    delete process.env.RECORD_PROOF_WORKER_INTERVAL_MS;
    delete process.env.CHAIN_ENABLED;
    delete process.env.CHAIN_CALLBACK_URL;
    delete process.env.AVATA_API_KEY;
    delete process.env.AVATA_API_SECRET;
    delete process.env.AVATA_IDENTITY_NAME;
    delete process.env.AVATA_IDENTITY_NUM;
  }
});
