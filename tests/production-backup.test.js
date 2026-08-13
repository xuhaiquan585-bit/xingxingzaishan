'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  PRODUCTION_DATABASE,
  ProductionBackupError,
  assertPm2DumpSecretSafe,
  buildBackupObjectKeys,
  buildManifest,
  createPostgresDump,
  createRunId,
  executeProductionBackup,
  safeErrorCode,
  snapshotJsonFile,
  uploadAndVerify,
  writeTemporaryPgpass
} = require('../scripts/database/production-backup');
const {
  uploadProtectedFileToOss
} = require('../src/server/services/storageService');

function makeTempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xingxing-production-backup-'));
}

function writePrivateFile(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
  return filePath;
}

function makeConnection() {
  return {
    host: '127.0.0.1',
    port: '5432',
    user: 'xingxing_staging_app',
    database: PRODUCTION_DATABASE,
    sslMode: 'disable'
  };
}

function makeFakeSpawn({ dumpFails = false, restoreFails = false } = {}) {
  return (binary, args) => {
    if (binary.endsWith('pg_dump')) {
      if (dumpFails) return { status: 1, stdout: '', stderr: 'redacted' };
      const outputPath = args[args.indexOf('--file') + 1];
      fs.writeFileSync(outputPath, Buffer.from('fake-custom-dump'));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (restoreFails) return { status: 1, stdout: '', stderr: 'redacted' };
    return {
      status: 0,
      stdout: [
        '1; 0 0 TABLE DATA app qr_codes owner',
        '2; 0 0 TABLE DATA app records owner'
      ].join('\n'),
      stderr: ''
    };
  };
}

function makeBackupFixture() {
  const root = makeTempDirectory();
  const passwordFile = writePrivateFile(path.join(root, 'password'), 'p:a\\ss\n');
  const jsonSource = writePrivateFile(path.join(root, 'db.json'), '{"qr_codes":[]}\n');
  const pm2DumpPath = writePrivateFile(
    path.join(root, 'dump.pm2'),
    JSON.stringify([{ name: 'xingxingzaishan', env: { PGHOST: '127.0.0.1' } }])
  );
  return { root, passwordFile, jsonSource, pm2DumpPath };
}

test('production backup run ID and object keys are unique and date partitioned', () => {
  const now = new Date('2026-08-13T02:10:28.000Z');
  const runId = createRunId(now, () => Buffer.from('a1b2c3d4', 'hex'));
  assert.equal(runId, '20260813T021028Z-a1b2c3d4');
  assert.deepEqual(buildBackupObjectKeys({ runId }), {
    postgresql:
      'backups/xingxingzaishan/production/postgresql/2026/08/13/'
      + `${runId}-${PRODUCTION_DATABASE}.dump`,
    json:
      `backups/xingxingzaishan/production/json/2026/08/13/${runId}-db.json`,
    manifest:
      `backups/xingxingzaishan/production/manifests/2026/08/13/${runId}-manifest.json`
  });
});

test('JSON snapshot hashes and writes exactly the validated source bytes', () => {
  const root = makeTempDirectory();
  const source = writePrivateFile(path.join(root, 'source.json'), '{"ok":true}\n');
  const destination = path.join(root, 'snapshot.json');
  const result = snapshotJsonFile({ sourcePath: source, destinationPath: destination });

  assert.equal(result.size, 12);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(fs.readFileSync(destination), fs.readFileSync(source));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
  }
});

test('JSON snapshot rejects malformed input before writing a snapshot', () => {
  const root = makeTempDirectory();
  const source = writePrivateFile(path.join(root, 'source.json'), '{broken');
  const destination = path.join(root, 'snapshot.json');
  assert.throws(
    () => snapshotJsonFile({ sourcePath: source, destinationPath: destination }),
    (error) => error.code === 'PRODUCTION_JSON_INVALID'
  );
  assert.equal(fs.existsSync(destination), false);
});

test('JSON snapshot rejects a symbolic-link source', {
  skip: process.platform === 'win32'
}, () => {
  const root = makeTempDirectory();
  const target = writePrivateFile(path.join(root, 'target.json'), '{"ok":true}\n');
  const source = path.join(root, 'source.json');
  fs.symlinkSync(target, source);
  assert.throws(
    () => snapshotJsonFile({
      sourcePath: source,
      destinationPath: path.join(root, 'snapshot.json')
    }),
    (error) => error.code === 'PROTECTED_FILE_NOT_REGULAR'
  );
});

test('temporary pgpass escapes fields and never places the password in arguments', () => {
  const root = makeTempDirectory();
  const passwordFile = writePrivateFile(path.join(root, 'password'), 'p:a\\ss\n');
  const pgpass = path.join(root, 'pgpass');
  writeTemporaryPgpass({ filePath: pgpass, connection: makeConnection(), passwordFile });
  assert.equal(
    fs.readFileSync(pgpass, 'utf8'),
    `127.0.0.1:5432:${PRODUCTION_DATABASE}:xingxing_staging_app:p\\:a\\\\ss\n`
  );
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(pgpass).mode & 0o777, 0o600);
  }
});

test('PostgreSQL dump uses protected flags, validates structure, and removes pgpass', () => {
  const fixture = makeBackupFixture();
  const output = path.join(fixture.root, 'backup.dump');
  const restoreList = path.join(fixture.root, 'restore-list.txt');
  const calls = [];
  const fakeSpawn = (binary, args, options) => {
    calls.push({ binary, args, env: options.env });
    return makeFakeSpawn()(binary, args, options);
  };
  createPostgresDump({
    connection: makeConnection(),
    passwordFile: fixture.passwordFile,
    dumpPath: output,
    restoreListPath: restoreList,
    pgDumpBin: '/fake/pg_dump',
    pgRestoreBin: '/fake/pg_restore',
    spawn: fakeSpawn,
    randomBytes: () => Buffer.from('010203040506', 'hex')
  });

  assert.equal(calls.length, 2);
  assert.ok(calls[0].args.includes('--format=custom'));
  assert.ok(calls[0].args.includes('--no-owner'));
  assert.ok(calls[0].args.includes('--no-privileges'));
  assert.equal(calls[0].args.some((arg) => arg.includes('p:a')), false);
  assert.equal(calls[0].env.PGPASSWORD, undefined);
  assert.equal(calls[0].env.DATABASE_URL, undefined);
  assert.equal(fs.existsSync(calls[0].env.PGPASSFILE), false);
  assert.match(fs.readFileSync(restoreList, 'utf8'), /TABLE DATA app qr_codes/);
});

test('PostgreSQL dump failure is nonzero-equivalent and still removes pgpass', () => {
  const fixture = makeBackupFixture();
  const output = path.join(fixture.root, 'backup.dump');
  let pgpassPath;
  const fakeSpawn = (_binary, _args, options) => {
    pgpassPath = options.env.PGPASSFILE;
    return { status: 1, stdout: '', stderr: 'contains no emitted secrets' };
  };
  assert.throws(
    () => createPostgresDump({
      connection: makeConnection(),
      passwordFile: fixture.passwordFile,
      dumpPath: output,
      restoreListPath: path.join(fixture.root, 'restore-list.txt'),
      pgDumpBin: '/fake/pg_dump',
      pgRestoreBin: '/fake/pg_restore',
      spawn: fakeSpawn
    }),
    (error) => error.code === 'POSTGRES_DUMP_FAILED'
  );
  assert.equal(fs.existsSync(pgpassPath), false);
});

test('PostgreSQL restore-list failure rejects the dump and removes pgpass', () => {
  const fixture = makeBackupFixture();
  let pgpassPath;
  const baseSpawn = makeFakeSpawn({ restoreFails: true });
  const fakeSpawn = (binary, args, options) => {
    pgpassPath = options.env.PGPASSFILE;
    return baseSpawn(binary, args, options);
  };
  assert.throws(
    () => createPostgresDump({
      connection: makeConnection(),
      passwordFile: fixture.passwordFile,
      dumpPath: path.join(fixture.root, 'backup.dump'),
      restoreListPath: path.join(fixture.root, 'restore-list.txt'),
      pgDumpBin: '/fake/pg_dump',
      pgRestoreBin: '/fake/pg_restore',
      spawn: fakeSpawn
    }),
    (error) => error.code === 'POSTGRES_DUMP_STRUCTURE_INVALID'
  );
  assert.equal(fs.existsSync(pgpassPath), false);
});

test('protected OSS upload verifies status, size, SHA metadata, and ETag', async () => {
  const localArtifact = {
    path: '/tmp/backup.dump',
    size: 18,
    sha256: 'a'.repeat(64)
  };
  let captured;
  const result = await uploadAndVerify({
    localArtifact,
    objectKey: 'backups/example.dump',
    contentType: 'application/octet-stream',
    uploader: async (options) => {
      captured = options;
      return {
        status: 200,
        size: 18,
        declared_size: '18',
        sha256: 'a'.repeat(64),
        etag: 'etag-value'
      };
    }
  });
  assert.equal(captured.localPath, localArtifact.path);
  assert.equal(result.verified, true);
  assert.equal(result.etag, 'etag-value');
});

test('OSS storage helper streams a path with no-overwrite and private metadata', async () => {
  const calls = [];
  const client = {
    async put(objectKey, localPath, options) {
      calls.push({ objectKey, localPath, options });
      return { res: { status: 200 } };
    },
    async getObjectMeta(objectKey) {
      assert.equal(objectKey, 'backups/2026/object.dump');
      return {
        status: 200,
        res: {
          headers: {
            'content-length': '18',
            etag: '"fake-etag"'
          }
        }
      };
    },
    async head(objectKey) {
      assert.equal(objectKey, 'backups/2026/object.dump');
      return {
        status: 200,
        meta: {
          sha256: 'd'.repeat(64),
          size: '18'
        },
        res: { headers: {} }
      };
    }
  };
  const remote = await uploadProtectedFileToOss({
    objectKey: 'backups/2026/object.dump',
    localPath: '/tmp/object.dump',
    sha256: 'd'.repeat(64),
    size: 18,
    client
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].localPath, '/tmp/object.dump');
  assert.equal(calls[0].options.headers['x-oss-forbid-overwrite'], 'true');
  assert.equal(calls[0].options.headers['Cache-Control'], 'private, max-age=0, no-cache');
  assert.equal(calls[0].options.meta.sha256, 'd'.repeat(64));
  assert.equal(calls[0].options.meta.size, '18');
  assert.equal(remote.size, 18);
  assert.equal(remote.etag, 'fake-etag');
  assert.equal(remote.metadata_status, 200);
});

test('protected OSS upload rejects existing objects, upload errors, and bad metadata', async () => {
  const artifact = { path: '/tmp/object', size: 2, sha256: 'b'.repeat(64) };
  await assert.rejects(
    uploadAndVerify({
      localArtifact: artifact,
      objectKey: 'backups/object',
      uploader: async () => {
        const error = new Error('already exists');
        error.code = 'PreconditionFailed';
        throw error;
      }
    }),
    (error) => error.code === 'OSS_OBJECT_ALREADY_EXISTS'
  );
  await assert.rejects(
    uploadAndVerify({
      localArtifact: artifact,
      objectKey: 'backups/object',
      uploader: async () => {
        const error = new Error('already exists');
        error.code = 'FileAlreadyExists';
        error.status = 409;
        throw error;
      }
    }),
    (error) => error.code === 'OSS_OBJECT_ALREADY_EXISTS'
  );
  await assert.rejects(
    uploadAndVerify({
      localArtifact: artifact,
      objectKey: 'backups/object',
      uploader: async () => {
        throw new Error('network details stay private');
      }
    }),
    (error) => error.code === 'OSS_UPLOAD_FAILED'
  );
  await assert.rejects(
    uploadAndVerify({
      localArtifact: artifact,
      objectKey: 'backups/object',
      uploader: async () => ({
        status: 200,
        size: 3,
        declared_size: '2',
        sha256: artifact.sha256,
        etag: 'etag'
      })
    }),
    (error) => error.code === 'OSS_REMOTE_METADATA_MISMATCH'
  );
  await assert.rejects(
    uploadAndVerify({
      localArtifact: artifact,
      objectKey: 'backups/object',
      uploader: async () => ({
        status: 200,
        size: 2,
        declared_size: '2',
        sha256: 'c'.repeat(64),
        etag: 'etag'
      })
    }),
    (error) => error.code === 'OSS_REMOTE_METADATA_MISMATCH'
  );
});

test('manifest states independent consistency and records verified artifacts', () => {
  const artifact = {
    path: '/root/backup',
    object_key: 'backups/object',
    sha256: 'c'.repeat(64),
    size: 12,
    etag: 'etag',
    verified: true
  };
  const manifest = buildManifest({
    runId: '20260813T021028Z-a1b2c3d4',
    gitCommit: '8bfd1da',
    database: PRODUCTION_DATABASE,
    startedAt: '2026-08-13T02:10:28.000Z',
    completedAt: '2026-08-13T02:10:30.000Z',
    postgresql: artifact,
    json: artifact
  });
  assert.equal(manifest.consistency.cross_store_transactional_snapshot, false);
  assert.equal(manifest.snapshots.postgresql.verified, true);
  assert.equal(manifest.snapshots.json.sha256, artifact.sha256);
});

test('PM2 dump secret gate and public failure code do not expose secret values', () => {
  const root = makeTempDirectory();
  const safeDump = writePrivateFile(path.join(root, 'safe.pm2'), '[{"env":{}}]');
  const unsafeDump = writePrivateFile(
    path.join(root, 'unsafe.pm2'),
    '[{"env":{"OSS_ACCESS_KEY_SECRET":"do-not-print"}}]'
  );
  assert.doesNotThrow(() => assertPm2DumpSecretSafe(safeDump));
  assert.throws(
    () => assertPm2DumpSecretSafe(unsafeDump),
    (error) => error.code === 'PM2_DUMP_CONTAINS_SECRET'
      && !error.message.includes('do-not-print')
  );
  assert.equal(
    safeErrorCode(new Error('password=do-not-print')),
    'PRODUCTION_BACKUP_UNEXPECTED_FAILURE'
  );
});

test('full backup uploads dump, JSON, then manifest and retains local artifacts', async () => {
  const fixture = makeBackupFixture();
  const uploads = [];
  const result = await executeProductionBackup({
    connection: makeConnection(),
    passwordFile: fixture.passwordFile,
    gitCommit: '8bfd1daf12ea9d2026f7886654aa8866ec65728e',
    appPid: '237588',
    appHttp: '200',
    now: new Date('2026-08-13T02:10:28.000Z'),
    randomBytes: (size) => size === 4
      ? Buffer.from('a1b2c3d4', 'hex')
      : Buffer.alloc(size, 1),
    backupRoot: path.join(fixture.root, 'backup-root'),
    jsonSource: fixture.jsonSource,
    pm2DumpPath: fixture.pm2DumpPath,
    loadOssEnvironment: false,
    pgDumpBin: '/fake/pg_dump',
    pgRestoreBin: '/fake/pg_restore',
    spawn: makeFakeSpawn(),
    uploader: async (options) => {
      uploads.push(options.objectKey);
      return {
        status: 200,
        size: options.size,
        declared_size: String(options.size),
        sha256: options.sha256,
        etag: `etag-${uploads.length}`
      };
    }
  });

  assert.match(uploads[0], /\/postgresql\//);
  assert.match(uploads[1], /\/json\//);
  assert.match(uploads[2], /\/manifests\//);
  assert.equal(fs.existsSync(result.postgresql.path), true);
  assert.equal(fs.existsSync(result.json.path), true);
  assert.equal(fs.existsSync(result.manifest.path), true);
  assert.equal(fs.existsSync(result.summaryPath), true);
  const manifest = JSON.parse(fs.readFileSync(result.manifest.path, 'utf8'));
  assert.equal(manifest.status, 'COMPLETE');
  assert.equal(manifest.snapshots.postgresql.verified, true);
});

test('failure on the second upload returns failure and never uploads a manifest', async () => {
  const fixture = makeBackupFixture();
  const uploads = [];
  await assert.rejects(
    executeProductionBackup({
      connection: makeConnection(),
      passwordFile: fixture.passwordFile,
      gitCommit: '8bfd1daf12ea9d2026f7886654aa8866ec65728e',
      appPid: '237588',
      appHttp: '200',
      now: new Date('2026-08-13T02:10:28.000Z'),
      randomBytes: (size) => size === 4
        ? Buffer.from('a1b2c3d4', 'hex')
        : Buffer.alloc(size, 2),
      backupRoot: path.join(fixture.root, 'backup-root'),
      jsonSource: fixture.jsonSource,
      pm2DumpPath: fixture.pm2DumpPath,
      loadOssEnvironment: false,
      pgDumpBin: '/fake/pg_dump',
      pgRestoreBin: '/fake/pg_restore',
      spawn: makeFakeSpawn(),
      uploader: async (options) => {
        uploads.push(options.objectKey);
        if (uploads.length === 2) throw new Error('simulated upload failure');
        return {
          status: 200,
          size: options.size,
          declared_size: String(options.size),
          sha256: options.sha256,
          etag: 'etag-1'
        };
      }
    }),
    (error) => error.code === 'OSS_UPLOAD_FAILED'
  );
  assert.equal(uploads.length, 2);
  assert.equal(uploads.some((key) => /\/manifests\//.test(key)), false);
  const runDirectory = path.join(
    fixture.root,
    'backup-root',
    '20260813T021028Z-a1b2c3d4'
  );
  assert.equal(fs.existsSync(path.join(runDirectory, 'failure-summary.txt')), true);
});

test('backup errors expose stable codes only', () => {
  const error = new ProductionBackupError('OSS_UPLOAD_FAILED');
  assert.equal(safeErrorCode(error), 'OSS_UPLOAD_FAILED');
  assert.equal(error.message, 'OSS_UPLOAD_FAILED');
});
