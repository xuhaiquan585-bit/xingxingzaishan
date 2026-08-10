'use strict';

const {
  closePostgresPool,
  createPostgresPool,
  sanitizePostgresError
} = require('../../src/server/database/connection');
const { readPostgresConfig } = require('../../src/server/database/config');
const { withTransaction } = require('../../src/server/database/transaction');
const { assertAnalysisReady, assertStagingEnvironment } = require('./import-staging');
const { analyzeSourceSnapshot } = require('./importer');
const {
  PUBLIC_QR_DOMAIN_CHECKSUM_KEY,
  publicQrDomainSha256
} = require('./importer/domain-markers');
const { assertSourceUnchanged, readSourceSnapshot } = require('./importer/reader');
const { inspectMigrationState, loadMigrations } = require('./migrate');
const { verifyImportedPlan } = require('./importer/verify-import');

const DOMAIN_MARKER_LOCK_KEY = 'xingxingzaishan:public-qr-domain-marker';

function markerError(code, message) {
  const error = new Error(message || code);
  error.code = code;
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
    if (!match || ![
      'input',
      'expected-source-sha256',
      'expected-domain-sha256',
      'target'
    ].includes(match[1]) || Object.hasOwn(values, match[1])) {
      throw markerError(
        'PUBLIC_QR_DOMAIN_MARKER_ARGUMENT_INVALID',
        'Use the explicit public QR domain marker arguments.'
      );
    }
    values[match[1]] = match[2];
  }

  for (const key of ['expected-source-sha256', 'expected-domain-sha256']) {
    if (!/^[0-9a-f]{64}$/.test(values[key] || '')) {
      throw markerError(
        'PUBLIC_QR_DOMAIN_MARKER_SHA256_REQUIRED',
        'Canonical source and public QR domain SHA-256 values are required.'
      );
    }
  }
  if (!values.input || values.target !== 'staging' || !applyStaging || !stagingConfirmed) {
    throw markerError(
      'PUBLIC_QR_DOMAIN_MARKER_CONFIRMATION_REQUIRED',
      'Input, staging target, and both staging confirmations are required.'
    );
  }
  return {
    inputPath: values.input,
    expectedSourceSha256: values['expected-source-sha256'],
    expectedDomainSha256: values['expected-domain-sha256'],
    target: values.target
  };
}

async function registerPublicQrDomainMarker({
  pool,
  snapshot,
  plan,
  expectedDomainSha256,
  migrations = loadMigrations(),
  transactionRunner = withTransaction,
  sourceUnchanged = assertSourceUnchanged,
  migrationInspector = inspectMigrationState,
  verifyPlan = verifyImportedPlan
}) {
  const calculatedDomainSha256 = publicQrDomainSha256(plan);
  if (calculatedDomainSha256 !== expectedDomainSha256) {
    throw markerError(
      'PUBLIC_QR_DOMAIN_MARKER_MISMATCH',
      'The expected public QR domain marker does not match the source plan.'
    );
  }

  return transactionRunner(pool, async (transactionContext) => {
    await transactionContext.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [DOMAIN_MARKER_LOCK_KEY]
    );
    const migrationState = await migrationInspector(transactionContext, migrations);
    if (migrationState.pending.length > 0) {
      throw markerError(
        'PUBLIC_QR_DOMAIN_MARKER_MIGRATIONS_REQUIRED',
        'All repository migrations must be applied before marker registration.'
      );
    }

    const verification = await verifyPlan({ plan, transactionContext });
    sourceUnchanged(snapshot);

    const importRun = await transactionContext.query(
      `SELECT id, checksum_summary ->> $2 AS current_domain_sha256
       FROM app.import_runs
       WHERE source_sha256 = $1 AND status = 'passed'
       FOR UPDATE`,
      [snapshot.sourceHash, PUBLIC_QR_DOMAIN_CHECKSUM_KEY]
    );
    if (importRun.rows.length !== 1) {
      throw markerError(
        'PUBLIC_QR_DOMAIN_MARKER_IMPORT_REQUIRED',
        'Exactly one passed import for the source snapshot is required.'
      );
    }
    const row = importRun.rows[0];
    const current = String(row.current_domain_sha256 || '').trim();
    if (current && current !== calculatedDomainSha256) {
      throw markerError(
        'PUBLIC_QR_DOMAIN_MARKER_CONFLICT',
        'The passed import already contains a different public QR domain marker.'
      );
    }
    if (!current) {
      await transactionContext.query(
        `UPDATE app.import_runs
         SET checksum_summary = jsonb_set(
           checksum_summary,
           ARRAY[$2]::text[],
           to_jsonb($3::text),
           true
         )
         WHERE id = $1`,
        [row.id, PUBLIC_QR_DOMAIN_CHECKSUM_KEY, calculatedDomainSha256]
      );
    }
    return {
      status: 'PASSED',
      source_sha256: snapshot.sourceHash,
      public_qr_domain_sha256: calculatedDomainSha256,
      marker_key: PUBLIC_QR_DOMAIN_CHECKSUM_KEY,
      updated: !current,
      integrity_checks: verification.integrity
    };
  }, { isolationLevel: 'serializable' });
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArguments(argv);
  const snapshot = readSourceSnapshot({
    inputPath: options.inputPath,
    expectedSha256: options.expectedSourceSha256
  });
  const { report, plan } = analyzeSourceSnapshot(snapshot);
  assertAnalysisReady(report, plan);
  const config = readPostgresConfig(env);
  const target = assertStagingEnvironment({ config, env, target: options.target });
  const pool = createPostgresPool({ config });
  try {
    const result = await registerPublicQrDomainMarker({
      pool,
      snapshot,
      plan,
      expectedDomainSha256: options.expectedDomainSha256
    });
    process.stdout.write(`${JSON.stringify({ ...result, target }, null, 2)}\n`);
  } finally {
    await closePostgresPool(pool);
  }
}

if (require.main === module) {
  main().catch((error) => {
    const safeError = error && String(error.code || '').startsWith('PUBLIC_QR_')
      ? error
      : sanitizePostgresError(error, 'PUBLIC_QR_DOMAIN_MARKER_FAILED');
    process.stderr.write(`${JSON.stringify({
      error: safeError.code,
      message: safeError.message,
      postgres_code: safeError.postgresCode || undefined
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DOMAIN_MARKER_LOCK_KEY,
  main,
  parseArguments,
  registerPublicQrDomainMarker
};
