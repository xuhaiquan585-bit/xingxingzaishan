'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');

const {
  downloadProtectedObjectFromOss
} = require('../src/server/services/storageService');
const {
  BACKUP_RUN_ID,
  EXPECTED,
  PRODUCTION_DATABASE,
  ProductionRestoreDrillError,
  assertRestoreDatabaseName,
  buildPgRestoreArguments,
  downloadArtifact,
  downloadBackupArtifacts,
  safeErrorCode,
  restorePostgresDump,
  validateJsonSnapshot,
  validateManifest,
  validateMigrationRows,
  validateRestoredDatabase,
  verifyDownloadedArtifact,
  verifyRemoteArtifact
} = require('../scripts/database/production-restore-drill');
const { loadMigrations } = require('../scripts/database/migrate');

function makeTempDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingxing-restore-drill-'));
  fs.chmodSync(directory, 0o700);
  return directory;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function makeValidManifest() {
  return {
    schema_version: 1,
    status: 'COMPLETE',
    run_id: BACKUP_RUN_ID,
    git_commit: '08a128f9aeffee92da97aad0fd85f8b05431e4db',
    started_at_utc: '2026-08-13T11:05:35.000Z',
    completed_at_utc: '2026-08-13T11:05:36.000Z',
    database: PRODUCTION_DATABASE,
    consistency: {
      postgresql: 'pg_dump consistent snapshot',
      json: 'single immutable byte snapshot',
      cross_store_transactional_snapshot: false
    },
    snapshots: {
      postgresql: {
        format: 'pg_dump custom',
        local_path: '/root/backup.dump',
        object_key: EXPECTED.postgresql.object_key,
        sha256: EXPECTED.postgresql.sha256,
        size: EXPECTED.postgresql.size,
        etag: EXPECTED.postgresql.etag,
        verified: true
      },
      json: {
        format: 'json',
        local_path: '/root/db.json',
        object_key: EXPECTED.json.object_key,
        sha256: EXPECTED.json.sha256,
        size: EXPECTED.json.size,
        etag: EXPECTED.json.etag,
        verified: true
      }
    }
  };
}

function remoteMetadata(expected) {
  return {
    status: 200,
    metadata_status: 200,
    size: expected.size,
    declared_size: String(expected.size),
    sha256: expected.sha256,
    etag: expected.etag
  };
}

function makeRestoreValidationPool({ failRepositoryRead = false } = {}) {
  const calls = [];
  const migrations = loadMigrations();
  const query = async (sql, values = []) => {
    calls.push(sql);
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)
      || sql.startsWith('SET TRANSACTION')) return { rows: [] };
    if (sql.includes('current_database()')) {
      return {
        rows: [{
          database: 'xingxing_restore_drill_20260813_abcdef12',
          read_only: 'on'
        }]
      };
    }
    if (sql.includes('FROM app.schema_migrations')) {
      return { rows: migrations.map(({ version, checksum }) => ({ version, checksum })) };
    }
    if (sql.includes('FROM information_schema.tables')) {
      return { rows: values[0].map((table_name) => ({ table_name })) };
    }
    if (sql.includes('AS relations(relation_name)')) {
      return { rows: values[0].map((relation_name) => ({ relation_name })) };
    }
    if (sql.includes('FROM pg_constraint')) {
      return { rows: values[0].map((conname) => ({ conname })) };
    }
    if (sql.includes('AS qr_codes,') && sql.includes('AS co_creation_comments')) {
      return {
        rows: [{
          qr_codes: 103,
          records: 55,
          accounts: 27,
          users: 27,
          identities: 27,
          co_creations: 2,
          co_creation_comments: 4
        }]
      };
    }
    if (sql.includes('GROUP BY issue_status')) {
      return { rows: [{ status: 'issued', count: 103 }] };
    }
    if (sql.includes('GROUP BY lifecycle_status')) {
      return {
        rows: [
          { status: 'activated', count: 54 },
          { status: 'co_creating', count: 1 },
          { status: 'unactivated', count: 48 }
        ]
      };
    }
    if (sql.includes('AS users_without_accounts')) {
      return {
        rows: [{
          users_without_accounts: 0,
          records_without_qr: 0,
          records_without_accounts: 0,
          co_creations_without_qr: 0,
          comments_without_co_creation: 0,
          proofs_without_records: 0,
          archives_without_records: 0
        }]
      };
    }
    if (sql.includes('AS invalid_sets')) return { rows: [{ invalid_sets: 0 }] };
    if (sql.includes('WITH object_keys AS')) {
      return {
        rows: [
          { source: 'records.image_object_key', reference_count: 55, invalid_count: 0 },
          { source: 'record_proofs.manifest_object_key', reference_count: 1, invalid_count: 0 }
        ]
      };
    }
    if (sql.includes('LEFT JOIN app.co_creations c') && sql.includes('LIMIT 3')) {
      return {
        rows: [
          { qr_id: 'SSS00004', account_id: 'ACC000002' },
          { qr_id: 'A00001', account_id: 'ACC000002' },
          { qr_id: 'A00003', account_id: 'ACC000002' }
        ]
      };
    }
    if (sql.includes('FROM app.qr_codes WHERE id = $1')) {
      if (failRepositoryRead) throw new Error('password=must-not-surface');
      return { rows: [{ id: values[0] }] };
    }
    if (sql.includes('FROM app.records WHERE qr_id = $1')) {
      return { rows: [{ qr_id: values[0], account_id: 'ACC000002' }] };
    }
    if (sql.includes('FROM app.accounts WHERE id = $1')) {
      return { rows: [{ id: values[0] }] };
    }
    if (sql.includes('FROM app.users WHERE account_id = $1')) {
      return { rows: [{ id: 'USR000001', account_id: values[0] }] };
    }
    if (sql.includes('FROM app.co_creations') && sql.includes('WHERE qr_id = $1')) {
      return values[0] === 'SSS00004'
        ? { rows: [{ id: 'creation-1', qr_id: values[0] }] }
        : { rows: [] };
    }
    if (sql.includes('FROM app.co_creation_comments')) {
      return {
        rows: [
          { id: 'comment-1', source_position: 0 },
          { id: 'comment-2', source_position: 1 }
        ]
      };
    }
    throw new Error(`Unexpected SQL in restore validation test: ${sql}`);
  };
  return {
    calls,
    pool: {
      async connect() {
        return { query, release() {} };
      }
    }
  };
}

test('protected OSS download streams to an exclusive file and hashes the exact bytes', async () => {
  const root = makeTempDirectory();
  const destinationPath = path.join(root, 'download.bin');
  const bytes = Buffer.from('restore-drill-stream');
  const calls = [];
  const result = await downloadProtectedObjectFromOss({
    objectKey: 'backups/test/object.bin',
    destinationPath,
    client: {
      async getStream(objectKey) {
        calls.push(objectKey);
        return {
          stream: Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]),
          res: { status: 200, headers: { etag: '"ETAG-ONE"' } }
        };
      }
    }
  });

  assert.deepEqual(calls, ['backups/test/object.bin']);
  assert.deepEqual(fs.readFileSync(destinationPath), bytes);
  assert.equal(result.size, bytes.length);
  assert.equal(result.sha256, sha256(bytes));
  assert.equal(result.etag, 'ETAG-ONE');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(destinationPath).mode & 0o777, 0o600);
  }
});

test('protected OSS download refuses an existing destination and never calls OSS', async () => {
  const root = makeTempDirectory();
  const destinationPath = path.join(root, 'existing.bin');
  fs.writeFileSync(destinationPath, 'preserve-me');
  let called = false;
  await assert.rejects(
    downloadProtectedObjectFromOss({
      objectKey: 'backups/test/object.bin',
      destinationPath,
      client: {
        async getStream() {
          called = true;
          return null;
        }
      }
    }),
    /OBJECT_DESTINATION_EXISTS/
  );
  assert.equal(called, false);
  assert.equal(fs.readFileSync(destinationPath, 'utf8'), 'preserve-me');
});

test('protected OSS download refuses a symbolic-link destination', {
  skip: process.platform === 'win32'
}, async () => {
  const root = makeTempDirectory();
  const targetPath = path.join(root, 'target.bin');
  const destinationPath = path.join(root, 'destination.bin');
  fs.writeFileSync(targetPath, 'preserve-me');
  fs.symlinkSync(targetPath, destinationPath);
  await assert.rejects(
    downloadProtectedObjectFromOss({
      objectKey: 'backups/test/object.bin',
      destinationPath,
      client: { async getStream() { throw new Error('must not be called'); } }
    }),
    /OBJECT_DESTINATION_EXISTS/
  );
  assert.equal(fs.readFileSync(targetPath, 'utf8'), 'preserve-me');
});

test('fixed backup identity and temporary restore database name cannot be overridden', () => {
  assert.equal(BACKUP_RUN_ID, '20260813T110535Z-6586d9b1');
  assert.equal(PRODUCTION_DATABASE, 'xingxing_clean_baseline_20260812_staging');
  assert.equal(
    assertRestoreDatabaseName('xingxing_restore_drill_20260813_abcdef12'),
    'xingxing_restore_drill_20260813_abcdef12'
  );
  assert.throws(
    () => assertRestoreDatabaseName(PRODUCTION_DATABASE),
    (error) => error.code === 'RESTORE_DATABASE_NAME_INVALID'
  );
  assert.throws(
    () => assertRestoreDatabaseName('some_other_database'),
    (error) => error.code === 'RESTORE_DATABASE_NAME_INVALID'
  );
});

test('PostgreSQL restore is fixed to the temporary database and fails closed', () => {
  const database = 'xingxing_restore_drill_20260813_abcdef12';
  const dumpPath = path.join(makeTempDirectory(), 'backup.dump');
  const connection = { host: '127.0.0.1', port: '5432', user: 'restore_role' };
  const args = buildPgRestoreArguments({ ...connection, database, dumpPath });
  assert.deepEqual(args, [
    '--host=127.0.0.1',
    '--port=5432',
    '--username=restore_role',
    `--dbname=${database}`,
    '--single-transaction',
    '--exit-on-error',
    '--no-owner',
    '--no-privileges',
    dumpPath
  ]);
  assert.equal(args.some((value) => /password|--clean|--create|production/i.test(value)), false);

  const calls = [];
  assert.equal(restorePostgresDump({
    connection,
    database,
    dumpPath,
    binary: '/fake/pg_restore',
    spawn: (binary, restoreArgs, options) => {
      calls.push({ binary, restoreArgs, options });
      return { status: 0, stdout: '', stderr: '' };
    },
    env: { PGPASSFILE: '/protected/pgpass' }
  }).status, 'RESTORED');
  assert.equal(calls[0].binary, '/fake/pg_restore');
  assert.equal(calls[0].options.env.PGPASSFILE, '/protected/pgpass');

  assert.throws(
    () => restorePostgresDump({
      connection,
      database,
      dumpPath,
      binary: '/fake/pg_restore',
      spawn: () => ({ status: 1, stdout: '', stderr: 'secret provider detail' }),
      env: {}
    }),
    (error) => error.code === 'POSTGRES_RESTORE_FAILED'
      && !error.message.includes('secret provider detail')
  );
});

test('manifest trust chain accepts only the fixed complete backup', () => {
  assert.equal(validateManifest(makeValidManifest()).status, 'COMPLETE');
  for (const mutate of [
    (manifest) => { manifest.run_id = '20260813T000000Z-00000000'; },
    (manifest) => { manifest.database = 'wrong_database'; },
    (manifest) => { manifest.status = 'FAILED'; },
    (manifest) => { manifest.snapshots.postgresql.object_key = 'backups/wrong.dump'; },
    (manifest) => { manifest.snapshots.json.sha256 = '0'.repeat(64); },
    (manifest) => { manifest.consistency.cross_store_transactional_snapshot = true; }
  ]) {
    const manifest = makeValidManifest();
    mutate(manifest);
    assert.throws(
      () => validateManifest(manifest),
      (error) => String(error.code).startsWith('RESTORE_MANIFEST_')
    );
  }
});

test('remote and downloaded integrity require status, size, SHA, declared size, and ETag', () => {
  assert.doesNotThrow(() => verifyRemoteArtifact(
    EXPECTED.postgresql,
    remoteMetadata(EXPECTED.postgresql)
  ));
  assert.doesNotThrow(() => verifyDownloadedArtifact(EXPECTED.postgresql, {
    status: 200,
    size: EXPECTED.postgresql.size,
    sha256: EXPECTED.postgresql.sha256,
    etag: EXPECTED.postgresql.etag
  }));

  for (const remote of [
    { ...remoteMetadata(EXPECTED.postgresql), metadata_status: 500 },
    { ...remoteMetadata(EXPECTED.postgresql), size: 1 },
    { ...remoteMetadata(EXPECTED.postgresql), declared_size: '1' },
    { ...remoteMetadata(EXPECTED.postgresql), sha256: '0'.repeat(64) },
    { ...remoteMetadata(EXPECTED.postgresql), etag: 'wrong' }
  ]) {
    assert.throws(
      () => verifyRemoteArtifact(EXPECTED.postgresql, remote),
      (error) => error.code === 'RESTORE_OSS_METADATA_MISMATCH'
    );
  }
  for (const downloaded of [
    { status: 500, size: EXPECTED.json.size, sha256: EXPECTED.json.sha256, etag: EXPECTED.json.etag },
    { status: 200, size: 1, sha256: EXPECTED.json.sha256, etag: EXPECTED.json.etag },
    { status: 200, size: EXPECTED.json.size, sha256: '0'.repeat(64), etag: EXPECTED.json.etag },
    { status: 200, size: EXPECTED.json.size, sha256: EXPECTED.json.sha256, etag: 'wrong' }
  ]) {
    assert.throws(
      () => verifyDownloadedArtifact(EXPECTED.json, downloaded),
      (error) => error.code === 'RESTORE_DOWNLOAD_INTEGRITY_MISMATCH'
    );
  }
});

test('artifact download fails closed before GET when remote metadata differs', async () => {
  let downloaded = false;
  await assert.rejects(
    downloadArtifact({
      expected: EXPECTED.json,
      destinationPath: path.join(makeTempDirectory(), 'db.json'),
      metadataReader: async () => ({
        ...remoteMetadata(EXPECTED.json),
        sha256: '0'.repeat(64)
      }),
      downloader: async () => {
        downloaded = true;
      }
    }),
    (error) => error.code === 'RESTORE_OSS_METADATA_MISMATCH'
  );
  assert.equal(downloaded, false);
});

test('download phase retrieves manifest first and retains verified local artifacts', async () => {
  const root = makeTempDirectory();
  const pm2DumpPath = path.join(root, 'dump.pm2');
  fs.writeFileSync(pm2DumpPath, '[{"env":{}}]', { mode: 0o600 });
  fs.chmodSync(pm2DumpPath, 0o600);
  const manifestBytes = Buffer.from(`${JSON.stringify(makeValidManifest(), null, 2)}\n`);
  const jsonBytes = Buffer.from(JSON.stringify({ users: [], qr_codes: [], accounts: [] }));
  const calls = [];
  const contentByKey = new Map([
    [EXPECTED.manifest.object_key, manifestBytes],
    [EXPECTED.postgresql.object_key, Buffer.from('fake-pg-dump')],
    [EXPECTED.json.object_key, jsonBytes]
  ]);

  const result = await downloadBackupArtifacts({
    outputDirectory: root,
    pm2DumpPath,
    loadOssEnvironment: false,
    metadataReader: async ({ objectKey }) => {
      calls.push(`HEAD:${objectKey}`);
      const expected = Object.values(EXPECTED).find((item) => item.object_key === objectKey);
      return remoteMetadata(expected);
    },
    downloader: async ({ objectKey, destinationPath }) => {
      calls.push(`GET:${objectKey}`);
      const expected = Object.values(EXPECTED).find((item) => item.object_key === objectKey);
      fs.writeFileSync(destinationPath, contentByKey.get(objectKey), { mode: 0o600 });
      return {
        status: 200,
        path: destinationPath,
        size: expected.size,
        sha256: expected.sha256,
        etag: expected.etag
      };
    }
  });

  assert.deepEqual(calls.slice(0, 2), [
    `HEAD:${EXPECTED.manifest.object_key}`,
    `GET:${EXPECTED.manifest.object_key}`
  ]);
  assert.equal(result.status, 'DOWNLOADED_AND_VERIFIED');
  assert.deepEqual(result.json_collections, { users: 0, qr_codes: 0, accounts: 0 });
  assert.equal(fs.existsSync(result.resultPath), true);
});

test('JSON validation rejects malformed or structurally incomplete snapshots', () => {
  assert.deepEqual(
    validateJsonSnapshot(Buffer.from('{"users":[],"qr_codes":[],"accounts":[]}')),
    { users: 0, qr_codes: 0, accounts: 0 }
  );
  assert.throws(
    () => validateJsonSnapshot(Buffer.from('{broken')),
    (error) => error.code === 'RESTORE_JSON_INVALID'
  );
  assert.throws(
    () => validateJsonSnapshot(Buffer.from('{"users":[]}')),
    (error) => error.code === 'RESTORE_JSON_STRUCTURE_INVALID'
  );
});

test('migration validation requires the exact repository migration set and checksums', () => {
  const migrations = loadMigrations();
  const rows = migrations.map(({ version, checksum }) => ({ version, checksum }));
  assert.equal(validateMigrationRows(rows).length, migrations.length);
  assert.throws(
    () => validateMigrationRows(rows.slice(1)),
    (error) => error.code === 'RESTORE_MIGRATION_SET_MISMATCH'
  );
  const changed = rows.map((row) => ({ ...row }));
  changed[0].checksum = '0'.repeat(64);
  assert.throws(
    () => validateMigrationRows(changed),
    (error) => error.code === 'RESTORE_MIGRATION_SET_MISMATCH'
  );
});

test('restored database validation checks schema, relations, counts, and repositories read-only', async () => {
  const root = makeTempDirectory();
  const resultPath = path.join(root, 'restore-validation.json');
  const harness = makeRestoreValidationPool();
  const result = await validateRestoredDatabase({
    database: 'xingxing_restore_drill_20260813_abcdef12',
    pool: harness.pool,
    resultPath
  });

  assert.equal(result.status, 'RESTORED_AND_VALIDATED');
  assert.equal(result.counts.identities, 27);
  assert.equal(result.samples.length, 3);
  assert.equal(result.samples[0].effective_comment_count, 2);
  assert.equal(fs.existsSync(resultPath), true);
  assert.equal(harness.calls.includes('BEGIN'), true);
  assert.equal(harness.calls.some((sql) => sql.includes('READ ONLY')), true);
  assert.equal(harness.calls.includes('COMMIT'), true);
});

test('restored database validation rolls back a repository failure without exposing details', async () => {
  const root = makeTempDirectory();
  const harness = makeRestoreValidationPool({ failRepositoryRead: true });
  await assert.rejects(
    validateRestoredDatabase({
      database: 'xingxing_restore_drill_20260813_abcdef12',
      pool: harness.pool,
      resultPath: path.join(root, 'restore-validation.json')
    }),
    (error) => !String(error.message).includes('must-not-surface')
  );
  assert.equal(harness.calls.includes('ROLLBACK'), true);
});

test('restore errors expose stable codes and never echo secret-bearing messages', () => {
  const error = new ProductionRestoreDrillError('RESTORE_OSS_DOWNLOAD_FAILED');
  assert.equal(safeErrorCode(error), 'RESTORE_OSS_DOWNLOAD_FAILED');
  assert.equal(error.message, 'RESTORE_OSS_DOWNLOAD_FAILED');
  assert.equal(
    safeErrorCode(new Error('password=do-not-print')),
    'PRODUCTION_RESTORE_DRILL_UNEXPECTED_FAILURE'
  );
});
