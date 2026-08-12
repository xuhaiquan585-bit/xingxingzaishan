'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  readPersonalRecordPrimaryReadConfig
} = require('../src/server/services/postgres/personalRecordPrimaryReadConfig');
const {
  PersonalRecordPrimaryReadError,
  createPersonalRecordPrimaryReadController,
  createPersonalRecordPrimaryReadRuntime,
  personalRecordPrimaryReadHttpError
} = require('../src/server/services/postgres/personalRecordPrimaryReadRuntime');

const DOMAIN_HASH = 'a'.repeat(64);
const BASELINE_DOMAIN_HASH = 'c'.repeat(64);

function enabledConfig(overrides = {}) {
  return {
    enabled: true,
    requested: true,
    reason: 'ENABLED',
    scope: 'allowlist',
    allowlist: new Set(['ACC000002']),
    domainHash: DOMAIN_HASH,
    baselineDomainHash: DOMAIN_HASH,
    timeoutMs: 500,
    ...overrides
  };
}

test('personal record primary config is strict, account-scoped, and default-off', () => {
  assert.deepEqual(
    {
      enabled: readPersonalRecordPrimaryReadConfig({}).enabled,
      requested: readPersonalRecordPrimaryReadConfig({}).requested,
      reason: readPersonalRecordPrimaryReadConfig({}).reason
    },
    { enabled: false, requested: false, reason: 'DISABLED_BY_DEFAULT' }
  );
  assert.equal(readPersonalRecordPrimaryReadConfig({
    PERSONAL_RECORD_POSTGRES_READ_ENABLED: 'false'
  }).requested, false);
  assert.equal(readPersonalRecordPrimaryReadConfig({
    PERSONAL_RECORD_POSTGRES_READ_ENABLED: 'TRUE'
  }).reason, 'INVALID_ENABLED_VALUE');
  assert.equal(readPersonalRecordPrimaryReadConfig({
    PERSONAL_RECORD_POSTGRES_READ_ENABLED: 'true'
  }).reason, 'ALLOWLIST_REQUIRED');
  assert.equal(readPersonalRecordPrimaryReadConfig({
    PERSONAL_RECORD_POSTGRES_READ_ENABLED: 'true',
    PERSONAL_RECORD_POSTGRES_READ_ALLOWLIST: 'https://private-token'
  }).reason, 'ALLOWLIST_INVALID');
  assert.equal(readPersonalRecordPrimaryReadConfig({
    PERSONAL_RECORD_POSTGRES_READ_ENABLED: 'true',
    PERSONAL_RECORD_POSTGRES_READ_ALLOWLIST: 'ACC000002',
    PERSONAL_RECORD_POSTGRES_READ_DOMAIN_SHA256: 'invalid'
  }).reason, 'DOMAIN_SHA256_REQUIRED');
  assert.equal(readPersonalRecordPrimaryReadConfig({
    PERSONAL_RECORD_POSTGRES_READ_ENABLED: 'true',
    PERSONAL_RECORD_POSTGRES_READ_SCOPE: 'future',
    PERSONAL_RECORD_POSTGRES_READ_DOMAIN_SHA256: DOMAIN_HASH
  }).reason, 'SCOPE_INVALID');
  assert.equal(readPersonalRecordPrimaryReadConfig({
    PERSONAL_RECORD_POSTGRES_READ_ENABLED: 'true',
    PERSONAL_RECORD_POSTGRES_READ_SCOPE: 'all',
    PERSONAL_RECORD_POSTGRES_READ_ALLOWLIST: 'ACC000002',
    PERSONAL_RECORD_POSTGRES_READ_DOMAIN_SHA256: DOMAIN_HASH
  }).reason, 'ALLOWLIST_FORBIDDEN_FOR_ALL_SCOPE');
  assert.equal(readPersonalRecordPrimaryReadConfig({
    PERSONAL_RECORD_POSTGRES_READ_ENABLED: 'true',
    PERSONAL_RECORD_POSTGRES_READ_SCOPE: 'all',
    PERSONAL_RECORD_POSTGRES_READ_DOMAIN_SHA256: DOMAIN_HASH,
    POSTGRES_AUTHORITY_BASELINE_DOMAIN_SHA256: 'invalid'
  }).reason, 'BASELINE_DOMAIN_SHA256_INVALID');

  const config = readPersonalRecordPrimaryReadConfig({
    PERSONAL_RECORD_POSTGRES_READ_ENABLED: 'true',
    PERSONAL_RECORD_POSTGRES_READ_ALLOWLIST: 'ACC000002, ACC000003',
    PERSONAL_RECORD_POSTGRES_READ_DOMAIN_SHA256: DOMAIN_HASH
  });
  assert.equal(config.enabled, true);
  assert.equal(config.scope, 'allowlist');
  assert.deepEqual([...config.allowlist], ['ACC000002', 'ACC000003']);
  assert.equal(config.domainHash, DOMAIN_HASH);
  assert.equal(config.baselineDomainHash, DOMAIN_HASH);
});

test('personal record primary all scope is explicit and needs no static account list', () => {
  const config = readPersonalRecordPrimaryReadConfig({
    PERSONAL_RECORD_POSTGRES_READ_ENABLED: 'true',
    PERSONAL_RECORD_POSTGRES_READ_SCOPE: 'all',
    PERSONAL_RECORD_POSTGRES_READ_DOMAIN_SHA256: DOMAIN_HASH,
    POSTGRES_AUTHORITY_BASELINE_DOMAIN_SHA256: BASELINE_DOMAIN_HASH
  });
  assert.equal(config.enabled, true);
  assert.equal(config.scope, 'all');
  assert.equal(config.allowlist.size, 0);
  assert.equal(config.domainHash, DOMAIN_HASH);
  assert.equal(config.baselineDomainHash, BASELINE_DOMAIN_HASH);
});

test('personal primary controller stays lazy for default-off and account misses', async () => {
  let runtimeCalls = 0;
  const disabled = createPersonalRecordPrimaryReadController({
    env: {},
    runtimeFactory: () => { runtimeCalls += 1; }
  });
  assert.deepEqual(await disabled.read({ accountId: 'ACC000002' }), { selected: false });

  const missed = createPersonalRecordPrimaryReadController({
    readConfig: () => enabledConfig(),
    runtimeFactory: () => { runtimeCalls += 1; }
  });
  assert.deepEqual(await missed.read({
    accountId: 'ACC000003',
    domainHash: DOMAIN_HASH
  }), { selected: false });
  assert.equal(runtimeCalls, 0);
  await disabled.close();
  await missed.close();
});

test('personal primary all scope selects a future canonical account ID', async () => {
  let runtimeCalls = 0;
  const controller = createPersonalRecordPrimaryReadController({
    readConfig: () => enabledConfig({
      scope: 'all',
      allowlist: new Set(),
      baselineDomainHash: BASELINE_DOMAIN_HASH
    }),
    runtimeFactory: (config) => {
      runtimeCalls += 1;
      assert.equal(config.scope, 'all');
      return {
        read: async () => ({ dto: { total: 0, records: [] } }),
        close: async () => {}
      };
    }
  });
  assert.deepEqual(await controller.read({
    accountId: 'ACC_FUTURE_0001',
    domainHash: BASELINE_DOMAIN_HASH,
    readKind: 'list'
  }), {
    selected: true,
    dto: { total: 0, records: [] }
  });
  assert.equal(runtimeCalls, 1);
  await controller.close();
});

test('personal primary controller fails closed for partial config and domain drift', async () => {
  let runtimeCalls = 0;
  const invalid = createPersonalRecordPrimaryReadController({
    readConfig: () => ({ enabled: false, requested: true }),
    runtimeFactory: () => { runtimeCalls += 1; }
  });
  await assert.rejects(
    invalid.read({ accountId: 'ACC000002' }),
    (error) => error.code === 'PERSONAL_RECORD_POSTGRES_READ_CONFIG_INVALID'
  );

  const conflictingScope = createPersonalRecordPrimaryReadController({
    readConfig: () => enabledConfig({ scope: 'all' }),
    runtimeFactory: () => { runtimeCalls += 1; }
  });
  await assert.rejects(
    conflictingScope.read({ accountId: 'ACC000002', domainHash: DOMAIN_HASH }),
    (error) => error.code === 'PERSONAL_RECORD_POSTGRES_READ_CONFIG_INVALID'
  );

  const drifted = createPersonalRecordPrimaryReadController({
    readConfig: () => enabledConfig(),
    runtimeFactory: () => { runtimeCalls += 1; }
  });
  await assert.rejects(
    drifted.read({ accountId: 'ACC000002', domainHash: 'b'.repeat(64) }),
    (error) => error.code === 'PERSONAL_RECORD_POSTGRES_READ_DOMAIN_MISMATCH'
  );
  assert.equal(runtimeCalls, 0);
  await conflictingScope.close();
});

test('personal primary controller reuses one runtime and drains reads before closing', async () => {
  let finishRead;
  let runtimeCalls = 0;
  let closeCalls = 0;
  const controller = createPersonalRecordPrimaryReadController({
    readConfig: () => enabledConfig(),
    runtimeFactory: () => {
      runtimeCalls += 1;
      return {
        read: () => new Promise((resolve) => { finishRead = resolve; }),
        close: async () => { closeCalls += 1; }
      };
    }
  });
  const reading = controller.read({
    accountId: 'ACC000002',
    domainHash: DOMAIN_HASH,
    readKind: 'list'
  });
  await new Promise((resolve) => setImmediate(resolve));
  const closing = controller.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeCalls, 0);
  finishRead({ dto: { total: 0, records: [] } });
  assert.equal((await reading).selected, true);
  await closing;
  await controller.close();
  assert.equal(runtimeCalls, 1);
  assert.equal(closeCalls, 1);
});

test('personal primary runtime verifies domain freshness in a read-only transaction', async () => {
  const migrations = [{ version: '001.sql', checksum: 'b'.repeat(64) }];
  let inTransaction = false;
  let poolClosed = 0;

  class EmptyRepository { constructor() {} }
  class ProvenanceRepository { constructor(context) { this.context = context; } }
  class FakeAdapter {
    async loadSnapshot(input) {
      assert.equal(inTransaction, true);
      assert.equal(input.accountId, 'ACC000002');
      assert.equal(input.readKind, 'detail');
      return { readKind: 'detail', recordId: input.recordId };
    }
    async present(snapshot, { assetResolver }) {
      assert.equal(inTransaction, false);
      assert.equal(assetResolver.name, 'request-assets');
      return { id: snapshot.recordId, content: 'record' };
    }
  }

  const runtime = createPersonalRecordPrimaryReadRuntime(enabledConfig(), {
    env: {
      PGHOST: '127.0.0.1', PGUSER: 'test', PGDATABASE: 'personal_test', PGSSL: 'false'
    },
    createPool: ({ config }) => {
      assert.equal(config.poolMax, 2);
      assert.equal(config.connectionTimeoutMillis, 500);
      assert.equal(config.applicationName, 'xingxingzaishan-personal-record-primary-read');
      return {};
    },
    closePool: async () => { poolClosed += 1; },
    transactionRunner: async (_pool, callback, options) => {
      assert.deepEqual(options, { isolationLevel: 'repeatable read', readOnly: true });
      inTransaction = true;
      try {
        return await callback({ query: async () => {} });
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
    freshnessChecker: async ({ domainHash, migrations: actualMigrations }) => {
      assert.equal(domainHash, DOMAIN_HASH);
      assert.deepEqual(actualMigrations, migrations);
      return 'ELIGIBLE';
    },
    storageModeReader: () => 'local'
  });

  assert.deepEqual(await runtime.read({
    readKind: 'detail',
    accountId: 'ACC000002',
    recordId: 'SSS00004',
    channel: 'h5',
    assetResolver: { name: 'request-assets' }
  }), { dto: { id: 'SSS00004', content: 'record' } });
  await runtime.close();
  await runtime.close();
  assert.equal(poolClosed, 1);
});

test('personal primary runtime rejects stale provenance and detail identity drift', async () => {
  class EmptyRepository { constructor() {} }
  class FakeAdapter {
    async loadSnapshot(input) { return { readKind: input.readKind }; }
    async present() { return { id: 'OTHER_RECORD' }; }
  }
  function makeRuntime(freshnessChecker) {
    return createPersonalRecordPrimaryReadRuntime(enabledConfig(), {
      env: { PGHOST: '127.0.0.1', PGUSER: 'test', PGDATABASE: 'test', PGSSL: 'false' },
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
    stale.read({ readKind: 'list', accountId: 'ACC000002', channel: 'h5' }),
    (error) => error.code === 'PERSONAL_RECORD_POSTGRES_READ_STALE_SOURCE'
  );
  await stale.close();

  const drifted = makeRuntime(async () => 'ELIGIBLE');
  await assert.rejects(
    drifted.read({
      readKind: 'detail', accountId: 'ACC000002', recordId: 'SSS00004', channel: 'h5'
    }),
    (error) => error.code === 'PERSONAL_RECORD_POSTGRES_READ_IDENTITY_MISMATCH'
  );
  await drifted.close();
});

test('personal primary HTTP errors preserve ownership-safe not-found and hide failures', () => {
  assert.deepEqual(personalRecordPrimaryReadHttpError({
    code: 'PERSONAL_RECORD_NOT_FOUND'
  }), {
    status: 404,
    code: 'RECORD_NOT_FOUND',
    message: '未找到该记录，或你无权查看。'
  });
  const unavailable = personalRecordPrimaryReadHttpError(
    new PersonalRecordPrimaryReadError('PERSONAL_RECORD_POSTGRES_READ_STALE_SOURCE')
  );
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.code, 'PERSONAL_RECORD_READ_UNAVAILABLE');
  assert.equal(JSON.stringify(unavailable).includes('STALE_SOURCE'), false);
});

test('both personal record route families and shutdown wire the primary runtime', () => {
  const repositoryRoot = path.join(__dirname, '..');
  const h5Route = fs.readFileSync(
    path.join(repositoryRoot, 'src/server/routes/user.js'),
    'utf8'
  );
  const miniappRoute = fs.readFileSync(
    path.join(repositoryRoot, 'src/server/routes/miniapp.js'),
    'utf8'
  );
  const server = fs.readFileSync(
    path.join(repositoryRoot, 'src/server/server.js'),
    'utf8'
  );
  assert.match(h5Route, /await readPersonalRecordPrimary\(/);
  assert.match(miniappRoute, /await readPersonalRecordPrimary\(/);
  assert.match(h5Route, /handleRecords\(req, res\)\.catch\(next\)/);
  assert.match(miniappRoute, /handleMiniappPersonalRecords\(req, res\)\.catch\(next\)/);
  assert.match(server, /closePersonalRecordPrimaryReadRuntime\(\)/);
});
