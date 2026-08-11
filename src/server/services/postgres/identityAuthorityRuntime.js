'use strict';

const {
  checkSourceAndDomainFreshness
} = require('./publicQrFreshness');
const {
  readIdentityAuthorityConfig
} = require('./identityAuthorityConfig');
const { IdentityWriteError } = require('./identityWriteService');

class IdentityAuthorityError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'IdentityAuthorityError';
    this.code = code;
  }
}

function authorityError(code, cause = null) {
  const error = new IdentityAuthorityError(
    code,
    'The PostgreSQL identity authority is unavailable.'
  );
  if (cause) error.cause = cause;
  return error;
}

function assertEnabledConfig(config) {
  if (!config || config.enabled !== true || config.scope !== 'all'
    || !config.sourceHash || !config.domainHash) {
    throw authorityError('IDENTITY_POSTGRES_AUTHORITY_CONFIG_INVALID');
  }
}

function createIdentityAuthorityRuntime(config, {
  env = process.env,
  createPool,
  closePool,
  transactionRunner,
  migrationsLoader,
  repositoryTypes,
  readAdapterClass,
  writeServiceFactory,
  freshnessChecker = checkSourceAndDomainFreshness
} = {}) {
  assertEnabledConfig(config);

  const connection = createPool && closePool ? null : require('../../database/connection');
  const transaction = transactionRunner ? null : require('../../database/transaction');
  const databaseConfig = require('../../database/config');
  const repositories = repositoryTypes || require('../../repositories');
  const { IdentityReadAdapter } = readAdapterClass
    ? { IdentityReadAdapter: readAdapterClass }
    : require('./identityReadAdapter');
  const { createIdentityWriteService } = writeServiceFactory
    ? { createIdentityWriteService: writeServiceFactory }
    : require('./identityWriteService');
  const migrationModule = migrationsLoader
    ? { loadMigrations: migrationsLoader }
    : require('../../../../scripts/database/migrate');

  const postgresConfig = databaseConfig.readPostgresConfig(env);
  const poolFactory = createPool || connection.createPostgresPool;
  const poolCloser = closePool || connection.closePostgresPool;
  const runTransaction = transactionRunner || transaction.withTransaction;
  const pool = poolFactory({
    config: {
      ...postgresConfig,
      poolMax: Math.min(2, postgresConfig.poolMax),
      connectionTimeoutMillis: Math.min(
        config.timeoutMs,
        postgresConfig.connectionTimeoutMillis
      ),
      statementTimeoutMillis: Math.min(
        config.timeoutMs,
        postgresConfig.statementTimeoutMillis || config.timeoutMs
      ),
      applicationName: 'xingxingzaishan-identity-authority'
    }
  });
  const migrations = migrationModule.loadMigrations()
    .map(({ version, checksum }) => ({ version, checksum }));
  let closed = false;

  async function assertEligible(transactionContext) {
    await transactionContext.query(
      "SELECT set_config('statement_timeout', $1, true)",
      [`${config.timeoutMs}ms`]
    );
    const eligibility = await freshnessChecker({
      provenanceRepository:
        new repositories.PublicQrProvenanceRepository(transactionContext),
      sourceHash: config.sourceHash,
      domainHash: config.domainHash,
      migrations
    });
    if (eligibility !== 'ELIGIBLE') {
      throw authorityError(`IDENTITY_POSTGRES_AUTHORITY_${eligibility}`);
    }
  }

  const writeService = createIdentityWriteService({
    pool,
    transactionRunner: runTransaction,
    repositoryTypes: repositories,
    beforeOperation: ({ transactionContext }) => assertEligible(transactionContext)
  });

  async function readIdentity(input) {
    return runTransaction(pool, async (transactionContext) => {
      await assertEligible(transactionContext);
      const adapter = new IdentityReadAdapter({
        identityRepository: new repositories.IdentityRepository(transactionContext),
        accountRepository: new repositories.AccountRepository(transactionContext)
      });
      return adapter.getAuthenticatedIdentity(input);
    }, { isolationLevel: 'repeatable read', readOnly: true });
  }

  async function invoke(operation, input) {
    if (closed) throw authorityError('IDENTITY_POSTGRES_AUTHORITY_CLOSED');
    switch (operation) {
      case 'createOrGetWebIdentity':
        return { data: await writeService.createOrGetWebIdentity(input) };
      case 'createOrGetMiniappIdentity':
        return { data: await writeService.createOrGetMiniappIdentity(input) };
      case 'bindMiniappPhone':
        return writeService.bindMiniappPhone(input);
      case 'getAuthenticatedIdentity':
        return readIdentity(input);
      default:
        throw authorityError('IDENTITY_POSTGRES_AUTHORITY_OPERATION_INVALID');
    }
  }

  async function close() {
    if (closed) return;
    closed = true;
    await poolCloser(pool);
  }

  return Object.freeze({ invoke, close });
}

function createIdentityAuthorityController({
  env = process.env,
  readConfig = readIdentityAuthorityConfig,
  runtimeFactory = createIdentityAuthorityRuntime
} = {}) {
  let runtimePromise = null;
  let closed = false;
  const activeOperations = new Set();

  async function invoke(operation, input = {}) {
    const config = readConfig(env);
    if (!config || config.requested !== true) return { selected: false };
    if (config.enabled !== true) {
      throw authorityError('IDENTITY_POSTGRES_AUTHORITY_CONFIG_INVALID');
    }
    assertEnabledConfig(config);
    if (closed) throw authorityError('IDENTITY_POSTGRES_AUTHORITY_CLOSED');

    if (!runtimePromise) {
      runtimePromise = Promise.resolve().then(() => runtimeFactory(config, { env }));
    }

    let runtime;
    try {
      runtime = await runtimePromise;
    } catch (error) {
      runtimePromise = null;
      throw error instanceof IdentityAuthorityError
        ? error
        : authorityError('IDENTITY_POSTGRES_AUTHORITY_START_FAILED', error);
    }

    const active = Promise.resolve().then(() => runtime.invoke(operation, input));
    activeOperations.add(active);
    try {
      return { selected: true, result: await active };
    } catch (error) {
      if (error instanceof IdentityWriteError || error instanceof IdentityAuthorityError) {
        throw error;
      }
      throw authorityError('IDENTITY_POSTGRES_AUTHORITY_OPERATION_FAILED', error);
    } finally {
      activeOperations.delete(active);
    }
  }

  async function close() {
    closed = true;
    if (!runtimePromise) return;
    const runtime = await runtimePromise.catch(() => null);
    runtimePromise = null;
    await Promise.allSettled([...activeOperations]);
    if (runtime && typeof runtime.close === 'function') await runtime.close();
  }

  return Object.freeze({ invoke, close });
}

function identityAuthorityHttpError() {
  return {
    status: 503,
    code: 'IDENTITY_AUTHORITY_UNAVAILABLE',
    message: '账号服务暂时不可用，请稍后重试。'
  };
}

const defaultController = createIdentityAuthorityController();

function invokeIdentityAuthority(operation, input) {
  return defaultController.invoke(operation, input);
}

function closeIdentityAuthorityRuntime() {
  return defaultController.close();
}

module.exports = {
  IdentityAuthorityError,
  closeIdentityAuthorityRuntime,
  createIdentityAuthorityController,
  createIdentityAuthorityRuntime,
  identityAuthorityHttpError,
  invokeIdentityAuthority
};
