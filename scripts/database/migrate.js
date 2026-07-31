'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const {
  closePostgresPool,
  createPostgresPool,
  sanitizePostgresError
} = require('../../src/server/database/connection');
const { readPostgresConfig } = require('../../src/server/database/config');

const MIGRATIONS_DIRECTORY = path.resolve(__dirname, '..', '..', 'database', 'migrations');
const MIGRATION_FILENAME_PATTERN = /^(\d{3})_[a-z0-9][a-z0-9_]*\.sql$/;
const ALLOWED_TARGETS = new Set(['development', 'test', 'staging']);
const MIGRATION_LOCK_KEY = 'xingxingzaishan:postgresql:migrations';

function migrationError(code, message, details = {}) {
  const error = new Error(message || code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function canonicalMigrationBytes(buffer) {
  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const canonical = Buffer.allocUnsafe(source.length);
  let writeOffset = 0;

  for (let readOffset = 0; readOffset < source.length; readOffset += 1) {
    if (source[readOffset] === 0x0d && source[readOffset + 1] === 0x0a) continue;
    canonical[writeOffset] = source[readOffset];
    writeOffset += 1;
  }

  return canonical.subarray(0, writeOffset);
}

function migrationChecksum(buffer) {
  return crypto.createHash('sha256').update(canonicalMigrationBytes(buffer)).digest('hex');
}

function stripSqlForControlCheck(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ')
    .replace(/'(?:''|[^'])*'/g, "''");
}

function assertMigrationSqlSafe(sql, version) {
  const stripped = stripSqlForControlCheck(sql);
  if (/\b(?:BEGIN|COMMIT|ROLLBACK)\b\s*;/i.test(stripped)) {
    throw migrationError(
      'POSTGRES_MIGRATION_TRANSACTION_CONTROL_FORBIDDEN',
      'Migration files must not manage transactions.',
      { migration: version }
    );
  }
  if (/^\s*\\/m.test(stripped)) {
    throw migrationError(
      'POSTGRES_MIGRATION_PSQL_COMMAND_FORBIDDEN',
      'Migration files must not contain psql meta commands.',
      { migration: version }
    );
  }
  if (sql.includes('\u0000')) {
    throw migrationError(
      'POSTGRES_MIGRATION_INVALID_ENCODING',
      'Migration files must not contain null bytes.',
      { migration: version }
    );
  }
}

function loadMigrations({ migrationsDirectory = MIGRATIONS_DIRECTORY } = {}) {
  const directory = path.resolve(migrationsDirectory);
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const sqlEntries = entries.filter((entry) => entry.name.toLowerCase().endsWith('.sql'));

  const migrations = sqlEntries.map((entry) => {
    if (!entry.isFile() || entry.isSymbolicLink() || !MIGRATION_FILENAME_PATTERN.test(entry.name)) {
      throw migrationError(
        'POSTGRES_MIGRATION_FILENAME_INVALID',
        'Migration filenames must match NNN_name.sql and must be regular files.',
        { migration: entry.name }
      );
    }

    const filePath = path.join(directory, entry.name);
    const bytes = fs.readFileSync(filePath);
    let sql;
    try {
      sql = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (_error) {
      throw migrationError(
        'POSTGRES_MIGRATION_INVALID_ENCODING',
        'Migration files must be valid UTF-8.',
        { migration: entry.name }
      );
    }
    if (sql.charCodeAt(0) === 0xfeff) sql = sql.slice(1);
    assertMigrationSqlSafe(sql, entry.name);
    return {
      version: entry.name,
      checksum: migrationChecksum(bytes),
      sql
    };
  });

  migrations.sort((left, right) => left.version.localeCompare(right.version));
  const prefixes = new Set();
  for (const migration of migrations) {
    const prefix = migration.version.slice(0, 3);
    if (prefixes.has(prefix)) {
      throw migrationError(
        'POSTGRES_MIGRATION_VERSION_DUPLICATE',
        'Migration numeric prefixes must be unique.',
        { migration: migration.version }
      );
    }
    prefixes.add(prefix);
  }
  return migrations;
}

function assertSafeMigrationTarget(targetValue) {
  const target = String(targetValue || '').trim().toLowerCase();
  if (!target) {
    throw migrationError(
      'POSTGRES_MIGRATION_TARGET_REQUIRED',
      'POSTGRES_MIGRATION_TARGET must be explicitly set.'
    );
  }
  if (target === 'production') {
    throw migrationError(
      'POSTGRES_MIGRATION_PRODUCTION_FORBIDDEN',
      'Production migrations are disabled in Phase 2A-2.'
    );
  }
  if (!ALLOWED_TARGETS.has(target)) {
    throw migrationError(
      'POSTGRES_MIGRATION_TARGET_INVALID',
      'POSTGRES_MIGRATION_TARGET must be development, test, or staging.'
    );
  }
  return target;
}

async function inspectMigrationState(client, migrations) {
  const relationResult = await client.query(
    "SELECT to_regclass('app.schema_migrations') AS relation"
  );
  const relation = relationResult.rows[0] && relationResult.rows[0].relation;
  let applied = [];

  if (!relation) {
    const schemaResult = await client.query(
      "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'app') AS schema_exists"
    );
    if (schemaResult.rows[0] && schemaResult.rows[0].schema_exists) {
      throw migrationError(
        'POSTGRES_MIGRATION_DIRTY_SCHEMA',
        'The app schema exists without app.schema_migrations.'
      );
    }
  } else {
    const appliedResult = await client.query(
      'SELECT version, trim(checksum) AS checksum, applied_at FROM app.schema_migrations ORDER BY version'
    );
    applied = appliedResult.rows;
  }

  const localByVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  for (const row of applied) {
    const local = localByVersion.get(row.version);
    if (!local) {
      throw migrationError(
        'POSTGRES_MIGRATION_UNKNOWN_VERSION',
        'The database contains a migration version missing from the repository.',
        { migration: row.version }
      );
    }
    if (String(row.checksum || '').trim() !== local.checksum) {
      throw migrationError(
        'POSTGRES_MIGRATION_CHECKSUM_MISMATCH',
        'An applied migration differs from the repository copy.',
        { migration: row.version }
      );
    }
  }

  const appliedVersions = new Set(applied.map((row) => row.version));
  const pending = migrations.filter((migration) => !appliedVersions.has(migration.version));
  const highestApplied = applied.length ? applied[applied.length - 1].version : '';
  if (highestApplied && pending.some((migration) => migration.version < highestApplied)) {
    throw migrationError(
      'POSTGRES_MIGRATION_OUT_OF_ORDER',
      'A pending migration sorts before an applied migration.'
    );
  }
  return { applied, pending };
}

async function acquireMigrationLock(client) {
  const result = await client.query(
    'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
    [MIGRATION_LOCK_KEY]
  );
  if (!result.rows[0] || result.rows[0].locked !== true) {
    throw migrationError(
      'POSTGRES_MIGRATION_LOCKED',
      'Another migration runner holds the migration lock.'
    );
  }
}

async function releaseMigrationLock(client) {
  try {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [MIGRATION_LOCK_KEY]);
  } catch (_error) {
    // The session close also releases advisory locks.
  }
}

async function applyMigration(client, migration) {
  let started = false;
  try {
    await client.query('BEGIN');
    started = true;
    await client.query(migration.sql);
    await client.query(
      'INSERT INTO app.schema_migrations (version, checksum) VALUES ($1, $2)',
      [migration.version, migration.checksum]
    );
    await client.query('COMMIT');
    started = false;
  } catch (error) {
    if (started) {
      try {
        await client.query('ROLLBACK');
      } catch (_rollbackError) {
        throw migrationError(
          'POSTGRES_MIGRATION_ROLLBACK_FAILED',
          'Migration failed and rollback could not be confirmed.',
          { migration: migration.version }
        );
      }
    }
    if (error && String(error.code || '').startsWith('POSTGRES_MIGRATION_')) throw error;
    throw migrationError(
      'POSTGRES_MIGRATION_FAILED',
      'Migration execution failed.',
      {
        migration: migration.version,
        postgresCode: sanitizePostgresError(error).postgresCode
      }
    );
  }
}

async function runMigrations({
  pool,
  apply = false,
  target,
  migrationsDirectory = MIGRATIONS_DIRECTORY
}) {
  const safeTarget = assertSafeMigrationTarget(target);
  const migrations = loadMigrations({ migrationsDirectory });
  const client = await pool.connect();
  let lockAcquired = false;

  try {
    if (apply) {
      await acquireMigrationLock(client);
      lockAcquired = true;
    }
    const state = await inspectMigrationState(client, migrations);
    if (!apply) {
      return {
        mode: 'dry-run',
        target: safeTarget,
        pending: state.pending.map(({ version, checksum }) => ({ version, checksum }))
      };
    }

    const applied = [];
    for (const migration of state.pending) {
      await applyMigration(client, migration);
      applied.push({ version: migration.version, checksum: migration.checksum });
    }
    return {
      mode: 'apply',
      target: safeTarget,
      applied
    };
  } finally {
    if (lockAcquired) await releaseMigrationLock(client);
    client.release();
  }
}

function parseArguments(argv) {
  const apply = argv.includes('--apply');
  const dryRun = argv.includes('--dry-run');
  const unknown = argv.filter((argument) => !['--apply', '--dry-run'].includes(argument));
  if (unknown.length || (apply && dryRun)) {
    throw migrationError(
      'POSTGRES_MIGRATION_ARGUMENT_INVALID',
      'Use either --dry-run or --apply.'
    );
  }
  return { apply };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const { apply } = parseArguments(argv);
  const target = assertSafeMigrationTarget(env.POSTGRES_MIGRATION_TARGET);
  const config = readPostgresConfig(env);
  const pool = createPostgresPool({ config });
  try {
    const report = await runMigrations({ pool, apply, target });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await closePostgresPool(pool);
  }
}

if (require.main === module) {
  main().catch((error) => {
    const safeError = error && String(error.code || '').startsWith('POSTGRES_')
      ? error
      : sanitizePostgresError(error, 'POSTGRES_MIGRATION_FAILED');
    process.stderr.write(`${JSON.stringify({
      error: safeError.code,
      message: safeError.message,
      migration: safeError.migration || undefined,
      postgres_code: safeError.postgresCode || undefined
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  MIGRATIONS_DIRECTORY,
  acquireMigrationLock,
  applyMigration,
  assertMigrationSqlSafe,
  assertSafeMigrationTarget,
  inspectMigrationState,
  loadMigrations,
  main,
  migrationChecksum,
  parseArguments,
  releaseMigrationLock,
  runMigrations
};
