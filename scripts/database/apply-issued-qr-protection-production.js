'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  closePostgresPool,
  createPostgresPool,
  sanitizePostgresError
} = require('../../src/server/database/connection');
const { readPostgresConfig } = require('../../src/server/database/config');
const {
  acquireMigrationLock,
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
const BACKUP_STATE_DIRECTORY = '/var/lib/xingxingzaishan-production-backup';
const BACKUP_LOG_DIRECTORY = '/var/log/xingxingzaishan-production-backup';
const PRODUCTION_JSON = '/www/wwwroot/xingxingzaishan/src/server/data/db.json';
const MAX_BACKUP_AGE_MS = 2 * 60 * 60 * 1000;
const BACKUP_RUN_ID_PATTERN = /^\d{8}T\d{6}Z-[a-f0-9]{8}$/;
const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const BACKUP_STATE_KEYS = Object.freeze([
  'ATTEMPT_STARTED_AT_UTC',
  'ATTEMPT_FINISHED_AT_UTC',
  'STATUS',
  'EXIT_CODE',
  'RUN_ID',
  'LOG_PATH'
]);
const REQUIRED_JSON_ARRAYS = Object.freeze([
  'users', 'qr_codes', 'admins', 'products', 'orders', 'accounts'
]);

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

function assertProtectedPath(filePath, {
  directory = false,
  exactMode = null,
  forbidGroupOrOtherWrite = false
} = {}) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (_error) {
    throw protectionError(directory
      ? 'ISSUED_QR_PROTECTION_DIRECTORY_MISSING'
      : 'ISSUED_QR_PROTECTION_FILE_MISSING');
  }
  if (stat.isSymbolicLink()
      || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw protectionError(directory
      ? 'ISSUED_QR_PROTECTION_DIRECTORY_UNSAFE'
      : 'ISSUED_QR_PROTECTION_FILE_UNSAFE');
  }
  if (process.platform !== 'win32') {
    if (stat.uid !== 0 || stat.gid !== 0) {
      throw protectionError('ISSUED_QR_PROTECTION_FILE_OWNER_INVALID');
    }
    const mode = stat.mode & 0o777;
    if ((exactMode !== null && mode !== exactMode)
        || (forbidGroupOrOtherWrite && (mode & 0o022) !== 0)) {
      throw protectionError('ISSUED_QR_PROTECTION_FILE_MODE_INVALID');
    }
  }
  return stat;
}

function readProtectedFile(filePath, options = {}) {
  assertProtectedPath(filePath, options);
  let descriptor;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw protectionError('ISSUED_QR_PROTECTION_FILE_UNSAFE');
    if (process.platform !== 'win32') {
      if (stat.uid !== 0 || stat.gid !== 0) {
        throw protectionError('ISSUED_QR_PROTECTION_FILE_OWNER_INVALID');
      }
      const mode = stat.mode & 0o777;
      if ((options.exactMode !== null && options.exactMode !== undefined
            && mode !== options.exactMode)
          || (options.forbidGroupOrOtherWrite && (mode & 0o022) !== 0)) {
        throw protectionError('ISSUED_QR_PROTECTION_FILE_MODE_INVALID');
      }
    }
    return fs.readFileSync(descriptor, 'utf8');
  } catch (error) {
    if (error instanceof IssuedQrProtectionError) throw error;
    throw protectionError('ISSUED_QR_PROTECTION_FILE_READ_FAILED');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function parseBackupAttempt(content, { now = new Date() } = {}) {
  const values = Object.create(null);
  const lines = String(content || '').split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const separator = line.indexOf('=');
    if (separator < 1) throw protectionError('RECENT_BACKUP_STATE_INVALID');
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (!BACKUP_STATE_KEYS.includes(key) || Object.hasOwn(values, key)) {
      throw protectionError('RECENT_BACKUP_STATE_INVALID');
    }
    values[key] = value;
  }
  if (BACKUP_STATE_KEYS.some((key) => !Object.hasOwn(values, key))) {
    throw protectionError('RECENT_BACKUP_STATE_INVALID');
  }
  if (values.STATUS !== 'PASS' || values.EXIT_CODE !== '0'
      || !BACKUP_RUN_ID_PATTERN.test(values.RUN_ID)
      || !path.isAbsolute(values.LOG_PATH)
      || path.dirname(values.LOG_PATH) !== BACKUP_LOG_DIRECTORY
      || /[\r\n=]/.test(values.LOG_PATH)
      || !UTC_PATTERN.test(values.ATTEMPT_STARTED_AT_UTC)
      || !UTC_PATTERN.test(values.ATTEMPT_FINISHED_AT_UTC)) {
    throw protectionError('RECENT_BACKUP_STATE_INVALID');
  }
  const startedAt = Date.parse(values.ATTEMPT_STARTED_AT_UTC);
  const finishedAt = Date.parse(values.ATTEMPT_FINISHED_AT_UTC);
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)
      || new Date(startedAt).toISOString()
        !== values.ATTEMPT_STARTED_AT_UTC.replace('Z', '.000Z')
      || new Date(finishedAt).toISOString()
        !== values.ATTEMPT_FINISHED_AT_UTC.replace('Z', '.000Z')) {
    throw protectionError('RECENT_BACKUP_STATE_INVALID');
  }
  if (!Number.isFinite(nowMs) || finishedAt < startedAt
      || finishedAt > nowMs || nowMs - finishedAt > MAX_BACKUP_AGE_MS) {
    throw protectionError('RECENT_BACKUP_NOT_FRESH');
  }
  return Object.freeze({
    startedAt: values.ATTEMPT_STARTED_AT_UTC,
    finishedAt: values.ATTEMPT_FINISHED_AT_UTC,
    runId: values.RUN_ID,
    logPath: values.LOG_PATH
  });
}

function assertRecentBackupAttempt({
  stateDirectory = BACKUP_STATE_DIRECTORY,
  attemptFile = null,
  now = new Date()
} = {}) {
  assertProtectedPath(stateDirectory, { directory: true, exactMode: 0o700 });
  assertProtectedPath(BACKUP_LOG_DIRECTORY, { directory: true, exactMode: 0o700 });
  const stateFile = attemptFile || path.join(stateDirectory, 'last-attempt.env');
  const content = readProtectedFile(stateFile, { exactMode: 0o600 });
  const result = parseBackupAttempt(content, { now });
  assertProtectedPath(result.logPath, { exactMode: 0o600 });
  return result;
}

function parseProductionJson(content) {
  let source;
  try {
    source = JSON.parse(String(content || ''));
  } catch (_error) {
    throw protectionError('PRODUCTION_JSON_INVALID');
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)
      || REQUIRED_JSON_ARRAYS.some((key) => !Array.isArray(source[key]))) {
    throw protectionError('PRODUCTION_JSON_STRUCTURE_INVALID');
  }
  return Object.freeze({
    qrCount: source.qr_codes.length,
    accountCount: source.accounts.length
  });
}

function validateProductionJson({ jsonPath = PRODUCTION_JSON } = {}) {
  return parseProductionJson(readProtectedFile(jsonPath, {
    forbidGroupOrOtherWrite: true
  }));
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

async function expectIssuedQrProtection(client, {
  savepoint,
  sql,
  params = [],
  invalidErrorCode
}) {
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    await client.query(sql, params);
    throw protectionError('ISSUED_QR_PROTECTION_PROBE_ALLOWED');
  } catch (error) {
    if (error instanceof IssuedQrProtectionError) throw error;
    if (error?.code !== '23514' || error?.constraint !== ISSUED_QR_CONSTRAINT) {
      throw protectionError(invalidErrorCode);
    }
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  }
}

async function verifyIssuedQrProtection(client, { transactionOpen = false } = {}) {
  let ownsTransaction = false;
  if (!transactionOpen) {
    await client.query('BEGIN');
    ownsTransaction = true;
  }
  try {
    await client.query('LOCK TABLE app.qr_codes IN ACCESS EXCLUSIVE MODE');
    const beforeResult = await client.query(
      'SELECT count(*)::integer AS count FROM app.qr_codes'
    );
    const beforeCount = Number(beforeResult.rows[0]?.count);
    const issuedResult = await client.query(
      `SELECT id
         FROM app.qr_codes
        WHERE issue_status = 'issued'
        ORDER BY id
        LIMIT 2`
    );
    const issuedIds = issuedResult.rows.map(row => row.id).filter(Boolean);
    if (issuedIds.length !== 2 || issuedIds[0] === issuedIds[1]) {
      throw protectionError('ISSUED_QR_PROTECTION_SAMPLE_MISSING');
    }
    const [issuedId, secondIssuedId] = issuedIds;

    await expectIssuedQrProtection(client, {
      savepoint: 'issued_qr_delete_probe',
      sql: 'DELETE FROM app.qr_codes WHERE id = $1',
      params: [issuedId],
      invalidErrorCode: 'ISSUED_QR_PROTECTION_DELETE_ERROR_INVALID'
    });
    await expectIssuedQrProtection(client, {
      savepoint: 'issued_qr_status_probe',
      sql: `UPDATE app.qr_codes
             SET issue_status = 'unissued'
             WHERE id = $1`,
      params: [issuedId],
      invalidErrorCode: 'ISSUED_QR_PROTECTION_STATUS_ERROR_INVALID'
    });
    await expectIssuedQrProtection(client, {
      savepoint: 'issued_qr_truncate_probe',
      sql: 'TRUNCATE app.qr_codes',
      invalidErrorCode: 'ISSUED_QR_PROTECTION_TRUNCATE_ERROR_INVALID'
    });
    await expectIssuedQrProtection(client, {
      savepoint: 'issued_qr_multi_delete_probe',
      sql: 'DELETE FROM app.qr_codes WHERE id = ANY($1::varchar[])',
      params: [[issuedId, secondIssuedId]],
      invalidErrorCode: 'ISSUED_QR_PROTECTION_MULTI_DELETE_ERROR_INVALID'
    });

    const afterResult = await client.query(
      'SELECT count(*)::integer AS count FROM app.qr_codes'
    );
    const afterCount = Number(afterResult.rows[0]?.count);
    const retainedResult = await client.query(
      `SELECT count(*)::integer AS count
       FROM app.qr_codes
       WHERE id = ANY($1::varchar[])`,
      [[issuedId, secondIssuedId]]
    );
    if (!Number.isInteger(beforeCount) || beforeCount !== afterCount) {
      throw protectionError('ISSUED_QR_PROTECTION_COUNT_CHANGED');
    }
    if (Number(retainedResult.rows[0]?.count) !== 2) {
      throw protectionError('ISSUED_QR_PROTECTION_MULTI_DELETE_CHANGED_ROWS');
    }
    return { beforeCount, afterCount };
  } finally {
    if (ownsTransaction) await client.query('ROLLBACK');
  }
}

async function applyExpectedMigrationWithVerification(client, migration, migrations, {
  migrationStateInspector = inspectMigrationState,
  verifier = verifyIssuedQrProtection
} = {}) {
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query(migration.sql);
    await client.query(
      'INSERT INTO app.schema_migrations (version, checksum) VALUES ($1, $2)',
      [migration.version, migration.checksum]
    );
    const afterState = await migrationStateInspector(client, migrations);
    if (assertExpectedMigrationState(afterState, migrations) !== 'ALREADY_APPLIED') {
      throw protectionError('ISSUED_QR_PROTECTION_POST_STATE_INVALID');
    }
    const counts = await verifier(client, { transactionOpen: true });
    await client.query('COMMIT');
    transactionOpen = false;
    return counts;
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
      } catch (_rollbackError) {
        throw protectionError('ISSUED_QR_PROTECTION_ROLLBACK_FAILED');
      }
    }
    throw error;
  }
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
    let counts;
    if (disposition === 'READY_TO_APPLY') {
      counts = await applyExpectedMigrationWithVerification(
        client,
        expectedMigration,
        migrations
      );
      status = 'APPLIED_NOW';
    } else {
      counts = await verifyIssuedQrProtection(client);
    }
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
  const backup = assertRecentBackupAttempt();
  validateProductionJson();
  const config = readPostgresConfig(env);
  assertExpectedDatabase(config);
  const pool = createPostgresPool({ config: {
    ...config,
    poolMax: 1,
    applicationName: 'xingxingzaishan-issued-qr-protection'
  } });
  try {
    const result = await executeIssuedQrProtection({ pool });
    validateProductionJson();
    process.stdout.write([
      `MIGRATION=${result.migration}`,
      `MIGRATION_SHA256=${result.checksum}`,
      `MIGRATION_STATUS=${result.status}`,
      `RECENT_BACKUP_RUN_ID=${backup.runId}`,
      `RECENT_BACKUP_FINISHED_AT_UTC=${backup.finishedAt}`,
      'RECENT_AUTOMATIC_BACKUP=PASS',
      'PRODUCTION_JSON_VALID=YES',
      'ISSUED_QR_DIRECT_DELETE=REJECTED_23514',
      'ISSUED_QR_STATUS_DOWNGRADE=REJECTED_23514',
      'ISSUED_QR_TRUNCATE=REJECTED_23514',
      'ISSUED_QR_MULTI_DELETE=REJECTED_23514',
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
  assertRecentBackupAttempt,
  applyExpectedMigrationWithVerification,
  executeIssuedQrProtection,
  expectIssuedQrProtection,
  main,
  parseBackupAttempt,
  parseProductionJson,
  validateProductionJson,
  verifyIssuedQrProtection
};
