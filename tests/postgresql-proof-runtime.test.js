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
const {
  createAvataCallbackHandler
} = require('../src/server/routes/chain');
const { startServer } = require('../src/server/server');

function enabledEnv(overrides = {}) {
  return {
    RECORD_PROOF_RUNTIME_ENABLED: 'true',
    RECORD_PROOF_RUNTIME_ALLOWLIST: 'QR_ALLOWED,QR_SECOND',
    RECORD_PROOF_RUNTIME_SOURCE_SHA256: 'a'.repeat(64),
    RECORD_PROOF_RUNTIME_DOMAIN_SHA256: 'b'.repeat(64),
    RECORD_PROOF_WORKER_ID: 'proof-worker-test',
    CHAIN_ENABLED: 'true',
    CHAIN_CALLBACK_URL: 'https://example.test/api/chain/avata/callback',
    AVATA_API_KEY: 'api-key',
    AVATA_API_SECRET: 'api-secret',
    AVATA_IDENTITY_NAME: 'identity-name',
    AVATA_IDENTITY_NUM: 'identity-number',
    AVATA_OPERATION_NOT_FOUND_CODE: 'OPERATION_NOT_FOUND',
    AVATA_CERTIFICATE_HOST_ALLOWLIST: 'cert.example.test',
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

function runtimePersistenceDependencies() {
  const proofRepository = {
    async listSubmittedForQuery() { return []; },
    async listConfirmedForCertificateArchive() { return []; },
    async markQueryDeferred() { return null; }
  };
  const outboxRepository = {
    async insertPendingOnce() { return null; }
  };
  return {
    repositoryTypes: {
      ProofRepository: class { constructor() { return proofRepository; } },
      OutboxRepository: class { constructor() { return outboxRepository; } }
    },
    async transactionRunner(_pool, callback) {
      return callback({ query() {} });
    },
    certificateArchiveHandlerFactory: () => async () => {}
  };
}

test('record proof runtime config is default-off and requires complete real-provider gates', () => {
  assert.equal(readRecordProofRuntimeConfig({}).reason, 'DISABLED_BY_DEFAULT');
  assert.equal(readRecordProofRuntimeConfig({
    RECORD_PROOF_RUNTIME_ENABLED: 'false'
  }).reason, 'DISABLED_BY_CONFIGURATION');
  assert.equal(readRecordProofRuntimeConfig({
    ...enabledEnv(),
    RECORD_PROOF_RUNTIME_ALLOWLIST: ''
  }).reason, 'ALLOWLIST_REQUIRED');
  assert.equal(readRecordProofRuntimeConfig({
    ...enabledEnv(),
    RECORD_PROOF_RUNTIME_SCOPE: 'all'
  }).reason, 'ALLOWLIST_FORBIDDEN_FOR_ALL_SCOPE');
  assert.equal(readRecordProofRuntimeConfig({
    ...enabledEnv(),
    RECORD_PROOF_RUNTIME_SOURCE_SHA256: 'invalid'
  }).reason, 'SOURCE_SHA256_REQUIRED');
  assert.equal(readRecordProofRuntimeConfig({
    ...enabledEnv(),
    RECORD_PROOF_RUNTIME_DOMAIN_SHA256: 'invalid'
  }).reason, 'DOMAIN_SHA256_REQUIRED');
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
  assert.equal(readRecordProofRuntimeConfig({
    ...enabledEnv(),
    AVATA_OPERATION_NOT_FOUND_CODE: 'NOT_FOUND'
  }).reason, 'OPERATION_NOT_FOUND_CODE_REQUIRED');
  assert.equal(readRecordProofRuntimeConfig({
    ...enabledEnv(),
    AVATA_OPERATION_NOT_FOUND_CODE: ''
  }).reason, 'OPERATION_NOT_FOUND_CODE_REQUIRED');
  assert.equal(readRecordProofRuntimeConfig(enabledEnv({
    NODE_ENV: 'production',
    AVATA_ENV: 'prod',
    AVATA_API_BASE: 'https://attacker.example.test'
  })).reason, 'PRODUCTION_CHAIN_PROVIDER_REQUIRED');

  const productionConfig = readRecordProofRuntimeConfig(enabledEnv({
    NODE_ENV: 'production',
    AVATA_ENV: 'prod',
    AVATA_API_BASE: 'https://apis.avata.bianjie.ai/'
  }));
  assert.equal(productionConfig.enabled, true);

  const config = readRecordProofRuntimeConfig(enabledEnv({
    RECORD_PROOF_WORKER_INTERVAL_MS: '2000',
    RECORD_PROOF_WORKER_BATCH_SIZE: '3'
  }));
  assert.equal(config.enabled, true);
  assert.deepEqual([...config.allowlist], ['QR_ALLOWED', 'QR_SECOND']);
  assert.equal(config.scope, 'allowlist');
  assert.equal(config.sourceSha256, 'a'.repeat(64));
  assert.equal(config.domainSha256, 'b'.repeat(64));
  assert.equal(config.intervalMs, 2000);
  assert.equal(config.batchSize, 3);
  assert.equal(config.queryMinAgeMs, 60000);
  assert.equal(config.queryBatchSize, 5);
  assert.equal(config.operationNotFoundCode, 'OPERATION_NOT_FOUND');
  assert.deepEqual([...config.certificateHostAllowlist], ['cert.example.test']);
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
    ...runtimePersistenceDependencies(),
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
        normalizeRecordResult: (value) => value,
        queryRecordResult: async () => ({})
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
        applyQueryResult: async () => ({ outcome: 'duplicate', status: 'confirmed' }),
        applyCanonicalQueryResult: async () => ({
          outcome: 'duplicate', status: 'confirmed'
        })
      };
    },
    workerFactory(input) {
      captured.worker = input;
      return {
        runOnce: () => workerResult,
        inspect: async () => ({
          pending: 0,
          ready: 0,
          processing: 0,
          stale_processing: 0,
          failed: 0,
          succeeded: 2,
          maximum_attempt_count: 1
        })
      };
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
  assert.deepEqual(captured.worker.jobTypes, [
    'record_proof_prepare_submit',
    'record_proof_archive_certificate'
  ]);
  assert.deepEqual(captured.worker.retryableErrorCodes, [
    'RECORD_PROOF_RECOVERY_DEFERRED'
  ]);
  assert.deepEqual(captured.worker.aggregateIds, ['QR_ALLOWED', 'QR_SECOND']);
  assert.deepEqual(captured.result.allowedRecordQrIds, ['QR_ALLOWED', 'QR_SECOND']);
  assert.equal(runtime.start(), true);
  assert.equal(runtime.start(), false);
  assert.equal(captured.timer.delay, 5000);

  const firstRun = runtime.runOnce();
  const secondRun = runtime.runOnce();
  assert.equal(firstRun, secondRun);
  workerResolve({ claimed: 0, succeeded: 0 });
  assert.deepEqual(await firstRun, {
    outbox: { claimed: 0, succeeded: 0 },
    query: { selected: 0, applied: 0, stale: 0, failed: 0 },
    certificate_archive: { selected: 0, queued: 0 }
  });
  assert.equal(captured.eligibility.sourceSha256, 'a'.repeat(64));
  assert.equal(captured.eligibility.domainSha256, 'b'.repeat(64));
  assert.deepEqual(captured.eligibility.migrations, [{
    version: '001.sql',
    checksum: 'b'.repeat(64)
  }]);
  assert.deepEqual(await runtime.applyCallback({}), {
    outcome: 'applied',
    status: 'confirmed'
  });
  const status = await runtime.status();
  assert.equal(status.healthy, true);
  assert.equal(status.scope, 'allowlist');
  assert.equal(status.outbox.succeeded, 2);

  await runtime.close();
  assert.equal(timerCleared, true);
  assert.equal(poolClosed, true);
  await assert.rejects(
    runtime.runOnce(),
    (error) => error.code === 'RECORD_PROOF_RUNTIME_CLOSED'
  );
});

test('record proof runtime all scope covers future QR jobs without an allowlist', async () => {
  const config = readRecordProofRuntimeConfig(enabledEnv({
    RECORD_PROOF_RUNTIME_SCOPE: 'all',
    RECORD_PROOF_RUNTIME_ALLOWLIST: ''
  }));
  assert.equal(config.enabled, true);
  assert.equal(config.scope, 'all');
  assert.equal(config.allowlist.size, 0);

  const captured = {};
  const runtime = createRecordProofRuntime(config, {
    ...runtimePersistenceDependencies(),
    env: enabledEnv(),
    createPool: () => ({ connect() {} }),
    closePool: async () => {},
    externalAdapterFactory: () => ({
      prepareRecord: async () => ({}),
      submitRecord: async () => ({}),
      normalizeRecordResult: (value) => value,
      queryRecordResult: async () => ({})
    }),
    jobHandlerFactory: () => async () => {},
    resultServiceFactory(input) {
      captured.result = input;
      return {
        applyCallback: async () => ({ outcome: 'not_found', status: null }),
        applyQueryResult: async () => ({ outcome: 'not_found', status: null }),
        applyCanonicalQueryResult: async () => ({ outcome: 'not_found', status: null })
      };
    },
    workerFactory(input) {
      captured.worker = input;
      return {
        runOnce: async () => ({
          recovered: 0, claimed: 0, succeeded: 0, retried: 0, failed: 0
        }),
        inspect: async () => ({
          pending: 0, ready: 0, processing: 0, stale_processing: 0,
          failed: 0, succeeded: 0, maximum_attempt_count: 0
        })
      };
    },
    migrationsLoader: () => [],
    eligibilityChecker: async () => 'ELIGIBLE'
  });

  assert.equal(captured.worker.aggregateIds, null);
  assert.equal(captured.result.allowedRecordQrIds, null);
  assert.equal((await runtime.status()).scope, 'all');
  await runtime.close();
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
    status: null,
    reason: 'DISABLED_BY_DEFAULT'
  });
  assert.deepEqual(await controller.status(), {
    enabled: false,
    healthy: true,
    reason: 'DISABLED_BY_DEFAULT',
    scope: null,
    started: false,
    running: false,
    last_run_at: null,
    last_run_summary: null,
    last_error_code: null,
    outbox: null
  });
  assert.equal(factoryCalls, 0);
  await controller.close();
});

test('record proof controller fails closed when enablement is invalid', async () => {
  let factoryCalls = 0;
  const controller = createRecordProofRuntimeController({
    env: {},
    readConfig: () => ({ enabled: false, reason: 'ALLOWLIST_REQUIRED' }),
    runtimeFactory() {
      factoryCalls += 1;
    }
  });

  await assert.rejects(
    controller.start(),
    (error) => error.code === 'RECORD_PROOF_RUNTIME_CONFIG_INVALID'
  );
  assert.deepEqual(await controller.applyCallback({}), {
    outcome: 'disabled',
    status: null,
    reason: 'ALLOWLIST_REQUIRED'
  });
  assert.equal(factoryCalls, 0);
  await controller.close();
});

test('record proof runtime blocks worker and callbacks when import provenance is stale', async () => {
  const config = readRecordProofRuntimeConfig(enabledEnv());
  let workerCalls = 0;
  let resultCalls = 0;
  const runtime = createRecordProofRuntime(config, {
    ...runtimePersistenceDependencies(),
    env: enabledEnv(),
    createPool: () => ({ connect() {} }),
    closePool: async () => {},
    externalAdapterFactory: () => ({
      prepareRecord: async () => ({}),
      submitRecord: async () => ({}),
      normalizeRecordResult: (value) => value,
      queryRecordResult: async () => ({})
    }),
    jobHandlerFactory: () => async () => {},
    resultServiceFactory: () => ({
      async applyCallback() {
        resultCalls += 1;
      },
      async applyQueryResult() {
        resultCalls += 1;
      },
      async applyCanonicalQueryResult() {
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

function fakeResponse() {
  return {
    statusCode: 200,
    contentType: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    type(value) {
      this.contentType = value;
      return this;
    },
    send(value) {
      this.body = value;
      return this;
    }
  };
}

function callbackRequest() {
  return {
    originalUrl: '/api/chain/avata/callback?source=provider',
    body: { operation_id: 'operation-1', status: 1 },
    headers: { 'x-api-key': 'test' }
  };
}

test('AVATA callback verifies before selecting a persistence path', async () => {
  let runtimeCalls = 0;
  let legacyCalls = 0;
  const handler = createAvataCallbackHandler({
    verifyCallback: () => ({ ok: false }),
    applyRuntimeCallback: async () => {
      runtimeCalls += 1;
    },
    applyLegacyCallback: async () => {
      legacyCalls += 1;
    }
  });
  const response = fakeResponse();

  await handler(callbackRequest(), response);

  assert.equal(response.statusCode, 401);
  assert.equal(response.body, 'FAILED');
  assert.equal(runtimeCalls, 0);
  assert.equal(legacyCalls, 0);
});

test('AVATA callback fails closed while the PostgreSQL proof runtime is off', async () => {
  let legacyCalls = 0;
  const handler = createAvataCallbackHandler({
    verifyCallback: () => ({ ok: true }),
    applyRuntimeCallback: async () => ({
      outcome: 'disabled',
      status: null,
      reason: 'DISABLED_BY_CONFIGURATION'
    }),
    applyLegacyCallback: async () => {
      legacyCalls += 1;
      return { data: { id: 'QR_ALLOWED' } };
    }
  });
  const response = fakeResponse();

  await handler(callbackRequest(), response);

  assert.equal(response.statusCode, 503);
  assert.equal(response.body, 'FAILED');
  assert.equal(legacyCalls, 0);
});

test('AVATA callback uses PostgreSQL exclusively when proof runtime is enabled', async () => {
  let legacyCalls = 0;
  const handler = createAvataCallbackHandler({
    verifyCallback: () => ({ ok: true }),
    applyRuntimeCallback: async () => ({ outcome: 'duplicate', status: 'confirmed' }),
    applyLegacyCallback: async () => {
      legacyCalls += 1;
    }
  });
  const response = fakeResponse();

  await handler(callbackRequest(), response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body, 'SUCCESS');
  assert.equal(legacyCalls, 0);
});

test('AVATA callback fails closed for out-of-scope and invalid runtime states', async () => {
  const notFoundHandler = createAvataCallbackHandler({
    verifyCallback: () => ({ ok: true }),
    applyRuntimeCallback: async () => ({ outcome: 'not_found', status: null }),
    applyLegacyCallback: async () => assert.fail('legacy fallback must not run')
  });
  const notFoundResponse = fakeResponse();
  await notFoundHandler(callbackRequest(), notFoundResponse);
  assert.equal(notFoundResponse.statusCode, 404);

  const invalidHandler = createAvataCallbackHandler({
    verifyCallback: () => ({ ok: true }),
    applyRuntimeCallback: async () => ({
      outcome: 'disabled',
      status: null,
      reason: 'ALLOWLIST_REQUIRED'
    }),
    applyLegacyCallback: async () => assert.fail('legacy fallback must not run')
  });
  const invalidResponse = fakeResponse();
  await invalidHandler(callbackRequest(), invalidResponse);
  assert.equal(invalidResponse.statusCode, 503);
});

test('server starts and closes the shared proof runtime with its process lifecycle', async () => {
  const calls = [];
  const listeners = new Map();
  const server = {
    close(callback) {
      calls.push('http-close');
      callback();
    }
  };
  const app = {
    listen(_port, callback) {
      calls.push('http-listen');
      callback();
      return server;
    }
  };
  const processObject = {
    once(event, handler) {
      listeners.set(event, handler);
    },
    exit(code) {
      calls.push(`exit-${code}`);
    }
  };
  const runtimeError = new Error('runtime start failed');
  const errors = [];
  const { startup } = startServer({
    app,
    port: 0,
    processObject,
    startProofRuntime: async () => {
      calls.push('proof-start');
      throw runtimeError;
    },
    closeShadowRuntime: async () => calls.push('runtime-close'),
    onError: (error) => errors.push(error)
  });

  await startup;

  assert.equal(listeners.has('SIGTERM'), true);
  assert.equal(listeners.has('SIGINT'), true);
  assert.deepEqual(errors, [runtimeError]);
  assert.deepEqual(calls, [
    'http-listen',
    'proof-start',
    'http-close',
    'runtime-close',
    'exit-1'
  ]);
});

test('record proof runtime wiring remains isolated from PM2 and JSON internals', () => {
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
  assert.match(serverSource, /startRecordProofRuntime/);
  assert.match(serverSource, /closeRecordProofRuntime/);
  assert.match(routeSource, /applyRecordProofCallback/);
  assert.doesNotMatch(serverSource, /pm2/);
  assert.doesNotMatch(routeSource, /pm2/);
});
