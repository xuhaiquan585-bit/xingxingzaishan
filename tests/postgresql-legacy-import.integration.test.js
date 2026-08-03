'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { readPostgresConfig } = require('../src/server/database/config');
const { closePostgresPool, createPostgresPool } = require('../src/server/database/connection');
const { withTransaction } = require('../src/server/database/transaction');
const {
  CoCreationRepository,
  ProofRepository,
  QrBatchRepository,
  QrRepository,
  RecordRepository
} = require('../src/server/repositories');
const { chainStatusForCustomer } = require('../src/server/services/chainViewService');
const {
  PublicQrReadAdapter
} = require('../src/server/services/postgres/publicQrReadAdapter');
const {
  comparePublicQrDtos
} = require('../src/server/services/postgres/publicQrDtoComparator');
const { executeStagingImport } = require('../scripts/database/import-staging');
const { analyzeSourceSnapshot } = require('../scripts/database/importer');
const { readSourceSnapshot, sha256 } = require('../scripts/database/importer/reader');
const { runMigrations } = require('../scripts/database/migrate');

const RUN_INTEGRATION = process.env.RUN_POSTGRES_INTEGRATION === 'true';
const CREATED_AT = '2026-07-01T10:00:00.000Z';
const LATER_AT = '2026-07-01T11:00:00.000Z';
const LEGACY_HASH = 'legacy-proof-marker-1';

function buildSource() {
  return {
    meta: {},
    accounts: [{
      id: 'ACC000001', status: 'active', display_name: '', avatar_url: '',
      created_from: 'migration', created_at: CREATED_AT, updated_at: CREATED_AT
    }],
    users: [{
      id: 1, phone: '13800000001', openid: 'openid-fixture-1', unionid: null,
      source: 'web+miniapp', created_at: CREATED_AT, account_id: 'ACC000001'
    }],
    admins: [],
    batches: [],
    qr_codes: [{
      id: 'QR_LEGACY_COMPAT', issue_status: 'issued', activation_status: 'activated',
      hidden: false, batch_id: null, print_batch_id: null,
      quality_check: { checked: false, checked_at: null, checked_by: null, result: null },
      content: 'Legacy compatibility fixture',
      image_url: 'https://fixture.invalid/legacy.jpg', image_object_key: null,
      image_sha256: null, phone: '13800000001', account_id: null,
      activated_at: LATER_AT, blockchain_hash: LEGACY_HASH,
      chain_provider: 'avata_wenchang', chain_status: 'confirmed',
      chain_operation_id: null, manifest_object_key: null, manifest_hash: LEGACY_HASH,
      chain_tx_hash: null, chain_block_height: null, chain_record_id: null,
      chain_certificate_url: null, chain_certificate_object_key: null,
      chain_certificate_object_url: null, chain_confirmed_at: null,
      chain_callback_received_at: null, chain_last_error: '', chain_retry_count: 0,
      legacy_manifest_object_key: null, archive_index_object_key: null,
      archive_status: 'not_started', archive_last_error: '', archive_updated_at: null,
      co_creation_enabled: true, co_creation_owner_phone: '13800000001',
      co_creation_owner_account_id: 'ACC000001',
      co_creation_comments: [
        {
          id: 'COMMENT_FIRST', phone: '13800000001', account_id: null,
          author_name: 'First author', content: 'First distinct content', status: 'kept',
          created_at: LATER_AT
        },
        {
          id: 'COMMENT_SECOND', phone: '13800000001', account_id: 'ACC000001',
          author_name: 'Second author', content: 'Second distinct content', status: 'kept',
          created_at: CREATED_AT
        }
      ],
      co_creation_started_at: CREATED_AT, show_brand_disclosure: false,
      brand_disclosure_text_snapshot: '', qr_image_url: null,
      qr_access_token: 'token-qr_legacy_compat', created_at: CREATED_AT,
      updated_at: LATER_AT
    }],
    quality_check_logs: [],
    products: [],
    content_pages: [],
    banners: [],
    orders: [],
    payment_logs: [],
    miniapp_content: {}
  };
}

function writeSource(directory, source) {
  const inputPath = path.join(directory, 'legacy-compat.json');
  const bytes = Buffer.from(JSON.stringify(source), 'utf8');
  fs.writeFileSync(inputPath, bytes);
  return { inputPath, sourceHash: sha256(bytes) };
}

test('manual PostgreSQL legacy import compatibility', {
  skip: RUN_INTEGRATION ? false : 'Set RUN_POSTGRES_INTEGRATION=true and an explicit _test database.'
}, async () => {
  assert.notEqual(String(process.env.NODE_ENV || '').toLowerCase(), 'production');
  assert.match(String(process.env.PGDATABASE || ''), /_test$/i);
  assert.equal(Boolean(process.env.DATABASE_URL), false);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingxing-legacy-import-'));
  const source = writeSource(directory, buildSource());
  const snapshot = readSourceSnapshot({
    inputPath: source.inputPath,
    expectedSha256: source.sourceHash
  });
  const analysis = { snapshot, ...analyzeSourceSnapshot(snapshot) };
  assert.equal(analysis.report.status, 'READY');
  assert.equal(analysis.report.anomaly_counts.LEGACY_NON_SHA_HASH_PRESERVED, 1);
  assert.equal(analysis.report.anomaly_counts.LEGACY_ACCOUNT_LINK_RECOVERED, 2);
  assert.equal(analysis.report.anomaly_counts.LEGACY_DUPLICATE_COMMENT_ACCOUNT_PRESERVED, 1);

  const pool = createPostgresPool({ config: readPostgresConfig(process.env) });
  try {
    const migration = await runMigrations({ pool, apply: true, target: 'test' });
    assert.deepEqual(migration.applied.map((item) => item.version), [
      '001_init_schema.sql',
      '002_add_comment_source_position.sql',
      '003_preserve_legacy_import_evidence.sql'
    ]);
    const imported = await executeStagingImport({
      pool,
      snapshot: analysis.snapshot,
      report: analysis.report,
      plan: analysis.plan
    });
    assert.equal(imported.status, 'PASSED');

    const comments = await pool.query(
      `SELECT account_id, source_position, legacy_duplicate, author_name, content
       FROM app.co_creation_comments
       ORDER BY source_position`
    );
    assert.deepEqual(comments.rows, [
      {
        account_id: 'ACC000001', source_position: 0, legacy_duplicate: false,
        author_name: 'First author', content: 'First distinct content'
      },
      {
        account_id: 'ACC000001', source_position: 1, legacy_duplicate: true,
        author_name: 'Second author', content: 'Second distinct content'
      }
    ]);
    const proof = await pool.query(
      'SELECT manifest_hash, legacy_hash_snapshot FROM app.record_proofs'
    );
    assert.deepEqual(proof.rows, [{
      manifest_hash: null,
      legacy_hash_snapshot: LEGACY_HASH
    }]);
    const record = await pool.query('SELECT account_id FROM app.records');
    assert.deepEqual(record.rows, [{ account_id: 'ACC000001' }]);

    await assert.rejects(
      pool.query(
        `INSERT INTO app.co_creation_comments
           (id, co_creation_id, account_id, legacy_comment_id, source_position,
            legacy_duplicate, content, status, created_at)
         SELECT '00000000-0000-0000-0000-000000000999', id, 'ACC000001',
                'COMMENT_RUNTIME_DUPLICATE', 2, false, 'blocked', 'kept', $1
         FROM app.co_creations`,
        [CREATED_AT]
      ),
      (error) => error && error.code === '23505'
    );

    const candidate = await withTransaction(pool, async (transactionContext) => {
      const adapter = new PublicQrReadAdapter({
        qrRepository: new QrRepository(transactionContext),
        recordRepository: new RecordRepository(transactionContext),
        coCreationRepository: new CoCreationRepository(transactionContext),
        proofRepository: new ProofRepository(transactionContext),
        batchReader: new QrBatchRepository(transactionContext),
        publicRuntimeMetadata: { storage_mode: 'local' }
      });
      return adapter.read({
        key: 'token-qr_legacy_compat',
        channel: 'h5',
        viewer: { account_id: 'ACC000001', phone_bound: true }
      });
    }, { isolationLevel: 'repeatable read', readOnly: true });

    const baseline = {
      id: 'QR_LEGACY_COMPAT', qr_id: 'QR_LEGACY_COMPAT',
      activation_status: 'activated', issue_status: 'issued',
      active_storage_mode: 'local', batch_id: null,
      content: 'Legacy compatibility fixture',
      image_url: 'https://fixture.invalid/legacy.jpg', image_object_key: null,
      blockchain_hash: LEGACY_HASH, chain_provider: 'avata_wenchang',
      chain_status: 'confirmed', chain_status_text: chainStatusForCustomer('confirmed'),
      manifest_hash: LEGACY_HASH, chain_tx_hash: null,
      chain_certificate_url: null, chain_confirmed_at: null,
      activated_at: LATER_AT, co_creation_enabled: true,
      is_co_creation_owner: true,
      co_creation_comments: [
        { id: 'COMMENT_FIRST', author_name: 'First author', content: 'First distinct content', created_at: LATER_AT },
        { id: 'COMMENT_SECOND', author_name: 'Second author', content: 'Second distinct content', created_at: CREATED_AT }
      ],
      has_my_co_creation_comment: true,
      co_creation_comment_count: 2,
      co_creation_comment_limit: 12,
      show_brand_disclosure: false,
      brand_disclosure_text_snapshot: ''
    };
    const comparison = comparePublicQrDtos({ baseline, candidate, channel: 'h5' });
    assert.equal(comparison.matches, true, JSON.stringify(comparison));
    assert.equal(comparison.mismatch_count, 0);
    assert.equal(JSON.stringify(candidate).includes('legacy_duplicate'), false);
    assert.equal(JSON.stringify(candidate).includes('legacy_hash_snapshot'), false);
  } finally {
    await pool.query('DROP SCHEMA IF EXISTS app CASCADE');
    await closePostgresPool(pool);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
