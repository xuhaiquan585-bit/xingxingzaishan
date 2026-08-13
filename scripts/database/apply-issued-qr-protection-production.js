'use strict';

const {
  closePostgresPool,
  createPostgresPool,
  sanitizePostgresError
} = require('../../src/server/database/connection');
const { readPostgresConfig } = require('../../src/server/database/config');
const {
  acquireMigrationLock,
  applyMigration,
  inspectMigrationState,
  loadMigrations,
  releaseMigrationLock
} = require('./migrate');

const PRODUCTION_DATABASE = 'xingxing_clean_baseline_20260812_staging';
const EXPECTED_MIGRATION = '007_prevent_issued_qr_deletion.sql';
const EXPECTED_MIGRATION_CHECKSUM = 'f2404ceef14280f4025f5a00d0586ce58597007c4a2cdfae2ce4a26487b8f70e';
const EXPECTED_MIGRATION_NAMES = Object.freeze([
  '001_init_schema.sql',
  '002_add_comment_source_position.sql',
  '003_preserve_legacy_import_evidence.sql',
  '004_allow_legacy_product_buy_type.sql',
  '005_add_account_id_sequence.sql',
  '006_guard_unissued_qr_lifecycle.sql',
  EXPECTED_MIGRATION
]);
const ISSUED_QR_CONSTRAINT = 'qr_codes_issued_immutable';

class IssuedQrProtectionError extends Error {
  constructor(code) {
    super(code);
    this.name = 'IssuedQrProtectionError';
    this.code = code;
  }
}

function protectionError(code) {
  return new IssuedQrProtectionError(code);
}

function assertExpectedMigrationSet(migrations) {
  const names = migrations.map((migration) => migration.version);
  if (JSON.stringify(names) !== JSON.stringify(EXPECTED_MIGRATION_NAMES)) {
    throw protectionError('ISSUED_QR_PROTECTION_MIGRATION_SET_INVALID');
  }
  const expected = migrations[migrations.length - 1];
  if (!expected || expected.checksum !== EXPECTED_MIGRATION_CHECKSUM) {
    throw protectionError('ISSUED_QR_PROTECTION_CHECKSUM_INVALID');
  }
  return expected;
}

function assertExpectedDatabase(config) {
  if (!config || config.source !== 'discrete' || config.database !== PRODUCTION_DATABASE) {
    throw protectionError('ISSUED_QR_PROTECTION_DATABASE_INVALID');
  }
}

function assertExpectedMigrationState(state, migrations) {
  const expectedMigration = migrations[migrations.length - 1];
  const prior = migrations.slice(0, -1);
  const applied = state.applied.map(({ version, checksum }) => ({ version, checksum }));
  const expectedPrior = prior.map(({ version, checksum }) => ({ version, checksum }));
  const expectedAll = migrations.map(({ version, checksum }) => ({ version, checksum }));
  const pending = state.pending.map(({ version, checksum }) => ({ version, checksum }));

  if (JSON.stringify(applied) === JSON.stringify(expectedAll) && pending.length === 0) {
    return 'ALREADY_APPLIED';
  }
  if (JSON.stringify(applied) === JSON.stringify(expectedPrior)
      && JSON.stringify(pending) === JSON.stringify([{
        version: expectedMigration.version,
        checksum: expectedMigration.checksum
      }])) {
    return 'READY_TO_APPLY';
  }
  throw protectionError('ISSUED_QR_PROTECTION_MIGRATION_STATE_INVALID');
}

async function verifyIssuedQrDeleteRejected(client) {
  const beforeResult = await client.query(
    'SELECT count(*)::integer AS count FROM app.qr_codes'
  );
  const beforeCount = Number(beforeResult.rows[0]?.count);
  const issuedResult = await client.query(
    `SELECT id
       FROM app.qr_codes
      WHERE issue_status = 'issued'
      ORDER BY id
      LIMIT 1`
  );
  if (!issuedResult.rows[0]?.id) {
    throw protectionError('ISSUED_QR_PROTECTION_SAMPLE_MISSING');
  }

  await client.query('BEGIN');
  try {
    await client.query('SAVEPOINT issued_qr_delete_probe');
    try {
      await client.query(
        'DELETE FROM app.qr_codes WHERE id = $1',
        [issuedResult.rows[0].id]
      );
      throw protectionError('ISSUED_QR_PROTECTION_DELETE_ALLOWED');
    } catch (error) {
      if (error instanceof IssuedQrProtectionError) throw error;
      if (error?.code !== '23514' || error?.constraint !== ISSUED_QR_CONSTRAINT) {
        throw protectionError('ISSUED_QR_PROTECTION_DELETE_ERROR_INVALID');
      }
      await client.query('ROLLBACK TO SAVEPOINT issued_qr_delete_probe');
    }
  } finally {
    await client.query('ROLLBACK');
  }

  const afterResult = await client.query(
    'SELECT count(*)::integer AS count FROM app.qr_codes'
  );
  const afterCount = Number(afterResult.rows[0]?.count);
  if (!Number.isInteger(beforeCount) || beforeCount !== afterCount) {
    throw protectionError('ISSUED_QR_PROTECTION_COUNT_CHANGED');
  }
  return { beforeCount, afterCount };
}

async function executeIssuedQrProtection({ pool, migrations = loadMigrations() }) {
  const expectedMigration = assertExpectedMigrationSet(migrations);
  const client = await pool.connect();
  let lockAcquired = false;
  try {
    await client.query("SET lock_timeout = '5s'");
    await client.query("SET statement_timeout = '30s'");
    await acquireMigrationLock(client);
    lockAcquired = true;

    const beforeState = await inspectMigrationState(client, migrations);
    const disposition = assertExpectedMigrationState(beforeState, migrations);
    let status = 'ALREADY_APPLIED';
    if (disposition === 'READY_TO_APPLY') {
      await applyMigration(client, expectedMigration);
      status = 'APPLIED_NOW';
    }

    const afterState = await inspectMigrationState(client, migrations);
    if (assertExpectedMigrationState(afterState, migrations) !== 'ALREADY_APPLIED') {
      throw protectionError('ISSUED_QR_PROTECTION_POST_STATE_INVALID');
    }
    const counts = await verifyIssuedQrDeleteRejected(client);
    return {
      status,
      migration: expectedMigration.version,
      checksum: expectedMigration.checksum,
      ...counts
    };
  } finally {
    if (lockAcquired) await releaseMigrationLock(client);
    client.release();
  }
}

async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.length !== 0) throw protectionError('ISSUED_QR_PROTECTION_ARGUMENT_FORBIDDEN');
  const config = readPostgresConfig(env);
  assertExpectedDatabase(config);
  const pool = createPostgresPool({ config: {
    ...config,
    poolMax: 1,
    applicationName: 'xingxingzaishan-issued-qr-protection'
  } });
  try {
    const result = await executeIssuedQrProtection({ pool });
    process.stdout.write([
      `MIGRATION=${result.migration}`,
      `MIGRATION_SHA256=${result.checksum}`,
      `MIGRATION_STATUS=${result.status}`,
      'ISSUED_QR_DIRECT_DELETE=REJECTED_23514',
      `QR_COUNT_BEFORE=${result.beforeCount}`,
      `QR_COUNT_AFTER=${result.afterCount}`,
      'QR_COUNT_UNCHANGED=YES',
      'ISSUED_QR_DATABASE_PROTECTION=PASS',
      ''
    ].join('\n'));
  } finally {
    await closePostgresPool(pool);
  }
}

if (require.main === module) {
  main().catch((error) => {
    const safe = error instanceof IssuedQrProtectionError
      ? error
      : sanitizePostgresError(error, 'ISSUED_QR_PROTECTION_FAILED');
    process.stderr.write(`ISSUED_QR_DATABASE_PROTECTION=FAIL\nERROR_CODE=${safe.code}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  EXPECTED_MIGRATION,
  EXPECTED_MIGRATION_CHECKSUM,
  EXPECTED_MIGRATION_NAMES,
  ISSUED_QR_CONSTRAINT,
  IssuedQrProtectionError,
  PRODUCTION_DATABASE,
  assertExpectedDatabase,
  assertExpectedMigrationSet,
  assertExpectedMigrationState,
  executeIssuedQrProtection,
  main,
  verifyIssuedQrDeleteRejected
};
