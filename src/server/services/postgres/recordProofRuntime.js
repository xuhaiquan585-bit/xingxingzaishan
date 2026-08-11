'use strict';

const { readRecordProofRuntimeConfig } = require('./recordProofRuntimeConfig');
const { JOB_TYPE, createRecordProofJobHandler } = require('./recordProofJobHandler');
const { createRecordProofExternalAdapter } = require('./recordProofExternalAdapter');
const { createRecordProofResultService } = require('./recordProofResultService');
const { createOutboxWorker, safeErrorCode } = require('./outboxWorkerService');
const { checkSourceAndDomainFreshness } = require('./publicQrFreshness');
const { hasValidPrimarySelectionScope } = require('./primarySelectionScope');

class RecordProofRuntimeError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RecordProofRuntimeError';
    this.code = code;
  }
}

function createRecordProofRuntime(config, {
  env = process.env,
  createPool,
  closePool,
  externalAdapterFactory = createRecordProofExternalAdapter,
  jobHandlerFactory = createRecordProofJobHandler,
  resultServiceFactory = createRecordProofResultService,
  workerFactory = createOutboxWorker,
  transactionRunner,
  migrationsLoader,
  repositoryTypes,
  eligibilityChecker,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  clock = () => new Date(),
  onWorkerError = () => {}
} = {}) {
  if (!config || config.enabled !== true
    || !hasValidPrimarySelectionScope(config)) {
    throw new RecordProofRuntimeError('RECORD_PROOF_RUNTIME_CONFIG_REQUIRED');
  }
  if (!/^[0-9a-f]{64}$/.test(String(config.sourceSha256 || ''))) {
    throw new RecordProofRuntimeError('RECORD_PROOF_RUNTIME_SOURCE_REQUIRED');
  }
  if (!/^[0-9a-f]{64}$/.test(String(config.domainSha256 || ''))) {
    throw new RecordProofRuntimeError('RECORD_PROOF_RUNTIME_DOMAIN_REQUIRED');
  }
  if (typeof clock !== 'function') {
    throw new RecordProofRuntimeError('RECORD_PROOF_RUNTIME_CLOCK_REQUIRED');
  }

  const connection = createPool && closePool ? null : require('../../database/connection');
  const transaction = transactionRunner ? null : require('../../database/transaction');
  const databaseConfig = require('../../database/config');
  const migrationModule = migrationsLoader
    ? { loadMigrations: migrationsLoader }
    : require('../../../../scripts/database/migrate');
  const repositories = repositoryTypes || require('../../repositories');
  const poolFactory = createPool || connection.createPostgresPool;
  const poolCloser = closePool || connection.closePostgresPool;
  const runTransaction = transactionRunner || transaction.withTransaction;
  const postgresConfig = databaseConfig.readPostgresConfig(env);
  const pool = poolFactory({
    config: {
      ...postgresConfig,
      poolMax: Math.min(3, postgresConfig.poolMax),
      applicationName: 'xingxingzaishan-record-proof-runtime'
    }
  });
  const migrations = migrationModule.loadMigrations()
    .map(({ version, checksum }) => ({ version, checksum }));
  const allowedRecordQrIds = config.scope === 'all'
    ? null
    : [...config.allowlist];
  const externalAdapter = externalAdapterFactory();
  const handler = jobHandlerFactory({
    pool,
    prepareRecord: externalAdapter.prepareRecord,
    submitRecord: externalAdapter.submitRecord
  });
  const resultService = resultServiceFactory({
    pool,
    normalizeProviderResult: externalAdapter.normalizeRecordResult,
    allowedRecordQrIds
  });
  const worker = workerFactory({
    pool,
    workerId: config.workerId,
    handlers: { [JOB_TYPE]: handler },
    batchSize: config.batchSize,
    maxAttempts: config.maxAttempts,
    retryBaseMs: config.retryBaseMs,
    lockTimeoutMs: config.lockTimeoutMs,
    jobTypes: [JOB_TYPE],
    aggregateIds: allowedRecordQrIds
  });

  let timer = null;
  let activeRun = null;
  let started = false;
  let closed = false;
  let lastRunAt = null;
  let lastRunSummary = null;
  let lastErrorCode = null;

  async function assertEligible() {
    const eligibility = eligibilityChecker
      ? await eligibilityChecker({
        pool,
        sourceSha256: config.sourceSha256,
        domainSha256: config.domainSha256,
        migrations
      })
      : await runTransaction(pool, async (context) => checkSourceAndDomainFreshness({
        provenanceRepository: new repositories.PublicQrProvenanceRepository(context),
        sourceHash: config.sourceSha256,
        domainHash: config.domainSha256,
        migrations
      }), { isolationLevel: 'repeatable read', readOnly: true });
    if (eligibility !== 'ELIGIBLE') {
      throw new RecordProofRuntimeError('RECORD_PROOF_RUNTIME_INELIGIBLE');
    }
  }

  function schedule() {
    if (!started || closed || timer) return;
    timer = setTimer(async () => {
      timer = null;
      try {
        await runOnce();
      } catch (error) {
        onWorkerError(safeErrorCode(error));
      } finally {
        schedule();
      }
    }, config.intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function start() {
    if (closed) throw new RecordProofRuntimeError('RECORD_PROOF_RUNTIME_CLOSED');
    if (started) return false;
    started = true;
    schedule();
    return true;
  }

  function runOnce() {
    if (closed) {
      return Promise.reject(new RecordProofRuntimeError('RECORD_PROOF_RUNTIME_CLOSED'));
    }
    if (!activeRun) {
      activeRun = Promise.resolve()
        .then(() => assertEligible())
        .then(() => worker.runOnce())
        .then((summary) => {
          lastRunAt = new Date(clock()).toISOString();
          lastRunSummary = summary;
          lastErrorCode = null;
          return summary;
        })
        .catch((error) => {
          lastErrorCode = safeErrorCode(error);
          throw error;
        })
        .finally(() => {
          activeRun = null;
        });
    }
    return activeRun;
  }

  async function close() {
    if (closed) return;
    closed = true;
    started = false;
    if (timer) clearTimer(timer);
    timer = null;
    if (activeRun) await activeRun.catch(() => null);
    await poolCloser(pool);
  }

  async function applyResult(method, rawResult) {
    if (closed) throw new RecordProofRuntimeError('RECORD_PROOF_RUNTIME_CLOSED');
    await assertEligible();
    return resultService[method](rawResult);
  }

  async function status() {
    if (closed) throw new RecordProofRuntimeError('RECORD_PROOF_RUNTIME_CLOSED');
    await assertEligible();
    const outbox = await worker.inspect();
    return Object.freeze({
      enabled: true,
      healthy: outbox.failed === 0 && outbox.stale_processing === 0,
      reason: 'ENABLED',
      scope: config.scope,
      started,
      running: activeRun !== null,
      last_run_at: lastRunAt,
      last_run_summary: lastRunSummary,
      last_error_code: lastErrorCode,
      outbox
    });
  }

  return Object.freeze({
    applyCallback: (rawResult) => applyResult('applyCallback', rawResult),
    applyQueryResult: (rawResult) => applyResult('applyQueryResult', rawResult),
    close,
    runOnce,
    start,
    status
  });
}

function createRecordProofRuntimeController({
  env = process.env,
  readConfig = readRecordProofRuntimeConfig,
  runtimeFactory = createRecordProofRuntime,
  onWorkerError
} = {}) {
  let runtimePromise = null;
  let closed = false;

  function ensureRuntime() {
    if (closed) {
      return {
        config: Object.freeze({ enabled: false, reason: 'RUNTIME_CLOSED' }),
        pending: null
      };
    }
    const config = readConfig(env);
    if (!config || config.enabled !== true) {
      return { config, pending: null };
    }
    if (!runtimePromise) {
      runtimePromise = Promise.resolve().then(() => runtimeFactory(config, {
        env,
        onWorkerError
      }));
    }
    return { config, pending: runtimePromise };
  }

  async function start() {
    const { config, pending } = ensureRuntime();
    if (!pending) {
      const reason = String(config && config.reason || 'CONFIG_INVALID');
      if (['DISABLED_BY_DEFAULT', 'DISABLED_BY_CONFIGURATION'].includes(reason)) {
        return false;
      }
      throw new RecordProofRuntimeError('RECORD_PROOF_RUNTIME_CONFIG_INVALID');
    }
    const runtime = await pending;
    runtime.start();
    return true;
  }

  async function invoke(method, rawResult) {
    const { config, pending } = ensureRuntime();
    if (!pending) {
      return Object.freeze({
        outcome: 'disabled',
        status: null,
        reason: String(config && config.reason || 'CONFIG_INVALID')
      });
    }
    const runtime = await pending;
    return runtime[method](rawResult);
  }

  async function close() {
    closed = true;
    if (!runtimePromise) return;
    const runtime = await runtimePromise.catch(() => null);
    runtimePromise = null;
    if (runtime) await runtime.close();
  }

  async function status() {
    const { config, pending } = ensureRuntime();
    if (!pending) {
      return Object.freeze({
        enabled: false,
        healthy: true,
        reason: String(config && config.reason || 'CONFIG_INVALID'),
        scope: null,
        started: false,
        running: false,
        last_run_at: null,
        last_run_summary: null,
        last_error_code: null,
        outbox: null
      });
    }
    const runtime = await pending;
    return runtime.status();
  }

  return Object.freeze({
    applyCallback: (rawResult) => invoke('applyCallback', rawResult),
    applyQueryResult: (rawResult) => invoke('applyQueryResult', rawResult),
    close,
    start,
    status
  });
}

const defaultController = createRecordProofRuntimeController();

function startRecordProofRuntime() {
  return defaultController.start();
}

function applyRecordProofCallback(rawResult) {
  return defaultController.applyCallback(rawResult);
}

function closeRecordProofRuntime() {
  return defaultController.close();
}

function getRecordProofRuntimeStatus() {
  return defaultController.status();
}

module.exports = {
  RecordProofRuntimeError,
  applyRecordProofCallback,
  closeRecordProofRuntime,
  createRecordProofRuntime,
  createRecordProofRuntimeController,
  getRecordProofRuntimeStatus,
  startRecordProofRuntime
};
