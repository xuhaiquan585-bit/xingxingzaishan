'use strict';

const { readPersonalRecordShadowConfig } = require('./personalRecordShadowConfig');
const { checkCandidateFreshness } = require('./publicQrShadowRuntime');

function createPersonalRecordShadowRuntime(config, {
  env = process.env,
  createPool,
  closePool,
  transactionRunner,
  migrationsLoader,
  repositories,
  AdapterClass,
  compareDtos,
  SinkClass,
  createObserver,
  storageModeReader
} = {}) {
  const connection = createPool && closePool ? null : require('../../database/connection');
  const transaction = transactionRunner ? null : require('../../database/transaction');
  const databaseConfig = require('../../database/config');
  const repositoryTypes = repositories || require('../../repositories');
  const { PersonalRecordReadAdapter } = AdapterClass
    ? { PersonalRecordReadAdapter: AdapterClass }
    : require('./personalRecordReadAdapter');
  const comparator = compareDtos
    ? { comparePublicQrDtos: compareDtos }
    : require('./publicQrDtoComparator');
  const sinkModule = SinkClass
    ? { PublicQrMismatchSink: SinkClass }
    : require('./publicQrMismatchSink');
  const observerModule = createObserver
    ? { createPublicQrShadowObserver: createObserver }
    : require('./publicQrShadowObserver');
  const migrationModule = migrationsLoader
    ? { loadMigrations: migrationsLoader }
    : require('../../../../scripts/database/migrate');
  const storage = storageModeReader
    ? { getStorageMode: storageModeReader }
    : require('../storageService');

  const postgresConfig = databaseConfig.readPostgresConfig(env);
  const poolConfig = {
    ...postgresConfig,
    poolMax: Math.min(2, postgresConfig.poolMax),
    connectionTimeoutMillis: Math.min(config.timeoutMs, postgresConfig.connectionTimeoutMillis),
    statementTimeoutMillis: Math.min(
      config.timeoutMs,
      postgresConfig.statementTimeoutMillis || config.timeoutMs
    ),
    applicationName: 'xingxingzaishan-personal-record-shadow'
  };
  const poolFactory = createPool || connection.createPostgresPool;
  const poolCloser = closePool || connection.closePostgresPool;
  const runTransaction = transactionRunner || transaction.withTransaction;
  const pool = poolFactory({ config: poolConfig });
  const migrations = migrationModule.loadMigrations()
    .map(({ version, checksum }) => ({ version, checksum }));
  const sink = new sinkModule.PublicQrMismatchSink({
    directory: config.logDirectory,
    maxBytes: config.maxLogBytes,
    retentionDays: config.retentionDays,
    queueLimit: config.queueLimit,
    filePrefix: 'personal-record-shadow-'
  });

  async function readCandidate(input) {
    const startedAt = Date.now();
    const transactionResult = await runTransaction(pool, async (transactionContext) => {
      if (input.signal && input.signal.aborted) {
        const error = new Error('CANDIDATE_TIMEOUT');
        error.code = 'CANDIDATE_TIMEOUT';
        throw error;
      }
      const remainingMs = Math.max(1, input.timeoutMs - (Date.now() - startedAt));
      await transactionContext.query(
        "SELECT set_config('statement_timeout', $1, true)",
        [`${remainingMs}ms`]
      );
      const provenanceRepository = new repositoryTypes.PublicQrProvenanceRepository(
        transactionContext
      );
      const eligibility = await checkCandidateFreshness({
        provenanceRepository,
        sourceHash: input.sourceHash,
        migrations
      });
      if (eligibility !== 'ELIGIBLE') return { eligibility };

      const adapter = new PersonalRecordReadAdapter({
        qrRepository: new repositoryTypes.QrRepository(transactionContext),
        recordRepository: new repositoryTypes.RecordRepository(transactionContext),
        coCreationRepository: new repositoryTypes.CoCreationRepository(transactionContext),
        proofRepository: new repositoryTypes.ProofRepository(transactionContext),
        batchReader: new repositoryTypes.QrBatchRepository(transactionContext),
        publicRuntimeMetadata: { storage_mode: storage.getStorageMode() }
      });
      const snapshot = await adapter.loadSnapshot({
        readKind: input.readKind,
        accountId: input.accountId,
        recordId: input.recordId,
        channel: input.channel
      });
      return { eligibility, adapter, snapshot };
    }, { isolationLevel: 'repeatable read', readOnly: true });

    if (transactionResult.eligibility !== 'ELIGIBLE') return transactionResult;
    const dto = await transactionResult.adapter.present(transactionResult.snapshot, {
      assetResolver: input.assetResolver
    });
    return {
      eligibility: 'ELIGIBLE',
      lifecycle: input.readKind === 'list'
        ? 'personal_list'
        : transactionResult.snapshot.publicSnapshot.qr.lifecycle_status,
      dto
    };
  }

  const observer = observerModule.createPublicQrShadowObserver({
    getConfig: () => config,
    readCandidate,
    compareDtos: comparator.comparePublicQrDtos,
    sink,
    observerVersion: 'personal-record-shadow-v1'
  });

  return Object.freeze({
    observer,
    close: async () => {
      await observer.close();
      await sink.flush();
      await poolCloser(pool);
    }
  });
}

function createPersonalRecordShadowScheduler({
  env = process.env,
  readConfig = readPersonalRecordShadowConfig,
  runtimeFactory = createPersonalRecordShadowRuntime
} = {}) {
  let runtimePromise = null;
  let closed = false;

  function register({ res, event } = {}) {
    if (closed) return false;
    const config = readConfig(env);
    const accountId = String(event && event.accountId || '');
    if (!config || config.enabled !== true || !config.allowlist.has(accountId)) return false;
    if (!res || typeof res.once !== 'function') return false;

    res.once('finish', () => {
      Promise.resolve().then(async () => {
        if (closed) return;
        let runtime = null;
        if (!runtimePromise) {
          runtimePromise = Promise.resolve().then(() => runtimeFactory(config, { env }));
        }
        try {
          runtime = await runtimePromise;
          await runtime.observer.observe({ ...event, allowlistKey: accountId });
        } catch (error) {
          if (!runtime) runtimePromise = null;
          throw error;
        }
      }).catch(() => {
        // Shadow failures are intentionally isolated from the completed JSON response.
      });
    });
    return true;
  }

  async function close() {
    closed = true;
    if (!runtimePromise) return;
    const runtime = await runtimePromise.catch(() => null);
    runtimePromise = null;
    if (runtime && typeof runtime.close === 'function') await runtime.close();
  }

  return Object.freeze({ register, close });
}

const defaultScheduler = createPersonalRecordShadowScheduler();

function registerPersonalRecordShadowObservation(input) {
  return defaultScheduler.register(input);
}

function closePersonalRecordShadowRuntime() {
  return defaultScheduler.close();
}

module.exports = {
  closePersonalRecordShadowRuntime,
  createPersonalRecordShadowRuntime,
  createPersonalRecordShadowScheduler,
  registerPersonalRecordShadowObservation
};
