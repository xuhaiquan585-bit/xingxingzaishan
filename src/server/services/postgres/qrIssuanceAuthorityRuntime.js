'use strict';

const { checkSourceAndDomainFreshness } = require('./publicQrFreshness');
const {
  readQrIssuanceAuthorityConfig
} = require('./qrIssuanceAuthorityConfig');
const { QrIssuanceError } = require('./qrIssuanceService');
const { QrAdministrationError } = require('./qrAdministrationService');

class QrIssuanceAuthorityError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'QrIssuanceAuthorityError';
    this.code = code;
  }
}

function authorityError(code, cause = null) {
  const error = new QrIssuanceAuthorityError(
    code,
    'The PostgreSQL QR issuance authority is unavailable.'
  );
  if (cause) error.cause = cause;
  return error;
}

function assertEnabledConfig(config) {
  if (!config || config.enabled !== true || config.scope !== 'all'
    || !config.sourceHash || !config.domainHash) {
    throw authorityError('QR_ISSUANCE_POSTGRES_AUTHORITY_CONFIG_INVALID');
  }
}

function createQrIssuanceAuthorityRuntime(config, {
  env = process.env,
  createPool,
  closePool,
  transactionRunner,
  migrationsLoader,
  repositoryTypes,
  issuanceServiceFactory,
  administrationServiceFactory,
  freshnessChecker = checkSourceAndDomainFreshness
} = {}) {
  assertEnabledConfig(config);
  const connection = createPool && closePool ? null : require('../../database/connection');
  const transaction = transactionRunner ? null : require('../../database/transaction');
  const databaseConfig = require('../../database/config');
  const repositories = repositoryTypes || require('../../repositories');
  const migrationModule = migrationsLoader
    ? { loadMigrations: migrationsLoader }
    : require('../../../../scripts/database/migrate');
  const createService = issuanceServiceFactory
    || require('./qrIssuanceService').createQrIssuanceService;
  const createAdministrationService = administrationServiceFactory
    || require('./qrAdministrationService').createQrAdministrationService;

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
      applicationName: 'xingxingzaishan-qr-issuance-authority'
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
      throw authorityError(`QR_ISSUANCE_POSTGRES_AUTHORITY_${eligibility}`);
    }
  }

  const service = createService({
    pool,
    transactionRunner: runTransaction,
    repositoryType: repositories.QrIssuanceRepository,
    beforeOperation: ({ transactionContext }) => assertEligible(transactionContext),
    env
  });
  const administrationService = createAdministrationService({
    pool,
    transactionRunner: runTransaction,
    repositoryType: repositories.QrAdministrationRepository,
    beforeOperation: ({ transactionContext }) => assertEligible(transactionContext)
  });

  async function issue(input) {
    if (closed) throw authorityError('QR_ISSUANCE_POSTGRES_AUTHORITY_CLOSED');
    return service.issue(input);
  }

  async function administer(operation, input) {
    if (closed) throw authorityError('QR_ISSUANCE_POSTGRES_AUTHORITY_CLOSED');
    if (!operation || typeof administrationService[operation] !== 'function') {
      throw authorityError('QR_ISSUANCE_POSTGRES_AUTHORITY_OPERATION_INVALID');
    }
    return administrationService[operation](input || {});
  }

  async function close() {
    if (closed) return;
    closed = true;
    await poolCloser(pool);
  }

  return Object.freeze({ administer, issue, close });
}

function createQrIssuanceAuthorityController({
  env = process.env,
  readConfig = readQrIssuanceAuthorityConfig,
  runtimeFactory = createQrIssuanceAuthorityRuntime
} = {}) {
  let runtimePromise = null;
  let closed = false;
  const activeOperations = new Set();

  async function execute(operation, input = {}) {
    const config = readConfig(env);
    if (!config || config.requested !== true) return { selected: false };
    if (config.enabled !== true) {
      throw authorityError('QR_ISSUANCE_POSTGRES_AUTHORITY_CONFIG_INVALID');
    }
    assertEnabledConfig(config);
    if (closed) throw authorityError('QR_ISSUANCE_POSTGRES_AUTHORITY_CLOSED');

    if (!runtimePromise) {
      runtimePromise = Promise.resolve().then(() => runtimeFactory(config, { env }));
    }
    let runtime;
    try {
      runtime = await runtimePromise;
    } catch (error) {
      runtimePromise = null;
      throw error instanceof QrIssuanceAuthorityError
        ? error
        : authorityError('QR_ISSUANCE_POSTGRES_AUTHORITY_START_FAILED', error);
    }

    const active = Promise.resolve().then(() => (
      operation === 'issue'
        ? runtime.issue(input)
        : runtime.administer(operation, input)
    ));
    activeOperations.add(active);
    try {
      return { selected: true, result: await active };
    } catch (error) {
      if (error instanceof QrIssuanceError
        || error instanceof QrAdministrationError
        || error instanceof QrIssuanceAuthorityError) {
        throw error;
      }
      throw authorityError('QR_ISSUANCE_POSTGRES_AUTHORITY_OPERATION_FAILED', error);
    } finally {
      activeOperations.delete(active);
    }
  }

  function issue(input = {}) {
    return execute('issue', input);
  }

  function administer(operation, input = {}) {
    return execute(operation, input);
  }

  async function close() {
    closed = true;
    if (!runtimePromise) return;
    const runtime = await runtimePromise.catch(() => null);
    runtimePromise = null;
    await Promise.allSettled([...activeOperations]);
    if (runtime && typeof runtime.close === 'function') await runtime.close();
  }

  return Object.freeze({ administer, issue, close });
}

function qrIssuanceAuthorityHttpError(error) {
  if (error && error.code === 'QR_SEQUENCE_EXCEEDED') {
    return {
      status: 400,
      code: 'QR_SEQUENCE_EXCEEDED',
      message: '该 prefix 可用序号已用尽（最多 99999）。'
    };
  }
  if (error && error.code === 'BATCH_NOT_FOUND') {
    return { status: 404, code: 'BATCH_NOT_FOUND', message: '未找到该批次。' };
  }
  if (error && error.code === 'QR_NOT_FOUND') {
    return { status: 404, code: 'QR_NOT_FOUND', message: '未找到该二维码。' };
  }
  if (error && [
    'BATCH_NAME_REQUIRED',
    'QR_ADMINISTRATION_IDS_INVALID',
    'QR_ADMINISTRATION_PAGINATION_INVALID',
    'QR_ADMINISTRATION_DATE_INVALID'
  ].includes(error.code)) {
    return { status: 400, code: 'VALIDATION_ERROR', message: '请求参数无效。' };
  }
  return {
    status: 503,
    code: 'QR_ISSUANCE_UNAVAILABLE',
    message: '二维码服务暂时不可用，请稍后重试。'
  };
}

const defaultController = createQrIssuanceAuthorityController();

function issueQrCodes(input) {
  return defaultController.issue(input);
}

function administerQrs(operation, input) {
  return defaultController.administer(operation, input);
}

function closeQrIssuanceAuthorityRuntime() {
  return defaultController.close();
}

module.exports = {
  QrIssuanceAuthorityError,
  administerQrs,
  closeQrIssuanceAuthorityRuntime,
  createQrIssuanceAuthorityController,
  createQrIssuanceAuthorityRuntime,
  issueQrCodes,
  qrIssuanceAuthorityHttpError
};
