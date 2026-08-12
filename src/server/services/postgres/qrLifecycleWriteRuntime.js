'use strict';

const { checkPublicQrDomainFreshness } = require('./publicQrFreshness');
const { readQrLifecycleWriteConfig } = require('./qrLifecycleWriteConfig');
const {
  hasValidPrimarySelectionScope,
  isSelectedByPrimaryScope
} = require('./primarySelectionScope');

const OPERATION_METHODS = Object.freeze({
  activate: 'activateQRByKey',
  start_co_creation: 'startCoCreationByKey',
  add_comment: 'addCoCreationCommentByKey',
  delete_comment: 'deleteCoCreationCommentByKey',
  finalize: 'finalizeCoCreationByKey'
});

class QrLifecyclePostgresWriteError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'QrLifecyclePostgresWriteError';
    this.code = code;
  }
}

function writeError(code) {
  return new QrLifecyclePostgresWriteError(
    code,
    'The PostgreSQL QR lifecycle write is unavailable.'
  );
}

function assertEnabledConfig(config) {
  if (!config || config.enabled !== true || !config.domainHash
    || !hasValidPrimarySelectionScope(config)) {
    throw writeError('QR_LIFECYCLE_POSTGRES_WRITE_CONFIG_INVALID');
  }
}

function createQrLifecycleWriteRuntime(config, {
  env = process.env,
  createPool,
  closePool,
  transactionRunner,
  migrationsLoader,
  repositories,
  AdapterClass,
  freshnessChecker = checkPublicQrDomainFreshness,
  storageModeReader,
  writeServiceFactory
} = {}) {
  assertEnabledConfig(config);

  const connection = createPool && closePool ? null : require('../../database/connection');
  const transaction = transactionRunner ? null : require('../../database/transaction');
  const databaseConfig = require('../../database/config');
  const repositoryTypes = repositories || require('../../repositories');
  const { PublicQrReadAdapter } = AdapterClass
    ? { PublicQrReadAdapter: AdapterClass }
    : require('./publicQrReadAdapter');
  const migrationModule = migrationsLoader
    ? { loadMigrations: migrationsLoader }
    : require('../../../../scripts/database/migrate');
  const storage = storageModeReader
    ? { getStorageMode: storageModeReader }
    : require('../storageService');
  const createWriteService = writeServiceFactory
    || require('./qrLifecycleWriteService').createQrLifecycleWriteService;

  const migrations = migrationModule.loadMigrations()
    .map(({ version, checksum }) => ({ version, checksum }));
  const postgresConfig = databaseConfig.readPostgresConfig(env);
  const poolConfig = {
    ...postgresConfig,
    poolMax: Math.min(2, postgresConfig.poolMax),
    connectionTimeoutMillis: Math.min(config.timeoutMs, postgresConfig.connectionTimeoutMillis),
    statementTimeoutMillis: Math.min(
      config.timeoutMs,
      postgresConfig.statementTimeoutMillis || config.timeoutMs
    ),
    applicationName: 'xingxingzaishan-qr-lifecycle-write'
  };
  const poolFactory = createPool || connection.createPostgresPool;
  const poolCloser = closePool || connection.closePostgresPool;
  const runTransaction = transactionRunner || transaction.withTransaction;
  const pool = poolFactory({ config: poolConfig });
  const writeService = createWriteService({ pool });
  let closed = false;

  async function assertFreshCandidate(input) {
    const accountId = String(
      input && input.payload && (input.payload.account_id || input.payload.accountId) || ''
    ).trim();
    const state = await runTransaction(pool, async (transactionContext) => {
      const provenanceRepository = new repositoryTypes.PublicQrProvenanceRepository(
        transactionContext
      );
      const eligibility = await freshnessChecker({
        provenanceRepository,
        domainHash: config.domainHash,
        migrations
      });
      const accountAvailable = eligibility !== 'ELIGIBLE' || !accountId
        || await new repositoryTypes.AccountRepository(transactionContext).exists(accountId);
      return { eligibility, accountAvailable };
    }, { isolationLevel: 'repeatable read', readOnly: true });

    if (state.eligibility !== 'ELIGIBLE') {
      throw writeError(`QR_LIFECYCLE_POSTGRES_WRITE_${state.eligibility}`);
    }
    if (!state.accountAvailable) {
      throw writeError('QR_LIFECYCLE_POSTGRES_WRITE_IDENTITY_UNAVAILABLE');
    }
  }

  async function readPublicDto(input) {
    const transactionResult = await runTransaction(pool, async (transactionContext) => {
      const adapter = new PublicQrReadAdapter({
        qrRepository: new repositoryTypes.QrRepository(transactionContext),
        recordRepository: new repositoryTypes.RecordRepository(transactionContext),
        coCreationRepository: new repositoryTypes.CoCreationRepository(transactionContext),
        proofRepository: new repositoryTypes.ProofRepository(transactionContext),
        batchReader: new repositoryTypes.QrBatchRepository(transactionContext),
        assetResolver: null,
        publicRuntimeMetadata: { storage_mode: storage.getStorageMode() }
      });
      const snapshot = await adapter.loadSnapshot({
        key: input.key,
        channel: input.channel,
        viewer: input.viewer
      });
      const expectedPublicQrId = String(input.publicQrId || '').trim();
      if (!snapshot.qr
        || (config.scope === 'allowlist' && !expectedPublicQrId)
        || (expectedPublicQrId && String(snapshot.qr.id) !== expectedPublicQrId)) {
        throw writeError('QR_LIFECYCLE_POSTGRES_WRITE_IDENTITY_MISMATCH');
      }
      return { adapter, snapshot };
    }, { isolationLevel: 'repeatable read', readOnly: true });

    return transactionResult.adapter.present(transactionResult.snapshot, {
      assetResolver: input.assetResolver
    });
  }

  async function write(input = {}) {
    if (closed) throw writeError('QR_LIFECYCLE_POSTGRES_WRITE_CLOSED');
    const method = OPERATION_METHODS[input.operation];
    if (!method || typeof writeService[method] !== 'function') {
      throw writeError('QR_LIFECYCLE_POSTGRES_WRITE_OPERATION_INVALID');
    }

    await assertFreshCandidate(input);
    const result = await writeService[method](input.key, input.payload || {});
    if (result && result.error) return Object.freeze({ result });

    const dto = await readPublicDto(input);
    return Object.freeze({ result, dto });
  }

  async function close() {
    if (closed) return;
    closed = true;
    await poolCloser(pool);
  }

  return Object.freeze({ write, close });
}

function createQrLifecycleWriteController({
  env = process.env,
  readConfig = readQrLifecycleWriteConfig,
  runtimeFactory = createQrLifecycleWriteRuntime
} = {}) {
  let runtimePromise = null;
  let closed = false;
  const activeWrites = new Set();

  async function write(input = {}) {
    const config = readConfig(env);
    if (!config || config.requested !== true) return { selected: false };
    if (config.enabled !== true) {
      throw writeError('QR_LIFECYCLE_POSTGRES_WRITE_CONFIG_INVALID');
    }
    assertEnabledConfig(config);

    const publicQrId = String(input.publicQrId || '').trim();
    const selectionKey = config.scope === 'all' ? input.key : publicQrId;
    if (!isSelectedByPrimaryScope(config, selectionKey)) return { selected: false };
    const baselineDomainHash = config.baselineDomainHash || config.domainHash;
    if (String(input.domainHash || '') !== baselineDomainHash) {
      throw writeError('QR_LIFECYCLE_POSTGRES_WRITE_DOMAIN_MISMATCH');
    }
    if (closed) throw writeError('QR_LIFECYCLE_POSTGRES_WRITE_CLOSED');

    if (!runtimePromise) {
      runtimePromise = Promise.resolve().then(() => runtimeFactory(config, { env }));
    }

    let runtime;
    try {
      runtime = await runtimePromise;
    } catch (error) {
      runtimePromise = null;
      throw error;
    }
    if (closed) throw writeError('QR_LIFECYCLE_POSTGRES_WRITE_CLOSED');

    const activeWrite = Promise.resolve().then(() => runtime.write({
      ...input,
      publicQrId
    }));
    activeWrites.add(activeWrite);
    try {
      const result = await activeWrite;
      return { selected: true, ...result };
    } finally {
      activeWrites.delete(activeWrite);
    }
  }

  async function close() {
    closed = true;
    if (!runtimePromise) return;
    const runtime = await runtimePromise.catch(() => null);
    runtimePromise = null;
    await Promise.allSettled([...activeWrites]);
    if (runtime && typeof runtime.close === 'function') await runtime.close();
  }

  return Object.freeze({ write, close });
}

function qrLifecycleWriteHttpError() {
  return {
    status: 503,
    code: 'QR_WRITE_UNAVAILABLE',
    message: '这颗星暂时无法保存，请稍后重试。'
  };
}

const defaultController = createQrLifecycleWriteController();

function writeQrLifecycle(input) {
  return defaultController.write(input);
}

function closeQrLifecycleWriteRuntime() {
  return defaultController.close();
}

module.exports = {
  OPERATION_METHODS,
  QrLifecyclePostgresWriteError,
  closeQrLifecycleWriteRuntime,
  createQrLifecycleWriteController,
  createQrLifecycleWriteRuntime,
  qrLifecycleWriteHttpError,
  writeQrLifecycle
};
