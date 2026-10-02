'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  readPostgresConfig,
  redactPostgresConfig
} = require('../../src/server/database/config');
const {
  parseProcessEnvironment,
  readProtectedEnvironmentFile,
  reconstructRuntimeEnvironment
} = require('./validate-running-production-config');

function clientConfigError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function readRunningPostgresClientConfig({
  argv = process.argv.slice(2),
  readFileSync = fs.readFileSync,
  readlinkSync = fs.readlinkSync,
  realpathSync = fs.realpathSync,
  readProtectedEnv = readProtectedEnvironmentFile
} = {}) {
  const pid = String(argv[0] || '');
  const expectedRepository = path.resolve(String(argv[1] || ''));
  const expectedDatabase = String(argv[2] || '');
  const processStartedAtMs = Number(argv[3]);
  if (argv.length !== 4
      || !/^[1-9][0-9]*$/.test(pid)
      || !String(argv[1] || '').trim()
      || !path.isAbsolute(expectedRepository)
      || !/^[A-Za-z0-9_]+$/.test(expectedDatabase)
      || !Number.isSafeInteger(processStartedAtMs)
      || processStartedAtMs <= 0) {
    throw clientConfigError('ARGUMENT_INVALID');
  }

  let processEnvironment;
  try {
    processEnvironment = parseProcessEnvironment(
      readFileSync(path.join('/proc', pid, 'environ'))
    );
  } catch (_error) {
    throw clientConfigError('PROCESS_ENVIRONMENT_UNREADABLE');
  }

  let processWorkingDirectory;
  let repositoryRealPath;
  try {
    processWorkingDirectory = realpathSync(readlinkSync(path.join('/proc', pid, 'cwd')));
    repositoryRealPath = realpathSync(expectedRepository);
  } catch (_error) {
    throw clientConfigError('PROCESS_WORKING_DIRECTORY_UNREADABLE');
  }
  if (processWorkingDirectory !== repositoryRealPath) {
    throw clientConfigError('PROCESS_WORKING_DIRECTORY_UNEXPECTED');
  }

  let protectedEnvironment;
  try {
    protectedEnvironment = readProtectedEnv(path.join(repositoryRealPath, '.env'));
  } catch (error) {
    throw clientConfigError(error && error.code === 'PROTECTED_ENV_FILE_UNSAFE'
      ? error.code
      : 'PROTECTED_ENV_FILE_UNREADABLE');
  }
  if (!Number.isFinite(protectedEnvironment.modifiedAtMs)
      || protectedEnvironment.modifiedAtMs > processStartedAtMs + 2000) {
    throw clientConfigError('PROTECTED_ENV_FILE_NEWER_THAN_PROCESS');
  }

  const environment = reconstructRuntimeEnvironment({
    processEnvironment,
    fileEnvironment: protectedEnvironment.environment
  });
  let config;
  try {
    config = redactPostgresConfig(readPostgresConfig(environment));
  } catch (_error) {
    throw clientConfigError('POSTGRES_CONFIG_INVALID');
  }
  if (!config || config.database !== expectedDatabase) {
    throw clientConfigError('PRODUCTION_DATABASE_UNEXPECTED');
  }
  if (config.host !== '127.0.0.1') {
    throw clientConfigError('POSTGRES_HOST_NOT_LOCAL');
  }
  if (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw clientConfigError('POSTGRES_PORT_INVALID');
  }

  return Object.freeze({
    source: config.source,
    host: config.host,
    port: config.port,
    user: config.user,
    database: config.database,
    passwordFile: String(environment.PGPASSWORD_FILE || '').trim(),
    ssl: config.ssl !== false,
    rejectUnauthorized: config.ssl !== false
      && config.ssl.rejectUnauthorized !== false
  });
}

function run({
  argv = process.argv.slice(2),
  writeOutput = (value) => process.stdout.write(value),
  writeError = (value) => process.stderr.write(value),
  ...dependencies
} = {}) {
  try {
    const backupMode = argv[0] === '--backup';
    const config = readRunningPostgresClientConfig({
      argv: backupMode ? argv.slice(1) : argv,
      ...dependencies
    });
    if (backupMode) {
      if (config.source !== 'discrete'
          || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(config.user || ''))
          || !path.isAbsolute(config.passwordFile)
          || /[|\r\n]/.test(config.passwordFile)) {
        throw clientConfigError('BACKUP_POSTGRES_CONFIG_UNSAFE');
      }
      writeOutput([
        config.host,
        String(config.port),
        config.user,
        config.database,
        config.ssl ? 'require' : 'disable',
        config.passwordFile
      ].join('|'));
    } else {
      writeOutput([
        config.host,
        String(config.port),
        String(config.ssl),
        String(config.rejectUnauthorized)
      ].join('|'));
    }
    return 0;
  } catch (error) {
    const code = /^[A-Z0-9_]+$/.test(String(error && error.code || ''))
      ? error.code
      : 'POSTGRES_CLIENT_CONFIG_READ_FAILED';
    writeError(`RUNNING_POSTGRES_CLIENT_CONFIG=FAIL\nERROR_CODE=${code}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = run();
}

module.exports = {
  readRunningPostgresClientConfig,
  run
};
