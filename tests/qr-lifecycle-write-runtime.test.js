'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  readQrLifecycleWriteConfig
} = require('../src/server/services/postgres/qrLifecycleWriteConfig');
const {
  QrLifecyclePostgresWriteError,
  closeQrLifecycleWriteRuntime,
  createQrLifecycleWriteController,
  createQrLifecycleWriteRuntime,
  qrLifecycleWriteHttpError
} = require('../src/server/services/postgres/qrLifecycleWriteRuntime');

const SOURCE_HASH = 'a'.repeat(64);

function enabledConfig(overrides = {}) {
  return {
    enabled: true,
    requested: true,
    reason: 'ENABLED',
    allowlist: new Set(['SSS00004']),
    sourceHash: SOURCE_HASH,
    timeoutMs: 2_000,
    ...overrides
  };
}

test('QR lifecycle PostgreSQL write config is strict and default-off', () => {
  assert.deepEqual(
    {
      enabled: readQrLifecycleWriteConfig({}).enabled,
      requested: readQrLifecycleWriteConfig({}).requested,
      reason: readQrLifecycleWriteConfig({}).reason
    },
    { enabled: false, requested: false, reason: 'DISABLED_BY_DEFAULT' }
  );
  assert.equal(readQrLifecycleWriteConfig({
    QR_LIFECYCLE_POSTGRES_WRITE_ENABLED: 'false'
  }).requested, false);
  assert.equal(readQrLifecycleWriteConfig({
    QR_LIFECYCLE_POSTGRES_WRITE_ENABLED: 'TRUE'
  }).reason, 'INVALID_ENABLED_VALUE');
  assert.equal(readQrLifecycleWriteConfig({
    QR_LIFECYCLE_POSTGRES_WRITE_ENABLED: 'true'
  }).reason, 'ALLOWLIST_REQUIRED');
  assert.equal(readQrLifecycleWriteConfig({
    QR_LIFECYCLE_POSTGRES_WRITE_ENABLED: 'true',
    QR_LIFECYCLE_POSTGRES_WRITE_ALLOWLIST: 'https://private-token'
  }).reason, 'ALLOWLIST_INVALID');
  assert.equal(readQrLifecycleWriteConfig({
    QR_LIFECYCLE_POSTGRES_WRITE_ENABLED: 'true',
    QR_LIFECYCLE_POSTGRES_WRITE_ALLOWLIST: 'SSS00004',
    QR_LIFECYCLE_POSTGRES_WRITE_SOURCE_SHA256: 'not-a-hash'
  }).reason, 'SOURCE_SHA256_REQUIRED');
});

test('QR lifecycle PostgreSQL write config accepts a canonical allowlist and source hash', () => {
  const config = readQrLifecycleWriteConfig({
    QR_LIFECYCLE_POSTGRES_WRITE_ENABLED: 'true',
    QR_LIFECYCLE_POSTGRES_WRITE_ALLOWLIST: 'SSS00004,A00002',
    QR_LIFECYCLE_POSTGRES_WRITE_SOURCE_SHA256: SOURCE_HASH
  });
  assert.equal(config.enabled, true);
  assert.equal(config.sourceHash, SOURCE_HASH);
  assert.deepEqual([...config.allowlist], ['SSS00004', 'A00002']);
});

test('write controller remains lazy while disabled or outside the allowlist', async () => {
  let runtimeCalls = 0;
  const disabled = createQrLifecycleWriteController({
    env: {},
    runtimeFactory: () => { runtimeCalls += 1; }
  });
  assert.deepEqual(await disabled.write({ publicQrId: 'SSS00004' }), { selected: false });

  const allowlistMiss = createQrLifecycleWriteController({
    readConfig: () => enabledConfig(),
    runtimeFactory: () => { runtimeCalls += 1; }
  });
  assert.deepEqual(await allowlistMiss.write({
    publicQrId: 'SSS00005',
    sourceHash: SOURCE_HASH
  }), { selected: false });
  assert.equal(runtimeCalls, 0);
  await disabled.close();
  await allowlistMiss.close();
});

test('write controller fails closed for partial configuration and source drift', async () => {
  let runtimeCalls = 0;
  const invalid = createQrLifecycleWriteController({
    readConfig: () => ({ enabled: false, requested: true }),
    runtimeFactory: () => { runtimeCalls += 1; }
  });
  await assert.rejects(
    invalid.write({ publicQrId: 'SSS00004' }),
    (error) => error.code === 'QR_LIFECYCLE_POSTGRES_WRITE_CONFIG_INVALID'
  );

  const drifted = createQrLifecycleWriteController({
    readConfig: () => enabledConfig(),
    runtimeFactory: () => { runtimeCalls += 1; }
  });
  await assert.rejects(
    drifted.write({ publicQrId: 'SSS00004', sourceHash: 'b'.repeat(64) }),
    (error) => error.code === 'QR_LIFECYCLE_POSTGRES_WRITE_SOURCE_MISMATCH'
  );
  assert.equal(runtimeCalls, 0);
});

test('selected writes share one lazy runtime and drain before closing', async () => {
  let runtimeCalls = 0;
  let finishWrite;
  let closeCalls = 0;
  const controller = createQrLifecycleWriteController({
    readConfig: () => enabledConfig(),
    runtimeFactory: () => {
      runtimeCalls += 1;
      return {
        write: (input) => new Promise((resolve) => {
          assert.equal(input.publicQrId, 'SSS00004');
          finishWrite = resolve;
        }),
        close: async () => { closeCalls += 1; }
      };
    }
  });
  const writing = controller.write({
    operation: 'activate',
    publicQrId: 'SSS00004',
    sourceHash: SOURCE_HASH
  });
  await new Promise((resolve) => setImmediate(resolve));
  const closing = controller.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeCalls, 0);
  finishWrite({ result: { data: {} }, dto: { id: 'SSS00004' } });
  assert.deepEqual(await writing, {
    selected: true,
    result: { data: {} },
    dto: { id: 'SSS00004' }
  });
  await closing;
  await controller.close();
  assert.equal(runtimeCalls, 1);
  assert.equal(closeCalls, 1);
});

test('write runtime checks provenance, executes the selected operation, and returns a public DTO', async () => {
  const calls = [];
  const migrations = [{ version: '001_init_schema.sql', checksum: 'b'.repeat(64) }];
  let poolClosed = 0;
  class EmptyRepository { constructor() {} }
  class FakeAdapter {
    async loadSnapshot(input) {
      calls.push(['load', input.key, input.channel]);
      return { qr: { id: 'SSS00004', lifecycle_status: 'activated' } };
    }
    async present(snapshot, { assetResolver }) {
      calls.push(['present', assetResolver.name]);
      return { id: snapshot.qr.id, activation_status: snapshot.qr.lifecycle_status };
    }
  }

  const runtime = createQrLifecycleWriteRuntime(enabledConfig(), {
    env: {
      PGHOST: '127.0.0.1',
      PGUSER: 'test',
      PGDATABASE: 'write_test',
      PGSSL: 'false'
    },
    createPool: ({ config }) => {
      assert.equal(config.poolMax, 2);
      assert.equal(config.applicationName, 'xingxingzaishan-qr-lifecycle-write');
      return { type: 'write-pool' };
    },
    closePool: async () => { poolClosed += 1; },
    transactionRunner: async (_pool, callback, options) => {
      assert.deepEqual(options, { isolationLevel: 'repeatable read', readOnly: true });
      return callback({});
    },
    migrationsLoader: () => migrations,
    repositories: {
      PublicQrProvenanceRepository: EmptyRepository,
      QrRepository: EmptyRepository,
      RecordRepository: EmptyRepository,
      CoCreationRepository: EmptyRepository,
      ProofRepository: EmptyRepository,
      QrBatchRepository: EmptyRepository
    },
    AdapterClass: FakeAdapter,
    freshnessChecker: async ({ sourceHash, migrations: actualMigrations }) => {
      calls.push(['freshness', sourceHash]);
      assert.deepEqual(actualMigrations, migrations);
      return 'ELIGIBLE';
    },
    storageModeReader: () => 'oss',
    writeServiceFactory: ({ pool }) => {
      assert.equal(pool.type, 'write-pool');
      return {
        activateQRByKey: async (key, payload) => {
          calls.push(['activate', key, payload.account_id]);
          return { data: { qr: { id: 'SSS00004' } } };
        }
      };
    }
  });

  assert.deepEqual(await runtime.write({
    operation: 'activate',
    key: 'public-token',
    publicQrId: 'SSS00004',
    channel: 'h5',
    payload: { account_id: 'ACC000002' },
    viewer: { accountId: 'ACC000002', phoneBound: true },
    assetResolver: { name: 'request-assets' }
  }), {
    result: { data: { qr: { id: 'SSS00004' } } },
    dto: { id: 'SSS00004', activation_status: 'activated' }
  });
  assert.deepEqual(calls, [
    ['freshness', SOURCE_HASH],
    ['activate', 'public-token', 'ACC000002'],
    ['load', 'public-token', 'h5'],
    ['present', 'request-assets']
  ]);
  await runtime.close();
  await runtime.close();
  assert.equal(poolClosed, 1);
});

test('write runtime returns business failures without presenting and rejects stale candidates', async () => {
  class EmptyRepository { constructor() {} }
  let presentCalls = 0;
  class FakeAdapter {
    async loadSnapshot() { presentCalls += 1; }
    async present() { presentCalls += 1; }
  }
  const baseOptions = {
    env: {
      PGHOST: '127.0.0.1', PGUSER: 'test', PGDATABASE: 'test', PGSSL: 'false'
    },
    createPool: () => ({}),
    closePool: async () => {},
    transactionRunner: async (_pool, callback) => callback({}),
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
    storageModeReader: () => 'local'
  };

  const businessFailure = createQrLifecycleWriteRuntime(enabledConfig(), {
    ...baseOptions,
    freshnessChecker: async () => 'ELIGIBLE',
    writeServiceFactory: () => ({
      finalizeCoCreationByKey: async () => ({ error: 'FORBIDDEN' })
    })
  });
  assert.deepEqual(await businessFailure.write({ operation: 'finalize' }), {
    result: { error: 'FORBIDDEN' }
  });
  assert.equal(presentCalls, 0);
  await businessFailure.close();

  const stale = createQrLifecycleWriteRuntime(enabledConfig(), {
    ...baseOptions,
    freshnessChecker: async () => 'STALE_SOURCE',
    writeServiceFactory: () => ({ activateQRByKey: async () => ({ data: {} }) })
  });
  await assert.rejects(
    stale.write({ operation: 'activate' }),
    (error) => error.code === 'QR_LIFECYCLE_POSTGRES_WRITE_STALE_SOURCE'
  );
  await stale.close();
});

test('write runtime HTTP failures are sanitized and both route families are wired', () => {
  const unavailable = qrLifecycleWriteHttpError(
    new QrLifecyclePostgresWriteError('QR_LIFECYCLE_POSTGRES_WRITE_STALE_SOURCE')
  );
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.code, 'QR_WRITE_UNAVAILABLE');
  assert.equal(JSON.stringify(unavailable).includes('STALE_SOURCE'), false);

  const repositoryRoot = path.join(__dirname, '..');
  const h5Route = fs.readFileSync(path.join(repositoryRoot, 'src/server/routes/qr.js'), 'utf8');
  const miniappRoute = fs.readFileSync(
    path.join(repositoryRoot, 'src/server/routes/miniapp.js'),
    'utf8'
  );
  const server = fs.readFileSync(path.join(repositoryRoot, 'src/server/server.js'), 'utf8');
  assert.match(h5Route, /await selectPostgresLifecycleWrite\(/);
  assert.match(miniappRoute, /await selectPostgresLifecycleWrite\(/);
  for (const operation of [
    'activate', 'start_co_creation', 'add_comment', 'delete_comment', 'finalize'
  ]) {
    assert.match(h5Route, new RegExp(`['\"]${operation}['\"]`));
    assert.match(miniappRoute, new RegExp(`['\"]${operation}['\"]`));
  }
  assert.match(server, /closeQrLifecycleWriteRuntime\(\)/);
});

test('default-off H5 route preserves the existing JSON write path without PostgreSQL config', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-write-route-'));
  const databaseFile = path.join(directory, 'db.json');
  process.env.DB_FILE = databaseFile;
  process.env.STORAGE_ROOT = path.join(directory, 'storage');
  process.env.AUTH_SECRET = 'qr-write-route-secret';
  delete process.env.QR_LIFECYCLE_POSTGRES_WRITE_ENABLED;
  delete process.env.QR_LIFECYCLE_POSTGRES_WRITE_ALLOWLIST;
  delete process.env.QR_LIFECYCLE_POSTGRES_WRITE_SOURCE_SHA256;

  let server;
  try {
    const { createApp } = require('../src/server/app');
    server = await new Promise((resolve) => {
      const listening = createApp().listen(0, '127.0.0.1', () => resolve(listening));
    });
    const postJson = (requestPath, body, headers = {}) => {
      const payload = JSON.stringify(body);
      return new Promise((resolve, reject) => {
        const request = http.request({
          hostname: '127.0.0.1',
          port: server.address().port,
          path: requestPath,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            ...headers
          }
        }, (incoming) => {
          const chunks = [];
          incoming.on('data', (chunk) => chunks.push(chunk));
          incoming.on('end', () => resolve({
            status: incoming.statusCode,
            headers: incoming.headers,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
          }));
        });
        request.on('error', reject);
        request.end(payload);
      });
    };

    const login = await postJson('/api/user/login', { phone: '13800138991' });
    assert.equal(login.status, 200);
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const before = JSON.parse(fs.readFileSync(databaseFile, 'utf8'));
    const qr = before.qr_codes.find((item) => (
      item.issue_status === 'issued' && item.activation_status === 'unactivated'
    ));
    assert.ok(qr);

    const response = await postJson(
      `/api/qr/${encodeURIComponent(qr.qr_access_token || qr.id)}/record`,
      {
      content: 'Default-off JSON route contract',
      image_object_key: 'records/default-off-route.jpg'
      },
      { Cookie: cookie }
    );

    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, qr.id);
    assert.equal(response.body.data.activation_status, 'activated');
    const updated = JSON.parse(fs.readFileSync(databaseFile, 'utf8'));
    assert.equal(
      updated.qr_codes.find((item) => item.id === qr.id).activation_status,
      'activated'
    );
  } finally {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    await closeQrLifecycleWriteRuntime();
    fs.rmSync(directory, { recursive: true, force: true });
    delete process.env.DB_FILE;
    delete process.env.STORAGE_ROOT;
    delete process.env.AUTH_SECRET;
  }
});
