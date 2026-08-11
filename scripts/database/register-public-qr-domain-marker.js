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
const PRESERVED_LIFECYCLE_ARGUMENT = 'allow-preserved-unissued-lifecycle-ids';

function markerError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function normalizePreservedLifecycleIds(value) {
  const raw = Array.isArray(value)
    ? value.map((item) => String(item || '').trim())
    : String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (raw.some((id) => !/^[A-Za-z0-9_-]+$/.test(id))
      || new Set(raw).size !== raw.length) {
    throw markerError(
      'PUBLIC_QR_DOMAIN_MARKER_LEGACY_ALLOWLIST_INVALID',
      'Preserved unissued lifecycle IDs must be unique canonical QR IDs.'
    );
  }
  return raw.sort();
}

function preservedUnissuedLifecycleIds(plan) {
  return (Array.isArray(plan && plan.qr_codes) ? plan.qr_codes : [])
    .filter((row) => (
      row.issue_status !== 'issued'
      && row.lifecycle_status !== 'unactivated'
    ))
    .map((row) => String(row.id || '').trim())
    .sort();
}

function assertMarkerAnalysisReady(report, plan, allowedIds = []) {
  const expected = normalizePreservedLifecycleIds(allowedIds);
  const actual = preservedUnissuedLifecycleIds(plan);
  if (actual.length === 0 && expected.length === 0) {
    assertAnalysisReady(report, plan);
    return actual;
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw markerError(
      'PUBLIC_QR_DOMAIN_MARKER_LEGACY_ALLOWLIST_MISMATCH',
      'The explicit preserved lifecycle allowlist must exactly match the source plan.'
    );
  }
  const blocking = Array.isArray(report && report.anomalies)
    ? report.anomalies.filter((item) => item.blocking)
    : [];
  const accepted = (item) => (
    item.category === 'INVALID_QR_ISSUE_LIFECYCLE'
    && item.entity_type === 'qr_codes'
    && item.field === 'issue_status'
    && item.count === 1
  );
  if (blocking.length !== actual.length || blocking.some((item) => !accepted(item))) {
    throw markerError(
      'PUBLIC_QR_DOMAIN_MARKER_SOURCE_BLOCKED',
      'Only the explicitly preserved unissued lifecycle anomalies may be registered.'
    );
  }
  assertAnalysisReady({
    ...report,
    status: 'READY',
    can_import: true,
    blocked_reasons: [],
    anomalies: report.anomalies.map((item) => (
      item.blocking && accepted(item) ? { ...item, blocking: false } : item
    ))
  }, plan);
  return actual;
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
      'target',
      PRESERVED_LIFECYCLE_ARGUMENT
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
    target: values.target,
    preservedUnissuedLifecycleIds: normalizePreservedLifecycleIds(
      values[PRESERVED_LIFECYCLE_ARGUMENT]
    )
  };
}

async function assertPreservedLifecycleConstraint(transactionContext, ids) {
  if (ids.length === 0) return;
  const result = await transactionContext.query(
    `SELECT convalidated
     FROM pg_constraint
     WHERE conrelid = 'app.qr_codes'::regclass
       AND conname = 'qr_codes_issued_lifecycle_chk'`
  );
  if (result.rows.length !== 1 || result.rows[0].convalidated !== false) {
    throw markerError(
      'PUBLIC_QR_DOMAIN_MARKER_LEGACY_CONSTRAINT_REQUIRED',
      'The preserved lifecycle exception requires the migration 006 NOT VALID constraint.'
    );
  }
}

async function registerPublicQrDomainMarker({
  pool,
  snapshot,
  plan,
  expectedDomainSha256,
  preservedUnissuedLifecycleIds: allowedIds = [],
  migrations = loadMigrations(),
  transactionRunner = withTransaction,
  sourceUnchanged = assertSourceUnchanged,
  migrationInspector = inspectMigrationState,
  verifyPlan = verifyImportedPlan
}) {
  const preservedIds = normalizePreservedLifecycleIds(allowedIds);
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

    await assertPreservedLifecycleConstraint(transactionContext, preservedIds);

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
      preserved_unissued_lifecycle_ids: preservedIds,
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
  const preservedIds = assertMarkerAnalysisReady(
    report,
    plan,
    options.preservedUnissuedLifecycleIds
  );
  const config = readPostgresConfig(env);
  const target = assertStagingEnvironment({ config, env, target: options.target });
  const pool = createPostgresPool({ config });
  try {
    const result = await registerPublicQrDomainMarker({
      pool,
      snapshot,
      plan,
      expectedDomainSha256: options.expectedDomainSha256,
      preservedUnissuedLifecycleIds: preservedIds
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
  assertMarkerAnalysisReady,
  main,
  normalizePreservedLifecycleIds,
  parseArguments,
  registerPublicQrDomainMarker
};
