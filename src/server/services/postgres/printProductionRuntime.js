'use strict';

const { checkSourceAndDomainFreshness } = require('./publicQrFreshness');
const { readQrIssuanceAuthorityConfig } = require('./qrIssuanceAuthorityConfig');
const { LabelTemplateServiceError } = require('./labelTemplateService');
const { LabelRenderError } = require('../labelRenderer');

class PrintProductionRuntimeError extends Error {
  constructor(code) {
    super(code);
    this.name = 'PrintProductionRuntimeError';
    this.code = code;
  }
}

function createPrintProductionRuntime({ env = process.env } = {}) {
  const config = readQrIssuanceAuthorityConfig(env);
  if (!config.requested || !config.enabled) {
    throw new PrintProductionRuntimeError('PRINT_PRODUCTION_POSTGRES_AUTHORITY_REQUIRED');
  }
  const { createPostgresPool, closePostgresPool } = require('../../database/connection');
  const { readPostgresConfig } = require('../../database/config');
  const { withTransaction } = require('../../database/transaction');
  const repositories = require('../../repositories');
  const migrations = require('../../../../scripts/database/migrate').loadMigrations()
    .map(({ version, checksum }) => ({ version, checksum }));
  const postgresConfig = readPostgresConfig(env);
  const pool = createPostgresPool({
    config: {
      ...postgresConfig,
      poolMax: Math.min(4, postgresConfig.poolMax),
      applicationName: 'xingxingzaishan-print-production'
    }
  });
  const service = require('./labelTemplateService').createLabelTemplateService({
    pool,
    transactionRunner: withTransaction,
    repositoryType: repositories.LabelTemplateRepository,
    beforeOperation: async ({ transactionContext }) => {
      const eligibility = await checkSourceAndDomainFreshness({
        provenanceRepository: new repositories.PublicQrProvenanceRepository(transactionContext),
        sourceHash: config.sourceHash,
        domainHash: config.domainHash,
        migrations
      });
      if (eligibility !== 'ELIGIBLE') {
        throw new PrintProductionRuntimeError(`PRINT_PRODUCTION_POSTGRES_${eligibility}`);
      }
    }
  });
  let closed = false;
  async function execute(operation, input) {
    if (closed) throw new PrintProductionRuntimeError('PRINT_PRODUCTION_RUNTIME_CLOSED');
    if (!operation || typeof service[operation] !== 'function') {
      throw new PrintProductionRuntimeError('PRINT_PRODUCTION_OPERATION_INVALID');
    }
    return service[operation](input || {});
  }
  async function close() {
    if (closed) return;
    closed = true;
    await closePostgresPool(pool);
  }
  return Object.freeze({ execute, close });
}

let runtimePromise = null;

async function executePrintProduction(operation, input) {
  if (!runtimePromise) {
    runtimePromise = Promise.resolve().then(() => createPrintProductionRuntime());
  }
  try {
    return await (await runtimePromise).execute(operation, input);
  } catch (error) {
    if (error instanceof LabelTemplateServiceError
        || error instanceof PrintProductionRuntimeError
        || error instanceof LabelRenderError
        || error?.code === 'LABEL_TEMPLATE_INVALID') throw error;
    throw new PrintProductionRuntimeError('PRINT_PRODUCTION_OPERATION_FAILED');
  }
}

async function closePrintProductionRuntime() {
  if (!runtimePromise) return;
  const runtime = await runtimePromise.catch(() => null);
  runtimePromise = null;
  if (runtime) await runtime.close();
}

module.exports = {
  PrintProductionRuntimeError,
  closePrintProductionRuntime,
  createPrintProductionRuntime,
  executePrintProduction
};
