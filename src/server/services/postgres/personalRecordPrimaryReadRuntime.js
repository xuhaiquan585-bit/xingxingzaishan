'use strict';

const { checkPublicQrDomainFreshness } = require('./publicQrFreshness');
const {
  readPersonalRecordPrimaryReadConfig
} = require('./personalRecordPrimaryReadConfig');
const {
  hasValidPrimarySelectionScope,
  isSelectedByPrimaryScope
} = require('./primarySelectionScope');

class PersonalRecordPrimaryReadError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'PersonalRecordPrimaryReadError';
    this.code = code;
  }
}

function primaryReadError(code) {
  return new PersonalRecordPrimaryReadError(
    code,
    'The PostgreSQL personal record read is unavailable.'
  );
}

function assertEnabledConfig(config) {
  if (!config || config.enabled !== true || !config.domainHash
    || !hasValidPrimarySelectionScope(config)) {
    throw primaryReadError('PERSONAL_RECORD_POSTGRES_READ_CONFIG_INVALID');
  }
}

function createPersonalRecordPrimaryReadRuntime(config, {
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
  const { PersonalRecordReadAdapter } = AdapterClass
    ? { PersonalRecordReadAdapter: AdapterClass }
    : require('./personalRecordReadAdapter');
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
    applicationName: 'xingxingzaishan-personal-record-primary-read'
  };
  const poolFactory = createPool || connection.createPostgresPool;
  const poolCloser = closePool || connection.closePostgresPool;
  const runTransaction = transactionRunner || transaction.withTransaction;
  const pool = poolFactory({ config: poolConfig });
  let closed = false;

  async function read(input = {}) {
    if (closed) throw primaryReadError('PERSONAL_RECORD_POSTGRES_READ_CLOSED');
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
        throw primaryReadError(`PERSONAL_RECORD_POSTGRES_READ_${eligibility}`);
      }

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
      return { adapter, snapshot };
    }, { isolationLevel: 'repeatable read', readOnly: true });

    const dto = await transactionResult.adapter.present(transactionResult.snapshot, {
      assetResolver: input.assetResolver
    });
    if (input.readKind === 'detail'
      && String(dto && dto.id || '') !== String(input.recordId || '')) {
      throw primaryReadError('PERSONAL_RECORD_POSTGRES_READ_IDENTITY_MISMATCH');
    }
    return Object.freeze({ dto });
  }

  async function close() {
    if (closed) return;
    closed = true;
    await poolCloser(pool);
  }

  return Object.freeze({ read, close });
}

function createPersonalRecordPrimaryReadController({
  env = process.env,
  readConfig = readPersonalRecordPrimaryReadConfig,
  runtimeFactory = createPersonalRecordPrimaryReadRuntime
} = {}) {
  let runtimePromise = null;
  let closed = false;
  const activeReads = new Set();

  async function read(input = {}) {
    const config = readConfig(env);
    if (!config || config.requested !== true) return { selected: false };
    if (config.enabled !== true) {
      throw primaryReadError('PERSONAL_RECORD_POSTGRES_READ_CONFIG_INVALID');
    }
    assertEnabledConfig(config);

    const accountId = String(input.accountId || '').trim();
    if (!isSelectedByPrimaryScope(config, accountId)) return { selected: false };
    if (String(input.domainHash || '') !== config.domainHash) {
      throw primaryReadError('PERSONAL_RECORD_POSTGRES_READ_DOMAIN_MISMATCH');
    }
    if (closed) throw primaryReadError('PERSONAL_RECORD_POSTGRES_READ_CLOSED');

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
    if (closed) throw primaryReadError('PERSONAL_RECORD_POSTGRES_READ_CLOSED');

    const activeRead = Promise.resolve().then(() => runtime.read({ ...input, accountId }));
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

function personalRecordPrimaryReadHttpError(error) {
  if (error && error.code === 'PERSONAL_RECORD_NOT_FOUND') {
    return {
      status: 404,
      code: 'RECORD_NOT_FOUND',
      message: '未找到该记录，或你无权查看。'
    };
  }
  return {
    status: 503,
    code: 'PERSONAL_RECORD_READ_UNAVAILABLE',
    message: '个人记录暂时无法查看，请稍后重试。'
  };
}

const defaultController = createPersonalRecordPrimaryReadController();

function readPersonalRecordPrimary(input) {
  return defaultController.read(input);
}

function closePersonalRecordPrimaryReadRuntime() {
  return defaultController.close();
}

module.exports = {
  PersonalRecordPrimaryReadError,
  closePersonalRecordPrimaryReadRuntime,
  createPersonalRecordPrimaryReadController,
  createPersonalRecordPrimaryReadRuntime,
  personalRecordPrimaryReadHttpError,
  readPersonalRecordPrimary
};
