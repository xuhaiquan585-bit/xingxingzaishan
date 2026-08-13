'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const dotenv = require('dotenv');

const {
  uploadProtectedFileToOss
} = require('../../src/server/services/storageService');

const PRODUCTION_DATABASE = 'xingxing_clean_baseline_20260812_staging';
const PRODUCTION_JSON = '/www/wwwroot/xingxingzaishan/src/server/data/db.json';
const BACKUP_ROOT = '/root/xingxingzaishan-production-backup';
const OSS_ENV_FILE = '/www/wwwroot/xingxingzaishan/.env';
const PM2_DUMP_FILE = '/root/.pm2/dump.pm2';
const PG_DUMP_BIN = '/usr/pgsql-15/bin/pg_dump';
const PG_RESTORE_BIN = '/usr/pgsql-15/bin/pg_restore';
const OBJECT_PREFIX = 'backups/xingxingzaishan/production';
const FORBIDDEN_PM2_SECRET_KEYS = new Set([
  'DATABASE_URL',
  'PGPASSWORD',
  'OSS_ACCESS_KEY_ID',
  'OSS_ACCESS_KEY_SECRET',
  'AVATA_API_KEY',
  'AVATA_API_SECRET'
]);

class ProductionBackupError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ProductionBackupError';
    this.code = code;
  }
}

function backupError(code) {
  return new ProductionBackupError(code);
}

function safeErrorCode(error) {
  if (error instanceof ProductionBackupError) return error.code;
  if (['PreconditionFailed', 'FileAlreadyExists'].includes(error?.code)
    || [409, 412].includes(error?.status)) {
    return 'OSS_OBJECT_ALREADY_EXISTS';
  }
  return 'PRODUCTION_BACKUP_UNEXPECTED_FAILURE';
}

function pad(value, length = 2) {
  return String(value).padStart(length, '0');
}

function createRunId(now = new Date(), randomBytes = crypto.randomBytes) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw backupError('RUN_TIME_INVALID');
  }
  const timestamp = [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate())
  ].join('') + 'T' + [
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds())
  ].join('') + 'Z';
  const nonce = randomBytes(4).toString('hex');
  if (!/^[a-f0-9]{8}$/.test(nonce)) {
    throw backupError('RUN_NONCE_INVALID');
  }
  return `${timestamp}-${nonce}`;
}

function assertRunId(runId) {
  if (!/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(String(runId || ''))) {
    throw backupError('RUN_ID_INVALID');
  }
}

function buildBackupObjectKeys({ runId, database = PRODUCTION_DATABASE }) {
  assertRunId(runId);
  if (database !== PRODUCTION_DATABASE) {
    throw backupError('PRODUCTION_DATABASE_MISMATCH');
  }
  const year = runId.slice(0, 4);
  const month = runId.slice(4, 6);
  const day = runId.slice(6, 8);
  const datePrefix = `${year}/${month}/${day}`;
  return {
    postgresql: `${OBJECT_PREFIX}/postgresql/${datePrefix}/${runId}-${database}.dump`,
    json: `${OBJECT_PREFIX}/json/${datePrefix}/${runId}-db.json`,
    manifest: `${OBJECT_PREFIX}/manifests/${datePrefix}/${runId}-manifest.json`
  };
}

function assertRegularFileNoFollow(filePath, { rootOnly = false } = {}) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (_error) {
    throw backupError('PROTECTED_FILE_MISSING');
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw backupError('PROTECTED_FILE_NOT_REGULAR');
  }
  if (rootOnly && process.platform !== 'win32') {
    if (stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o077) !== 0) {
      throw backupError('PROTECTED_FILE_PERMISSION_INVALID');
    }
  }
  return stat;
}

function readFileNoFollow(filePath, { rootOnly = false } = {}) {
  assertRegularFileNoFollow(filePath, { rootOnly });
  let descriptor;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    const openedStat = fs.fstatSync(descriptor);
    if (!openedStat.isFile()) throw backupError('PROTECTED_FILE_NOT_REGULAR');
    if (rootOnly && process.platform !== 'win32') {
      if (openedStat.uid !== 0 || openedStat.gid !== 0 || (openedStat.mode & 0o077) !== 0) {
        throw backupError('PROTECTED_FILE_PERMISSION_INVALID');
      }
    }
    return fs.readFileSync(descriptor);
  } catch (error) {
    if (error instanceof ProductionBackupError) throw error;
    throw backupError('PROTECTED_FILE_READ_FAILED');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function writeFileExclusive(filePath, bytes) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, 'wx', 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.fchmodSync(descriptor, 0o600);
  } catch (_error) {
    throw backupError('LOCAL_BACKUP_WRITE_FAILED');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function snapshotJsonFile({ sourcePath, destinationPath }) {
  const bytes = readFileNoFollow(sourcePath);
  try {
    JSON.parse(bytes.toString('utf8'));
  } catch (_error) {
    throw backupError('PRODUCTION_JSON_INVALID');
  }
  writeFileExclusive(destinationPath, bytes);
  return {
    path: destinationPath,
    sha256: sha256Bytes(bytes),
    size: bytes.length
  };
}

async function hashFile(filePath) {
  assertRegularFileNoFollow(filePath);
  const hash = crypto.createHash('sha256');
  let size = 0;
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => {
      size += chunk.length;
      hash.update(chunk);
    });
    stream.on('error', () => reject(backupError('LOCAL_BACKUP_READ_FAILED')));
    stream.on('end', resolve);
  });
  return { path: filePath, sha256: hash.digest('hex'), size };
}

function escapePgpassField(value) {
  return String(value).replace(/([\\:])/g, '\\$1');
}

function writeTemporaryPgpass({ filePath, connection, passwordFile }) {
  const passwordBytes = readFileNoFollow(passwordFile, { rootOnly: true });
  const password = passwordBytes.toString('utf8').replace(/[\r\n]+$/, '');
  if (!password || /[\r\n]/.test(password)) {
    throw backupError('POSTGRES_PASSWORD_FILE_INVALID');
  }
  const line = [
    connection.host,
    connection.port,
    connection.database,
    connection.user,
    password
  ].map(escapePgpassField).join(':') + '\n';
  writeFileExclusive(filePath, Buffer.from(line, 'utf8'));
}

function runPostgresCommand({ binary, args, env, spawn = spawnSync }) {
  const result = spawn(binary, args, {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error || result.status !== 0) {
    throw backupError(binary.includes('pg_restore')
      ? 'POSTGRES_DUMP_STRUCTURE_INVALID'
      : 'POSTGRES_DUMP_FAILED');
  }
  return result;
}

function createPostgresDump({
  connection,
  passwordFile,
  dumpPath,
  restoreListPath,
  pgDumpBin = PG_DUMP_BIN,
  pgRestoreBin = PG_RESTORE_BIN,
  spawn = spawnSync,
  randomBytes = crypto.randomBytes
}) {
  if (connection.database !== PRODUCTION_DATABASE) {
    throw backupError('PRODUCTION_DATABASE_MISMATCH');
  }
  const pgpassPath = path.join(
    path.dirname(dumpPath),
    `.pgpass-${randomBytes(6).toString('hex')}`
  );
  try {
    writeTemporaryPgpass({ filePath: pgpassPath, connection, passwordFile });
    const commandEnv = { ...process.env };
    delete commandEnv.PGPASSWORD;
    delete commandEnv.DATABASE_URL;
    commandEnv.PGPASSFILE = pgpassPath;
    commandEnv.PGSSLMODE = connection.sslMode;
    commandEnv.PGAPPNAME = 'xingxingzaishan-production-backup';

    runPostgresCommand({
      binary: pgDumpBin,
      args: [
        '--host', connection.host,
        '--port', String(connection.port),
        '--username', connection.user,
        '--dbname', connection.database,
        '--format=custom',
        '--no-owner',
        '--no-privileges',
        '--file', dumpPath
      ],
      env: commandEnv,
      spawn
    });
    assertRegularFileNoFollow(dumpPath);
    fs.chmodSync(dumpPath, 0o600);

    const restoreResult = runPostgresCommand({
      binary: pgRestoreBin,
      args: ['--list', dumpPath],
      env: commandEnv,
      spawn
    });
    if (!/TABLE DATA app qr_codes/.test(restoreResult.stdout || '')
      || !/TABLE DATA app records/.test(restoreResult.stdout || '')) {
      throw backupError('POSTGRES_DUMP_STRUCTURE_INVALID');
    }
    writeFileExclusive(restoreListPath, Buffer.from(restoreResult.stdout, 'utf8'));
  } finally {
    try {
      fs.unlinkSync(pgpassPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw backupError('TEMPORARY_PGPASS_CLEANUP_FAILED');
      }
    }
  }
}

function findConfiguredSecrets(value, found = []) {
  if (!value || typeof value !== 'object') return found;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_PM2_SECRET_KEYS.has(key) && String(child || '').trim()) {
      found.push(key);
    }
    findConfiguredSecrets(child, found);
  }
  return found;
}

function assertPm2DumpSecretSafe(pm2DumpPath = PM2_DUMP_FILE) {
  const bytes = readFileNoFollow(pm2DumpPath, { rootOnly: true });
  let dump;
  try {
    dump = JSON.parse(bytes.toString('utf8'));
  } catch (_error) {
    throw backupError('PM2_DUMP_INVALID');
  }
  if (findConfiguredSecrets(dump).length > 0) {
    throw backupError('PM2_DUMP_CONTAINS_SECRET');
  }
}

function loadProtectedOssEnvironment(ossEnvPath = OSS_ENV_FILE) {
  const bytes = readFileNoFollow(ossEnvPath, { rootOnly: true });
  const parsed = dotenv.parse(bytes);
  const required = [
    'OSS_ENDPOINT',
    'OSS_REGION',
    'OSS_BUCKET',
    'OSS_ACCESS_KEY_ID',
    'OSS_ACCESS_KEY_SECRET'
  ];
  if (required.some((key) => !String(parsed[key] || '').trim())) {
    throw backupError('OSS_ENVIRONMENT_INCOMPLETE');
  }
  for (const key of [...required, 'OSS_SECURE']) {
    if (parsed[key] !== undefined) process.env[key] = parsed[key];
  }
}

function verifyRemoteMetadata({ expected, remote }) {
  if (remote.status !== 200
    || (remote.metadata_status ?? remote.status) !== 200
    || remote.size !== expected.size
    || remote.declared_size !== String(expected.size)
    || remote.sha256 !== expected.sha256
    || !remote.etag) {
    throw backupError('OSS_REMOTE_METADATA_MISMATCH');
  }
  return {
    ...expected,
    etag: remote.etag,
    verified: true
  };
}

async function uploadAndVerify({
  localArtifact,
  objectKey,
  contentType,
  client = null,
  uploader = uploadProtectedFileToOss
}) {
  let remote;
  try {
    remote = await uploader({
      objectKey,
      localPath: localArtifact.path,
      contentType,
      sha256: localArtifact.sha256,
      size: localArtifact.size,
      client
    });
  } catch (error) {
    if (['PreconditionFailed', 'FileAlreadyExists'].includes(error?.code)
      || [409, 412].includes(error?.status)) {
      throw backupError('OSS_OBJECT_ALREADY_EXISTS');
    }
    if (error instanceof ProductionBackupError) throw error;
    throw backupError('OSS_UPLOAD_FAILED');
  }
  return verifyRemoteMetadata({
    expected: { ...localArtifact, object_key: objectKey },
    remote
  });
}

function buildManifest({
  runId,
  gitCommit,
  database,
  startedAt,
  completedAt,
  postgresql,
  json
}) {
  return {
    schema_version: 1,
    status: 'COMPLETE',
    run_id: runId,
    git_commit: gitCommit,
    started_at_utc: startedAt,
    completed_at_utc: completedAt,
    database,
    consistency: {
      postgresql: 'pg_dump consistent snapshot',
      json: 'single immutable byte snapshot',
      cross_store_transactional_snapshot: false
    },
    snapshots: {
      postgresql: {
        format: 'pg_dump custom',
        local_path: postgresql.path,
        object_key: postgresql.object_key,
        sha256: postgresql.sha256,
        size: postgresql.size,
        etag: postgresql.etag,
        verified: postgresql.verified
      },
      json: {
        format: 'json',
        local_path: json.path,
        object_key: json.object_key,
        sha256: json.sha256,
        size: json.size,
        etag: json.etag,
        verified: json.verified
      }
    }
  };
}

function writeJsonExclusive(filePath, value) {
  writeFileExclusive(
    filePath,
    Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  );
}

function createOutputDirectory(root, runId) {
  assertRunId(runId);
  if (fs.existsSync(root)) {
    const rootStat = fs.lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw backupError('BACKUP_ROOT_INVALID');
    }
    if (process.platform !== 'win32' && (rootStat.uid !== 0 || rootStat.gid !== 0)) {
      throw backupError('BACKUP_ROOT_INVALID');
    }
  } else {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(root, 0o700);
  const outputDirectory = path.join(root, runId);
  if (fs.existsSync(outputDirectory)) {
    throw backupError('BACKUP_RUN_DIRECTORY_EXISTS');
  }
  fs.mkdirSync(outputDirectory, { mode: 0o700 });
  fs.chmodSync(outputDirectory, 0o700);
  return outputDirectory;
}

function writeFailureSummary(outputDirectory, runId, code) {
  if (!outputDirectory || !fs.existsSync(outputDirectory)) return;
  const summaryPath = path.join(outputDirectory, 'failure-summary.txt');
  if (fs.existsSync(summaryPath)) return;
  writeFileExclusive(summaryPath, Buffer.from([
    `RUN_ID=${runId}`,
    'STATUS=FAILED',
    `ERROR_CODE=${code}`,
    'REMOTE_PARTIAL_OBJECTS_DELETED=NO',
    ''
  ].join('\n'), 'utf8'));
}

async function executeProductionBackup({
  connection,
  passwordFile,
  gitCommit,
  appPid,
  appHttp,
  now = new Date(),
  randomBytes = crypto.randomBytes,
  backupRoot = BACKUP_ROOT,
  jsonSource = PRODUCTION_JSON,
  ossEnvPath = OSS_ENV_FILE,
  pm2DumpPath = PM2_DUMP_FILE,
  pgDumpBin = PG_DUMP_BIN,
  pgRestoreBin = PG_RESTORE_BIN,
  spawn = spawnSync,
  ossClient = null,
  uploader = uploadProtectedFileToOss,
  loadOssEnvironment = true
}) {
  const startedAt = now.toISOString();
  const runId = createRunId(now, randomBytes);
  let outputDirectory;
  try {
    if (connection.database !== PRODUCTION_DATABASE) {
      throw backupError('PRODUCTION_DATABASE_MISMATCH');
    }
    assertPm2DumpSecretSafe(pm2DumpPath);
    if (loadOssEnvironment) loadProtectedOssEnvironment(ossEnvPath);
    outputDirectory = createOutputDirectory(backupRoot, runId);

    const dumpPath = path.join(
      outputDirectory,
      `${runId}-${PRODUCTION_DATABASE}.dump`
    );
    const restoreListPath = path.join(outputDirectory, 'postgresql-restore-list.txt');
    const jsonPath = path.join(outputDirectory, `${runId}-db.json`);
    const manifestPath = path.join(outputDirectory, `${runId}-manifest.json`);
    const summaryPath = path.join(outputDirectory, 'backup-summary.txt');

    createPostgresDump({
      connection,
      passwordFile,
      dumpPath,
      restoreListPath,
      pgDumpBin,
      pgRestoreBin,
      spawn,
      randomBytes
    });
    const dumpArtifact = await hashFile(dumpPath);
    const jsonArtifact = snapshotJsonFile({
      sourcePath: jsonSource,
      destinationPath: jsonPath
    });
    const objectKeys = buildBackupObjectKeys({ runId });

    const uploadedDump = await uploadAndVerify({
      localArtifact: dumpArtifact,
      objectKey: objectKeys.postgresql,
      contentType: 'application/octet-stream',
      client: ossClient,
      uploader
    });
    const uploadedJson = await uploadAndVerify({
      localArtifact: jsonArtifact,
      objectKey: objectKeys.json,
      contentType: 'application/json; charset=utf-8',
      client: ossClient,
      uploader
    });

    const completedAt = new Date().toISOString();
    const manifest = buildManifest({
      runId,
      gitCommit,
      database: PRODUCTION_DATABASE,
      startedAt,
      completedAt,
      postgresql: uploadedDump,
      json: uploadedJson
    });
    writeJsonExclusive(manifestPath, manifest);
    const manifestArtifact = await hashFile(manifestPath);
    const uploadedManifest = await uploadAndVerify({
      localArtifact: manifestArtifact,
      objectKey: objectKeys.manifest,
      contentType: 'application/json; charset=utf-8',
      client: ossClient,
      uploader
    });

    const lines = [
      `RUN_ID=${runId}`,
      `GIT_COMMIT=${gitCommit}`,
      `DATABASE=${PRODUCTION_DATABASE}`,
      `LOCAL_BACKUP_DIRECTORY=${outputDirectory}`,
      `POSTGRESQL_LOCAL_PATH=${uploadedDump.path}`,
      `POSTGRESQL_OSS_KEY=${uploadedDump.object_key}`,
      `POSTGRESQL_SHA256=${uploadedDump.sha256}`,
      `POSTGRESQL_SIZE=${uploadedDump.size}`,
      `POSTGRESQL_ETAG=${uploadedDump.etag}`,
      'POSTGRESQL_REMOTE_VERIFIED=YES',
      `JSON_LOCAL_PATH=${uploadedJson.path}`,
      `JSON_OSS_KEY=${uploadedJson.object_key}`,
      `JSON_SHA256=${uploadedJson.sha256}`,
      `JSON_SIZE=${uploadedJson.size}`,
      `JSON_ETAG=${uploadedJson.etag}`,
      'JSON_REMOTE_VERIFIED=YES',
      `MANIFEST_LOCAL_PATH=${uploadedManifest.path}`,
      `MANIFEST_OSS_KEY=${uploadedManifest.object_key}`,
      `MANIFEST_SHA256=${uploadedManifest.sha256}`,
      `MANIFEST_SIZE=${uploadedManifest.size}`,
      `MANIFEST_ETAG=${uploadedManifest.etag}`,
      'MANIFEST_REMOTE_VERIFIED=YES',
      `APP_PID=${appPid}`,
      `APP_HTTP=${appHttp}`,
      'SCHEDULE_READY=YES_NOT_CONFIGURED',
      'PRODUCTION_BACKUP_ARTIFACT_UPLOAD=PASS',
      ''
    ];
    writeFileExclusive(summaryPath, Buffer.from(lines.join('\n'), 'utf8'));

    return {
      runId,
      outputDirectory,
      summaryPath,
      postgresql: uploadedDump,
      json: uploadedJson,
      manifest: uploadedManifest,
      lines
    };
  } catch (error) {
    const code = safeErrorCode(error);
    writeFailureSummary(outputDirectory, runId, code);
    throw backupError(code);
  }
}

function parseCliArguments(argv) {
  const values = {};
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(argument);
    if (!match) throw backupError('BACKUP_ARGUMENT_INVALID');
    values[match[1]] = match[2];
  }
  const allowed = new Set([
    'pg-host',
    'pg-port',
    'pg-user',
    'pg-database',
    'pg-ssl-mode',
    'password-file',
    'git-commit',
    'app-pid',
    'app-http'
  ]);
  if (Object.keys(values).some((key) => !allowed.has(key))) {
    throw backupError('BACKUP_ARGUMENT_INVALID');
  }
  if ([...allowed].some((key) => !String(values[key] || '').trim())) {
    throw backupError('BACKUP_ARGUMENT_MISSING');
  }
  return values;
}

async function main(argv = process.argv.slice(2)) {
  try {
    const values = parseCliArguments(argv);
    const result = await executeProductionBackup({
      connection: {
        host: values['pg-host'],
        port: values['pg-port'],
        user: values['pg-user'],
        database: values['pg-database'],
        sslMode: values['pg-ssl-mode']
      },
      passwordFile: values['password-file'],
      gitCommit: values['git-commit'],
      appPid: values['app-pid'],
      appHttp: values['app-http']
    });
    process.stdout.write(result.lines.join('\n'));
    return result;
  } catch (error) {
    process.stderr.write(`PRODUCTION_MANUAL_OFFSITE_BACKUP=FAIL\nERROR_CODE=${safeErrorCode(error)}\n`);
    process.exitCode = 1;
    return null;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  BACKUP_ROOT,
  OBJECT_PREFIX,
  OSS_ENV_FILE,
  PM2_DUMP_FILE,
  PRODUCTION_DATABASE,
  PRODUCTION_JSON,
  ProductionBackupError,
  assertPm2DumpSecretSafe,
  buildBackupObjectKeys,
  buildManifest,
  createPostgresDump,
  createRunId,
  executeProductionBackup,
  hashFile,
  loadProtectedOssEnvironment,
  main,
  parseCliArguments,
  safeErrorCode,
  snapshotJsonFile,
  uploadAndVerify,
  verifyRemoteMetadata,
  writeTemporaryPgpass
};
