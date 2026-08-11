'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  readQrIssuanceAuthorityConfig
} = require('../src/server/services/postgres/qrIssuanceAuthorityConfig');
const {
  createQrIssuanceAuthorityController,
  createQrIssuanceAuthorityRuntime
} = require('../src/server/services/postgres/qrIssuanceAuthorityRuntime');
const {
  QrIssuanceError,
  createQrIssuanceService
} = require('../src/server/services/postgres/qrIssuanceService');

const SOURCE_HASH = 'a'.repeat(64);
const DOMAIN_HASH = 'b'.repeat(64);

function enabledConfig() {
  return {
    enabled: true,
    requested: true,
    reason: 'ENABLED',
    scope: 'all',
    sourceHash: SOURCE_HASH,
    domainHash: DOMAIN_HASH,
    timeoutMs: 5_000
  };
}

test('QR issuance authority is default-off and requires one all scope', () => {
  assert.equal(readQrIssuanceAuthorityConfig({}).reason, 'DISABLED_BY_DEFAULT');
  assert.equal(readQrIssuanceAuthorityConfig({
    QR_ISSUANCE_POSTGRES_AUTHORITY_ENABLED: 'true'
  }).reason, 'SCOPE_ALL_REQUIRED');
  assert.equal(readQrIssuanceAuthorityConfig({
    QR_ISSUANCE_POSTGRES_AUTHORITY_ENABLED: 'true',
    QR_ISSUANCE_POSTGRES_AUTHORITY_SCOPE: 'all',
    QR_ISSUANCE_POSTGRES_AUTHORITY_ALLOWLIST: 'A00001'
  }).reason, 'ALLOWLIST_FORBIDDEN');
  assert.equal(readQrIssuanceAuthorityConfig({
    QR_ISSUANCE_POSTGRES_AUTHORITY_ENABLED: 'true',
    QR_ISSUANCE_POSTGRES_AUTHORITY_SCOPE: 'all',
    QR_ISSUANCE_POSTGRES_AUTHORITY_SOURCE_SHA256: SOURCE_HASH
  }).reason, 'DOMAIN_SHA256_REQUIRED');
  const config = readQrIssuanceAuthorityConfig({
    QR_ISSUANCE_POSTGRES_AUTHORITY_ENABLED: 'true',
    QR_ISSUANCE_POSTGRES_AUTHORITY_SCOPE: 'all',
    QR_ISSUANCE_POSTGRES_AUTHORITY_SOURCE_SHA256: SOURCE_HASH,
    QR_ISSUANCE_POSTGRES_AUTHORITY_DOMAIN_SHA256: DOMAIN_HASH
  });
  assert.equal(config.enabled, true);
  assert.equal(config.scope, 'all');
});

test('QR issuance service serializes a prefix and commits staged images', async () => {
  const events = [];
  const inserted = [];
  let tokenByte = 1;
  class Repository {
    async lockPrefix(prefix) { events.push(`lock:${prefix}`); }
    async batchExists(batchId) { events.push(`batch:${batchId}`); return true; }
    async findMaxSequence(prefix) { events.push(`max:${prefix}`); return 7; }
    async insertIssued(input) {
      events.push(`insert:${input.id}`);
      inserted.push(input);
      return {
        id: input.id,
        issue_status: 'issued',
        lifecycle_status: 'unactivated',
        hidden: false,
        batch_id: input.batch_id,
        print_batch_id: null,
        qr_image_url_snapshot: input.qr_image_url_snapshot,
        access_token: input.access_token,
        created_at: input.created_at,
        updated_at: input.created_at
      };
    }
  }
  const service = createQrIssuanceService({
    pool: { connect() {} },
    transactionRunner: async (_pool, callback, options) => {
      assert.deepEqual(options, { isolationLevel: 'read committed' });
      return callback({ query: async () => {} });
    },
    repositoryType: Repository,
    beforeOperation: async () => { events.push('freshness'); },
    clock: () => new Date('2026-08-12T01:02:03.000Z'),
    randomBytes: () => Buffer.alloc(16, tokenByte++),
    renderImage: async ({ qrId }) => Buffer.from(`png:${qrId}`),
    imagePath: (id) => `/isolated/${id}.png`,
    stageImage: (target, image) => {
      events.push(`stage:${target}:${image.toString()}`);
      return {
        commit: () => events.push(`commit:${target}`),
        rollback: () => events.push(`rollback:${target}`)
      };
    }
  });
  const result = await service.issue({
    prefix: 'NEW', count: 2, batchId: 'BATCH_PUBLIC', baseUrl: 'https://example.test'
  });
  assert.deepEqual(result.data.ids, ['NEW00008', 'NEW00009']);
  assert.equal(result.data.records[0].activation_status, 'unactivated');
  assert.equal(result.data.records[0].qr_image_url.startsWith('/api/qr/image/'), true);
  assert.equal(inserted[0].access_token.length, 32);
  assert.deepEqual(events.slice(0, 4), [
    'freshness', 'lock:NEW', 'batch:BATCH_PUBLIC', 'max:NEW'
  ]);
  assert.equal(events.filter((item) => item.startsWith('commit:')).length, 2);
  assert.equal(events.some((item) => item.startsWith('rollback:')), false);
});

test('QR issuance rolls staged images back and rejects missing batches', async () => {
  const events = [];
  class Repository {
    async lockPrefix() {}
    async batchExists() { return false; }
    async findMaxSequence() { return 0; }
    async insertIssued() { throw new Error('must not insert'); }
  }
  const service = createQrIssuanceService({
    pool: { connect() {} },
    transactionRunner: async (_pool, callback) => callback({ query: async () => {} }),
    repositoryType: Repository
  });
  await assert.rejects(
    service.issue({ prefix: 'NEW', count: 1, batchId: 'MISSING' }),
    (error) => error instanceof QrIssuanceError && error.code === 'BATCH_NOT_FOUND'
  );

  class FailingRepository extends Repository {
    async batchExists() { return true; }
    async insertIssued(input) {
      if (input.id === 'NEW00002') throw new Error('INSERT_FAILED');
      return {
        ...input,
        issue_status: 'issued', lifecycle_status: 'unactivated', hidden: false,
        print_batch_id: null
      };
    }
  }
  const failing = createQrIssuanceService({
    pool: { connect() {} },
    transactionRunner: async (_pool, callback) => callback({ query: async () => {} }),
    repositoryType: FailingRepository,
    randomBytes: () => Buffer.alloc(16, 7),
    renderImage: async () => Buffer.from('png'),
    imagePath: (id) => `/isolated/${id}.png`,
    stageImage: (target) => ({
      commit: () => events.push(`commit:${target}`),
      rollback: () => events.push(`rollback:${target}`)
    })
  });
  await assert.rejects(failing.issue({ prefix: 'NEW', count: 2 }));
  assert.deepEqual(events, [
    'rollback:/isolated/NEW00002.png',
    'rollback:/isolated/NEW00001.png'
  ]);
});

test('QR issuance authority verifies provenance inside the write transaction', async () => {
  const migrations = [{ version: '001.sql', checksum: 'c'.repeat(64) }];
  const calls = [];
  let beforeOperation;
  let closeCount = 0;
  class EmptyRepository { constructor(context) { this.context = context; } }
  const runtime = createQrIssuanceAuthorityRuntime(enabledConfig(), {
    env: {
      PGHOST: '127.0.0.1', PGUSER: 'test', PGDATABASE: 'issuance_test', PGSSL: 'false'
    },
    createPool: ({ config }) => {
      assert.equal(config.applicationName, 'xingxingzaishan-qr-issuance-authority');
      return { connect() {} };
    },
    closePool: async () => { closeCount += 1; },
    transactionRunner: async (_pool, callback) => callback({ query: async () => {} }),
    migrationsLoader: () => migrations,
    repositoryTypes: {
      PublicQrProvenanceRepository: EmptyRepository,
      QrIssuanceRepository: EmptyRepository
    },
    freshnessChecker: async (input) => {
      calls.push(input);
      return 'ELIGIBLE';
    },
    issuanceServiceFactory: (options) => {
      beforeOperation = options.beforeOperation;
      return {
        issue: async () => {
          await beforeOperation({ transactionContext: { query: async () => {} } });
          return { data: { count: 1, ids: ['NEW00001'], records: [] } };
        }
      };
    }
  });
  assert.equal((await runtime.issue({ prefix: 'NEW', count: 1 })).data.count, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sourceHash, SOURCE_HASH);
  assert.equal(calls[0].domainHash, DOMAIN_HASH);
  assert.deepEqual(calls[0].migrations, migrations);
  await runtime.close();
  await runtime.close();
  assert.equal(closeCount, 1);
});

test('QR issuance controller stays lazy and drains selected operations', async () => {
  let runtimeCount = 0;
  let closeCount = 0;
  let finish;
  const disabled = createQrIssuanceAuthorityController({
    readConfig: () => readQrIssuanceAuthorityConfig({}),
    runtimeFactory: () => { runtimeCount += 1; }
  });
  assert.deepEqual(await disabled.issue({}), { selected: false });
  assert.equal(runtimeCount, 0);

  const controller = createQrIssuanceAuthorityController({
    readConfig: () => enabledConfig(),
    runtimeFactory: () => {
      runtimeCount += 1;
      return {
        issue: () => new Promise((resolve) => { finish = resolve; }),
        close: async () => { closeCount += 1; }
      };
    }
  });
  const pending = controller.issue({ prefix: 'NEW', count: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  const closing = controller.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeCount, 0);
  finish({ data: { count: 1 } });
  assert.equal((await pending).selected, true);
  await closing;
  assert.equal(runtimeCount, 1);
  assert.equal(closeCount, 1);
});
