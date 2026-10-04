#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const EXPECTED_PRODUCTION_DATABASE = 'xingxing_clean_baseline_20260812_staging';
const MAX_JSON_DATABASE_BYTES = 64 * 1024 * 1024;
const BACKUP_ROOT = '/root/production-source-oss-logo-remediation';

function remediationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeErrorCode(error) {
  const code = String(error && error.code || '');
  return /^SOURCE_OSS_LOGO_REMEDIATION_[A-Z0-9_]+$/.test(code)
    ? code
    : 'SOURCE_OSS_LOGO_REMEDIATION_UNEXPECTED_FAILURE';
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeBaseUrl(value) {
  const text = normalizeText(value);
  if (!text) return null;
  try {
    const parsed = new URL(text);
    if (!['http:', 'https:'].includes(parsed.protocol)
        || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return Object.freeze({
      origin: parsed.origin,
      pathname: parsed.pathname.replace(/\/+$/, '')
    });
  } catch (_error) {
    return null;
  }
}

function sourceUrlMatchers(environment, sourceConfig) {
  const matchers = [];
  const publicBase = normalizeBaseUrl(environment.CLOUD_PUBLIC_BASE_URL);
  if (publicBase) {
    matchers.push({ ...publicBase, prefixBounded: true });
    const alternateProtocol = publicBase.origin.startsWith('https://') ? 'http://' : 'https://';
    matchers.push({
      ...publicBase,
      origin: publicBase.origin.replace(/^https?:\/\//, alternateProtocol),
      prefixBounded: true
    });
  }
  const endpoint = normalizeText(sourceConfig.endpoint)
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
  const bucket = normalizeText(sourceConfig.bucket);
  if (endpoint && bucket) {
    for (const protocol of ['https:', 'http:']) {
      matchers.push({
        origin: `${protocol}//${bucket}.${endpoint}`,
        pathname: '',
        prefixBounded: false
      });
    }
  }
  return Object.freeze(matchers);
}

function classifyUrlReference(value, matchers) {
  const text = normalizeText(value);
  if (!text) return 'empty';
  if (text.startsWith('/') && !text.startsWith('//')) return 'relative_local';
  let parsed;
  try {
    parsed = new URL(text);
  } catch (_error) {
    return 'invalid';
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    return 'invalid';
  }
  const source = matchers.some((matcher) => {
    if (parsed.origin !== matcher.origin) return false;
    if (!matcher.prefixBounded || !matcher.pathname) return true;
    return parsed.pathname === matcher.pathname
      || parsed.pathname.startsWith(`${matcher.pathname}/`);
  });
  return source ? 'source_public_direct' : 'external_absolute';
}

function resolveJsonDatabasePath(repository, environment) {
  const configured = normalizeText(environment && environment.DB_FILE);
  return Object.freeze({
    filePath: configured
      ? (path.isAbsolute(configured) ? configured : path.resolve(repository, configured))
      : path.join(repository, 'src', 'server', 'data', 'db.json'),
    source: configured ? 'EXPLICIT_DB_FILE' : 'RUNTIME_DEFAULT'
  });
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseArguments(argv) {
  const options = {
    mode: '',
    repository: '',
    appPid: '',
    processStartedAtMs: 0,
    backupDirectory: ''
  };
  for (const argument of argv) {
    if (argument === '--preflight') {
      if (options.mode) throw remediationError('SOURCE_OSS_LOGO_REMEDIATION_ARGUMENT_INVALID');
      options.mode = 'preflight';
      continue;
    }
    if (argument === '--authorize-remediate=YES') {
      if (options.mode) throw remediationError('SOURCE_OSS_LOGO_REMEDIATION_ARGUMENT_INVALID');
      options.mode = 'authorized';
      continue;
    }
    const match = /^--([a-z-]+)=(.+)$/.exec(argument);
    if (!match) throw remediationError('SOURCE_OSS_LOGO_REMEDIATION_ARGUMENT_INVALID');
    const [, name, value] = match;
    if (name === 'repository') options.repository = path.resolve(value);
    else if (name === 'app-pid') options.appPid = value;
    else if (name === 'process-started-at-ms') options.processStartedAtMs = Number(value);
    else if (name === 'backup-directory') options.backupDirectory = path.resolve(value);
    else throw remediationError('SOURCE_OSS_LOGO_REMEDIATION_ARGUMENT_INVALID');
  }
  if (!options.mode
      || !path.isAbsolute(options.repository)
      || !/^[1-9][0-9]*$/.test(options.appPid)
      || !Number.isSafeInteger(options.processStartedAtMs)
      || options.processStartedAtMs <= 0) {
    throw remediationError('SOURCE_OSS_LOGO_REMEDIATION_ARGUMENT_INVALID');
  }
  if (options.mode === 'authorized') {
    const relative = path.relative(BACKUP_ROOT, options.backupDirectory);
    if (!options.backupDirectory
        || relative.startsWith('..')
        || path.isAbsolute(relative)
        || !relative) {
      throw remediationError('SOURCE_OSS_LOGO_REMEDIATION_BACKUP_PATH_INVALID');
    }
  } else if (options.backupDirectory) {
    throw remediationError('SOURCE_OSS_LOGO_REMEDIATION_ARGUMENT_INVALID');
  }
  return Object.freeze(options);
}

function readJsonSnapshot(filePath, fileSystem = fs) {
  if (!path.isAbsolute(filePath)) {
    throw remediationError('SOURCE_OSS_LOGO_REMEDIATION_JSON_PATH_INVALID');
  }
  let descriptor;
  try {
    descriptor = fileSystem.openSync(
      filePath,
      fileSystem.constants.O_RDONLY | (fileSystem.constants.O_NOFOLLOW || 0)
    );
    const stat = fileSystem.fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_JSON_DATABASE_BYTES) {
      throw remediationError('SOURCE_OSS_LOGO_REMEDIATION_JSON_FILE_INVALID');
    }
    const raw = fileSystem.readFileSync(descriptor, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)
        || !data.miniapp_content
        || typeof data.miniapp_content !== 'object'
        || Array.isArray(data.miniapp_content)) {
      throw remediationError('SOURCE_OSS_LOGO_REMEDIATION_JSON_SCHEMA_INVALID');
    }
    return Object.freeze({ raw, data, hash: sha256(raw), stat });
  } catch (error) {
    if (String(error && error.code || '').startsWith('SOURCE_OSS_LOGO_REMEDIATION_')) {
      throw error;
    }
    throw remediationError('SOURCE_OSS_LOGO_REMEDIATION_JSON_READ_FAILED');
  } finally {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
  }
}

function fsyncDirectory(directory, fileSystem = fs) {
  if (process.platform === 'win32') return false;
  let descriptor;
  try {
    descriptor = fileSystem.openSync(directory, 'r');
    fileSystem.fsyncSync(descriptor);
    return true;
  } catch (_error) {
    return false;
  } finally {
    if (descriptor !== undefined) {
      try { fileSystem.closeSync(descriptor); } catch (_closeError) {}
    }
  }
}

function writeFileAtomicallyIfUnchanged({
  filePath,
  expectedHash,
  content,
  stat,
  fileSystem = fs
}) {
  const current = fileSystem.readFileSync(filePath, 'utf8');
  if (sha256(current) !== expectedHash) {
    throw remediationError('SOURCE_OSS_LOGO_REMEDIATION_JSON_WRITE_CONFLICT');
  }
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );
  let descriptor;
  try {
    descriptor = fileSystem.openSync(temporary, 'wx', stat.mode & 0o777);
    fileSystem.writeFileSync(descriptor, content, { encoding: 'utf8' });
    if (process.platform !== 'win32' && typeof fileSystem.fchownSync === 'function') {
      fileSystem.fchownSync(descriptor, stat.uid, stat.gid);
    }
    fileSystem.fchmodSync(descriptor, stat.mode & 0o777);
    fileSystem.fsyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptor = undefined;
    if (sha256(fileSystem.readFileSync(filePath, 'utf8')) !== expectedHash) {
      throw remediationError('SOURCE_OSS_LOGO_REMEDIATION_JSON_WRITE_CONFLICT');
    }
    fileSystem.renameSync(temporary, filePath);
    fsyncDirectory(path.dirname(filePath), fileSystem);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fileSystem.closeSync(descriptor); } catch (_closeError) {}
    }
    try { fileSystem.unlinkSync(temporary); } catch (_unlinkError) {}
    throw error;
  }
}

function validateLogoReferences({ jsonLogo, postgresLogo, matchers }) {
  const normalizedJson = normalizeText(jsonLogo);
  const normalizedPostgres = normalizeText(postgresLogo);
  if (!normalizedJson || !normalizedPostgres) {
    throw remediationError('SOURCE_OSS_LOGO_REMEDIATION_REFERENCE_MISSING');
  }
  if (normalizedJson !== normalizedPostgres) {
    throw remediationError('SOURCE_OSS_LOGO_REMEDIATION_REFERENCE_MISMATCH');
  }
  if (classifyUrlReference(normalizedJson, matchers) !== 'source_public_direct') {
    throw remediationError('SOURCE_OSS_LOGO_REMEDIATION_REFERENCE_NOT_SOURCE_PUBLIC');
  }
  return normalizedJson;
}

async function readPostgresLogo({ pool, withTransaction, forUpdate = false }) {
  return withTransaction(pool, async (context) => {
    const result = await context.query(`/* source-oss-logo-remediation:read */
      SELECT logo_image FROM app.miniapp_content WHERE id = 1${forUpdate ? ' FOR UPDATE' : ''}`);
    if (!result || !Array.isArray(result.rows) || result.rows.length !== 1) {
      throw remediationError('SOURCE_OSS_LOGO_REMEDIATION_POSTGRES_ROW_INVALID');
    }
    return result.rows[0].logo_image;
  }, {
    isolationLevel: forUpdate ? 'serializable' : 'repeatable read',
    readOnly: !forUpdate
  });
}

function writePrivateBackup({ backupDirectory, jsonSnapshot, postgresLogo, fileSystem = fs }) {
  fileSystem.mkdirSync(backupDirectory, { recursive: false, mode: 0o700 });
  fileSystem.writeFileSync(
    path.join(backupDirectory, 'db.json.before'),
    jsonSnapshot.raw,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' }
  );
  fileSystem.writeFileSync(
    path.join(backupDirectory, 'postgres-logo-reference.before'),
    postgresLogo,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' }
  );
  fileSystem.writeFileSync(
    path.join(backupDirectory, 'manifest.json'),
    JSON.stringify({
      json_sha256: jsonSnapshot.hash,
      postgres_logo_sha256: sha256(postgresLogo)
    }, null, 2),
    { encoding: 'utf8', mode: 0o600, flag: 'wx' }
  );
  fsyncDirectory(backupDirectory, fileSystem);
}

async function applyRemediation({
  pool,
  withTransaction,
  jsonFile,
  jsonSnapshot,
  expectedLogo,
  fileSystem = fs
}) {
  const nextData = JSON.parse(jsonSnapshot.raw);
  nextData.miniapp_content.logo_image = '';
  const nextRaw = JSON.stringify(nextData, null, 2);
  let jsonWritten = false;
  try {
    await withTransaction(pool, async (context) => {
      const locked = await context.query(`/* source-oss-logo-remediation:lock */
        SELECT logo_image FROM app.miniapp_content WHERE id = 1 FOR UPDATE`);
      if (!locked || !Array.isArray(locked.rows) || locked.rows.length !== 1
          || normalizeText(locked.rows[0].logo_image) !== expectedLogo) {
        throw remediationError('SOURCE_OSS_LOGO_REMEDIATION_POSTGRES_WRITE_CONFLICT');
      }
      const updated = await context.query(`/* source-oss-logo-remediation:update */
        UPDATE app.miniapp_content SET logo_image = ''
        WHERE id = 1 AND logo_image = $1 RETURNING id`, [expectedLogo]);
      if (!updated || updated.rowCount !== 1) {
        throw remediationError('SOURCE_OSS_LOGO_REMEDIATION_POSTGRES_UPDATE_FAILED');
      }
      writeFileAtomicallyIfUnchanged({
        filePath: jsonFile,
        expectedHash: jsonSnapshot.hash,
        content: nextRaw,
        stat: jsonSnapshot.stat,
        fileSystem
      });
      jsonWritten = true;
    }, { isolationLevel: 'serializable', readOnly: false });
  } catch (error) {
    if (jsonWritten) {
      try {
        writeFileAtomicallyIfUnchanged({
          filePath: jsonFile,
          expectedHash: sha256(nextRaw),
          content: jsonSnapshot.raw,
          stat: jsonSnapshot.stat,
          fileSystem
        });
      } catch (_rollbackError) {
        throw remediationError('SOURCE_OSS_LOGO_REMEDIATION_JSON_ROLLBACK_FAILED');
      }
    }
    throw error;
  }
  return Object.freeze({ nextHash: sha256(nextRaw), nextRaw });
}

async function rollbackCommittedRemediation({
  pool,
  withTransaction,
  jsonFile,
  jsonSnapshot,
  remediatedSnapshot,
  expectedLogo,
  fileSystem = fs
}) {
  let jsonRestored = false;
  try {
    await withTransaction(pool, async (context) => {
      const locked = await context.query(`/* source-oss-logo-remediation:rollback-lock */
        SELECT logo_image FROM app.miniapp_content WHERE id = 1 FOR UPDATE`);
      if (!locked || !Array.isArray(locked.rows) || locked.rows.length !== 1
          || normalizeText(locked.rows[0].logo_image)) {
        throw remediationError('SOURCE_OSS_LOGO_REMEDIATION_ROLLBACK_CONFLICT');
      }
      const updated = await context.query(`/* source-oss-logo-remediation:rollback-update */
        UPDATE app.miniapp_content SET logo_image = $1
        WHERE id = 1 AND logo_image = '' RETURNING id`, [expectedLogo]);
      if (!updated || updated.rowCount !== 1) {
        throw remediationError('SOURCE_OSS_LOGO_REMEDIATION_ROLLBACK_UPDATE_FAILED');
      }
      writeFileAtomicallyIfUnchanged({
        filePath: jsonFile,
        expectedHash: remediatedSnapshot.nextHash,
        content: jsonSnapshot.raw,
        stat: jsonSnapshot.stat,
        fileSystem
      });
      jsonRestored = true;
    }, { isolationLevel: 'serializable', readOnly: false });
  } catch (_error) {
    if (jsonRestored) {
      try {
        writeFileAtomicallyIfUnchanged({
          filePath: jsonFile,
          expectedHash: jsonSnapshot.hash,
          content: remediatedSnapshot.nextRaw,
          stat: jsonSnapshot.stat,
          fileSystem
        });
      } catch (_restoreError) {}
    }
    throw remediationError('SOURCE_OSS_LOGO_REMEDIATION_ROLLBACK_FAILED');
  }
}

async function runRemediation({
  argv = process.argv.slice(2),
  writeLine = (line) => process.stdout.write(`${line}\n`),
  dependencies = null
} = {}) {
  const options = parseArguments(argv);
  const repository = options.repository;
  const load = (relativePath) => require(path.join(repository, relativePath));
  const deps = dependencies || {
    mirrorCli: load('scripts/database/production-object-mirror-cli.js'),
    databaseConfig: load('src/server/database/config.js'),
    databaseConnection: load('src/server/database/connection.js'),
    transaction: load('src/server/database/transaction.js'),
    fileSystem: fs
  };
  const fileSystem = deps.fileSystem || fs;
  const envPath = path.join(repository, '.env');
  const sourceSnapshot = deps.mirrorCli.readProtectedEnvironmentSnapshot(envPath);
  const environment = deps.mirrorCli.loadEffectiveSourceEnvironment({
    options: {
      appPid: options.appPid,
      processStartedAtMs: options.processStartedAtMs,
      sourceOssEnv: envPath
    },
    fallbackEnvironment: process.env,
    sourceSnapshot
  });
  deps.mirrorCli.assertProductionMirrorEnvironment(environment);
  if (normalizeText(environment.PGDATABASE) !== EXPECTED_PRODUCTION_DATABASE) {
    throw remediationError('SOURCE_OSS_LOGO_REMEDIATION_DATABASE_UNEXPECTED');
  }
  const sourceConfig = deps.mirrorCli.readOssConfig(environment);
  const matchers = sourceUrlMatchers(environment, sourceConfig);
  if (matchers.length === 0) {
    throw remediationError('SOURCE_OSS_LOGO_REMEDIATION_SOURCE_URL_UNAVAILABLE');
  }
  const jsonDatabase = resolveJsonDatabasePath(repository, environment);
  const jsonSnapshot = readJsonSnapshot(jsonDatabase.filePath, fileSystem);
  const pool = deps.databaseConnection.createPostgresPool({
    config: deps.databaseConfig.readPostgresConfig({
      ...environment,
      PGAPPLICATION_NAME: 'xingxingzaishan-source-oss-logo-remediation',
      PGPOOL_MAX: '2',
      PGSTATEMENT_TIMEOUT_MS: '30000'
    })
  });
  try {
    const postgresLogo = await readPostgresLogo({
      pool,
      withTransaction: deps.transaction.withTransaction
    });
    const expectedLogo = validateLogoReferences({
      jsonLogo: jsonSnapshot.data.miniapp_content.logo_image,
      postgresLogo,
      matchers
    });
    writeLine('JSON_LOGO_REFERENCE=SOURCE_PUBLIC_DIRECT');
    writeLine('POSTGRES_LOGO_REFERENCE=SOURCE_PUBLIC_DIRECT');
    writeLine('LOGO_REFERENCES_MATCH=YES');
    writeLine(`JSON_DATABASE_SOURCE=${jsonDatabase.source}`);
    writeLine('URLS_PRINTED=NO');
    writeLine('SECRET_VALUES_PRINTED=NO');

    if (options.mode === 'preflight') {
      writeLine('PRODUCTION_DATABASE_WRITE=NONE');
      writeLine('JSON_WRITE=NONE');
      writeLine('PRIVATE_ROLLBACK_BACKUP=NOT_EXECUTED_PREFLIGHT');
      writeLine('READY_FOR_SOURCE_OSS_LOGO_REMEDIATION=YES');
      writeLine('PRODUCTION_SOURCE_OSS_LOGO_REMEDIATION_PREFLIGHT=PASS');
      return;
    }

    writePrivateBackup({
      backupDirectory: options.backupDirectory,
      jsonSnapshot,
      postgresLogo: expectedLogo,
      fileSystem
    });
    const remediatedSnapshot = await applyRemediation({
      pool,
      withTransaction: deps.transaction.withTransaction,
      jsonFile: jsonDatabase.filePath,
      jsonSnapshot,
      expectedLogo,
      fileSystem
    });
    try {
      const afterJson = readJsonSnapshot(jsonDatabase.filePath, fileSystem);
      const afterPostgres = await readPostgresLogo({
        pool,
        withTransaction: deps.transaction.withTransaction
      });
      if (normalizeText(afterJson.data.miniapp_content.logo_image)
          || normalizeText(afterPostgres)) {
        throw remediationError('SOURCE_OSS_LOGO_REMEDIATION_POSTCHECK_FAILED');
      }
    } catch (error) {
      await rollbackCommittedRemediation({
        pool,
        withTransaction: deps.transaction.withTransaction,
        jsonFile: jsonDatabase.filePath,
        jsonSnapshot,
        remediatedSnapshot,
        expectedLogo,
        fileSystem
      });
      throw error;
    }
    writeLine('PRIVATE_ROLLBACK_BACKUP=PASS');
    writeLine('JSON_LOGO_REFERENCE_CLEARED=YES');
    writeLine('POSTGRES_LOGO_REFERENCE_CLEARED=YES');
    writeLine('PRODUCTION_DATABASE_WRITE=MINIAPP_LOGO_ONLY');
    writeLine('JSON_WRITE=MINIAPP_LOGO_ONLY');
    writeLine('PRODUCTION_SOURCE_OSS_LOGO_REMEDIATION=PASS');
  } finally {
    await deps.databaseConnection.closePostgresPool(pool);
  }
}

if (require.main === module) {
  runRemediation().catch((error) => {
    process.stderr.write('PRODUCTION_SOURCE_OSS_LOGO_REMEDIATION=FAIL\n');
    process.stderr.write(`ERROR_CODE=${safeErrorCode(error)}\n`);
    process.stderr.write('URLS_PRINTED=NO\n');
    process.stderr.write('SECRET_VALUES_PRINTED=NO\n');
    process.exitCode = 1;
  });
}

module.exports = {
  applyRemediation,
  parseArguments,
  readJsonSnapshot,
  rollbackCommittedRemediation,
  runRemediation,
  safeErrorCode,
  validateLogoReferences,
  writeFileAtomicallyIfUnchanged
};
