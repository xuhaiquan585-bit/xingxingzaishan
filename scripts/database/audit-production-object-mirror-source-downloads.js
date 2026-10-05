#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const EXPECTED_PRODUCTION_DATABASE = 'xingxing_clean_baseline_20260812_staging';
const DEFAULT_CONCURRENCY = 8;
const CATEGORY_NAMES = Object.freeze([
  'HEAD_NOT_FOUND',
  'HEAD_FORBIDDEN',
  'HEAD_TIMEOUT',
  'HEAD_TRANSPORT',
  'HEAD_UPSTREAM',
  'HEAD_RESPONSE_INVALID',
  'HEAD_UNKNOWN',
  'GET_NOT_FOUND',
  'GET_FORBIDDEN',
  'GET_TIMEOUT',
  'GET_TRANSPORT',
  'GET_UPSTREAM',
  'GET_RESPONSE_INVALID',
  'GET_UNKNOWN',
  'SIZE_MISMATCH'
]);

function auditError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeErrorCode(error) {
  const code = String(error && error.code || '');
  return /^SOURCE_DOWNLOAD_AUDIT_[A-Z0-9_]+$/.test(code)
    ? code
    : 'SOURCE_DOWNLOAD_AUDIT_UNEXPECTED_FAILURE';
}

function parseArguments(argv) {
  const options = {
    check: false,
    repository: '',
    appPid: '',
    processStartedAtMs: 0
  };
  for (const argument of argv) {
    if (argument === '--check') {
      options.check = true;
      continue;
    }
    const match = /^--([a-z-]+)=(.+)$/.exec(argument);
    if (!match) throw auditError('SOURCE_DOWNLOAD_AUDIT_ARGUMENT_INVALID');
    const [, name, value] = match;
    if (name === 'repository') options.repository = path.resolve(value);
    else if (name === 'app-pid') options.appPid = value;
    else if (name === 'process-started-at-ms') options.processStartedAtMs = Number(value);
    else throw auditError('SOURCE_DOWNLOAD_AUDIT_ARGUMENT_INVALID');
  }
  if (!options.check
      || !path.isAbsolute(options.repository)
      || !/^[1-9][0-9]*$/.test(options.appPid)
      || !Number.isSafeInteger(options.processStartedAtMs)
      || options.processStartedAtMs <= 0) {
    throw auditError('SOURCE_DOWNLOAD_AUDIT_ARGUMENT_INVALID');
  }
  return Object.freeze(options);
}

function responseHeaders(result) {
  const headers = result?.res?.headers || result?.headers || {};
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [String(key).toLowerCase(), value])
  );
}

function errorStatus(error) {
  return Number(
    error?.status
      || error?.statusCode
      || error?.res?.status
      || error?.response?.status
      || 0
  );
}

function classifySourceReadFailure(error, phase) {
  const prefix = phase === 'head' ? 'HEAD' : 'GET';
  const status = errorStatus(error);
  const code = String(error && error.code || '').trim().toUpperCase();
  if (status === 404 || ['NOSUCHKEY', 'NO_SUCH_KEY'].includes(code)) {
    return `${prefix}_NOT_FOUND`;
  }
  if (status === 401 || status === 403 || ['ACCESSDENIED', 'ACCESS_DENIED'].includes(code)) {
    return `${prefix}_FORBIDDEN`;
  }
  if (status === 408 || status === 504
      || ['CONNECTIONTIMEOUTERROR', 'ETIMEDOUT', 'TIMEOUT'].includes(code)) {
    return `${prefix}_TIMEOUT`;
  }
  if (['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'REQUESTERROR']
    .includes(code)) {
    return `${prefix}_TRANSPORT`;
  }
  if (status >= 500 && status <= 599) return `${prefix}_UPSTREAM`;
  if (code === 'SOURCE_DOWNLOAD_AUDIT_RESPONSE_INVALID') {
    return `${prefix}_RESPONSE_INVALID`;
  }
  return `${prefix}_UNKNOWN`;
}

async function auditSourceObject({ objectKey, client }) {
  let expectedSize;
  try {
    const head = await client.head(objectKey);
    const status = Number(head?.status || head?.res?.status || 0);
    const headers = responseHeaders(head);
    expectedSize = Number(headers['content-length']);
    if (status !== 200 || !Number.isSafeInteger(expectedSize) || expectedSize <= 0) {
      throw auditError('SOURCE_DOWNLOAD_AUDIT_RESPONSE_INVALID');
    }
  } catch (error) {
    return Object.freeze({ ok: false, category: classifySourceReadFailure(error, 'head') });
  }

  let receivedSize = 0;
  try {
    const result = await client.getStream(objectKey);
    const status = Number(result?.status || result?.res?.status || 0);
    if (status !== 200 || !result?.stream || typeof result.stream.pipe !== 'function') {
      throw auditError('SOURCE_DOWNLOAD_AUDIT_RESPONSE_INVALID');
    }
    await pipeline(result.stream, new Writable({
      write(chunk, _encoding, callback) {
        receivedSize += chunk.length;
        callback();
      }
    }));
  } catch (error) {
    return Object.freeze({ ok: false, category: classifySourceReadFailure(error, 'get') });
  }

  if (receivedSize !== expectedSize) {
    return Object.freeze({ ok: false, category: 'SIZE_MISMATCH' });
  }
  return Object.freeze({ ok: true, category: 'PASS' });
}

async function auditSourceDownloads({ objectKeys, client, concurrency = DEFAULT_CONCURRENCY }) {
  if (!Array.isArray(objectKeys) || objectKeys.length < 1) {
    throw auditError('SOURCE_DOWNLOAD_AUDIT_INVENTORY_INVALID');
  }
  if (!client || typeof client.head !== 'function' || typeof client.getStream !== 'function') {
    throw auditError('SOURCE_DOWNLOAD_AUDIT_CLIENT_INVALID');
  }
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw auditError('SOURCE_DOWNLOAD_AUDIT_CONCURRENCY_INVALID');
  }

  const counts = Object.fromEntries(CATEGORY_NAMES.map((name) => [name, 0]));
  let success = 0;
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= objectKeys.length) return;
      const result = await auditSourceObject({ objectKey: objectKeys[index], client });
      if (result.ok) success += 1;
      else counts[result.category] += 1;
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(concurrency, objectKeys.length) },
    () => worker()
  ));
  return Object.freeze({
    total: objectKeys.length,
    success,
    failure: objectKeys.length - success,
    concurrency,
    counts: Object.freeze(counts)
  });
}

function printAuditSummary(result, writeLine) {
  writeLine(`SOURCE_DOWNLOAD_AUDIT_TOTAL=${result.total}`);
  writeLine(`SOURCE_DOWNLOAD_AUDIT_SUCCESS=${result.success}`);
  writeLine(`SOURCE_DOWNLOAD_AUDIT_FAILURE=${result.failure}`);
  writeLine(`SOURCE_DOWNLOAD_AUDIT_CONCURRENCY=${result.concurrency}`);
  for (const name of CATEGORY_NAMES) {
    writeLine(`SOURCE_DOWNLOAD_AUDIT_${name}=${result.counts[name]}`);
  }
  writeLine(`SOURCE_DOWNLOAD_AUDIT_RESULT=${result.failure === 0
    ? 'PASS_ALL_READABLE'
    : 'FAILURES_CLASSIFIED'}`);
}

function loadRepositoryDependencies(repository) {
  const fromRepository = (...segments) => require(path.join(repository, ...segments));
  return Object.freeze({
    OSS: fromRepository('node_modules', 'ali-oss'),
    databaseConfig: fromRepository('src', 'server', 'database', 'config.js'),
    databaseConnection: fromRepository('src', 'server', 'database', 'connection.js'),
    mirror: fromRepository('scripts', 'database', 'production-object-mirror.js'),
    mirrorCli: fromRepository('scripts', 'database', 'production-object-mirror-cli.js')
  });
}

async function runSourceDownloadAudit({
  argv = process.argv.slice(2),
  environment = process.env,
  dependencies = null,
  writeLine = (line) => process.stdout.write(`${line}\n`)
} = {}) {
  const options = parseArguments(argv);
  const deps = dependencies || loadRepositoryDependencies(options.repository);
  const sourceOssEnv = path.join(options.repository, '.env');
  const sourceSnapshot = deps.mirrorCli.readProtectedEnvironmentSnapshot(sourceOssEnv);
  const sourceEnvironment = deps.mirrorCli.loadEffectiveSourceEnvironment({
    options: {
      appPid: options.appPid,
      processStartedAtMs: options.processStartedAtMs,
      sourceOssEnv
    },
    fallbackEnvironment: environment,
    sourceSnapshot
  });
  deps.mirrorCli.assertProductionMirrorEnvironment(sourceEnvironment);
  const sourceConfig = deps.mirrorCli.readOssConfig(sourceEnvironment);
  const sourceClient = new deps.OSS(sourceConfig);
  const sourceIdentity = await deps.mirror.inspectBucket(sourceClient, sourceConfig.bucket);
  if (sourceIdentity.acl !== 'private') {
    throw auditError('SOURCE_DOWNLOAD_AUDIT_SOURCE_NOT_PRIVATE');
  }

  const pool = deps.databaseConnection.createPostgresPool({
    config: deps.databaseConfig.readPostgresConfig({
      ...sourceEnvironment,
      PGAPPLICATION_NAME: 'xingxingzaishan-object-mirror-source-download-audit',
      PGPOOL_MAX: '2',
      PGSTATEMENT_TIMEOUT_MS: '30000'
    })
  });
  let objectKeys;
  try {
    objectKeys = await deps.mirror.listReferencedObjectKeys({ pool });
  } finally {
    await deps.databaseConnection.closePostgresPool(pool);
  }
  const result = await auditSourceDownloads({ objectKeys, client: sourceClient });
  writeLine(`SOURCE_DOWNLOAD_AUDIT_INVENTORY_COUNT=${objectKeys.length}`);
  writeLine('SOURCE_DOWNLOAD_AUDIT_SOURCE_ACL=PRIVATE');
  writeLine('SOURCE_DOWNLOAD_AUDIT_DATABASE_ACCESS=READ_ONLY_REPEATABLE_READ');
  printAuditSummary(result, writeLine);
  writeLine('PRODUCTION_DATABASE_WRITE=NONE');
  writeLine('OSS_REQUESTS=SOURCE_GET_BUCKET_INFO_HEAD_AND_GET_ONLY');
  writeLine('DESTINATION_OSS_REQUESTS=NONE');
  writeLine('APPLICATION_RESTART=NO');
  writeLine('CONFIGURATION_WRITE=NONE');
  writeLine('OBJECT_KEYS_PRINTED=NO');
  writeLine('URLS_PRINTED=NO');
  writeLine('SECRET_VALUES_PRINTED=NO');
  writeLine('PRODUCTION_OBJECT_MIRROR_SOURCE_DOWNLOAD_AUDIT=COLLECTED');
  return result;
}

if (require.main === module) {
  runSourceDownloadAudit().catch((error) => {
    process.stderr.write('PRODUCTION_OBJECT_MIRROR_SOURCE_DOWNLOAD_AUDIT=FAIL\n');
    process.stderr.write(`ERROR_CODE=${safeErrorCode(error)}\n`);
    process.stderr.write('OBJECT_KEYS_PRINTED=NO\n');
    process.stderr.write('SECRET_VALUES_PRINTED=NO\n');
    process.exitCode = 1;
  });
}

module.exports = {
  CATEGORY_NAMES,
  auditSourceDownloads,
  auditSourceObject,
  classifySourceReadFailure,
  parseArguments,
  printAuditSummary,
  runSourceDownloadAudit,
  safeErrorCode
};
