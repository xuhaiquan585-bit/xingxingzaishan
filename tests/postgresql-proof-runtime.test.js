'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  DEFAULT_LOCK_TIMEOUT_MS,
  MINIMUM_SAFE_LOCK_TIMEOUT_MS,
  QUERY_LEASE_SAFETY_MARGIN_MS,
  readRecordProofRuntimeConfig
} = require('../src/server/services/postgres/recordProofRuntimeConfig');
const { REQUEST_TIMEOUT_MS } = require('../src/server/services/avataService');
const {
  createRecordProofRuntime,
  createRecordProofRuntimeController
} = require('../src/server/services/postgres/recordProofRuntime');
const {
  createAvataCallbackHandler
} = require('../src/server/routes/chain');
const { ProofRepository } = require('../src/server/repositories/proofRepository');
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
    async claimSubmittedForQuery() { return []; },
    async listConfirmedForCertificateArchive() { return []; },
    async completeSubmittedQuery() { return null; }
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
  const invalidCallback = readRecordProofRuntimeConfig({
    ...enabledEnv(),
    CHAIN_CALLBACK_URL: 'http://example.test/callback'
  });
  assert.equal(invalidCallback.enabled, true);
  assert.deepEqual(invalidCallback.callbackFeature, {
    enabled: false,
    reason: 'INVALID_CALLBACK_URL'
  });
  const genericNotFound = readRecordProofRuntimeConfig({
    ...enabledEnv(),
    AVATA_OPERATION_NOT_FOUND_CODE: 'NOT_FOUND'
  });
  assert.equal(genericNotFound.enabled, true);
  assert.equal(genericNotFound.operationNotFoundCode, null);
  const minimalConfig = readRecordProofRuntimeConfig({
    ...enabledEnv(),
    AVATA_OPERATION_NOT_FOUND_CODE: '',
    CHAIN_CALLBACK_URL: '',
    AVATA_CERTIFICATE_HOST_ALLOWLIST: ''
  });
  assert.equal(minimalConfig.enabled, true);
  assert.equal(minimalConfig.operationNotFoundCode, null);
  assert.deepEqual(minimalConfig.callbackFeature, {
    enabled: false,
    reason: 'NOT_CONFIGURED'
  });
  assert.deepEqual(minimalConfig.certificateFeature, {
    enabled: false,
    reason: 'NOT_CONFIGURED'
  });
  const invalidCertificate = readRecordProofRuntimeConfig({
    ...enabledEnv(),
    AVATA_CERTIFICATE_HOST_ALLOWLIST: 'localhost'
  });
  assert.equal(invalidCertificate.enabled, true);
  assert.deepEqual(invalidCertificate.certificateFeature, {
    enabled: false,
    reason: 'INVALID_HOST_ALLOWLIST'
  });
  assert.equal(readRecordProofRuntimeConfig({
    ...enabledEnv(),
    AVATA_HASH_TYPE: 'invalid'
  }).reason, 'CHAIN_PROVIDER_NUMERIC_CONFIG_INVALID');
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
  assert.equal(config.queryMaxAgeMs, 1800000);
  assert.equal(config.queryBatchSize, 5);
  assert.equal(config.operationNotFoundCode, 'OPERATION_NOT_FOUND');
  assert.deepEqual([...config.certificateHostAllowlist], ['cert.example.test']);
  assert.equal(
    MINIMUM_SAFE_LOCK_TIMEOUT_MS,
    REQUEST_TIMEOUT_MS + QUERY_LEASE_SAFETY_MARGIN_MS + 1
  );
  assert.equal(DEFAULT_LOCK_TIMEOUT_MS > MINIMUM_SAFE_LOCK_TIMEOUT_MS, true);
  assert.equal(readRecordProofRuntimeConfig(enabledEnv({
    RECORD_PROOF_WORKER_LOCK_TIMEOUT_MS: '1000'
  })).reason, 'WORKER_LIMIT_INVALID');
  assert.equal(readRecordProofRuntimeConfig(enabledEnv({
    RECORD_PROOF_WORKER_LOCK_TIMEOUT_MS: String(
      REQUEST_TIMEOUT_MS + QUERY_LEASE_SAFETY_MARGIN_MS
    )
  })).reason, 'WORKER_LIMIT_INVALID');
  assert.equal(readRecordProofRuntimeConfig(enabledEnv({
    RECORD_PROOF_WORKER_LOCK_TIMEOUT_MS: String(MINIMUM_SAFE_LOCK_TIMEOUT_MS)
  })).lockTimeoutMs, MINIMUM_SAFE_LOCK_TIMEOUT_MS);
  assert.equal(readRecordProofRuntimeConfig(enabledEnv({
    RECORD_PROOF_WORKER_LOCK_TIMEOUT_MS: '20001.5'
  })).reason, 'WORKER_LIMIT_INVALID');
  assert.equal(readRecordProofRuntimeConfig(enabledEnv({
    RECORD_PROOF_QUERY_MAX_AGE_MS: '60000'
  })).reason, 'WORKER_LIMIT_INVALID');
  assert.equal(readRecordProofRuntimeConfig(enabledEnv({
    RECORD_PROOF_QUERY_MAX_AGE_MS: '3600000'
  })).queryMaxAgeMs, 3600000);
});

test('core proof polling atomically claims only eligible submitted work with durable bounds', async () => {
  let capturedSql = '';
  let capturedParams = null;
  const repository = new ProofRepository({
    async query(sql, params) {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [] };
    }
  });

  await repository.claimSubmittedForQuery({
    provider: 'avata_wenchang',
    submitted_before: '2026-08-09T09:59:00.000Z',
    stale_claim_before: '2026-08-09T09:55:00.000Z',
    age_limit_before: '2026-08-09T09:30:00.000Z',
    claimed_at: '2026-08-09T10:00:00.000Z',
    max_attempts: 5,
    record_qr_ids: null,
    limit: 5
  });

  assert.match(capturedSql, /status = 'submitted'/);
  assert.match(capturedSql, /FOR UPDATE OF p SKIP LOCKED/);
  assert.match(capturedSql, /p\.retry_count \+ 1/);
  assert.match(capturedSql, /MIN\(attempt\.requested_at\)/);
  assert.match(capturedSql, /COALESCE\(first_attempt\.requested_at, p\.created_at\)/);
  assert.match(capturedSql, /RECORD_PROOF_MANUAL_RECONCILIATION_QUERY_LIMIT/);
  assert.match(capturedSql, /RECORD_PROOF_MANUAL_RECONCILIATION_AGE_LIMIT/);
  assert.match(capturedSql, /RECORD_PROOF_QUERY_IN_PROGRESS/);
  assert.doesNotMatch(capturedSql, /status = 'confirmed'/);
  assert.doesNotMatch(capturedSql, /certificate_object_key IS NULL/);
  assert.equal(capturedParams[7], 5);
});

test('submitted query completion preserves count and fails closed at either durable bound', async () => {
  let capturedSql = '';
  const repository = new ProofRepository({
    async query(sql) {
      capturedSql = sql;
      return { rows: [] };
    }
  });

  await repository.completeSubmittedQuery({
    id: '00000000-0000-0000-0000-000000000951',
    last_error: 'RECORD_PROOF_PROVIDER_QUERY_FAILED',
    completed_at: '2026-08-09T10:00:00.000Z',
    age_limit_before: '2026-08-09T09:30:00.000Z',
    max_attempts: 5
  });

  assert.match(capturedSql, /retry_count >= \$5/);
  assert.match(capturedSql, /age_origin <= \$4/);
  assert.match(capturedSql, /p\.status = 'retrying'/);
  assert.match(capturedSql, /p\.last_error = 'RECORD_PROOF_QUERY_IN_PROGRESS'/);
  assert.doesNotMatch(capturedSql, /retry_count\s*=/);
});

test('runtime commits a durable query claim before provider GET and never POSTs from polling', async () => {
  const config = readRecordProofRuntimeConfig(enabledEnv());
  const pool = { connect() {} };
  let transactionDepth = 0;
  let claimed = false;
  let completed = false;
  let queryCalls = 0;
  let postCalls = 0;
  const current = {
    id: '00000000-0000-0000-0000-000000000951',
    record_qr_id: 'QR_ALLOWED',
    provider: 'avata_wenchang',
    status: 'retrying',
    operation_id: 'record_QR_ALLOWED_aaaaaaaaaaaaaaaa',
    retry_count: 2,
    last_error: 'RECORD_PROOF_QUERY_IN_PROGRESS'
  };
  const repository = {
    async claimSubmittedForQuery(input) {
      assert.equal(transactionDepth, 1);
      assert.equal(input.max_attempts, 5);
      assert.equal(input.record_qr_ids.length, 2);
      if (claimed) return [];
      claimed = true;
      return [{
        proof: current,
        query_claimed: true,
        age_origin: '2026-08-09T10:00:00.000Z'
      }];
    },
    async completeSubmittedQuery(input) {
      assert.equal(transactionDepth, 1);
      assert.equal(input.last_error, '');
      assert.equal(input.max_attempts, 5);
      completed = true;
      return { ...current, status: 'submitted', last_error: '' };
    },
    async listConfirmedForCertificateArchive() { return []; }
  };
  const runtime = createRecordProofRuntime(config, {
    env: enabledEnv(),
    createPool: () => pool,
    closePool: async () => {},
    repositoryTypes: {
      ProofRepository: class { constructor() { return repository; } },
      OutboxRepository: class {}
    },
    async transactionRunner(_pool, callback) {
      transactionDepth += 1;
      try {
        return await callback({ query() {} });
      } finally {
        transactionDepth -= 1;
      }
    },
    externalAdapterFactory: () => ({
      prepareRecord: async () => ({}),
      prepareSubmission: (value) => value,
      async submitRecord() { postCalls += 1; },
      normalizeRecordResult: (value) => value,
      async queryRecordResult(input) {
        assert.equal(transactionDepth, 0);
        assert.equal(claimed, true);
        queryCalls += 1;
        return { status: 'submitted', operation_id: input.operation_id };
      }
    }),
    jobHandlerFactory: () => async () => {},
    resultServiceFactory: () => ({
      applyCallback: async () => ({}),
      applyQueryResult: async () => ({}),
      applyCanonicalQueryResult: async () => ({
        outcome: 'applied', status: 'submitted'
      })
    }),
    workerFactory: () => ({
      runOnce: async () => ({ claimed: 0, succeeded: 0 }),
      inspect: async () => ({ failed: 0, stale_processing: 0 })
    }),
    migrationsLoader: () => [],
    eligibilityChecker: async () => 'ELIGIBLE'
  });

  assert.deepEqual((await runtime.runOnce()).query, {
    selected: 1, applied: 1, stale: 0, failed: 0
  });
  assert.equal(queryCalls, 1);
  assert.equal(postCalls, 0);
  assert.equal(completed, true);
  assert.deepEqual((await runtime.runOnce()).query, {
    selected: 0, applied: 0, stale: 0, failed: 0
  });
  await runtime.close();
});

test('runtime performs no provider work for rows atomically handed to manual reconciliation', async () => {
  const config = readRecordProofRuntimeConfig(enabledEnv());
  let queryCalls = 0;
  let postCalls = 0;
  let scanCount = 0;
  const manualProof = {
    id: '00000000-0000-0000-0000-000000000952',
    record_qr_id: 'QR_ALLOWED',
    operation_id: 'record_QR_ALLOWED_bbbbbbbbbbbbbbbb',
    status: 'retrying',
    retry_count: 5,
    last_error: 'RECORD_PROOF_MANUAL_RECONCILIATION_QUERY_LIMIT'
  };
  const repository = {
    async claimSubmittedForQuery() {
      scanCount += 1;
      return scanCount === 1
        ? [{ proof: manualProof, query_claimed: false, age_origin: manualProof.created_at }]
        : [];
    },
    async completeSubmittedQuery() {
      assert.fail('manual rows must not complete an automatic query');
    },
    async listConfirmedForCertificateArchive() { return []; }
  };
  const runtime = createRecordProofRuntime(config, {
    env: enabledEnv(),
    createPool: () => ({ connect() {} }),
    closePool: async () => {},
    repositoryTypes: {
      ProofRepository: class { constructor() { return repository; } },
      OutboxRepository: class {}
    },
    transactionRunner: async (_pool, callback) => callback({ query() {} }),
    externalAdapterFactory: () => ({
      prepareRecord: async () => ({}),
      prepareSubmission: (value) => value,
      async submitRecord() { postCalls += 1; },
      normalizeRecordResult: (value) => value,
      async queryRecordResult() { queryCalls += 1; }
    }),
    jobHandlerFactory: () => async () => {},
    resultServiceFactory: () => ({
      applyCallback: async () => ({}),
      applyQueryResult: async () => ({}),
      applyCanonicalQueryResult: async () => assert.fail('no result exists')
    }),
    workerFactory: () => ({
      runOnce: async () => ({ claimed: 0, succeeded: 0 }),
      inspect: async () => ({ failed: 0, stale_processing: 0 })
    }),
    migrationsLoader: () => [],
    eligibilityChecker: async () => 'ELIGIBLE'
  });

  assert.deepEqual((await runtime.runOnce()).query, {
    selected: 0, applied: 0, stale: 0, failed: 0
  });
  assert.deepEqual((await runtime.runOnce()).query, {
    selected: 0, applied: 0, stale: 0, failed: 0
  });
  assert.equal(queryCalls, 0);
  assert.equal(postCalls, 0);
  assert.equal(manualProof.operation_id, 'record_QR_ALLOWED_bbbbbbbbbbbbbbbb');
  assert.equal(
    manualProof.last_error,
    'RECORD_PROOF_MANUAL_RECONCILIATION_QUERY_LIMIT'
  );
  await runtime.close();
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
        prepareSubmission: (value) => value,
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
  assert.equal(captured.worker.retryableErrorCodes, undefined);
  assert.equal(typeof captured.handler.prepareSubmission, 'function');
  assert.equal(typeof captured.handler.certificateArchiveEnqueuer, 'function');
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
    RECORD_PROOF_RUNTIME_ALLOWLIST: '',
    AVATA_CERTIFICATE_HOST_ALLOWLIST: ''
  }));
  assert.equal(config.enabled, true);
  assert.equal(config.scope, 'all');
  assert.equal(config.allowlist.size, 0);
  assert.equal(config.certificateFeature.enabled, false);

  const captured = {};
  let certificateFactoryCalls = 0;
  const runtime = createRecordProofRuntime(config, {
    ...runtimePersistenceDependencies(),
    env: enabledEnv(),
    createPool: () => ({ connect() {} }),
    closePool: async () => {},
    externalAdapterFactory: () => ({
      prepareRecord: async () => ({}),
      prepareSubmission: (value) => value,
      submitRecord: async () => ({}),
      normalizeRecordResult: (value) => value,
      queryRecordResult: async () => ({})
    }),
    jobHandlerFactory: () => async () => {},
    certificateArchiveHandlerFactory() {
      certificateFactoryCalls += 1;
      throw new Error('certificate handler must stay disabled');
    },
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
  assert.deepEqual(captured.worker.jobTypes, ['record_proof_prepare_submit']);
  assert.equal(captured.result.certificateArchiveEnqueuer, null);
  assert.equal(certificateFactoryCalls, 0);
  assert.equal(captured.result.allowedRecordQrIds, null);
  assert.deepEqual((await runtime.runOnce()).certificate_archive, {
    selected: 0,
    queued: 0
  });
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
      prepareSubmission: (value) => value,
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
