'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

const { validateRuntimeConfig } = require('../../src/server/services/configService');

function parseProcessEnvironment(buffer) {
  const environment = Object.create(null);
  for (const entry of Buffer.from(buffer || '').toString('utf8').split('\0')) {
    if (!entry) continue;
    const separator = entry.indexOf('=');
    if (separator < 1) continue;
    environment[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return environment;
}

function validateEnvironmentSnapshot(environment) {
  return validateRuntimeConfig(environment && typeof environment === 'object'
    ? environment
    : Object.create(null));
}

function readProtectedEnvironmentFile(filePath, {
  openSync = fs.openSync,
  fstatSync = fs.fstatSync,
  readFileSync = fs.readFileSync,
  closeSync = fs.closeSync
} = {}) {
  let descriptor;
  try {
    descriptor = openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o777) !== 0o600) {
      const error = new Error('PROTECTED_ENV_FILE_UNSAFE');
      error.code = 'PROTECTED_ENV_FILE_UNSAFE';
      throw error;
    }
    return {
      environment: dotenv.parse(readFileSync(descriptor)),
      modifiedAtMs: Number(stat.mtimeMs)
    };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function reconstructRuntimeEnvironment({ processEnvironment, fileEnvironment }) {
  return {
    ...(fileEnvironment || Object.create(null)),
    ...(processEnvironment || Object.create(null))
  };
}

function runRuntimeConfigCheck({
  argv = process.argv.slice(2),
  readFileSync = fs.readFileSync,
  readlinkSync = fs.readlinkSync,
  realpathSync = fs.realpathSync,
  readProtectedEnv = readProtectedEnvironmentFile,
  writeLine = (line) => process.stdout.write(`${line}\n`)
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
    writeLine('PRODUCTION_RUNTIME_CONFIG=FAIL');
    writeLine('ERROR_CODE=ARGUMENT_INVALID');
    writeLine('SECRET_VALUES_PRINTED=NO');
    return 1;
  }

  let processEnvironment;
  try {
    processEnvironment = parseProcessEnvironment(readFileSync(path.join('/proc', pid, 'environ')));
  } catch (_error) {
    writeLine('PRODUCTION_RUNTIME_CONFIG=FAIL');
    writeLine('ERROR_CODE=PROCESS_ENVIRONMENT_UNREADABLE');
    writeLine('SECRET_VALUES_PRINTED=NO');
    return 1;
  }

  let processWorkingDirectory;
  let repositoryRealPath;
  try {
    processWorkingDirectory = realpathSync(readlinkSync(path.join('/proc', pid, 'cwd')));
    repositoryRealPath = realpathSync(expectedRepository);
  } catch (_error) {
    writeLine('PRODUCTION_RUNTIME_CONFIG=FAIL');
    writeLine('ERROR_CODE=PROCESS_WORKING_DIRECTORY_UNREADABLE');
    writeLine('SECRET_VALUES_PRINTED=NO');
    return 1;
  }
  if (processWorkingDirectory !== repositoryRealPath) {
    writeLine('PRODUCTION_RUNTIME_CONFIG=FAIL');
    writeLine('ERROR_CODE=PROCESS_WORKING_DIRECTORY_UNEXPECTED');
    writeLine('SECRET_VALUES_PRINTED=NO');
    return 1;
  }

  let protectedEnvironment;
  try {
    protectedEnvironment = readProtectedEnv(path.join(repositoryRealPath, '.env'));
  } catch (error) {
    writeLine('PRODUCTION_RUNTIME_CONFIG=FAIL');
    writeLine(`ERROR_CODE=${error && error.code === 'PROTECTED_ENV_FILE_UNSAFE'
      ? error.code
      : 'PROTECTED_ENV_FILE_UNREADABLE'}`);
    writeLine('SECRET_VALUES_PRINTED=NO');
    return 1;
  }
  if (!Number.isFinite(protectedEnvironment.modifiedAtMs)
      || protectedEnvironment.modifiedAtMs > processStartedAtMs + 2000) {
    writeLine('PRODUCTION_RUNTIME_CONFIG=FAIL');
    writeLine('ERROR_CODE=PROTECTED_ENV_FILE_NEWER_THAN_PROCESS');
    writeLine('SECRET_VALUES_PRINTED=NO');
    return 1;
  }

  const environment = reconstructRuntimeEnvironment({
    processEnvironment,
    fileEnvironment: protectedEnvironment.environment
  });
  if (String(environment.PGDATABASE || '') !== expectedDatabase) {
    writeLine('PRODUCTION_RUNTIME_CONFIG=FAIL');
    writeLine('ERROR_CODE=PRODUCTION_DATABASE_UNEXPECTED');
    writeLine('SECRET_VALUES_PRINTED=NO');
    return 1;
  }

  const result = validateEnvironmentSnapshot(environment);
  if (result.errors.length > 0) {
    writeLine('PRODUCTION_RUNTIME_CONFIG=FAIL');
    result.errors.forEach((message, index) => {
      writeLine(`CONFIG_ERROR_${index + 1}=${message}`);
    });
    writeLine('SECRET_VALUES_PRINTED=NO');
    return 1;
  }

  writeLine(`CONFIG_WARNING_COUNT=${result.warnings.length}`);
  writeLine('PRODUCTION_DATABASE=PASS_EXPECTED');
  writeLine('PROTECTED_ENV_FILE=PASS_ROOT_ROOT_0600');
  writeLine('PROTECTED_ENV_FILE_PREDATES_PROCESS=YES');
  writeLine('PRODUCTION_RUNTIME_CONFIG=PASS');
  writeLine('SECRET_VALUES_PRINTED=NO');
  return 0;
}

if (require.main === module) {
  process.exitCode = runRuntimeConfigCheck();
}

module.exports = {
  parseProcessEnvironment,
  readProtectedEnvironmentFile,
  reconstructRuntimeEnvironment,
  runRuntimeConfigCheck,
  validateEnvironmentSnapshot
};
