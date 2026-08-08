'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  readRecordProofRuntimeConfig
} = require('../src/server/services/postgres/recordProofRuntimeConfig');
const {
  createRecordProofRuntime,
  createRecordProofRuntimeController
} = require('../src/server/services/postgres/recordProofRuntime');

function enabledEnv(overrides = {}) {
  return {
    RECORD_PROOF_RUNTIME_ENABLED: 'true',
    RECORD_PROOF_RUNTIME_ALLOWLIST: 'QR_ALLOWED,QR_SECOND',
    RECORD_PROOF_RUNTIME_SOURCE_SHA256: 'a'.repeat(64),
    RECORD_PROOF_WORKER_ID: 'proof-worker-test',
    CHAIN_ENABLED: 'true',
    CHAIN_CALLBACK_URL: 'https://example.test/api/chain/avata/callback',
    AVATA_API_KEY: 'api-key',
    AVATA_API_SECRET: 'api-secret',
    AVATA_IDENTITY_NAME: 'identity-name',
    AVATA_IDENTITY_NUM: 'identity-number',
    PGHOST: '127.0.0.1',
    PGPORT: '5432',
    PGUSER: 'app',
    PGPASSWORD: 'secret',
    PGDATABASE: 'isolated',
    PGSSL: 'false',
    NODE_ENV: 'test',
    ...overrides
  };
}

test('record proof runtime config is default-off and requires complete real-provider gates', () => {
  assert.equal(readRecordProofRuntimeConfig({}).reason, 'DISABLED_BY_DEFAULT');
  assert.equal(readRecordProofRuntimeConfig({
    ...enabledEnv(),
    RECORD_PROOF_RUNTIME_ALLOWLIST: ''
  }).reason, 'ALLOWLIST_REQUIRED');
  assert.equal(readRecordProofRuntimeConfig({
    ...enabledEnv(),
    RECORD_PROOF_RUNTIME_SOURCE_SHA256: 'invalid'
  }).reason, 'SOURCE_SHA256_REQUIRED');
  assert.equal(readRecordProofRuntimeConfig({
    ...enabledEnv(),
    CHAIN_ENABLED: 'false'
  }).reason, 'CHAIN_PROVIDER_REQUIRED');
  assert.equal(readRecordProofRuntimeConfig({
    ...enabledEnv(),
    AVATA_API_SECRET: ''
  }).reason, 'CHAIN_PROVIDER_CONFIG_REQUIRED');
  assert.equal(readRecordProofRuntimeConfig({
    ...enabledEnv(),
    CHAIN_CALLBACK_URL: 'http://example.test/callback'
  }).reason, 'SECURE_CALLBACK_URL_REQUIRED');

  const config = readRecordProofRuntimeConfig(enabledEnv({
    RECORD_PROOF_WORKER_INTERVAL_MS: '2000',
    RECORD_PROOF_WORKER_BATCH_SIZE: '3'
  }));
  assert.equal(config.enabled, true);
  assert.deepEqual([...config.allowlist], ['QR_ALLOWED', 'QR_SECOND']);
  assert.equal(config.sourceSha256, 'a'.repeat(64));
  assert.equal(config.intervalMs, 2000);
  assert.equal(config.batchSize, 3);
});

test('record proof runtime scopes worker and result handling to one explicit QR set', async () => {
  const config = readRecordProofRuntimeConfig(enabledEnv());
  const pool = { connect() {} };
  const captured = {};
  let workerResolve;
  const workerResult = new Promise((resolve) => {
    workerResolve = resolve;
  });
  let timerCleared = false;
  let poolClosed = false;
  const runtime = createRecordProofRuntime(config, {
    env: enabledEnv(),
    createPool(input) {
      captured.pool = input;
      return pool;
    },
    async closePool(currentPool) {
      assert.equal(currentPool, pool);
      poolClosed = true;
    },
    externalAdapterFactory() {
      return {
        prepareRecord: async () => ({}),
        submitRecord: async () => ({}),
        normalizeRecordResult: (value) => value
      };
    },
    jobHandlerFactory(input) {
      captured.handler = input;
      return async () => {};
    },
    resultServiceFactory(input) {
      captured.result = input;
      return {
        applyCallback: async () => ({ outcome: 'applied', status: 'confirmed' }),
        applyQueryResult: async () => ({ outcome: 'duplicate', status: 'confirmed' })
      };
    },
    workerFactory(input) {
      captured.worker = input;
      return { runOnce: () => workerResult };
    },
    migrationsLoader: () => [{ version: '001.sql', checksum: 'b'.repeat(64) }],
    async eligibilityChecker(input) {
      captured.eligibility = input;
      return 'ELIGIBLE';
    },
    setTimer(callback, delay) {
      captured.timer = { callback, delay, unref() {} };
      return captured.timer;
    },
    clearTimer(timer) {
      assert.equal(timer, captured.timer);
      timerCleared = true;
    }
  });

  assert.equal(captured.pool.config.poolMax, 3);
  assert.equal(
    captured.pool.config.applicationName,
    'xingxingzaishan-record-proof-runtime'
  );
  assert.deepEqual(captured.worker.jobTypes, ['record_proof_prepare_submit']);
  assert.deepEqual(captured.worker.aggregateIds, ['QR_ALLOWED', 'QR_SECOND']);
  assert.deepEqual(captured.result.allowedRecordQrIds, ['QR_ALLOWED', 'QR_SECOND']);
  assert.equal(runtime.start(), true);
  assert.equal(runtime.start(), false);
  assert.equal(captured.timer.delay, 5000);

  const firstRun = runtime.runOnce();
  const secondRun = runtime.runOnce();
  assert.equal(firstRun, secondRun);
  workerResolve({ claimed: 0, succeeded: 0 });
  assert.deepEqual(await firstRun, { claimed: 0, succeeded: 0 });
  assert.equal(captured.eligibility.sourceSha256, 'a'.repeat(64));
  assert.deepEqual(captured.eligibility.migrations, [{
    version: '001.sql',
    checksum: 'b'.repeat(64)
  }]);
  assert.deepEqual(await runtime.applyCallback({}), {
    outcome: 'applied',
    status: 'confirmed'
  });

  await runtime.close();
  assert.equal(timerCleared, true);
  assert.equal(poolClosed, true);
  await assert.rejects(
    runtime.runOnce(),
    (error) => error.code === 'RECORD_PROOF_RUNTIME_CLOSED'
  );
});

test('record proof controller does not construct runtime while disabled', async () => {
  let factoryCalls = 0;
  const controller = createRecordProofRuntimeController({
    env: {},
    readConfig: () => ({ enabled: false, reason: 'DISABLED_BY_DEFAULT' }),
    runtimeFactory() {
      factoryCalls += 1;
      throw new Error('must not run');
    }
  });

  assert.equal(await controller.start(), false);
  assert.deepEqual(await controller.applyCallback({ secret: 'not-read' }), {
    outcome: 'disabled',
    status: null
  });
  assert.equal(factoryCalls, 0);
  await controller.close();
});

test('record proof runtime blocks worker and callbacks when import provenance is stale', async () => {
  const config = readRecordProofRuntimeConfig(enabledEnv());
  let workerCalls = 0;
  let resultCalls = 0;
  const runtime = createRecordProofRuntime(config, {
    env: enabledEnv(),
    createPool: () => ({ connect() {} }),
    closePool: async () => {},
    externalAdapterFactory: () => ({
      prepareRecord: async () => ({}),
      submitRecord: async () => ({}),
      normalizeRecordResult: (value) => value
    }),
    jobHandlerFactory: () => async () => {},
    resultServiceFactory: () => ({
      async applyCallback() {
        resultCalls += 1;
      },
      async applyQueryResult() {
        resultCalls += 1;
      }
    }),
    workerFactory: () => ({
      async runOnce() {
        workerCalls += 1;
      }
    }),
    migrationsLoader: () => [],
    eligibilityChecker: async () => 'STALE_SOURCE'
  });

  await assert.rejects(
    runtime.runOnce(),
    (error) => error.code === 'RECORD_PROOF_RUNTIME_INELIGIBLE'
  );
  await assert.rejects(
    runtime.applyCallback({}),
    (error) => error.code === 'RECORD_PROOF_RUNTIME_INELIGIBLE'
  );
  assert.equal(workerCalls, 0);
  assert.equal(resultCalls, 0);
  await runtime.close();
});

test('record proof runtime has no route, server, PM2, or automatic startup wiring', () => {
  const runtimeSource = fs.readFileSync(
    path.join(__dirname, '../src/server/services/postgres/recordProofRuntime.js'),
    'utf8'
  );
  const serverSource = fs.readFileSync(
    path.join(__dirname, '../src/server/server.js'),
    'utf8'
  );
  const routeSource = fs.readFileSync(
    path.join(__dirname, '../src/server/routes/chain.js'),
    'utf8'
  );

  assert.doesNotMatch(runtimeSource, /dbService|readDB|writeDB|express|router|pm2/);
  assert.doesNotMatch(serverSource, /recordProofRuntime/);
  assert.doesNotMatch(routeSource, /recordProofRuntime/);
});
