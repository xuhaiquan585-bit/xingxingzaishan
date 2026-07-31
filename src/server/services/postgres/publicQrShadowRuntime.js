'use strict';

const { readPublicQrShadowConfig } = require('./publicQrShadowConfig');

function migrationSetMatches(applied, expected) {
  if (!Array.isArray(applied) || !Array.isArray(expected) || applied.length !== expected.length) {
    return false;
  }
  return expected.every((migration, index) => (
    applied[index]
    && applied[index].version === migration.version
    && applied[index].checksum === migration.checksum
  ));
}

async function checkCandidateFreshness({ provenanceRepository, sourceHash, migrations }) {
  const importRun = await provenanceRepository.findPassedImportBySourceHash(sourceHash);
  if (!importRun) {
    const latest = await provenanceRepository.findLatestPassedImport();
    return latest ? 'STALE_SOURCE' : 'INELIGIBLE_NO_IMPORT';
  }
  const appliedMigrations = await provenanceRepository.listAppliedMigrations();
  if (appliedMigrations.length === 0) return 'INELIGIBLE_NO_VERSION';
  return migrationSetMatches(appliedMigrations, migrations)
    ? 'ELIGIBLE'
    : 'INELIGIBLE_VERSION';
}

function createPublicQrShadowRuntime(config, {
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
  // These dependencies are intentionally loaded only after strict enablement and allowlist gating.
  const connection = createPool && closePool ? null : require('../../database/connection');
  const transaction = transactionRunner ? null : require('../../database/transaction');
  const databaseConfig = require('../../database/config');
  const repositoryTypes = repositories || require('../../repositories');
  const { PublicQrReadAdapter } = AdapterClass
    ? { PublicQrReadAdapter: AdapterClass }
    : require('./publicQrReadAdapter');
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
    statementTimeoutMillis: Math.min(config.timeoutMs, postgresConfig.statementTimeoutMillis || config.timeoutMs),
    applicationName: 'xingxingzaishan-public-qr-shadow'
  };
  const poolFactory = createPool || connection.createPostgresPool;
  const poolCloser = closePool || connection.closePostgresPool;
  const runTransaction = transactionRunner || transaction.withTransaction;
  const pool = poolFactory({ config: poolConfig });
  const migrations = migrationModule.loadMigrations().map(({ version, checksum }) => ({ version, checksum }));
  const sink = new sinkModule.PublicQrMismatchSink({
    directory: config.logDirectory,
    maxBytes: config.maxLogBytes,
    retentionDays: config.retentionDays,
    queueLimit: config.queueLimit
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
      const provenanceRepository = new repositoryTypes.PublicQrProvenanceRepository(transactionContext);
      const eligibility = await checkCandidateFreshness({
        provenanceRepository,
        sourceHash: input.sourceHash,
        migrations
      });
      if (eligibility !== 'ELIGIBLE') return { eligibility };
      if (input.signal && input.signal.aborted) {
        const error = new Error('CANDIDATE_TIMEOUT');
        error.code = 'CANDIDATE_TIMEOUT';
        throw error;
      }

      const adapter = new PublicQrReadAdapter({
        qrRepository: new repositoryTypes.QrRepository(transactionContext),
        recordRepository: new repositoryTypes.RecordRepository(transactionContext),
        coCreationRepository: new repositoryTypes.CoCreationRepository(transactionContext),
        proofRepository: new repositoryTypes.ProofRepository(transactionContext),
        batchReader: new repositoryTypes.QrBatchRepository(transactionContext),
        assetResolver: null,
        publicRuntimeMetadata: { storage_mode: storage.getStorageMode() }
      });
      try {
        const snapshot = await adapter.loadSnapshot({
          key: input.key,
          channel: input.channel,
          viewer: input.viewer
        });
        return { eligibility, adapter, snapshot };
      } catch (error) {
        if (error && error.code === 'CANDIDATE_COMMENT_OVERFLOW') {
          return { eligibility: 'CANDIDATE_COMMENT_OVERFLOW' };
        }
        throw error;
      }
    }, { isolationLevel: 'repeatable read', readOnly: true });

    if (transactionResult.eligibility !== 'ELIGIBLE') return transactionResult;
    const dto = await transactionResult.adapter.present(transactionResult.snapshot, {
      assetResolver: input.assetResolver
    });
    return {
      eligibility: 'ELIGIBLE',
      lifecycle: transactionResult.snapshot.qr.lifecycle_status,
      dto
    };
  }

  const observer = observerModule.createPublicQrShadowObserver({
    getConfig: () => config,
    readCandidate,
    compareDtos: comparator.comparePublicQrDtos,
    sink
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

function createPublicQrShadowScheduler({
  env = process.env,
  readConfig = readPublicQrShadowConfig,
  runtimeFactory = createPublicQrShadowRuntime
} = {}) {
  let runtimePromise = null;
  let closed = false;

  function register({ res, event } = {}) {
    if (closed) return false;
    const config = readConfig(env);
    const publicQrId = String(event && event.publicQrId || '');
    if (!config || config.enabled !== true || !config.allowlist.has(publicQrId)) return false;
    if (!res || typeof res.once !== 'function') return false;

    res.once('finish', () => {
      Promise.resolve().then(async () => {
        let runtime = null;
        if (!runtimePromise) {
          runtimePromise = Promise.resolve().then(() => runtimeFactory(config, { env }));
        }
        try {
          runtime = await runtimePromise;
          await runtime.observer.observe(event);
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

const defaultScheduler = createPublicQrShadowScheduler();

function registerPublicQrShadowObservation(input) {
  return defaultScheduler.register(input);
}

function closePublicQrShadowRuntime() {
  return defaultScheduler.close();
}

module.exports = {
  checkCandidateFreshness,
  closePublicQrShadowRuntime,
  createPublicQrShadowRuntime,
  createPublicQrShadowScheduler,
  migrationSetMatches,
  registerPublicQrShadowObservation
};
