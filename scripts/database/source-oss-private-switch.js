#!/usr/bin/env node
'use strict';

const path = require('node:path');

function switchError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeErrorCode(error) {
  const code = String(error && error.code || '');
  return /^SOURCE_OSS_PRIVATE_SWITCH_[A-Z0-9_]+$/.test(code)
    ? code
    : 'SOURCE_OSS_PRIVATE_SWITCH_UNEXPECTED_FAILURE';
}

function normalizeAcl(value) {
  const acl = String(value || '').trim().toLowerCase();
  if (acl === 'private' || acl === 'public-read') return acl;
  throw switchError('SOURCE_OSS_PRIVATE_SWITCH_ACL_UNEXPECTED');
}

function parseArguments(argv) {
  const options = {
    mode: '',
    repository: '',
    appPid: '',
    processStartedAtMs: 0
  };
  for (const argument of argv) {
    if (argument === '--preflight') {
      if (options.mode) throw switchError('SOURCE_OSS_PRIVATE_SWITCH_ARGUMENT_INVALID');
      options.mode = 'preflight';
      continue;
    }
    if (argument === '--authorize-private=YES') {
      if (options.mode) throw switchError('SOURCE_OSS_PRIVATE_SWITCH_ARGUMENT_INVALID');
      options.mode = 'private';
      continue;
    }
    if (argument === '--authorize-rollback-public-read=YES') {
      if (options.mode) throw switchError('SOURCE_OSS_PRIVATE_SWITCH_ARGUMENT_INVALID');
      options.mode = 'public-read';
      continue;
    }
    const match = /^--([a-z-]+)=(.+)$/.exec(argument);
    if (!match) throw switchError('SOURCE_OSS_PRIVATE_SWITCH_ARGUMENT_INVALID');
    const [, name, value] = match;
    if (name === 'repository') options.repository = path.resolve(value);
    else if (name === 'app-pid') options.appPid = value;
    else if (name === 'process-started-at-ms') options.processStartedAtMs = Number(value);
    else throw switchError('SOURCE_OSS_PRIVATE_SWITCH_ARGUMENT_INVALID');
  }
  if (!options.mode
      || !path.isAbsolute(options.repository)
      || !/^[1-9][0-9]*$/.test(options.appPid)
      || !Number.isSafeInteger(options.processStartedAtMs)
      || options.processStartedAtMs <= 0) {
    throw switchError('SOURCE_OSS_PRIVATE_SWITCH_ARGUMENT_INVALID');
  }
  return Object.freeze(options);
}

async function readBucketAcl(client, bucket) {
  if (!client || typeof client.getBucketACL !== 'function') {
    throw switchError('SOURCE_OSS_PRIVATE_SWITCH_ACL_READER_UNAVAILABLE');
  }
  try {
    const result = await client.getBucketACL(bucket);
    return normalizeAcl(result && result.acl);
  } catch (error) {
    if (String(error && error.code || '').startsWith('SOURCE_OSS_PRIVATE_SWITCH_')) {
      throw error;
    }
    throw switchError('SOURCE_OSS_PRIVATE_SWITCH_ACL_READ_FAILED');
  }
}

async function changeBucketAcl({ client, bucket, mode }) {
  const before = await readBucketAcl(client, bucket);
  if (mode === 'preflight') {
    if (before !== 'public-read') {
      throw switchError(before === 'private'
        ? 'SOURCE_OSS_PRIVATE_SWITCH_ALREADY_PRIVATE'
        : 'SOURCE_OSS_PRIVATE_SWITCH_ACL_UNEXPECTED');
    }
    return Object.freeze({ before, after: before, changed: false });
  }

  const target = mode === 'private' ? 'private' : 'public-read';
  const expectedBefore = mode === 'private' ? 'public-read' : 'private';
  if (before !== expectedBefore) {
    throw switchError(mode === 'private'
      ? 'SOURCE_OSS_PRIVATE_SWITCH_SOURCE_NOT_PUBLIC_READ'
      : 'SOURCE_OSS_PRIVATE_SWITCH_SOURCE_NOT_PRIVATE');
  }
  if (!client || typeof client.putBucketACL !== 'function') {
    throw switchError('SOURCE_OSS_PRIVATE_SWITCH_ACL_WRITER_UNAVAILABLE');
  }
  try {
    await client.putBucketACL(bucket, target);
  } catch (_error) {
    throw switchError('SOURCE_OSS_PRIVATE_SWITCH_ACL_WRITE_FAILED');
  }
  const after = await readBucketAcl(client, bucket);
  if (after !== target) {
    throw switchError('SOURCE_OSS_PRIVATE_SWITCH_ACL_POSTCHECK_FAILED');
  }
  return Object.freeze({ before, after, changed: true });
}

async function runSourceOssPrivateSwitch({
  argv = process.argv.slice(2),
  environment = process.env,
  dependencies = null,
  writeLine = (line) => process.stdout.write(`${line}\n`)
} = {}) {
  const options = parseArguments(argv);
  const load = (relativePath) => require(path.join(options.repository, relativePath));
  const deps = dependencies || {
    OSS: require(path.join(options.repository, 'node_modules', 'ali-oss')),
    mirrorCli: load('scripts/database/production-object-mirror-cli.js')
  };
  const sourceEnvPath = path.join(options.repository, '.env');
  const sourceSnapshot = deps.mirrorCli.readProtectedEnvironmentSnapshot(sourceEnvPath);
  const sourceEnvironment = deps.mirrorCli.loadEffectiveSourceEnvironment({
    options: {
      appPid: options.appPid,
      processStartedAtMs: options.processStartedAtMs,
      sourceOssEnv: sourceEnvPath
    },
    fallbackEnvironment: environment,
    sourceSnapshot
  });
  deps.mirrorCli.assertProductionMirrorEnvironment(sourceEnvironment);
  const sourceConfig = deps.mirrorCli.readOssConfig(sourceEnvironment);
  const client = new deps.OSS(sourceConfig);
  const result = await changeBucketAcl({
    client,
    bucket: sourceConfig.bucket,
    mode: options.mode
  });

  writeLine(`SOURCE_OSS_ACL_BEFORE=${result.before.toUpperCase().replace('-', '_')}`);
  writeLine(`SOURCE_OSS_ACL_AFTER=${result.after.toUpperCase().replace('-', '_')}`);
  writeLine(`SOURCE_OSS_ACL_CHANGED=${result.changed ? 'YES' : 'NO'}`);
  writeLine(options.mode === 'preflight'
    ? 'SOURCE_OSS_PRIVATE_SWITCH_CLI_PREFLIGHT=PASS'
    : options.mode === 'private'
      ? 'SOURCE_OSS_PRIVATE_SWITCH_CLI=PASS'
      : 'SOURCE_OSS_PUBLIC_READ_ROLLBACK_CLI=PASS');
  writeLine('DATABASE_WRITE=NONE');
  writeLine('JSON_WRITE=NONE');
  writeLine('APPLICATION_RESTART=NO');
  writeLine('SECRET_VALUES_PRINTED=NO');
  return result;
}

if (require.main === module) {
  runSourceOssPrivateSwitch().catch((error) => {
    process.stderr.write('PRODUCTION_SOURCE_OSS_PRIVATE_SWITCH=FAIL\n');
    process.stderr.write(`ERROR_CODE=${safeErrorCode(error)}\n`);
    process.stderr.write('SECRET_VALUES_PRINTED=NO\n');
    process.exitCode = 1;
  });
}

module.exports = {
  changeBucketAcl,
  normalizeAcl,
  parseArguments,
  readBucketAcl,
  runSourceOssPrivateSwitch,
  safeErrorCode
};
