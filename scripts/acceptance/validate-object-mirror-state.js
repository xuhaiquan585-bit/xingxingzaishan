'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MIRROR_ROOT = '/root/xingxingzaishan-object-mirror';
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const RUN_ID_PATTERN = /^\d{8}T\d{6}Z-[a-f0-9]{8}$/;

function stateError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function assertPrivateStat(stat, { directory = false } = {}) {
  if (directory ? !stat.isDirectory() : !stat.isFile()) {
    throw stateError('MIRROR_STATE_PATH_INVALID');
  }
  if (process.platform !== 'win32'
      && (stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o077) !== 0)) {
    throw stateError('MIRROR_STATE_PERMISSION_INVALID');
  }
}

function readPrivateJson(filePath) {
  let descriptor;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    const stat = fs.fstatSync(descriptor);
    assertPrivateStat(stat);
    if (stat.size < 2 || stat.size > MAX_JSON_BYTES) {
      throw stateError('MIRROR_STATE_FILE_SIZE_INVALID');
    }
    return JSON.parse(fs.readFileSync(descriptor, 'utf8'));
  } catch (error) {
    if (error && String(error.code || '').startsWith('MIRROR_STATE_')) throw error;
    throw stateError('MIRROR_STATE_FILE_INVALID');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function objectMap(entries) {
  if (!Array.isArray(entries)) throw stateError('MIRROR_STATE_OBJECTS_INVALID');
  const result = new Map();
  for (const entry of entries) {
    const key = String(entry && entry.object_key || '');
    const sha256 = String(entry && entry.sha256 || '');
    const size = Number(entry && entry.size);
    if (!key || result.has(key) || !/^[a-f0-9]{64}$/.test(sha256)
        || !Number.isSafeInteger(size) || size <= 0) {
      throw stateError('MIRROR_STATE_OBJECTS_INVALID');
    }
    result.set(key, `${sha256}:${size}`);
  }
  return result;
}

function sameDestination(left, right) {
  return ['name', 'location', 'ownerId', 'acl']
    .every((key) => String(left && left[key] || '') === String(right && right[key] || ''));
}

function readRunState(rootDirectory, runId) {
  const runDirectory = path.join(rootDirectory, runId);
  const runStat = fs.lstatSync(runDirectory);
  if (runStat.isSymbolicLink()) throw stateError('MIRROR_STATE_RUN_INVALID');
  assertPrivateStat(runStat, { directory: true });

  const manifest = readPrivateJson(path.join(
    runDirectory,
    `${runId}-object-mirror-manifest.json`
  ));
  const audit = readPrivateJson(path.join(
    runDirectory,
    `${runId}-object-mirror-restore-audit.json`
  ));
  if (manifest.schema_version !== 1 || manifest.status !== 'COMPLETE'
      || manifest.run_id !== runId || audit.schema_version !== 1
      || audit.status !== 'PASS' || audit.mirror_run_id !== runId
      || !['sample', 'all'].includes(audit.mode)
      || !sameDestination(manifest.destination, audit.destination)) {
    throw stateError('MIRROR_STATE_CONTRACT_INVALID');
  }

  const manifestObjects = objectMap(manifest.objects);
  const auditObjects = objectMap(audit.objects);
  if (manifest.object_count !== manifestObjects.size
      || audit.manifest_object_count !== manifestObjects.size
      || audit.verified_object_count !== auditObjects.size
      || (audit.mode === 'all' && auditObjects.size !== manifestObjects.size)
      || (audit.mode === 'sample' && auditObjects.size > manifestObjects.size)) {
    throw stateError('MIRROR_STATE_COUNT_INVALID');
  }
  for (const [key, digest] of auditObjects.entries()) {
    if (manifestObjects.get(key) !== digest) {
      throw stateError('MIRROR_STATE_INTEGRITY_INVALID');
    }
  }

  const manifestCompletedAtMs = Date.parse(manifest.completed_at_utc);
  const auditCompletedAtMs = Date.parse(audit.completed_at_utc);
  if (!Number.isFinite(manifestCompletedAtMs) || !Number.isFinite(auditCompletedAtMs)
      || auditCompletedAtMs < manifestCompletedAtMs) {
    throw stateError('MIRROR_STATE_TIME_INVALID');
  }
  return Object.freeze({
    runId,
    mode: audit.mode,
    objectCount: manifestObjects.size,
    verifiedObjectCount: auditObjects.size,
    auditCompletedAtMs
  });
}

function validateObjectMirrorState({
  rootDirectory = MIRROR_ROOT,
  maxMirrorAgeSeconds,
  maxFullAuditAgeSeconds,
  nowMs = Date.now()
}) {
  if (!Number.isSafeInteger(maxMirrorAgeSeconds) || maxMirrorAgeSeconds < 1
      || !Number.isSafeInteger(maxFullAuditAgeSeconds) || maxFullAuditAgeSeconds < 1) {
    throw stateError('MIRROR_STATE_MAX_AGE_INVALID');
  }
  let rootStat;
  try {
    rootStat = fs.lstatSync(rootDirectory);
  } catch (_error) {
    throw stateError('MIRROR_STATE_ROOT_INVALID');
  }
  if (rootStat.isSymbolicLink()) throw stateError('MIRROR_STATE_ROOT_INVALID');
  assertPrivateStat(rootStat, { directory: true });

  const runIds = fs.readdirSync(rootDirectory)
    .filter((name) => RUN_ID_PATTERN.test(name))
    .sort((left, right) => right.localeCompare(left));
  if (runIds.length === 0) throw stateError('MIRROR_STATE_RUN_MISSING');
  const latest = readRunState(rootDirectory, runIds[0]);
  if (latest.auditCompletedAtMs > nowMs + 300_000) {
    throw stateError('MIRROR_STATE_TIME_INVALID');
  }
  const mirrorAgeSeconds = Math.max(
    0,
    Math.floor((nowMs - latest.auditCompletedAtMs) / 1000)
  );
  if (mirrorAgeSeconds > maxMirrorAgeSeconds) throw stateError('MIRROR_STATE_STALE');

  let latestFullAudit = null;
  for (const runId of runIds) {
    let candidate;
    try {
      candidate = runId === latest.runId ? latest : readRunState(rootDirectory, runId);
    } catch (_error) {
      continue;
    }
    if (candidate.mode === 'all') {
      latestFullAudit = candidate;
      break;
    }
  }
  if (!latestFullAudit) throw stateError('MIRROR_STATE_FULL_AUDIT_MISSING');
  if (latestFullAudit.auditCompletedAtMs > nowMs + 300_000) {
    throw stateError('MIRROR_STATE_TIME_INVALID');
  }
  const fullAuditAgeSeconds = Math.max(
    0,
    Math.floor((nowMs - latestFullAudit.auditCompletedAtMs) / 1000)
  );
  if (fullAuditAgeSeconds > maxFullAuditAgeSeconds) {
    throw stateError('MIRROR_STATE_FULL_AUDIT_STALE');
  }
  return Object.freeze({
    runId: latest.runId,
    objectCount: latest.objectCount,
    verifiedObjectCount: latest.verifiedObjectCount,
    auditMode: latest.mode,
    ageSeconds: mirrorAgeSeconds,
    fullAuditRunId: latestFullAudit.runId,
    fullAuditAgeSeconds
  });
}

function runObjectMirrorStateCheck({
  argv = process.argv.slice(2),
  writeLine = (line) => process.stdout.write(`${line}\n`)
} = {}) {
  const maxMirrorAgeSeconds = Number(argv[0]);
  const maxFullAuditAgeSeconds = Number(argv[1]);
  if (argv.length !== 2
      || !Number.isSafeInteger(maxMirrorAgeSeconds) || maxMirrorAgeSeconds < 1
      || !Number.isSafeInteger(maxFullAuditAgeSeconds) || maxFullAuditAgeSeconds < 1) {
    writeLine('PRODUCTION_OBJECT_MIRROR_STATE=FAIL');
    writeLine('ERROR_CODE=MIRROR_STATE_ARGUMENT_INVALID');
    writeLine('SECRET_VALUES_PRINTED=NO');
    return 1;
  }
  try {
    const result = validateObjectMirrorState({
      maxMirrorAgeSeconds,
      maxFullAuditAgeSeconds
    });
    writeLine(`MIRROR_LAST_SUCCESS_RUN_ID=${result.runId}`);
    writeLine(`MIRROR_LAST_SUCCESS_OBJECT_COUNT=${result.objectCount}`);
    writeLine(`MIRROR_LAST_RESTORE_VERIFIED_COUNT=${result.verifiedObjectCount}`);
    writeLine(`MIRROR_LAST_RESTORE_AUDIT_MODE=${result.auditMode.toUpperCase()}`);
    writeLine(`MIRROR_LAST_SUCCESS_AGE_SECONDS=${result.ageSeconds}`);
    writeLine(`MIRROR_LAST_FULL_RESTORE_RUN_ID=${result.fullAuditRunId}`);
    writeLine(`MIRROR_LAST_FULL_RESTORE_AGE_SECONDS=${result.fullAuditAgeSeconds}`);
    writeLine('MIRROR_LAST_FULL_RESTORE_AUDIT=PASS');
    writeLine('PRODUCTION_OBJECT_MIRROR_STATE=PASS');
    writeLine('SECRET_VALUES_PRINTED=NO');
    return 0;
  } catch (error) {
    writeLine('PRODUCTION_OBJECT_MIRROR_STATE=FAIL');
    writeLine(`ERROR_CODE=${String(error && error.code || 'MIRROR_STATE_INVALID')}`);
    writeLine('SECRET_VALUES_PRINTED=NO');
    return 1;
  }
}

if (require.main === module) process.exitCode = runObjectMirrorStateCheck();

module.exports = {
  MIRROR_ROOT,
  readPrivateJson,
  runObjectMirrorStateCheck,
  validateObjectMirrorState
};
