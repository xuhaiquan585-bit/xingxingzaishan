'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { createShutdownHandler } = require('../src/server/server');
const { createPublicQrAssetResolver } = require('../src/server/services/publicQrAssetResolver');
const {
  checkCandidateFreshness,
  createPublicQrShadowRuntime,
  createPublicQrShadowScheduler,
  migrationSetMatches
} = require('../src/server/services/postgres/publicQrShadowRuntime');
const {
  createPersonalRecordShadowScheduler
} = require('../src/server/services/postgres/personalRecordShadowRuntime');

function enabledConfig() {
  return {
    enabled: true,
    allowlist: new Set(['QR_PUBLIC_1']),
    logDirectory: 'D:\\outside-repository\\shadow',
    timeoutMs: 250,
    maxConcurrency: 2,
    maxLogBytes: 5 * 1024 * 1024,
    retentionDays: 14,
    queueLimit: 100
  };
}

test('request-scoped asset resolver preserves channel behavior and memoizes exact results', () => {
  const calls = [];
  const resolver = createPublicQrAssetResolver({
    resolveSignedUrl: (key) => {
      calls.push(['signed', key]);
      return `signed://${key}/one-time`;
    },
    resolvePublicObjectUrl: (key) => {
      calls.push(['public', key]);
      return `public://${key}`;
    }
  });
  const objectOnly = { image_object_key: 'records/photo.jpg', image_url: null };
  assert.equal(
    resolver.resolveRecordImage({ record: objectOnly, channel: 'h5' }),
    'signed://records/photo.jpg/one-time'
  );
  assert.equal(
    resolver.resolveRecordImage({ record: objectOnly, channel: 'h5' }),
    'signed://records/photo.jpg/one-time'
  );
  assert.equal(
    resolver.resolveRecordImage({ record: objectOnly, channel: 'miniapp' }),
    'public://records/photo.jpg'
  );
  assert.equal(
    resolver.resolveRecordImage({
      record: { image_object_key: 'ignored', image_url: 'https://snapshot.invalid/photo.jpg' },
      channel: 'miniapp'
    }),
    'https://snapshot.invalid/photo.jpg'
  );
  assert.deepEqual(calls, [
    ['signed', 'records/photo.jpg'],
    ['public', 'records/photo.jpg']
  ]);
});

test('scheduler stays inert while disabled and starts only after response finish', async () => {
  let runtimeCalls = 0;
  let observeCalls = 0;
  const disabledScheduler = createPublicQrShadowScheduler({
    readConfig: () => ({ enabled: false, allowlist: new Set() }),
    runtimeFactory: () => { runtimeCalls += 1; }
  });
  const disabledResponse = new EventEmitter();
  assert.equal(disabledScheduler.register({
    res: disabledResponse,
    event: { publicQrId: 'QR_PUBLIC_1' }
  }), false);
  disabledResponse.emit('finish');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtimeCalls, 0);

  const scheduler = createPublicQrShadowScheduler({
    readConfig: () => enabledConfig(),
    runtimeFactory: () => {
      runtimeCalls += 1;
      return {
        observer: { observe: async () => { observeCalls += 1; } },
        close: async () => {}
      };
    }
  });
  const response = new EventEmitter();
  assert.equal(scheduler.register({
    res: response,
    event: { publicQrId: 'QR_PUBLIC_1' }
  }), true);
  assert.equal(runtimeCalls, 0);
  response.emit('finish');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtimeCalls, 1);
  assert.equal(observeCalls, 1);
  await scheduler.close();
  assert.equal(scheduler.register({ res: new EventEmitter(), event: { publicQrId: 'QR_PUBLIC_1' } }), false);
});

test('personal record scheduler gates by account and starts only after response finish', async () => {
  let runtimeCalls = 0;
  const observed = [];
  const scheduler = createPersonalRecordShadowScheduler({
    readConfig: () => ({ enabled: true, allowlist: new Set(['ACC_OWNER']) }),
    runtimeFactory: () => {
      runtimeCalls += 1;
      return {
        observer: { observe: async (event) => observed.push(event) },
        close: async () => {}
      };
    }
  });
  const denied = new EventEmitter();
  assert.equal(scheduler.register({
    res: denied,
    event: { accountId: 'ACC_OTHER' }
  }), false);

  const response = new EventEmitter();
  assert.equal(scheduler.register({
    res: response,
    event: { accountId: 'ACC_OWNER', readKind: 'list' }
  }), true);
  assert.equal(runtimeCalls, 0);
  response.emit('finish');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtimeCalls, 1);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].allowlistKey, 'ACC_OWNER');
  await scheduler.close();
});

test('scheduler does not create a runtime when shutdown starts before response finish', async () => {
  let runtimeCalls = 0;
  const scheduler = createPublicQrShadowScheduler({
    readConfig: () => enabledConfig(),
    runtimeFactory: () => {
      runtimeCalls += 1;
      return { observer: { observe: async () => {} }, close: async () => {} };
    }
  });
  const response = new EventEmitter();
  assert.equal(scheduler.register({
    res: response,
    event: { publicQrId: 'QR_PUBLIC_1' }
  }), true);

  await scheduler.close();
  response.emit('finish');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtimeCalls, 0);
});

test('freshness requires exact passed source and canonical migration set', async () => {
  const migrations = [{ version: '001_init_schema.sql', checksum: 'a'.repeat(64) }];
  assert.equal(migrationSetMatches(migrations, migrations), true);
  assert.equal(migrationSetMatches([], migrations), false);

  function provenance({ exact = null, latest = null, applied = migrations } = {}) {
    return {
      findPassedImportBySourceHash: async () => exact,
      findLatestPassedImport: async () => latest,
      listAppliedMigrations: async () => applied
    };
  }
  const sourceHash = 'b'.repeat(64);
  assert.equal(await checkCandidateFreshness({
    provenanceRepository: provenance(), sourceHash, migrations
  }), 'INELIGIBLE_NO_IMPORT');
  assert.equal(await checkCandidateFreshness({
    provenanceRepository: provenance({ latest: { source_sha256: 'c'.repeat(64) } }),
    sourceHash,
    migrations
  }), 'STALE_SOURCE');
  assert.equal(await checkCandidateFreshness({
    provenanceRepository: provenance({ exact: { source_sha256: sourceHash }, applied: [] }),
    sourceHash,
    migrations
  }), 'INELIGIBLE_NO_VERSION');
  assert.equal(await checkCandidateFreshness({
    provenanceRepository: provenance({
      exact: { source_sha256: sourceHash },
      applied: [{ ...migrations[0], checksum: 'd'.repeat(64) }]
    }),
    sourceHash,
    migrations
  }), 'INELIGIBLE_VERSION');
  assert.equal(await checkCandidateFreshness({
    provenanceRepository: provenance({ exact: { source_sha256: sourceHash } }),
    sourceHash,
    migrations
  }), 'ELIGIBLE');
});

test('runtime releases the read-only transaction before resolving candidate assets', async () => {
  const sourceHash = 'e'.repeat(64);
  const migrations = [{ version: '001_init_schema.sql', checksum: 'f'.repeat(64) }];
  let inTransaction = false;
  let poolClosed = false;
  let observerDependencies;

  class ProvenanceRepository {
    async findPassedImportBySourceHash(value) {
      return value === sourceHash ? { source_sha256: value, status: 'passed' } : null;
    }
    async findLatestPassedImport() { return null; }
    async listAppliedMigrations() { return migrations; }
  }
  class EmptyRepository { constructor() {} }
  class FakeAdapter {
    async loadSnapshot({ key, channel }) {
      assert.equal(inTransaction, true);
      return { qr: { id: 'QR_PUBLIC_1', lifecycle_status: 'activated' }, key, channel };
    }
    async present(snapshot, { assetResolver }) {
      assert.equal(inTransaction, false);
      assert.ok(assetResolver);
      return { id: snapshot.qr.id, activation_status: snapshot.qr.lifecycle_status };
    }
  }
  class FakeSink {
    enqueue() { return { accepted: true, completion: Promise.resolve(true) }; }
    async flush() {}
  }

  const runtime = createPublicQrShadowRuntime(enabledConfig(), {
    env: {
      PGHOST: '127.0.0.1',
      PGUSER: 'test',
      PGDATABASE: 'shadow_test',
      PGSSL: 'false'
    },
    createPool: ({ config }) => {
      assert.equal(config.poolMax, 2);
      assert.equal(config.connectionTimeoutMillis, 250);
      return { type: 'fake-pool' };
    },
    closePool: async () => { poolClosed = true; },
    transactionRunner: async (_pool, callback, options) => {
      assert.deepEqual(options, { isolationLevel: 'repeatable read', readOnly: true });
      inTransaction = true;
      try {
        return await callback({ query: async () => ({ rows: [] }) });
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
    compareDtos: () => ({ matches: true, mismatch_count: 0, mismatches: [] }),
    SinkClass: FakeSink,
    createObserver: (dependencies) => {
      observerDependencies = dependencies;
      return {
        observe: (event) => dependencies.readCandidate({ ...event, timeoutMs: 250 }),
        close: () => {}
      };
    },
    storageModeReader: () => 'local'
  });
  const candidate = await runtime.observer.observe({
    key: 'public-token',
    channel: 'h5',
    sourceHash,
    assetResolver: { resolveRecordImage: () => 'resolved' }
  });
  assert.equal(observerDependencies !== undefined, true);
  assert.deepEqual(candidate, {
    eligibility: 'ELIGIBLE',
    lifecycle: 'activated',
    dto: { id: 'QR_PUBLIC_1', activation_status: 'activated' }
  });
  await runtime.close();
  assert.equal(poolClosed, true);
});

test('server shutdown closes HTTP and shadow runtime once before exiting', async () => {
  const calls = [];
  let finishHttpClose;
  let finishShadowClose;
  const server = {
    close: (callback) => {
      calls.push('http-close');
      finishHttpClose = callback;
    }
  };
  const closeShadowRuntime = () => new Promise((resolve) => {
    calls.push('shadow-close');
    finishShadowClose = resolve;
  });
  const processObject = { exit: (code) => calls.push(`exit-${code}`) };
  const timers = [];
  const shutdown = createShutdownHandler({
    server,
    closeShadowRuntime,
    processObject,
    setTimer: (callback) => {
      const timer = { callback, unref: () => calls.push('timer-unref') };
      timers.push(timer);
      return timer;
    },
    clearTimer: () => calls.push('timer-clear')
  });

  const first = shutdown();
  const second = shutdown();
  assert.equal(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.length, 1);
  assert.deepEqual(calls.slice(0, 3), ['timer-unref', 'http-close', 'shadow-close']);

  finishHttpClose();
  finishShadowClose();
  await first;
  assert.equal(calls.filter((call) => call === 'http-close').length, 1);
  assert.equal(calls.filter((call) => call === 'shadow-close').length, 1);
  assert.deepEqual(calls.slice(-2), ['timer-clear', 'exit-0']);
});
