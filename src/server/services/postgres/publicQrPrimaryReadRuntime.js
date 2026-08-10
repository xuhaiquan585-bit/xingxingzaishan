'use strict';

const { checkPublicQrDomainFreshness } = require('./publicQrFreshness');
const { readPublicQrPrimaryReadConfig } = require('./publicQrPrimaryReadConfig');

class PublicQrPrimaryReadError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'PublicQrPrimaryReadError';
    this.code = code;
  }
}

function primaryReadError(code) {
  return new PublicQrPrimaryReadError(code, 'The PostgreSQL public QR read is unavailable.');
}

function assertEnabledConfig(config) {
  if (!config || config.enabled !== true || !config.domainHash || !config.allowlist) {
    throw primaryReadError('PUBLIC_QR_POSTGRES_READ_CONFIG_INVALID');
  }
}

function createPublicQrPrimaryReadRuntime(config, {
  env = process.env,
  createPool,
  closePool,
  transactionRunner,
  migrationsLoader,
  repositories,
  AdapterClass,
  freshnessChecker = checkPublicQrDomainFreshness,
  storageModeReader
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
    applicationName: 'xingxingzaishan-public-qr-primary-read'
  };
  const poolFactory = createPool || connection.createPostgresPool;
  const poolCloser = closePool || connection.closePostgresPool;
  const runTransaction = transactionRunner || transaction.withTransaction;
  const pool = poolFactory({ config: poolConfig });
  let closed = false;

  async function read(input = {}) {
    if (closed) throw primaryReadError('PUBLIC_QR_POSTGRES_READ_CLOSED');
    const startedAt = Date.now();
    const transactionResult = await runTransaction(pool, async (transactionContext) => {
      const remainingMs = Math.max(1, config.timeoutMs - (Date.now() - startedAt));
      await transactionContext.query(
        "SELECT set_config('statement_timeout', $1, true)",
        [`${remainingMs}ms`]
      );
      const provenanceRepository = new repositoryTypes.PublicQrProvenanceRepository(
        transactionContext
      );
      const eligibility = await freshnessChecker({
        provenanceRepository,
        domainHash: config.domainHash,
        migrations
      });
      if (eligibility !== 'ELIGIBLE') {
        throw primaryReadError(`PUBLIC_QR_POSTGRES_READ_${eligibility}`);
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
      const snapshot = await adapter.loadSnapshot({
        key: input.key,
        channel: input.channel,
        viewer: input.viewer
      });
      if (!snapshot.qr || String(snapshot.qr.id) !== String(input.publicQrId || '')) {
        throw primaryReadError('PUBLIC_QR_POSTGRES_READ_IDENTITY_MISMATCH');
      }
      return { adapter, snapshot };
    }, { isolationLevel: 'repeatable read', readOnly: true });

    const dto = await transactionResult.adapter.present(transactionResult.snapshot, {
      assetResolver: input.assetResolver
    });
    return Object.freeze({
      dto,
      lifecycle: transactionResult.snapshot.qr.lifecycle_status
    });
  }

  async function close() {
    if (closed) return;
    closed = true;
    await poolCloser(pool);
  }

  return Object.freeze({ read, close });
}

function createPublicQrPrimaryReadController({
  env = process.env,
  readConfig = readPublicQrPrimaryReadConfig,
  runtimeFactory = createPublicQrPrimaryReadRuntime
} = {}) {
  let runtimePromise = null;
  let closed = false;
  const activeReads = new Set();

  async function read(input = {}) {
    const config = readConfig(env);
    if (!config || config.requested !== true) return { selected: false };
    if (config.enabled !== true) {
      throw primaryReadError('PUBLIC_QR_POSTGRES_READ_CONFIG_INVALID');
    }

    const publicQrId = String(input.publicQrId || '').trim();
    if (!publicQrId || !config.allowlist.has(publicQrId)) return { selected: false };
    if (String(input.domainHash || '') !== config.domainHash) {
      throw primaryReadError('PUBLIC_QR_POSTGRES_READ_DOMAIN_MISMATCH');
    }
    if (closed) throw primaryReadError('PUBLIC_QR_POSTGRES_READ_CLOSED');

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
    if (closed) throw primaryReadError('PUBLIC_QR_POSTGRES_READ_CLOSED');

    const activeRead = Promise.resolve().then(() => runtime.read({ ...input, publicQrId }));
    activeReads.add(activeRead);
    try {
      const result = await activeRead;
      return { selected: true, ...result };
    } finally {
      activeReads.delete(activeRead);
    }
  }

  async function close() {
    closed = true;
    if (!runtimePromise) return;
    const runtime = await runtimePromise.catch(() => null);
    runtimePromise = null;
    await Promise.allSettled([...activeReads]);
    if (runtime && typeof runtime.close === 'function') await runtime.close();
  }

  return Object.freeze({ read, close });
}

function publicQrPrimaryReadHttpError(error) {
  if (error && error.code === 'QR_NOT_FOUND') {
    return {
      status: 404,
      code: 'QR_NOT_FOUND',
      message: '未找到这颗星，请确认二维码是否正确。'
    };
  }
  if (error && error.code === 'QR_HIDDEN') {
    return {
      status: 403,
      code: 'QR_HIDDEN',
      message: '这颗星暂不可见。'
    };
  }
  return {
    status: 503,
    code: 'PUBLIC_QR_READ_UNAVAILABLE',
    message: '这颗星暂时无法查看，请稍后重试。'
  };
}

const defaultController = createPublicQrPrimaryReadController();

function readPublicQrPrimary(input) {
  return defaultController.read(input);
}

function closePublicQrPrimaryReadRuntime() {
  return defaultController.close();
}

module.exports = {
  PublicQrPrimaryReadError,
  closePublicQrPrimaryReadRuntime,
  createPublicQrPrimaryReadController,
  createPublicQrPrimaryReadRuntime,
  publicQrPrimaryReadHttpError,
  readPublicQrPrimary
};
