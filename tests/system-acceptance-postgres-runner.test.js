'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  readRunningPostgresClientConfig,
  run
} = require('../scripts/acceptance/read-running-postgres-client-config');

test('system acceptance PostgreSQL runner is disposable and production-write free', () => {
  const source = fs.readFileSync(path.join(
    __dirname,
    '..',
    'scripts',
    'database',
    'run-system-acceptance-postgres-integration.sh'
  ), 'utf8');

  assert.match(source, /--preflight/);
  assert.match(source, /--authorize-run=YES/);
  assert.match(source, /git status --porcelain=v1 --untracked-files=normal/);
  assert.match(source, /WORKTREE_NOT_CLEAN/);
  assert.doesNotMatch(source, /--untracked-files=no(?!rmal)/);
  assert.match(source, /TEST_DB="xingxing_acceptance_\$\{HEAD:0:8\}_\$\$_test"/);
  assert.match(source, /TEST_ROLE="xingxing_acceptance_\$\{HEAD:0:8\}_\$\$"/);
  assert.match(source, /CREATE ROLE/);
  assert.match(source, /NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION/);
  assert.match(source, /createdb[^\n]*-T template0/);
  assert.match(source, /dropdb --if-exists "\$TEST_DB"/);
  assert.match(source, /dropuser --if-exists "\$TEST_ROLE"/);
  assert.match(source, /export PGUSER="\$TEST_ROLE"/);
  assert.match(source, /export PGPASSWORD="\$TEST_PASSWORD"/);
  assert.doesNotMatch(source, /export PGUSER="\$PGUSER_VALUE"/);
  assert.doesNotMatch(source, /export PGPASSWORD_FILE=/);
  assert.match(source, /RUN_POSTGRES_INTEGRATION=true/);
  assert.match(source, /RUN_POSTGRES_PRINT_PRODUCTION_TEST=true/);
  assert.match(source, /PRODUCTION_DATABASE_WRITE_BY_RUNNER=NONE/);
  assert.match(source, /RUNTIME_CONFIG_CHECK/);
  assert.match(source, /RUNTIME_POSTGRES_CONFIG_READER/);
  assert.match(source, /PM2_STARTED_AT_MS/);
  assert.match(source, /POSTGRES_CLIENT_CONFIG=PASS_RECONSTRUCTED_REDACTED/);
  assert.doesNotMatch(source, /runtime_value/);
  assert.doesNotMatch(source, /pm2 restart/);
  assert.doesNotMatch(source, /git (?:pull|merge|checkout|reset)/);
  assert.doesNotMatch(source, /systemctl (?:start|restart|enable)/);
});

test('running PostgreSQL client config is reconstructed from protected dotenv without secrets', (t) => {
  const repository = path.resolve('fixture-production-app');
  const secret = 'must-never-be-printed';
  const fileEnvironment = {
    NODE_ENV: 'production',
    DATABASE_URL: `postgres://production-user:${secret}@127.0.0.1:5432/expected_database`,
    PGSSL: 'false'
  };
  const processEnvironment = { NODE_ENV: 'production' };
  const bytes = Buffer.from(Object.entries(processEnvironment)
    .map(([key, value]) => `${key}=${value}\0`).join(''));
  const dependencies = {
    argv: ['1234', repository, 'expected_database', '200000'],
    readFileSync: () => bytes,
    readlinkSync: () => repository,
    realpathSync: (value) => value,
    readProtectedEnv: () => ({ environment: fileEnvironment, modifiedAtMs: 100000 })
  };

  assert.deepEqual(readRunningPostgresClientConfig(dependencies), {
    source: 'database_url',
    host: '127.0.0.1',
    port: 5432,
    user: 'production-user',
    database: 'expected_database',
    passwordFile: '',
    ssl: false,
    rejectUnauthorized: false
  });
  let output = '';
  let errorOutput = '';
  assert.equal(run({
    ...dependencies,
    writeOutput: (value) => { output += value; },
    writeError: (value) => { errorOutput += value; }
  }), 0);
  assert.equal(output, '127.0.0.1|5432|false|false');
  assert.equal(errorOutput, '');
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes('production-user'), false);

  const passwordDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-password-'));
  const passwordFile = path.join(passwordDirectory, 'postgres.password');
  fs.writeFileSync(passwordFile, 'test-password', { mode: 0o600 });
  t.after(() => fs.rmSync(passwordDirectory, { recursive: true, force: true }));
  output = '';
  assert.equal(run({
    ...dependencies,
    argv: ['--backup', '1234', repository, 'expected_database', '200000'],
    readProtectedEnv: () => ({
      environment: {
        NODE_ENV: 'production',
        PGHOST: '127.0.0.1',
        PGPORT: '5432',
        PGUSER: 'production_user',
        PGDATABASE: 'expected_database',
        PGPASSWORD_FILE: passwordFile,
        PGSSL: 'false'
      },
      modifiedAtMs: 100000
    }),
    writeOutput: (value) => { output += value; },
    writeError: (value) => { errorOutput += value; }
  }), 0);
  assert.equal(
    output,
    `127.0.0.1|5432|production_user|expected_database|disable|${passwordFile}`
  );

  assert.throws(() => readRunningPostgresClientConfig({
    ...dependencies,
    readProtectedEnv: () => ({
      environment: {
        ...fileEnvironment,
        DATABASE_URL: 'postgres://user:secret@db.example.com/expected_database'
      },
      modifiedAtMs: 100000
    })
  }), { code: 'POSTGRES_HOST_NOT_LOCAL' });
});
