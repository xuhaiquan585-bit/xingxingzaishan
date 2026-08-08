'use strict';

const { readIdentityShadowConfig } = require('./identityShadowConfig');
const { checkCandidateFreshness } = require('./publicQrShadowRuntime');

function normalizedIdentityId(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const numericValue = Number(value);
    if (Number.isSafeInteger(numericValue)) return numericValue;
  }
  return value;
}

function identityAuthDto(result) {
  if (!result || !result.data) {
    return Object.freeze({
      authenticated: false,
      error: String(result && result.error || 'UNAUTHORIZED')
    });
  }
  const identity = result.data;
  return Object.freeze({
    authenticated: true,
    identity: Object.freeze({
      id: normalizedIdentityId(identity.id),
      phone: identity.phone || null,
      openid: identity.openid || null,
      unionid: identity.unionid || null,
      account_id: identity.account_id || null
    })
  });
}

function createIdentityShadowRuntime(config, {
  env = process.env,
  createPool,
  closePool,
  transactionRunner,
  migrationsLoader,
  repositories,
  AdapterClass,
  compareDtos,
  SinkClass,
  createObserver
} = {}) {
  const connection = createPool && closePool ? null : require('../../database/connection');
  const transaction = transactionRunner ? null : require('../../database/transaction');
  const databaseConfig = require('../../database/config');
  const repositoryTypes = repositories || require('../../repositories');
  const { IdentityReadAdapter } = AdapterClass
    ? { IdentityReadAdapter: AdapterClass }
    : require('./identityReadAdapter');
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

  const postgresConfig = databaseConfig.readPostgresConfig(env);
  const poolConfig = {
    ...postgresConfig,
    poolMax: Math.min(2, postgresConfig.poolMax),
    connectionTimeoutMillis: Math.min(config.timeoutMs, postgresConfig.connectionTimeoutMillis),
    statementTimeoutMillis: Math.min(
      config.timeoutMs,
      postgresConfig.statementTimeoutMillis || config.timeoutMs
    ),
    applicationName: 'xingxingzaishan-identity-shadow'
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
    filePrefix: 'identity-shadow-'
  });

  async function readCandidate(input) {
    const startedAt = Date.now();
    const result = await runTransaction(pool, async (transactionContext) => {
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

      const adapter = new IdentityReadAdapter({
        identityRepository: new repositoryTypes.IdentityRepository(transactionContext),
        accountRepository: new repositoryTypes.AccountRepository(transactionContext)
      });
      const viewer = input.viewer || {};
      const identityResult = await adapter.getAuthenticatedIdentity({
        identityId: viewer.identityId,
        accountId: input.accountId,
        openid: input.channel === 'miniapp' ? viewer.openid : null
      });
      return { eligibility, identityResult };
    }, { isolationLevel: 'repeatable read', readOnly: true });

    if (result.eligibility !== 'ELIGIBLE') return result;
    return {
      eligibility: 'ELIGIBLE',
      lifecycle: input.channel === 'miniapp' ? 'miniapp_session' : 'h5_session',
      dto: identityAuthDto(result.identityResult)
    };
  }

  const observer = observerModule.createPublicQrShadowObserver({
    getConfig: () => config,
    readCandidate,
    compareDtos: comparator.comparePublicQrDtos,
    sink,
    observerVersion: 'identity-shadow-v1'
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

function createIdentityShadowScheduler({
  env = process.env,
  readConfig = readIdentityShadowConfig,
  runtimeFactory = createIdentityShadowRuntime
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
        // Identity Shadow failures cannot alter the completed JSON response.
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

const defaultScheduler = createIdentityShadowScheduler();

function registerIdentityShadowObservation(input) {
  return defaultScheduler.register(input);
}

function closeIdentityShadowRuntime() {
  return defaultScheduler.close();
}

module.exports = {
  closeIdentityShadowRuntime,
  createIdentityShadowRuntime,
  createIdentityShadowScheduler,
  identityAuthDto,
  registerIdentityShadowObservation
};
