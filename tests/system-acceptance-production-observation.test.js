'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  parseProcessEnvironment,
  readProtectedEnvironmentFile,
  reconstructRuntimeEnvironment,
  runRuntimeConfigCheck
} = require('../scripts/acceptance/validate-running-production-config');
const {
  validateObjectMirrorState
} = require('../scripts/acceptance/validate-object-mirror-state');

test('production observation runner is read-only and covers operational gates', () => {
  const source = fs.readFileSync(path.join(
    __dirname,
    '..',
    'scripts',
    'database',
    'run-system-acceptance-production-observation.sh'
  ), 'utf8');

  assert.match(source, /\[ "\$1" = --check \]/);
  assert.match(source, /git status --porcelain=v1 --untracked-files=normal/);
  assert.match(source, /WORKTREE_NOT_CLEAN/);
  assert.match(source, /\?\? src\/frontend\/5QJLlAJPza\.txt/);
  assert.match(source, /PUBLIC_VERIFICATION_FILE_INVALID/);
  assert.doesNotMatch(source, /--untracked-files=no(?!rmal)/);
  assert.match(source, /BEGIN TRANSACTION READ ONLY;/);
  assert.match(source, /SET LOCAL statement_timeout = '10000ms';/);
  assert.match(source, /PRODUCTION_DATABASE=xingxing_clean_baseline_20260812_staging/);
  assert.match(source, /BACKUP_TIMER=ENABLED_ACTIVE/);
  assert.match(source, /RUNTIME_CONFIG_CHECK/);
  assert.match(source, /PM2_STARTED_AT_MS/);
  assert.match(source, /\[ "\$PM2_PID" = "\$APP_PID_INITIAL" \]/);
  assert.match(source, /PRODUCTION_RUNTIME_CONFIG=PASS/);
  assert.match(source, /BACKUP_LAST_ATTEMPT_NOT_PASS/);
  assert.match(source, /BACKUP_SERVICE_RESULT_INVALID/);
  assert.match(source, /BACKUP_LAST_SUCCESS_AGE_SECONDS/);
  assert.match(source, /PM2_RESTART_COUNT/);
  assert.match(source, /ROOT_DISK_USED_PERCENT/);
  assert.match(source, /OBJECT_MIRROR_TIMER/);
  assert.match(source, /OBJECT_MIRROR_STATE_CHECK/);
  assert.match(source, /OBJECT_MIRROR_SERVICE_RESULT_INVALID/);
  assert.match(source, /OBJECT_MIRROR_P0_GATE/);
  assert.match(source, /OUTBOX_STALE_PROCESSING_PRESENT/);
  assert.match(source, /OUTBOX_FAILED_PRESENT/);
  assert.match(source, /OBSERVATION_CYCLES=3/);
  assert.match(source, /PRODUCTION_DATABASE_WRITE=NONE/);
  assert.match(source, /APPLICATION_RESTART=NO/);
  assert.match(source, /EXTERNAL_PROVIDER_CALLS=NONE/);
  assert.match(source, /SECRET_VALUES_PRINTED=NO/);
  assert.doesNotMatch(source, /pm2 (?:restart|reload|start|delete)/);
  assert.doesNotMatch(source, /systemctl (?:start|restart|enable|disable)/);
  assert.doesNotMatch(source, /git (?:pull|merge|checkout|reset)/);
  assert.doesNotMatch(source, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/);
  assert.doesNotMatch(source, /cat .*\.env/);
});

test('object mirror state requires a fresh daily run and a recent full restore audit', () => {
  const rootDirectory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mirror-state-'));
  const destination = {
    name: 'secondary', location: 'oss-cn-shanghai', ownerId: 'owner-b', acl: 'private'
  };
  const objects = [{
    object_key: 'stars/a.jpg',
    sha256: 'a'.repeat(64),
    size: 123,
    destination_version_id: 'version-fixture-1'
  }];
  function writeRun(runId, completedAt, mode) {
    const runDirectory = path.join(rootDirectory, runId);
    fs.mkdirSync(runDirectory, { mode: 0o700 });
    fs.writeFileSync(
      path.join(runDirectory, `${runId}-object-mirror-manifest.json`),
      JSON.stringify({
        schema_version: 3,
        status: 'COMPLETE',
        run_id: runId,
        completed_at_utc: completedAt,
        destination,
        destination_versioning: 'ENABLED_VERSION_ID_PINNED',
        restore_verification: 'INDEPENDENT_EXACT_VERSION_AUDIT_REQUIRED',
        object_count: 1,
        objects
      }),
      { mode: 0o600 }
    );
    const auditPath = path.join(runDirectory, `${runId}-object-mirror-restore-audit.json`);
    fs.writeFileSync(auditPath, JSON.stringify({
      schema_version: 2,
      status: 'PASS',
      mirror_run_id: runId,
      completed_at_utc: completedAt,
      mode,
      manifest_object_count: 1,
      verified_object_count: 1,
      destination,
      objects
    }), { mode: 0o600 });
    return auditPath;
  }
  const fullRunId = '20261001T010203Z-1234abcd';
  writeRun(fullRunId, '2026-10-01T01:03:03.000Z', 'all');
  const runId = '20261002T010203Z-abcdef12';
  const auditPath = writeRun(runId, '2026-10-02T01:03:03.000Z', 'sample');
  try {
    const valid = validateObjectMirrorState({
      rootDirectory,
      maxMirrorAgeSeconds: 129600,
      maxFullAuditAgeSeconds: 3024000,
      nowMs: Date.parse('2026-10-02T02:03:03.000Z')
    });
    assert.equal(valid.runId, runId);
    assert.equal(valid.objectCount, 1);
    assert.equal(valid.auditMode, 'sample');
    assert.equal(valid.ageSeconds, 3600);
    assert.equal(valid.fullAuditRunId, fullRunId);

    assert.throws(() => validateObjectMirrorState({
      rootDirectory,
      maxMirrorAgeSeconds: 60,
      maxFullAuditAgeSeconds: 3024000,
      nowMs: Date.parse('2026-10-02T02:03:03.000Z')
    }), { code: 'MIRROR_STATE_STALE' });
    assert.throws(() => validateObjectMirrorState({
      rootDirectory,
      maxMirrorAgeSeconds: 129600,
      maxFullAuditAgeSeconds: 60,
      nowMs: Date.parse('2026-10-02T02:03:03.000Z')
    }), { code: 'MIRROR_STATE_FULL_AUDIT_STALE' });

    const tampered = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
    tampered.objects[0].sha256 = 'b'.repeat(64);
    fs.writeFileSync(auditPath, JSON.stringify(tampered));
    assert.throws(() => validateObjectMirrorState({
      rootDirectory,
      maxMirrorAgeSeconds: 129600,
      maxFullAuditAgeSeconds: 3024000,
      nowMs: Date.parse('2026-10-02T02:03:03.000Z')
    }), { code: 'MIRROR_STATE_INTEGRITY_INVALID' });

    tampered.objects[0].sha256 = 'a'.repeat(64);
    tampered.objects[0].destination_version_id = 'version-other-2';
    fs.writeFileSync(auditPath, JSON.stringify(tampered));
    assert.throws(() => validateObjectMirrorState({
      rootDirectory,
      maxMirrorAgeSeconds: 129600,
      maxFullAuditAgeSeconds: 3024000,
      nowMs: Date.parse('2026-10-02T02:03:03.000Z')
    }), { code: 'MIRROR_STATE_INTEGRITY_INVALID' });
  } finally {
    fs.rmSync(rootDirectory, { recursive: true, force: true });
  }
});

test('running production config check reconstructs dotenv runtime without printing secrets', () => {
  const repository = path.resolve('fixture-production-app');
  const fileEnvironment = {
    NODE_ENV: 'production',
    BASE_URL: 'https://xingxingzaishan.top',
    AUTH_SECRET: 'a'.repeat(64),
    UPLOAD_PROOF_SECRET: 'b'.repeat(64),
    STORAGE_MODE: 'cloud',
    CLOUD_FALLBACK_TO_LOCAL: 'false',
    OSS_ACCESS_KEY_ID: 'private-access-id',
    OSS_ACCESS_KEY_SECRET: 'private-access-secret',
    OSS_BUCKET: 'private-bucket',
    OSS_REGION: 'cn-hangzhou',
    OSS_ENDPOINT: 'oss-cn-hangzhou.aliyuncs.com',
    SMS_PROVIDER: 'aliyun',
    SMS_ACCESS_KEY_ID: 'private-sms-id',
    SMS_ACCESS_KEY_SECRET: 'private-sms-secret',
    SMS_SIGN_NAME: 'sign',
    SMS_TEMPLATE_CODE: 'template',
    USER_LEGACY_LOGIN_ENABLED: 'false',
    USER_SESSION_SECURE: 'true',
    USER_SESSION_SAMESITE: 'Lax',
    WECHAT_MINIAPP_APPID: 'private-app-id',
    WECHAT_MINIAPP_SECRET: 'private-app-secret',
    PGDATABASE: 'expected_database'
  };
  const processEnvironment = {
    NODE_ENV: 'production',
    BASE_URL: 'https://xingxingzaishan.top'
  };
  const bytes = Buffer.from(Object.entries(processEnvironment)
    .map(([key, value]) => `${key}=${value}\0`).join(''));
  assert.deepEqual({ ...parseProcessEnvironment(bytes) }, processEnvironment);
  assert.deepEqual(reconstructRuntimeEnvironment({ processEnvironment, fileEnvironment }), {
    ...fileEnvironment,
    ...processEnvironment
  });

  const lines = [];
  const exitCode = runRuntimeConfigCheck({
    argv: ['1234', repository, 'expected_database', '200000'],
    readFileSync: () => bytes,
    readlinkSync: () => repository,
    realpathSync: (value) => value,
    readProtectedEnv: () => ({ environment: fileEnvironment, modifiedAtMs: 100000 }),
    writeLine: (line) => lines.push(line)
  });
  assert.equal(exitCode, 0);
  assert.equal(lines.includes('PRODUCTION_RUNTIME_CONFIG=PASS'), true);
  assert.equal(lines.includes('PRODUCTION_DATABASE=PASS_EXPECTED'), true);
  assert.equal(lines.includes('PROTECTED_ENV_FILE=PASS_ROOT_ROOT_0600'), true);
  assert.equal(lines.includes('SECRET_VALUES_PRINTED=NO'), true);
  const output = lines.join('\n');
  for (const value of [
    fileEnvironment.AUTH_SECRET,
    fileEnvironment.UPLOAD_PROOF_SECRET,
    fileEnvironment.OSS_ACCESS_KEY_SECRET,
    fileEnvironment.SMS_ACCESS_KEY_SECRET,
    fileEnvironment.WECHAT_MINIAPP_SECRET
  ]) {
    assert.equal(output.includes(value), false);
  }
});

test('running production config check rejects an env file changed after process start', () => {
  const repository = path.resolve('fixture-production-app');
  const lines = [];
  const exitCode = runRuntimeConfigCheck({
    argv: ['1234', repository, 'expected_database', '200000'],
    readFileSync: () => Buffer.from('NODE_ENV=production\0'),
    readlinkSync: () => repository,
    realpathSync: (value) => value,
    readProtectedEnv: () => ({ environment: {}, modifiedAtMs: 203000 }),
    writeLine: (line) => lines.push(line)
  });
  assert.equal(exitCode, 1);
  assert.equal(lines.includes('ERROR_CODE=PROTECTED_ENV_FILE_NEWER_THAN_PROCESS'), true);
  assert.equal(lines.includes('SECRET_VALUES_PRINTED=NO'), true);
});

test('protected runtime env reader requires a root-owned regular 0600 file', () => {
  let closed = false;
  const result = readProtectedEnvironmentFile('/srv/app/.env', {
    openSync: () => 7,
    fstatSync: () => ({
      isFile: () => true,
      uid: 0,
      gid: 0,
      mode: 0o100600,
      mtimeMs: 12345
    }),
    readFileSync: () => Buffer.from('NODE_ENV=production\nAUTH_SECRET=secret'),
    closeSync: () => { closed = true; }
  });
  assert.equal(result.environment.NODE_ENV, 'production');
  assert.equal(result.modifiedAtMs, 12345);
  assert.equal(closed, true);

  assert.throws(() => readProtectedEnvironmentFile('/srv/app/.env', {
    openSync: () => 8,
    fstatSync: () => ({
      isFile: () => true,
      uid: 1000,
      gid: 1000,
      mode: 0o100644,
      mtimeMs: 12345
    }),
    readFileSync: () => Buffer.from('AUTH_SECRET=must-not-be-read'),
    closeSync: () => {}
  }), { code: 'PROTECTED_ENV_FILE_UNSAFE' });
});
