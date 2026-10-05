'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const OSS = require('ali-oss');

const { readPostgresConfig } = require('../../src/server/database/config');
const {
  closePostgresPool,
  createPostgresPool
} = require('../../src/server/database/connection');
const {
  assertIndependentBuckets,
  executeObjectMirror,
  inspectBucket,
  listReferencedObjectKeys,
  safeErrorCode,
  validateMirrorManifest
} = require('./production-object-mirror');
const {
  parseProcessEnvironment,
  reconstructRuntimeEnvironment
} = require('../acceptance/validate-running-production-config');

const SOURCE_OSS_ENV = '/www/wwwroot/xingxingzaishan/.env';
const DESTINATION_OSS_ENV = '/etc/xingxingzaishan/object-mirror.env';
const EXPECTED_PRODUCTION_DATABASE = 'xingxing_clean_baseline_20260812_staging';

function cliError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function readProtectedEnvironmentSnapshot(filePath, { rootOnly = true } = {}) {
  if (!path.isAbsolute(String(filePath || ''))) {
    throw cliError('MIRROR_ENV_PATH_INVALID');
  }
  let descriptor;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw cliError('MIRROR_ENV_FILE_INVALID');
    if (rootOnly && process.platform !== 'win32'
        && (stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o077) !== 0)) {
      throw cliError('MIRROR_ENV_FILE_PERMISSION_INVALID');
    }
    return Object.freeze({
      environment: dotenv.parse(fs.readFileSync(descriptor)),
      modifiedAtMs: Number(stat.mtimeMs)
    });
  } catch (error) {
    if (error && String(error.code || '').startsWith('MIRROR_')) throw error;
    throw cliError('MIRROR_ENV_FILE_READ_FAILED');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readProtectedEnvironment(filePath, options) {
  return readProtectedEnvironmentSnapshot(filePath, options).environment;
}

function readLatestPreviousMirrorManifest(outputDirectory) {
  const rootDirectory = path.dirname(outputDirectory);
  const currentRunId = path.basename(outputDirectory);
  let entries;
  try {
    entries = fs.readdirSync(rootDirectory, { withFileTypes: true });
  } catch (_error) {
    throw cliError('MIRROR_HISTORY_ROOT_INVALID');
  }
  const runIds = entries
    .filter((entry) => entry.isDirectory()
      && entry.name !== currentRunId
      && /^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));
  for (const runId of runIds) {
    const manifestPath = path.join(
      rootDirectory,
      runId,
      `${runId}-object-mirror-manifest.json`
    );
    if (!fs.existsSync(manifestPath)) continue;
    let descriptor;
    try {
      descriptor = fs.openSync(
        manifestPath,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
      );
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.size < 2 || stat.size > 64 * 1024 * 1024
          || (process.platform !== 'win32'
            && (stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o077) !== 0))) {
        throw cliError('MIRROR_PREVIOUS_MANIFEST_INVALID');
      }
      return validateMirrorManifest(JSON.parse(fs.readFileSync(descriptor, 'utf8')));
    } catch (error) {
      if (error && String(error.code || '').startsWith('MIRROR_')) throw error;
      throw cliError('MIRROR_PREVIOUS_MANIFEST_INVALID');
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }
  return null;
}

function assertProductionMirrorEnvironment(environment) {
  if (String(environment.NODE_ENV || '').trim().toLowerCase() !== 'production'
      || String(environment.PUBLIC_QR_POSTGRES_READ_ENABLED || '') !== 'true'
      || String(environment.PUBLIC_QR_POSTGRES_READ_SCOPE || '') !== 'all'
      || String(environment.PERSONAL_RECORD_POSTGRES_READ_ENABLED || '') !== 'true'
      || String(environment.PERSONAL_RECORD_POSTGRES_READ_SCOPE || '') !== 'all'
      || String(environment.PGDATABASE || '') !== EXPECTED_PRODUCTION_DATABASE
      || String(environment.PGHOST || '') !== '127.0.0.1') {
    throw cliError('MIRROR_PRODUCTION_AUTHORITY_INVALID');
  }
}

function readOssConfig(environment, prefix = '') {
  const source = environment && typeof environment === 'object' ? environment : {};
  const key = (name) => String(source[`${prefix}${name}`] || '').trim();
  const config = {
    endpoint: key('OSS_ENDPOINT'),
    region: key('OSS_REGION'),
    bucket: key('OSS_BUCKET'),
    accessKeyId: key('OSS_ACCESS_KEY_ID'),
    accessKeySecret: key('OSS_ACCESS_KEY_SECRET'),
    secure: key('OSS_SECURE').toLowerCase() !== 'false',
    timeout: 10000,
    retryMax: 2
  };
  if (!config.endpoint || !config.region || !config.bucket
      || !config.accessKeyId || !config.accessKeySecret) {
    throw cliError('MIRROR_OSS_ENVIRONMENT_INCOMPLETE');
  }
  return Object.freeze(config);
}

function parseArguments(argv) {
  const options = {
    sourceOssEnv: SOURCE_OSS_ENV,
    destinationOssEnv: DESTINATION_OSS_ENV,
    preflight: false,
    authorized: false,
    runId: '',
    outputDirectory: '',
    appPid: '',
    processStartedAtMs: 0
  };
  for (const argument of argv) {
    if (argument === '--preflight') {
      options.preflight = true;
      continue;
    }
    if (argument === '--authorize-mirror-write=YES') {
      options.authorized = true;
      continue;
    }
    const match = /^--([a-z-]+)=(.+)$/.exec(argument);
    if (!match) throw cliError('MIRROR_ARGUMENT_INVALID');
    const [, name, value] = match;
    if (name === 'source-oss-env') options.sourceOssEnv = value;
    else if (name === 'destination-oss-env') options.destinationOssEnv = value;
    else if (name === 'run-id') options.runId = value;
    else if (name === 'output-directory') options.outputDirectory = value;
    else if (name === 'app-pid') options.appPid = value;
    else if (name === 'process-started-at-ms') options.processStartedAtMs = Number(value);
    else throw cliError('MIRROR_ARGUMENT_INVALID');
  }
  if (options.preflight === options.authorized) {
    throw cliError('MIRROR_MODE_REQUIRED');
  }
  if (options.authorized
      && (!/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(options.runId)
        || !path.isAbsolute(options.outputDirectory))) {
    throw cliError('MIRROR_AUTHORIZED_ARGUMENT_INVALID');
  }
  if ((options.appPid || options.processStartedAtMs)
      && (!/^[1-9][0-9]*$/.test(options.appPid)
        || !Number.isSafeInteger(options.processStartedAtMs)
        || options.processStartedAtMs <= 0)) {
    throw cliError('MIRROR_RUNTIME_ARGUMENT_INVALID');
  }
  return Object.freeze(options);
}

function loadEffectiveSourceEnvironment({
  options,
  fallbackEnvironment,
  sourceSnapshot,
  readFileSync = fs.readFileSync,
  readlinkSync = fs.readlinkSync,
  realpathSync = fs.realpathSync
}) {
  if (!options.appPid) {
    if (String(fallbackEnvironment.NODE_ENV || '').trim().toLowerCase() === 'production') {
      throw cliError('MIRROR_RUNTIME_SNAPSHOT_REQUIRED');
    }
    return reconstructRuntimeEnvironment({
      processEnvironment: fallbackEnvironment,
      fileEnvironment: sourceSnapshot.environment
    });
  }

  let processEnvironment;
  let processWorkingDirectory;
  let expectedWorkingDirectory;
  try {
    processEnvironment = parseProcessEnvironment(
      readFileSync(path.join('/proc', options.appPid, 'environ'))
    );
    processWorkingDirectory = realpathSync(
      readlinkSync(path.join('/proc', options.appPid, 'cwd'))
    );
    expectedWorkingDirectory = realpathSync(path.dirname(options.sourceOssEnv));
  } catch (_error) {
    throw cliError('MIRROR_RUNTIME_SNAPSHOT_UNREADABLE');
  }
  if (processWorkingDirectory !== expectedWorkingDirectory) {
    throw cliError('MIRROR_RUNTIME_WORKING_DIRECTORY_INVALID');
  }
  if (!Number.isFinite(sourceSnapshot.modifiedAtMs)
      || sourceSnapshot.modifiedAtMs > options.processStartedAtMs + 2000) {
    throw cliError('MIRROR_SOURCE_ENV_NEWER_THAN_PROCESS');
  }
  return reconstructRuntimeEnvironment({
    processEnvironment,
    fileEnvironment: sourceSnapshot.environment
  });
}

async function runObjectMirrorCli({
  argv = process.argv.slice(2),
  environment = process.env,
  createPool = createPostgresPool,
  closePool = closePostgresPool,
  OssClient = OSS,
  readFileSync = fs.readFileSync,
  readlinkSync = fs.readlinkSync,
  realpathSync = fs.realpathSync,
  writeLine = (line) => process.stdout.write(`${line}\n`)
} = {}) {
  const options = parseArguments(argv);
  const sourceSnapshot = readProtectedEnvironmentSnapshot(options.sourceOssEnv);
  const sourceEnvironment = loadEffectiveSourceEnvironment({
    options,
    fallbackEnvironment: environment,
    sourceSnapshot,
    readFileSync,
    readlinkSync,
    realpathSync
  });
  const destinationEnvironment = readProtectedEnvironment(options.destinationOssEnv);
  if (options.appPid) assertProductionMirrorEnvironment(sourceEnvironment);
  const sourceConfig = readOssConfig(sourceEnvironment);
  const destinationConfig = readOssConfig(destinationEnvironment, 'MIRROR_');
  const sourceClient = new OssClient(sourceConfig);
  const destinationClient = new OssClient(destinationConfig);
  const pool = createPool({ config: readPostgresConfig({
    ...sourceEnvironment,
    PGAPPLICATION_NAME: 'xingxingzaishan-object-mirror',
    PGPOOL_MAX: '2',
    PGSTATEMENT_TIMEOUT_MS: '30000'
  }) });
  try {
    const [sourceIdentity, destinationIdentity, objectKeys] = await Promise.all([
      inspectBucket(sourceClient, sourceConfig.bucket),
      inspectBucket(destinationClient, destinationConfig.bucket),
      listReferencedObjectKeys({ pool })
    ]);
    assertIndependentBuckets(sourceIdentity, destinationIdentity);
    writeLine(`MIRROR_OBJECT_INVENTORY_COUNT=${objectKeys.length}`);
    writeLine('MIRROR_BUCKET_INDEPENDENCE=PASS');
    writeLine('MIRROR_DATABASE_ACCESS=READ_ONLY_REPEATABLE_READ');
    if (options.preflight) {
      writeLine('PRODUCTION_OBJECT_MIRROR_PREFLIGHT=PASS');
      return Object.freeze({ objectKeys, sourceIdentity, destinationIdentity });
    }

    const previousManifest = readLatestPreviousMirrorManifest(options.outputDirectory);
    const mirror = await executeObjectMirror({
      objectKeys,
      sourceClient,
      destinationClient,
      sourceBucket: sourceConfig.bucket,
      destinationBucket: destinationConfig.bucket,
      runId: options.runId,
      outputDirectory: options.outputDirectory,
      previousManifest
    });
    writeLine(`MIRROR_RUN_ID=${mirror.manifest.run_id}`);
    writeLine(`MIRROR_OBJECT_COUNT=${mirror.manifest.object_count}`);
    writeLine(`MIRROR_OBJECTS_COPIED=${mirror.manifest.copied_count}`);
    writeLine(`MIRROR_OBJECTS_REUSED_FROM_LOCAL_MANIFEST=${mirror.manifest.locally_reused_count}`);
    writeLine(`MIRROR_SOURCE_OBJECTS_DOWNLOADED=${mirror.manifest.source_downloaded_count}`);
    writeLine(`MIRROR_INCREMENTAL_BASE_RUN_ID=${mirror.manifest.incremental_base_run_id || 'NONE'}`);
    writeLine(`MIRROR_MANIFEST_OBJECT_KEY=${mirror.manifest.manifest_object_key}`);
    writeLine('MIRROR_DESTINATION_OBJECT_READ=NONE');
    writeLine('MIRROR_WRITE_RECEIPTS_VERIFIED=YES');
    writeLine('MIRROR_INDEPENDENT_RESTORE_AUDIT=REQUIRED');
    writeLine('PRODUCTION_OBJECT_MIRROR_WRITE_ONLY=PASS');
    return Object.freeze({ mirror });
  } finally {
    await closePool(pool);
  }
}

if (require.main === module) {
  runObjectMirrorCli().catch((error) => {
    process.stderr.write(`PRODUCTION_OBJECT_MIRROR_WRITE_ONLY=FAIL\nERROR_CODE=${safeErrorCode(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DESTINATION_OSS_ENV,
  EXPECTED_PRODUCTION_DATABASE,
  SOURCE_OSS_ENV,
  assertProductionMirrorEnvironment,
  loadEffectiveSourceEnvironment,
  parseArguments,
  readLatestPreviousMirrorManifest,
  readOssConfig,
  readProtectedEnvironment,
  readProtectedEnvironmentSnapshot,
  runObjectMirrorCli
};
