'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  readIdentityAuthorityConfig
} = require('../src/server/services/postgres/identityAuthorityConfig');
const {
  createIdentityAuthorityController,
  createIdentityAuthorityRuntime
} = require('../src/server/services/postgres/identityAuthorityRuntime');
const {
  checkSourceAndDomainFreshness
} = require('../src/server/services/postgres/publicQrFreshness');

const SOURCE_HASH = 'a'.repeat(64);
const DOMAIN_HASH = 'b'.repeat(64);

function enabledConfig(overrides = {}) {
  return {
    enabled: true,
    requested: true,
    reason: 'ENABLED',
    scope: 'all',
    sourceHash: SOURCE_HASH,
    domainHash: DOMAIN_HASH,
    timeoutMs: 2_000,
    ...overrides
  };
}

test('identity authority config is default-off and requires one explicit all scope', () => {
  assert.deepEqual(
    {
      enabled: readIdentityAuthorityConfig({}).enabled,
      requested: readIdentityAuthorityConfig({}).requested,
      reason: readIdentityAuthorityConfig({}).reason
    },
    { enabled: false, requested: false, reason: 'DISABLED_BY_DEFAULT' }
  );
  assert.equal(readIdentityAuthorityConfig({
    IDENTITY_POSTGRES_AUTHORITY_ENABLED: 'false'
  }).reason, 'EXPLICITLY_DISABLED');
  assert.equal(readIdentityAuthorityConfig({
    IDENTITY_POSTGRES_AUTHORITY_ENABLED: 'yes'
  }).reason, 'INVALID_ENABLED_VALUE');
  assert.equal(readIdentityAuthorityConfig({
    IDENTITY_POSTGRES_AUTHORITY_ENABLED: 'true'
  }).reason, 'SCOPE_ALL_REQUIRED');
  assert.equal(readIdentityAuthorityConfig({
    IDENTITY_POSTGRES_AUTHORITY_ENABLED: 'true',
    IDENTITY_POSTGRES_AUTHORITY_SCOPE: 'allowlist'
  }).reason, 'SCOPE_ALL_REQUIRED');
  assert.equal(readIdentityAuthorityConfig({
    IDENTITY_POSTGRES_AUTHORITY_ENABLED: 'true',
    IDENTITY_POSTGRES_AUTHORITY_SCOPE: 'all',
    IDENTITY_POSTGRES_AUTHORITY_ALLOWLIST: 'ACC000002'
  }).reason, 'ALLOWLIST_FORBIDDEN');
  assert.equal(readIdentityAuthorityConfig({
    IDENTITY_POSTGRES_AUTHORITY_ENABLED: 'true',
    IDENTITY_POSTGRES_AUTHORITY_SCOPE: 'all',
    IDENTITY_POSTGRES_AUTHORITY_SOURCE_SHA256: SOURCE_HASH
  }).reason, 'DOMAIN_SHA256_REQUIRED');

  const config = readIdentityAuthorityConfig({
    IDENTITY_POSTGRES_AUTHORITY_ENABLED: 'true',
    IDENTITY_POSTGRES_AUTHORITY_SCOPE: 'all',
    IDENTITY_POSTGRES_AUTHORITY_SOURCE_SHA256: SOURCE_HASH.toUpperCase(),
    IDENTITY_POSTGRES_AUTHORITY_DOMAIN_SHA256: DOMAIN_HASH.toUpperCase()
  });
  assert.equal(config.enabled, true);
  assert.equal(config.scope, 'all');
  assert.equal(config.sourceHash, SOURCE_HASH);
  assert.equal(config.domainHash, DOMAIN_HASH);
});

test('identity authority controller stays lazy, fails closed, and drains operations', async () => {
  let runtimeCalls = 0;
  let closeCalls = 0;
  let finishOperation;
  const disabled = createIdentityAuthorityController({
    readConfig: () => readIdentityAuthorityConfig({}),
    runtimeFactory: () => { runtimeCalls += 1; }
  });
  assert.deepEqual(await disabled.invoke('getAuthenticatedIdentity'), {
    selected: false
  });
  assert.equal(runtimeCalls, 0);

  const invalid = createIdentityAuthorityController({
    readConfig: () => ({ enabled: false, requested: true })
  });
  await assert.rejects(
    invalid.invoke('getAuthenticatedIdentity'),
    (error) => error.code === 'IDENTITY_POSTGRES_AUTHORITY_CONFIG_INVALID'
  );

  const controller = createIdentityAuthorityController({
    readConfig: () => enabledConfig(),
    runtimeFactory: () => {
      runtimeCalls += 1;
      return {
        invoke: () => new Promise((resolve) => { finishOperation = resolve; }),
        close: async () => { closeCalls += 1; }
      };
    }
  });
  const pending = controller.invoke('getAuthenticatedIdentity', { identityId: '1' });
  await new Promise((resolve) => setImmediate(resolve));
  const closing = controller.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeCalls, 0);
  finishOperation({ data: { id: 1, account_id: 'ACC000001' } });
  assert.deepEqual(await pending, {
    selected: true,
    result: { data: { id: 1, account_id: 'ACC000001' } }
  });
  await closing;
  assert.equal(runtimeCalls, 1);
  assert.equal(closeCalls, 1);
});

test('identity authority runtime gates reads and writes with source-domain provenance', async () => {
  const migrations = [{ version: '001.sql', checksum: 'c'.repeat(64) }];
  const transactionOptions = [];
  const freshnessCalls = [];
  let beforeWrite;
  let poolClosed = 0;

  class EmptyRepository { constructor(context) { this.context = context; } }
  class FakeReadAdapter {
    async getAuthenticatedIdentity(input) {
      return { data: { id: input.identityId, account_id: input.accountId } };
    }
  }

  const runtime = createIdentityAuthorityRuntime(enabledConfig(), {
    env: {
      PGHOST: '127.0.0.1', PGUSER: 'test', PGDATABASE: 'identity_test', PGSSL: 'false'
    },
    createPool: ({ config }) => {
      assert.equal(config.poolMax, 2);
      assert.equal(config.applicationName, 'xingxingzaishan-identity-authority');
      return {};
    },
    closePool: async () => { poolClosed += 1; },
    transactionRunner: async (_pool, callback, options) => {
      transactionOptions.push(options);
      return callback({ query: async () => {} });
    },
    migrationsLoader: () => migrations,
    repositoryTypes: {
      PublicQrProvenanceRepository: EmptyRepository,
      IdentityRepository: EmptyRepository,
      AccountRepository: EmptyRepository
    },
    readAdapterClass: FakeReadAdapter,
    writeServiceFactory: ({ beforeOperation }) => {
      beforeWrite = beforeOperation;
      return {
        createOrGetWebIdentity: async (input) => {
          await beforeWrite({ transactionContext: { query: async () => {} }, input });
          return { id: 91, phone: input.phone, account_id: 'ACC000091' };
        },
        createOrGetMiniappIdentity: async () => ({}),
        bindMiniappPhone: async () => ({ error: 'NOT_USED' })
      };
    },
    freshnessChecker: async (input) => {
      freshnessCalls.push(input);
      return 'ELIGIBLE';
    }
  });

  assert.deepEqual(await runtime.invoke('getAuthenticatedIdentity', {
    identityId: '91', accountId: 'ACC000091'
  }), { data: { id: '91', account_id: 'ACC000091' } });
  assert.deepEqual(await runtime.invoke('createOrGetWebIdentity', {
    phone: '13800000091'
  }), {
    data: { id: 91, phone: '13800000091', account_id: 'ACC000091' }
  });
  assert.equal(freshnessCalls.length, 2);
  freshnessCalls.forEach((call) => {
    assert.equal(call.sourceHash, SOURCE_HASH);
    assert.equal(call.domainHash, DOMAIN_HASH);
    assert.deepEqual(call.migrations, migrations);
  });
  assert.deepEqual(transactionOptions, [
    { isolationLevel: 'repeatable read', readOnly: true }
  ]);
  await runtime.close();
  await runtime.close();
  assert.equal(poolClosed, 1);
});

test('combined freshness requires source and domain on the same passed import', async () => {
  const migrations = [{ version: '001.sql', checksum: 'c'.repeat(64) }];
  const repository = {
    findPassedImportBySourceHash: async () => ({
      source_sha256: SOURCE_HASH,
      public_qr_domain_sha256: DOMAIN_HASH
    }),
    findLatestPassedImport: async () => ({ source_sha256: SOURCE_HASH }),
    listAppliedMigrations: async () => migrations
  };
  assert.equal(await checkSourceAndDomainFreshness({
    provenanceRepository: repository,
    sourceHash: SOURCE_HASH,
    domainHash: DOMAIN_HASH,
    migrations
  }), 'ELIGIBLE');
  assert.equal(await checkSourceAndDomainFreshness({
    provenanceRepository: repository,
    sourceHash: SOURCE_HASH,
    domainHash: 'd'.repeat(64),
    migrations
  }), 'STALE_DOMAIN');
});
