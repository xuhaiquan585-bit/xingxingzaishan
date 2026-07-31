'use strict';

const crypto = require('node:crypto');
const {
  closePostgresPool,
  createPostgresPool,
  sanitizePostgresError
} = require('../../src/server/database/connection');
const { readPostgresConfig, redactPostgresConfig } = require('../../src/server/database/config');
const { withTransaction } = require('../../src/server/database/transaction');
const { inspectMigrationState, loadMigrations } = require('./migrate');
const { analyzeSourceSnapshot } = require('./importer');
const { assertSourceUnchanged, readSourceSnapshot } = require('./importer/reader');
const {
  IMPORT_ORDER,
  importPlanToPostgres,
  planSha256,
  resetIdentitySequences
} = require('./importer/writer');
const { verifyImportedPlan } = require('./importer/verify-import');

const IMPORTER_VERSION = 'phase-2b-2-v1';
const IMPORT_LOCK_KEY = 'xingxingzaishan:postgresql:staging-import';
const STAGING_DATABASE_PATTERN = /(?:_staging|_test)$/i;
const CORE_TABLES = Object.freeze([...IMPORT_ORDER, 'outbox_jobs']);

function stagingImportError(code, message, details = {}) {
  const error = new Error(message || code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function parseArguments(argv) {
  const values = {};
  let applyStaging = false;
  let stagingConfirmed = false;
  for (const argument of argv) {
    if (argument === '--apply-staging') {
      applyStaging = true;
      continue;
    }
    if (argument === '--staging-confirmed') {
      stagingConfirmed = true;
      continue;
    }
    const match = /^--([a-z0-9-]+)=(.*)$/i.exec(argument);
    if (!match || !['input', 'expected-source-sha256', 'target'].includes(match[1])) {
      throw stagingImportError(
        'POSTGRES_IMPORT_ARGUMENT_INVALID',
        'Use the explicit staging import arguments.'
      );
    }
    if (Object.prototype.hasOwnProperty.call(values, match[1])) {
      throw stagingImportError(
        'POSTGRES_IMPORT_ARGUMENT_INVALID',
        'Staging import arguments may only be specified once.'
      );
    }
    values[match[1]] = match[2];
  }

  if (!values.input) {
    throw stagingImportError('POSTGRES_IMPORT_INPUT_REQUIRED', 'An explicit input file is required.');
  }
  if (!/^[0-9a-f]{64}$/i.test(values['expected-source-sha256'] || '')) {
    throw stagingImportError(
      'POSTGRES_IMPORT_EXPECTED_SHA256_REQUIRED',
      'A valid expected source SHA-256 is required.'
    );
  }
  if (String(values.target || '').toLowerCase() !== 'staging') {
    throw stagingImportError(
      'POSTGRES_IMPORT_STAGING_TARGET_REQUIRED',
      'The import target must be explicitly set to staging.'
    );
  }
  if (!applyStaging || !stagingConfirmed) {
    throw stagingImportError(
      'POSTGRES_IMPORT_STAGING_CONFIRMATION_REQUIRED',
      'Both --apply-staging and --staging-confirmed are required.'
    );
  }

  return {
    inputPath: values.input,
    expectedSha256: values['expected-source-sha256'].toLowerCase(),
    target: 'staging'
  };
}

function assertStagingEnvironment({ config, env = process.env, target }) {
  if (String(target || '').toLowerCase() !== 'staging') {
    throw stagingImportError(
      'POSTGRES_IMPORT_STAGING_TARGET_REQUIRED',
      'Only the staging target is allowed.'
    );
  }
  if (String(env.NODE_ENV || '').trim().toLowerCase() === 'production') {
    throw stagingImportError(
      'POSTGRES_IMPORT_PRODUCTION_FORBIDDEN',
      'Staging import is disabled when NODE_ENV is production.'
    );
  }
  const redacted = redactPostgresConfig(config);
  const database = redacted && String(redacted.database || '').trim();
  if (!database || !STAGING_DATABASE_PATTERN.test(database)) {
    throw stagingImportError(
      'POSTGRES_IMPORT_DATABASE_NOT_STAGING',
      'The database name must end with _staging or _test.'
    );
  }
  return { database, schema: 'app' };
}

function assertAnalysisReady(report, plan) {
  if (!report || report.status !== 'READY' || report.can_import !== true) {
    throw stagingImportError(
      'POSTGRES_IMPORT_DRY_RUN_BLOCKED',
      'The source must pass the Phase 2B-1 dry-run before staging import.'
    );
  }
  if (!report.count_conservation || report.count_conservation.passed !== true) {
    throw stagingImportError(
      'POSTGRES_IMPORT_CONSERVATION_FAILED',
      'Count conservation must pass before staging import.'
    );
  }
  if (!report.disposition_conservation || report.disposition_conservation.passed !== true) {
    throw stagingImportError(
      'POSTGRES_IMPORT_CONSERVATION_FAILED',
      'Source disposition conservation must pass before staging import.'
    );
  }
  if (!Array.isArray(report.anomalies) || report.anomalies.some((item) => item.blocking)) {
    throw stagingImportError(
      'POSTGRES_IMPORT_DRY_RUN_BLOCKED',
      'Blocking anomalies must be zero before staging import.'
    );
  }
  return planSha256(plan);
}

async function createImportRun(transactionContext, { report, runId, planDigest }) {
  const existing = await transactionContext.query(
    'SELECT id FROM app.import_runs WHERE source_sha256 = $1',
    [report.source_sha256]
  );
  if (existing.rows.length > 0) {
    throw stagingImportError(
      'POSTGRES_IMPORT_SOURCE_ALREADY_IMPORTED',
      'This source hash already has an import run.'
    );
  }
  await transactionContext.query(
    `INSERT INTO app.import_runs (
      id, source_sha256, source_label, importer_version, mode, status,
      source_counts, imported_counts, checksum_summary
    ) VALUES ($1, $2, $3, $4, 'staging', 'running', $5::jsonb, '{}'::jsonb, $6::jsonb)`,
    [
      runId,
      report.source_sha256,
      `snapshot-${report.source_sha256.slice(0, 12)}`,
      IMPORTER_VERSION,
      JSON.stringify(report.source_counts || {}),
      JSON.stringify({ plan_sha256: planDigest })
    ]
  );
}

async function assertMigrationsCurrent(transactionContext, migrations) {
  const state = await inspectMigrationState(transactionContext, migrations);
  if (state.pending.length > 0) {
    throw stagingImportError(
      'POSTGRES_IMPORT_MIGRATIONS_REQUIRED',
      'All repository migrations must be applied before staging import.'
    );
  }
}

async function assertBusinessTablesEmpty(transactionContext) {
  for (const table of CORE_TABLES) {
    const result = await transactionContext.query(
      `SELECT COUNT(*)::text AS row_count FROM app.${table}`
    );
    const count = Number(result.rows[0] && result.rows[0].row_count);
    if (!Number.isSafeInteger(count) || count !== 0) {
      throw stagingImportError(
        'POSTGRES_IMPORT_STAGING_NOT_EMPTY',
        'The staging business tables must be empty before import.',
        { table }
      );
    }
  }
}

async function assertRunIsActive(transactionContext, runId) {
  const result = await transactionContext.query(
    'SELECT status FROM app.import_runs WHERE id = $1 FOR UPDATE',
    [runId]
  );
  if (result.rows.length !== 1 || result.rows[0].status !== 'running') {
    throw stagingImportError(
      'POSTGRES_IMPORT_RUN_STATE_INVALID',
      'The staging import run is not active.'
    );
  }
}

async function markImportFailed(pool, runId, error, transactionRunner = withTransaction) {
  const category = String(error && error.code || 'POSTGRES_IMPORT_FAILED').slice(0, 80);
  await transactionRunner(pool, async (transactionContext) => {
    await transactionContext.query(
      `UPDATE app.import_runs
       SET status = 'failed', completed_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'running'`,
      [runId]
    );
    await transactionContext.query(
      `INSERT INTO app.import_anomalies (
        import_run_id, severity, category, entity_type, candidate_count, blocking, detail
      ) VALUES ($1, 'error', $2, 'import_run', 0, true, '{}'::jsonb)`,
      [runId, category]
    );
  });
}

async function executeStagingImport({
  pool,
  snapshot,
  report,
  plan,
  migrations = loadMigrations(),
  transactionRunner = withTransaction,
  sourceUnchanged = assertSourceUnchanged
}) {
  if (!pool) {
    throw stagingImportError('POSTGRES_IMPORT_POOL_REQUIRED', 'A PostgreSQL pool is required.');
  }
  const planDigest = assertAnalysisReady(report, plan);
  if (snapshot.sourceHash !== report.source_sha256) {
    throw stagingImportError(
      'POSTGRES_IMPORT_SOURCE_MISMATCH',
      'The source snapshot does not match the dry-run report.'
    );
  }
  const runId = crypto.randomUUID();
  let runCreated = false;

  try {
    await transactionRunner(pool, async (transactionContext) => {
      await createImportRun(transactionContext, { report, runId, planDigest });
    });
    runCreated = true;

    const result = await transactionRunner(pool, async (transactionContext) => {
      await transactionContext.query(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [IMPORT_LOCK_KEY]
      );
      await assertMigrationsCurrent(transactionContext, migrations);
      await assertRunIsActive(transactionContext, runId);
      await assertBusinessTablesEmpty(transactionContext);

      const importedCounts = await importPlanToPostgres({ plan, transactionContext });
      const sequenceValues = await resetIdentitySequences(transactionContext);
      const verification = await verifyImportedPlan({ plan, transactionContext });
      sourceUnchanged(snapshot);

      await transactionContext.query(
        `UPDATE app.import_runs
         SET status = 'passed', imported_counts = $2::jsonb,
             checksum_summary = $3::jsonb, completed_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND status = 'running'`,
        [
          runId,
          JSON.stringify(importedCounts),
          JSON.stringify({ plan_sha256: planDigest, source_sha256: report.source_sha256 })
        ]
      );
      return { importedCounts, sequenceValues, verification };
    }, { isolationLevel: 'serializable' });

    return {
      mode: 'staging-import',
      status: 'PASSED',
      import_run_id: runId,
      source_sha256: report.source_sha256,
      plan_sha256: planDigest,
      imported_counts: result.importedCounts,
      sequence_values: result.sequenceValues,
      integrity_checks: result.verification.integrity
    };
  } catch (error) {
    if (runCreated) {
      try {
        await markImportFailed(pool, runId, error, transactionRunner);
      } catch (failureRecordingError) {
        error.failureRecordingCode = failureRecordingError.code || 'POSTGRES_IMPORT_FAILURE_RECORDING_FAILED';
      }
    }
    if (error && error.code === 'POSTGRES_QUERY_FAILED' && error.postgresCode === '23505' && !runCreated) {
      throw stagingImportError(
        'POSTGRES_IMPORT_SOURCE_ALREADY_IMPORTED',
        'This source hash already has an import run.'
      );
    }
    throw error;
  }
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArguments(argv);
  const snapshot = readSourceSnapshot({
    inputPath: options.inputPath,
    expectedSha256: options.expectedSha256
  });
  const { report, plan } = analyzeSourceSnapshot(snapshot);
  assertAnalysisReady(report, plan);

  const config = readPostgresConfig(env);
  const target = assertStagingEnvironment({ config, env, target: options.target });
  const pool = createPostgresPool({ config });
  try {
    const result = await executeStagingImport({ pool, snapshot, report, plan });
    process.stdout.write(`${JSON.stringify({ ...result, target }, null, 2)}\n`);
  } finally {
    await closePostgresPool(pool);
  }
}

if (require.main === module) {
  main().catch((error) => {
    const safeError = error && String(error.code || '').startsWith('POSTGRES_')
      ? error
      : sanitizePostgresError(error, 'POSTGRES_IMPORT_FAILED');
    process.stderr.write(`${JSON.stringify({
      error: safeError.code,
      message: safeError.message,
      postgres_code: safeError.postgresCode || undefined,
      failure_recording_error: safeError.failureRecordingCode || undefined
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  CORE_TABLES,
  IMPORTER_VERSION,
  assertAnalysisReady,
  assertBusinessTablesEmpty,
  assertStagingEnvironment,
  executeStagingImport,
  main,
  parseArguments
};
