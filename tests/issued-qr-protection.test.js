'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { loadMigrations } = require('../scripts/database/migrate');
const {
  EXPECTED_MIGRATION,
  EXPECTED_MIGRATION_CHECKSUM,
  EXPECTED_MIGRATION_NAMES,
  PRODUCTION_DATABASE,
  assertExpectedDatabase,
  assertExpectedMigrationSet,
  assertExpectedMigrationState,
  main,
  verifyIssuedQrDeleteRejected
} = require('../scripts/database/apply-issued-qr-protection-production');

function migrationRows(migrations) {
  return migrations.map(({ version, checksum }) => ({ version, checksum }));
}

test('issued QR protection pins exactly migration 007 and its checksum', () => {
  const migrations = loadMigrations();
  assert.deepEqual(migrations.map(({ version }) => version), EXPECTED_MIGRATION_NAMES);
  assert.equal(migrations.at(-1).version, EXPECTED_MIGRATION);
  assert.equal(migrations.at(-1).checksum, EXPECTED_MIGRATION_CHECKSUM);
  assert.equal(assertExpectedMigrationSet(migrations), migrations.at(-1));

  assert.throws(
    () => assertExpectedMigrationSet(migrations.slice(0, -1)),
    { code: 'ISSUED_QR_PROTECTION_MIGRATION_SET_INVALID' }
  );
  assert.throws(
    () => assertExpectedMigrationSet([
      ...migrations.slice(0, -1),
      { ...migrations.at(-1), checksum: 'f'.repeat(64) }
    ]),
    { code: 'ISSUED_QR_PROTECTION_CHECKSUM_INVALID' }
  );
});

test('production protection accepts only the fixed discrete database', () => {
  assert.doesNotThrow(() => assertExpectedDatabase({
    source: 'discrete',
    database: PRODUCTION_DATABASE
  }));
  assert.throws(
    () => assertExpectedDatabase({ source: 'discrete', database: 'other' }),
    { code: 'ISSUED_QR_PROTECTION_DATABASE_INVALID' }
  );
  assert.throws(
    () => assertExpectedDatabase({ source: 'database_url', database: PRODUCTION_DATABASE }),
    { code: 'ISSUED_QR_PROTECTION_DATABASE_INVALID' }
  );
});

test('production protection permits only canonical 001-006 plus 007 or all applied', () => {
  const migrations = loadMigrations();
  assert.equal(assertExpectedMigrationState({
    applied: migrationRows(migrations.slice(0, -1)),
    pending: migrationRows(migrations.slice(-1))
  }, migrations), 'READY_TO_APPLY');
  assert.equal(assertExpectedMigrationState({
    applied: migrationRows(migrations),
    pending: []
  }, migrations), 'ALREADY_APPLIED');

  assert.throws(() => assertExpectedMigrationState({
    applied: migrationRows(migrations.slice(0, -2)),
    pending: migrationRows(migrations.slice(-2))
  }, migrations), { code: 'ISSUED_QR_PROTECTION_MIGRATION_STATE_INVALID' });
  assert.throws(() => assertExpectedMigrationState({
    applied: [
      ...migrationRows(migrations.slice(0, -1)),
      { version: '999_unknown.sql', checksum: 'e'.repeat(64) }
    ],
    pending: migrationRows(migrations.slice(-1))
  }, migrations), { code: 'ISSUED_QR_PROTECTION_MIGRATION_STATE_INVALID' });
});

test('direct issued QR delete probe requires the exact protection error', async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql.startsWith('SELECT count(*)')) return { rows: [{ count: 103 }] };
      if (sql.includes('WHERE issue_status')) return { rows: [{ id: 'QR_ISSUED' }] };
      if (sql.startsWith('DELETE')) {
        const error = new Error('protected');
        error.code = '23514';
        error.constraint = 'qr_codes_issued_immutable';
        throw error;
      }
      return { rows: [] };
    }
  };

  assert.deepEqual(await verifyIssuedQrDeleteRejected(client), {
    beforeCount: 103,
    afterCount: 103
  });
  assert.deepEqual(queries.filter((sql) => sql === 'ROLLBACK'), ['ROLLBACK']);
  assert.equal(queries.includes('ROLLBACK TO SAVEPOINT issued_qr_delete_probe'), true);

  const wrongClient = {
    async query(sql) {
      if (sql.startsWith('SELECT count(*)')) return { rows: [{ count: 103 }] };
      if (sql.includes('WHERE issue_status')) return { rows: [{ id: 'QR_ISSUED' }] };
      if (sql.startsWith('DELETE')) {
        const error = new Error('foreign key');
        error.code = '23503';
        throw error;
      }
      return { rows: [] };
    }
  };
  await assert.rejects(
    verifyIssuedQrDeleteRejected(wrongClient),
    { code: 'ISSUED_QR_PROTECTION_DELETE_ERROR_INVALID' }
  );
});

test('production protection rejects every command-line argument before connecting', async () => {
  await assert.rejects(
    main(['--database=other'], {}),
    { code: 'ISSUED_QR_PROTECTION_ARGUMENT_FORBIDDEN' }
  );
});
