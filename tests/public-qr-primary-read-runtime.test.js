'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  readPublicQrPrimaryReadConfig
} = require('../src/server/services/postgres/publicQrPrimaryReadConfig');
const {
  PublicQrPrimaryReadError,
  createPublicQrPrimaryReadController,
  createPublicQrPrimaryReadRuntime,
  publicQrPrimaryReadHttpError
} = require('../src/server/services/postgres/publicQrPrimaryReadRuntime');

const SOURCE_HASH = 'a'.repeat(64);

function enabledConfig(overrides = {}) {
  return {
    enabled: true,
    requested: true,
    reason: 'ENABLED',
    allowlist: new Set(['SSS00004']),
    sourceHash: SOURCE_HASH,
    timeoutMs: 500,
    ...overrides
  };
}

test('public QR primary read config is strictly default-off and rejects partial enablement', () => {
  assert.deepEqual(
    {
      enabled: readPublicQrPrimaryReadConfig({}).enabled,
      requested: readPublicQrPrimaryReadConfig({}).requested,
      reason: readPublicQrPrimaryReadConfig({}).reason
    },
    { enabled: false, requested: false, reason: 'DISABLED_BY_DEFAULT' }
  );
  assert.equal(readPublicQrPrimaryReadConfig({
    PUBLIC_QR_POSTGRES_READ_ENABLED: 'false'
  }).requested, false);
  assert.equal(readPublicQrPrimaryReadConfig({
    PUBLIC_QR_POSTGRES_READ_ENABLED: 'TRUE'
  }).reason, 'INVALID_ENABLED_VALUE');
  assert.equal(readPublicQrPrimaryReadConfig({
    PUBLIC_QR_POSTGRES_READ_ENABLED: 'true'
  }).reason, 'ALLOWLIST_REQUIRED');
  assert.equal(readPublicQrPrimaryReadConfig({
    PUBLIC_QR_POSTGRES_READ_ENABLED: 'true',
    PUBLIC_QR_POSTGRES_READ_ALLOWLIST: 'https://private-token'
  }).reason, 'ALLOWLIST_INVALID');
  assert.equal(readPublicQrPrimaryReadConfig({
    PUBLIC_QR_POSTGRES_READ_ENABLED: 'true',
    PUBLIC_QR_POSTGRES_READ_ALLOWLIST: 'SSS00004',
    PUBLIC_QR_POSTGRES_READ_SOURCE_SHA256: 'not-a-hash'
  }).reason, 'SOURCE_SHA256_REQUIRED');
});

test('public QR primary read config accepts only a canonical QR allowlist and exact source hash', () => {
  const config = readPublicQrPrimaryReadConfig({
    PUBLIC_QR_POSTGRES_READ_ENABLED: 'true',
    PUBLIC_QR_POSTGRES_READ_ALLOWLIST: 'SSS00004, CS1X00003',
    PUBLIC_QR_POSTGRES_READ_SOURCE_SHA256: SOURCE_HASH
  });
  assert.equal(config.enabled, true);
  assert.equal(config.requested, true);
  assert.equal(config.sourceHash, SOURCE_HASH);
  assert.deepEqual([...config.allowlist], ['SSS00004', 'CS1X00003']);
});

test('primary read controller stays lazy for default-off and allowlist misses', async () => {
  let runtimeCalls = 0;
  const disabled = createPublicQrPrimaryReadController({
    env: {},
    runtimeFactory: () => { runtimeCalls += 1; }
  });
  assert.deepEqual(await disabled.read({ publicQrId: 'SSS00004' }), { selected: false });

  const allowlistMiss = createPublicQrPrimaryReadController({
    readConfig: () => enabledConfig(),
    runtimeFactory: () => { runtimeCalls += 1; }
  });
  assert.deepEqual(await allowlistMiss.read({
    publicQrId: 'SSS00005',
    sourceHash: SOURCE_HASH
  }), { selected: false });
  assert.equal(runtimeCalls, 0);
  await disabled.close();
  await allowlistMiss.close();
});

test('primary read controller fails closed before runtime creation for invalid config or source drift', async () => {
  let runtimeCalls = 0;
  const invalid = createPublicQrPrimaryReadController({
    readConfig: () => ({ enabled: false, requested: true }),
    runtimeFactory: () => { runtimeCalls += 1; }
  });
  await assert.rejects(
    invalid.read({ publicQrId: 'SSS00004' }),
    (error) => error.code === 'PUBLIC_QR_POSTGRES_READ_CONFIG_INVALID'
  );

  const drifted = createPublicQrPrimaryReadController({
    readConfig: () => enabledConfig(),
    runtimeFactory: () => { runtimeCalls += 1; }
  });
  await assert.rejects(
    drifted.read({ publicQrId: 'SSS00004', sourceHash: 'b'.repeat(64) }),
    (error) => error.code === 'PUBLIC_QR_POSTGRES_READ_SOURCE_MISMATCH'
  );
  assert.equal(runtimeCalls, 0);
});

test('selected primary reads use one lazy runtime and close it once', async () => {
  let runtimeCalls = 0;
  let readCalls = 0;
  let closeCalls = 0;
  const controller = createPublicQrPrimaryReadController({
    readConfig: () => enabledConfig(),
    runtimeFactory: () => {
      runtimeCalls += 1;
      return {
        read: async (input) => {
          readCalls += 1;
          assert.equal(input.publicQrId, 'SSS00004');
          return { dto: { id: input.publicQrId }, lifecycle: 'activated' };
        },
        close: async () => { closeCalls += 1; }
      };
    }
  });
  const input = {
    key: 'public-token',
    publicQrId: 'SSS00004',
    sourceHash: SOURCE_HASH,
    channel: 'h5'
  };
  assert.deepEqual(await controller.read(input), {
    selected: true,
    dto: { id: 'SSS00004' },
    lifecycle: 'activated'
  });
  await controller.read(input);
  assert.equal(runtimeCalls, 1);
  assert.equal(readCalls, 2);
  await controller.close();
  await controller.close();
  assert.equal(closeCalls, 1);
});

test('primary read controller drains an active request before closing its runtime', async () => {
  let finishRead;
  let closeCalls = 0;
  const controller = createPublicQrPrimaryReadController({
    readConfig: () => enabledConfig(),
    runtimeFactory: () => ({
      read: () => new Promise((resolve) => { finishRead = resolve; }),
      close: async () => { closeCalls += 1; }
    })
  });
  const reading = controller.read({
    publicQrId: 'SSS00004',
    sourceHash: SOURCE_HASH
  });
  await new Promise((resolve) => setImmediate(resolve));
  const closing = controller.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeCalls, 0);
  finishRead({ dto: { id: 'SSS00004' }, lifecycle: 'activated' });
  await reading;
  await closing;
  assert.equal(closeCalls, 1);
});

test('primary runtime verifies freshness in a read-only transaction before presenting the DTO', async () => {
  const migrations = [{ version: '001_init_schema.sql', checksum: 'b'.repeat(64) }];
  let inTransaction = false;
  let poolClosed = 0;
  let freshnessCalls = 0;

  class EmptyRepository { constructor() {} }
  class ProvenanceRepository { constructor(context) { this.context = context; } }
  class FakeAdapter {
    async loadSnapshot(input) {
      assert.equal(inTransaction, true);
      assert.equal(input.key, 'public-token');
      return { qr: { id: 'SSS00004', lifecycle_status: 'activated' } };
    }
    async present(snapshot, { assetResolver }) {
      assert.equal(inTransaction, false);
      assert.equal(assetResolver.name, 'request-assets');
      return { id: snapshot.qr.id, activation_status: snapshot.qr.lifecycle_status };
    }
  }

  const runtime = createPublicQrPrimaryReadRuntime(enabledConfig(), {
    env: {
      PGHOST: '127.0.0.1',
      PGUSER: 'test',
      PGDATABASE: 'primary_read_test',
      PGSSL: 'false'
    },
    createPool: ({ config }) => {
      assert.equal(config.poolMax, 2);
      assert.equal(config.connectionTimeoutMillis, 500);
      assert.equal(config.applicationName, 'xingxingzaishan-public-qr-primary-read');
      return { type: 'primary-read-pool' };
    },
    closePool: async () => { poolClosed += 1; },
    transactionRunner: async (_pool, callback, options) => {
      assert.deepEqual(options, { isolationLevel: 'repeatable read', readOnly: true });
      inTransaction = true;
      try {
        return await callback({
          query: async (sql, params) => {
            assert.match(sql, /statement_timeout/);
            assert.match(params[0], /^\d+ms$/);
          }
        });
      } finally {
        inTransaction = false;
      }
    },
    migrationsLoader: () => migrations,
    repositories: {
      PublicQrProvenanceRepository: ProvenanceRepository,
      QrRepository: EmptyRepository,
      RecordRepository: EmptyRepository,
      CoCreationRepository: EmptyRepository,
      ProofRepository: EmptyRepository,
      QrBatchRepository: EmptyRepository
    },
    AdapterClass: FakeAdapter,
    freshnessChecker: async ({ sourceHash, migrations: actualMigrations }) => {
      freshnessCalls += 1;
      assert.equal(sourceHash, SOURCE_HASH);
      assert.deepEqual(actualMigrations, migrations);
      return 'ELIGIBLE';
    },
    storageModeReader: () => 'local'
  });

  assert.deepEqual(await runtime.read({
    key: 'public-token',
    publicQrId: 'SSS00004',
    channel: 'h5',
    viewer: { accountId: 'ACC000002', phoneBound: true },
    assetResolver: { name: 'request-assets' }
  }), {
    dto: { id: 'SSS00004', activation_status: 'activated' },
    lifecycle: 'activated'
  });
  assert.equal(freshnessCalls, 1);
  await runtime.close();
  await runtime.close();
  assert.equal(poolClosed, 1);
});

test('primary runtime rejects stale provenance and resolved QR identity drift', async () => {
  class EmptyRepository { constructor() {} }
  class FakeAdapter {
    async loadSnapshot() {
      return { qr: { id: 'DIFFERENT_QR', lifecycle_status: 'activated' } };
    }
    async present() { throw new Error('must not present'); }
  }
  function makeRuntime(freshnessChecker) {
    return createPublicQrPrimaryReadRuntime(enabledConfig(), {
      env: {
        PGHOST: '127.0.0.1', PGUSER: 'test', PGDATABASE: 'test', PGSSL: 'false'
      },
      createPool: () => ({}),
      closePool: async () => {},
      transactionRunner: async (_pool, callback) => callback({ query: async () => {} }),
      migrationsLoader: () => [],
      repositories: {
        PublicQrProvenanceRepository: EmptyRepository,
        QrRepository: EmptyRepository,
        RecordRepository: EmptyRepository,
        CoCreationRepository: EmptyRepository,
        ProofRepository: EmptyRepository,
        QrBatchRepository: EmptyRepository
      },
      AdapterClass: FakeAdapter,
      freshnessChecker,
      storageModeReader: () => 'local'
    });
  }

  const stale = makeRuntime(async () => 'STALE_SOURCE');
  await assert.rejects(
    stale.read({ publicQrId: 'SSS00004' }),
    (error) => error.code === 'PUBLIC_QR_POSTGRES_READ_STALE_SOURCE'
  );
  await stale.close();

  const drifted = makeRuntime(async () => 'ELIGIBLE');
  await assert.rejects(
    drifted.read({ publicQrId: 'SSS00004' }),
    (error) => error.code === 'PUBLIC_QR_POSTGRES_READ_IDENTITY_MISMATCH'
  );
  await drifted.close();
});

test('primary read HTTP errors preserve public not-found and hidden contracts without leaking failures', () => {
  assert.deepEqual(publicQrPrimaryReadHttpError({ code: 'QR_NOT_FOUND' }), {
    status: 404,
    code: 'QR_NOT_FOUND',
    message: '未找到这颗星，请确认二维码是否正确。'
  });
  assert.equal(publicQrPrimaryReadHttpError({ code: 'QR_HIDDEN' }).status, 403);
  const unavailable = publicQrPrimaryReadHttpError(
    new PublicQrPrimaryReadError('PUBLIC_QR_POSTGRES_READ_STALE_SOURCE')
  );
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.code, 'PUBLIC_QR_READ_UNAVAILABLE');
  assert.equal(JSON.stringify(unavailable).includes('STALE_SOURCE'), false);
});

test('both public QR routes and server shutdown are wired to the primary read runtime', () => {
  const repositoryRoot = path.join(__dirname, '..');
  const h5Route = fs.readFileSync(path.join(repositoryRoot, 'src/server/routes/qr.js'), 'utf8');
  const miniappRoute = fs.readFileSync(
    path.join(repositoryRoot, 'src/server/routes/miniapp.js'),
    'utf8'
  );
  const server = fs.readFileSync(path.join(repositoryRoot, 'src/server/server.js'), 'utf8');
  assert.match(h5Route, /await readPublicQrPrimary\(/);
  assert.match(miniappRoute, /await readPublicQrPrimary\(/);
  assert.match(server, /closePublicQrPrimaryReadRuntime\(\)/);
});
