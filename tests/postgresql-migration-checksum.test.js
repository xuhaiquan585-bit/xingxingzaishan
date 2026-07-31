'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  inspectMigrationState,
  loadMigrations,
  migrationChecksum
} = require('../scripts/database/migrate');

const INITIAL_MIGRATION_CHECKSUM =
  'c827cd85e9552805690d6837383fb6d23c043d32be359ce61b99f743ba477d18';

function withMigrationDirectory(sql, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-checksum-'));
  fs.writeFileSync(path.join(directory, '001_fixture.sql'), sql);
  return Promise.resolve()
    .then(() => callback(directory))
    .finally(() => fs.rmSync(directory, { recursive: true, force: true }));
}

function migrationStateClient(appliedChecksum) {
  return {
    async query(sql) {
      if (sql.includes("to_regclass('app.schema_migrations')")) {
        return { rows: [{ relation: 'app.schema_migrations' }] };
      }
      if (sql.startsWith('SELECT version, trim(checksum) AS checksum')) {
        return {
          rows: [{
            version: '001_fixture.sql',
            checksum: appliedChecksum,
            applied_at: '2026-01-01T00:00:00.000Z'
          }]
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
}

test('migration checksum canonicalizes CRLF without changing the LF baseline', () => {
  const migrationPath = path.join(
    __dirname,
    '..',
    'database',
    'migrations',
    '001_init_schema.sql'
  );
  const lf = fs.readFileSync(migrationPath);
  const text = lf.toString('utf8');
  assert.equal(text.includes('\r\n'), false);

  const crlf = Buffer.from(text.replace(/\n/g, '\r\n'), 'utf8');
  assert.notEqual(
    require('node:crypto').createHash('sha256').update(lf).digest('hex'),
    require('node:crypto').createHash('sha256').update(crlf).digest('hex')
  );
  assert.equal(migrationChecksum(lf), INITIAL_MIGRATION_CHECKSUM);
  assert.equal(migrationChecksum(crlf), INITIAL_MIGRATION_CHECKSUM);
});

test('migration checksum still detects every non-line-ending content change', () => {
  const original = Buffer.from('CREATE SCHEMA app;\n', 'utf8');
  const checksum = migrationChecksum(original);
  const variants = [
    Buffer.from('CREATE  SCHEMA app;\n', 'utf8'),
    Buffer.from('-- comment\nCREATE SCHEMA app;\n', 'utf8'),
    Buffer.from('CREATE SCHEMA changed;\n', 'utf8'),
    Buffer.from('CREATE SCHEMA app;\n\n', 'utf8')
  ];

  variants.forEach((variant) => assert.notEqual(migrationChecksum(variant), checksum));
});

test('migration state accepts canonical CRLF and still rejects semantic drift', async () => {
  const lfSql = 'CREATE SCHEMA app;\n';
  const appliedChecksum = migrationChecksum(Buffer.from(lfSql, 'utf8'));

  await withMigrationDirectory(lfSql.replace(/\n/g, '\r\n'), async (directory) => {
    const migrations = loadMigrations({ migrationsDirectory: directory });
    const state = await inspectMigrationState(migrationStateClient(appliedChecksum), migrations);
    assert.equal(state.pending.length, 0);
  });

  await withMigrationDirectory('CREATE SCHEMA changed;\r\n', async (directory) => {
    const migrations = loadMigrations({ migrationsDirectory: directory });
    await assert.rejects(
      inspectMigrationState(migrationStateClient(appliedChecksum), migrations),
      (error) => error.code === 'POSTGRES_MIGRATION_CHECKSUM_MISMATCH'
    );
  });
});

test('Git attributes pin migration SQL files to LF only', () => {
  const attributes = fs.readFileSync(path.join(__dirname, '..', '.gitattributes'), 'utf8');
  assert.match(attributes, /^database\/migrations\/\*\.sql text eol=lf$/m);
});
