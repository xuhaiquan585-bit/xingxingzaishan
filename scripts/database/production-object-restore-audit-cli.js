'use strict';

const fs = require('node:fs');
const path = require('node:path');
const OSS = require('ali-oss');

const {
  executeObjectRestoreAudit,
  inspectBucket,
  safeErrorCode,
  sameBucketIdentity,
  validateMirrorManifest
} = require('./production-object-mirror');
const {
  readOssConfig,
  readProtectedEnvironment
} = require('./production-object-mirror-cli');

function cliError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function parseArguments(argv) {
  const options = {
    preflight: false,
    authorized: false,
    auditOssEnv: '',
    manifestPath: '',
    outputDirectory: '',
    mode: ''
  };
  for (const argument of argv) {
    if (argument === '--preflight') {
      options.preflight = true;
      continue;
    }
    if (argument === '--authorize-restore-audit=YES') {
      options.authorized = true;
      continue;
    }
    const match = /^--([a-z-]+)=(.+)$/.exec(argument);
    if (!match) throw cliError('MIRROR_AUDIT_ARGUMENT_INVALID');
    const [, name, value] = match;
    if (name === 'audit-oss-env') options.auditOssEnv = value;
    else if (name === 'manifest-path') options.manifestPath = value;
    else if (name === 'output-directory') options.outputDirectory = value;
    else if (name === 'restore-audit') options.mode = value;
    else throw cliError('MIRROR_AUDIT_ARGUMENT_INVALID');
  }
  if (options.preflight === options.authorized) {
    throw cliError('MIRROR_AUDIT_MODE_REQUIRED');
  }
  if (!path.isAbsolute(options.auditOssEnv)
      || !path.isAbsolute(options.manifestPath)
      || !path.isAbsolute(options.outputDirectory)
      || !['sample', 'all'].includes(options.mode)) {
    throw cliError('MIRROR_AUDIT_ARGUMENT_INVALID');
  }
  return Object.freeze(options);
}

function readProtectedManifest(filePath) {
  let descriptor;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 2 || stat.size > 64 * 1024 * 1024
        || (process.platform !== 'win32'
          && (stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o077) !== 0))) {
      throw cliError('MIRROR_AUDIT_MANIFEST_INVALID');
    }
    return validateMirrorManifest(JSON.parse(fs.readFileSync(descriptor, 'utf8')));
  } catch (error) {
    if (error && String(error.code || '').startsWith('MIRROR_')) throw error;
    throw cliError('MIRROR_AUDIT_MANIFEST_INVALID');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

async function runRestoreAuditCli({
  argv = process.argv.slice(2),
  OssClient = OSS,
  writeLine = (line) => process.stdout.write(`${line}\n`)
} = {}) {
  const options = parseArguments(argv);
  const auditEnvironment = readProtectedEnvironment(options.auditOssEnv);
  const destinationConfig = readOssConfig(auditEnvironment, 'AUDIT_');
  const destinationClient = new OssClient(destinationConfig);
  const manifest = readProtectedManifest(options.manifestPath);
  const destinationIdentity = await inspectBucket(
    destinationClient,
    destinationConfig.bucket
  );
  if (!sameBucketIdentity(destinationIdentity, manifest.destination)) {
    throw cliError('MIRROR_RESTORE_BUCKET_MISMATCH');
  }
  writeLine(`MIRROR_AUDIT_MANIFEST_RUN_ID=${manifest.run_id}`);
  writeLine(`MIRROR_AUDIT_MANIFEST_OBJECT_COUNT=${manifest.object_count}`);
  writeLine('MIRROR_AUDIT_CREDENTIAL_ROLE=READ_ONLY_INDEPENDENT');
  if (options.preflight) {
    writeLine('INDEPENDENT_OBJECT_RESTORE_AUDIT_PREFLIGHT=PASS');
    return Object.freeze({ manifest, destinationIdentity });
  }
  const restore = await executeObjectRestoreAudit({
    manifest,
    destinationClient,
    destinationBucket: destinationConfig.bucket,
    outputDirectory: options.outputDirectory,
    mode: options.mode
  });
  writeLine(`MIRROR_RESTORE_VERIFIED_COUNT=${restore.audit.verified_object_count}`);
  writeLine(`MIRROR_RESTORE_AUDIT_MODE=${restore.audit.mode.toUpperCase()}`);
  writeLine(options.mode === 'all'
    ? 'MIRROR_FULL_RESTORE_AUDIT=PASS'
    : 'MIRROR_SAMPLE_RESTORE_AUDIT=PASS');
  writeLine('INDEPENDENT_OBJECT_RESTORE_AUDIT=PASS');
  return restore;
}

if (require.main === module) {
  runRestoreAuditCli().catch((error) => {
    process.stderr.write(
      `INDEPENDENT_OBJECT_RESTORE_AUDIT=FAIL\nERROR_CODE=${safeErrorCode(error)}\n`
    );
    process.exitCode = 1;
  });
}

module.exports = {
  parseArguments,
  readProtectedManifest,
  runRestoreAuditCli
};
