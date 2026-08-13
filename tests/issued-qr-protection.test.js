'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { loadMigrations } = require('../scripts/database/migrate');
const {
  EXPECTED_MIGRATION,
  EXPECTED_MIGRATION_CHECKSUM,
  EXPECTED_MIGRATION_NAMES,
  PRODUCTION_DATABASE,
  applyExpectedMigrationWithVerification,
  assertExpectedDatabase,
  assertExpectedMigrationSet,
  assertExpectedMigrationState,
  main,
  parseBackupAttempt,
  parseProductionJson,
  verifyIssuedQrProtection
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

function backupAttempt(overrides = {}) {
  return {
    ATTEMPT_STARTED_AT_UTC: '2026-08-13T14:41:14Z',
    ATTEMPT_FINISHED_AT_UTC: '2026-08-13T14:41:17Z',
    STATUS: 'PASS',
    EXIT_CODE: '0',
    RUN_ID: '20260813T144115Z-f683183b',
    LOG_PATH: '/var/log/xingxingzaishan-production-backup/20260813T144114Z.test.log',
    ...overrides
  };
}

function serializeAttempt(values) {
  return `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}

test('recent backup state is strict, successful, and no older than two hours', () => {
  const now = new Date('2026-08-13T16:00:00Z');
  assert.deepEqual(parseBackupAttempt(serializeAttempt(backupAttempt()), { now }), {
    startedAt: '2026-08-13T14:41:14Z',
    finishedAt: '2026-08-13T14:41:17Z',
    runId: '20260813T144115Z-f683183b',
    logPath: '/var/log/xingxingzaishan-production-backup/20260813T144114Z.test.log'
  });

  for (const [overrides, code] of [
    [{ STATUS: 'FAIL', EXIT_CODE: '1' }, 'RECENT_BACKUP_STATE_INVALID'],
    [{ ATTEMPT_FINISHED_AT_UTC: '2026-08-13T13:59:59Z' }, 'RECENT_BACKUP_NOT_FRESH'],
    [{ ATTEMPT_FINISHED_AT_UTC: '2026-08-13T16:00:01Z' }, 'RECENT_BACKUP_NOT_FRESH'],
    [{ ATTEMPT_FINISHED_AT_UTC: '2026-02-30T12:00:00Z' }, 'RECENT_BACKUP_STATE_INVALID'],
    [{ LOG_PATH: '/tmp/backup.log' }, 'RECENT_BACKUP_STATE_INVALID']
  ]) {
    assert.throws(
      () => parseBackupAttempt(serializeAttempt(backupAttempt(overrides)), { now }),
      { code }
    );
  }
  assert.throws(
    () => parseBackupAttempt(`${serializeAttempt(backupAttempt())}STATUS=PASS\n`, { now }),
    { code: 'RECENT_BACKUP_STATE_INVALID' }
  );
});

test('production JSON acceptance validates current structure without a historical hash', () => {
  assert.deepEqual(parseProductionJson(JSON.stringify({
    users: [], qr_codes: [{ id: 'CURRENT' }], admins: [], products: [],
    orders: [], accounts: [{ id: 'ACC' }]
  })), { qrCount: 1, accountCount: 1 });
  assert.throws(
    () => parseProductionJson('{not-json'),
    { code: 'PRODUCTION_JSON_INVALID' }
  );
  assert.throws(
    () => parseProductionJson(JSON.stringify({ users: [], qr_codes: [] })),
    { code: 'PRODUCTION_JSON_STRUCTURE_INVALID' }
  );
});

test('all issued QR probes require the exact protection error and preserve counts', async () => {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('SELECT count(*)') && sql.includes('WHERE id = ANY')) {
        return { rows: [{ count: 2 }] };
      }
      if (sql.startsWith('SELECT count(*)')) return { rows: [{ count: 103 }] };
      if (sql.includes('WHERE issue_status')) {
        return { rows: [{ id: 'QR_ISSUED_1' }, { id: 'QR_ISSUED_2' }] };
      }
      if (sql.startsWith('DELETE') || sql.startsWith('UPDATE') || sql.startsWith('TRUNCATE')) {
        const error = new Error('protected');
        error.code = '23514';
        error.constraint = 'qr_codes_issued_immutable';
        throw error;
      }
      return { rows: [] };
    }
  };

  assert.deepEqual(await verifyIssuedQrProtection(client), {
    beforeCount: 103,
    afterCount: 103
  });
  assert.equal(queries.filter(({ sql }) => sql === 'ROLLBACK').length, 1);
  for (const savepoint of [
    'issued_qr_delete_probe',
    'issued_qr_status_probe',
    'issued_qr_truncate_probe',
    'issued_qr_multi_delete_probe'
  ]) {
    assert.equal(
      queries.some(({ sql }) => sql === `ROLLBACK TO SAVEPOINT ${savepoint}`),
      true
    );
  }
  assert.equal(queries.some(({ sql }) => sql === 'TRUNCATE app.qr_codes'), true);
  assert.deepEqual(
    queries.find(({ sql }) => sql.includes('DELETE FROM app.qr_codes WHERE id = ANY')).params,
    [['QR_ISSUED_1', 'QR_ISSUED_2']]
  );

  const wrongClient = {
    async query(sql) {
      if (sql.startsWith('SELECT count(*)')) return { rows: [{ count: 103 }] };
      if (sql.includes('WHERE issue_status')) {
        return { rows: [{ id: 'QR_ISSUED_1' }, { id: 'QR_ISSUED_2' }] };
      }
      if (sql.startsWith('DELETE')) {
        const error = new Error('foreign key');
        error.code = '23503';
        throw error;
      }
      return { rows: [] };
    }
  };
  await assert.rejects(
    verifyIssuedQrProtection(wrongClient),
    { code: 'ISSUED_QR_PROTECTION_DELETE_ERROR_INVALID' }
  );
});

test('migration 007 commits only after its probes pass and rolls back on failure', async () => {
  const migrations = loadMigrations();
  const migration = migrations.at(-1);
  const expectedState = {
    applied: migrationRows(migrations),
    pending: []
  };
  const successfulQueries = [];
  const client = {
    async query(sql, params = []) {
      successfulQueries.push({ sql, params });
      return { rows: [] };
    }
  };
  const result = await applyExpectedMigrationWithVerification(
    client,
    migration,
    migrations,
    {
      migrationStateInspector: async () => expectedState,
      verifier: async (_client, options) => {
        assert.deepEqual(options, { transactionOpen: true });
        successfulQueries.push({ sql: 'PROBES_PASS', params: [] });
        return { beforeCount: 103, afterCount: 103 };
      }
    }
  );
  assert.deepEqual(result, { beforeCount: 103, afterCount: 103 });
  assert.ok(successfulQueries.findIndex(({ sql }) => sql === 'PROBES_PASS')
    < successfulQueries.findIndex(({ sql }) => sql === 'COMMIT'));
  assert.equal(successfulQueries.some(({ sql }) => sql === 'ROLLBACK'), false);

  const failedQueries = [];
  await assert.rejects(
    applyExpectedMigrationWithVerification(
      { async query(sql) { failedQueries.push(sql); return { rows: [] }; } },
      migration,
      migrations,
      {
        migrationStateInspector: async () => expectedState,
        verifier: async () => { throw new Error('probe failed'); }
      }
    ),
    /probe failed/
  );
  assert.equal(failedQueries.includes('COMMIT'), false);
  assert.equal(failedQueries.at(-1), 'ROLLBACK');
});

test('production protection rejects every command-line argument before connecting', async () => {
  await assert.rejects(
    main(['--database=other'], {}),
    { code: 'ISSUED_QR_PROTECTION_ARGUMENT_FORBIDDEN' }
  );
});
