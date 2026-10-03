'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const runner = fs.readFileSync(path.join(
  root,
  'scripts',
  'ops',
  'production-cloud-fallback-disable.sh'
), 'utf8').replace(/\r\n/g, '\n');

function functionBody(name) {
  const start = runner.indexOf(`${name}() {`);
  assert.notEqual(start, -1, `${name} must exist`);
  const end = runner.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `${name} must terminate`);
  return runner.slice(start, end + 3);
}

test('runner pins the current production revision and requires explicit authorization', () => {
  assert.match(runner, /^EXPECTED_ACTIVE_COMMIT=749f3fdb2beecb773cc8e6845b5022b3cdf1df2c$/m);
  assert.match(runner, /^EXPECTED_ACTIVE_TREE=fe871b6816d09bfd0e1d5bf8b609c0d807660289$/m);
  assert.match(runner, /--preflight\) MODE=preflight/);
  assert.match(runner, /--authorize-disable=YES\) MODE=authorized/);
  assert.match(runner, /AUTHORIZATION_MODE_REQUIRED/);
});

test('preflight is read-only and reports the exact source contract', () => {
  const start = runner.indexOf('if [ "$MODE" = preflight ]; then');
  const end = runner.indexOf('\nfi\n', start);
  const body = runner.slice(start, end + 4);
  assert.match(body, /ENV_FILE_CHANGED=NO/);
  assert.match(body, /APPLICATION_RESTART=NO/);
  assert.match(body, /DATABASE_WRITE=NONE/);
  assert.match(body, /OSS_REQUESTS=NONE/);
  assert.match(body, /PRODUCTION_CLOUD_FALLBACK_DISABLE_PREFLIGHT=PASS/);
  assert.doesNotMatch(body, /pm2 restart|install -d|renameSync/);
});

test('exact duplicate dotenv assignments collapse to one disabled setting', () => {
  assert.match(runner, /assert_env_value true 2/);
  assert.match(runner, /assert_env_value false 1/);
  assert.match(runner, /CLOUD_FALLBACK_SOURCE=ENV_FILE_ONLY_TRUE/);
  assert.match(runner, /ENV_REPLACEMENT_CONTRACT=PASS_EXACT_TWO_DUPLICATE_SETTINGS/);
  assert.match(runner, /Buffer\.from\('CLOUD_FALLBACK_TO_LOCAL=true'\)/);
  assert.match(runner, /Buffer\.from\('CLOUD_FALLBACK_TO_LOCAL=false'\)/);
  assert.match(runner, /source\.indexOf\(needle, second \+ needle\.length\) >= 0/);
  assert.match(runner, /source\.subarray\(first \+ needle\.length, second\)/);
  assert.match(runner, /source\.subarray\(secondEnd\)/);
  assert.match(runner, /if \(!expected\.equals\(after\)\) process\.exit\(2\)/);
});

test('preflight sweeps every candidate production environment gate after normalization', () => {
  assert.match(runner, /assert_post_remediation_environment_contract\(\) \{/);
  assert.match(runner, /CLOUD_FALLBACK_TO_LOCAL: 'false'/);
  assert.match(runner, /POST_REMEDIATION_ERROR_CODE=/);
  assert.match(runner, /POST_REMEDIATION_ENVIRONMENT_CONTRACT=PASS/);
  assert.match(runner, /POST_REMEDIATION_ENVIRONMENT_GATE_FAILED/);
});

test('runner rejects process and PM2 overrides without printing unrelated environment', () => {
  const body = functionBody('assert_no_runtime_or_pm2_override');
  assert.match(body, /\/proc\/\$app_pid\/environ/);
  assert.match(body, /Object\.hasOwn\(app\.pm2_env \|\| \{\}, "CLOUD_FALLBACK_TO_LOCAL"\)/);
  assert.match(body, /Object\.hasOwn\(app\.pm2_env \|\| \{\}, 'CLOUD_FALLBACK_TO_LOCAL'\)/);
  assert.doesNotMatch(runner, /cat "?\$ENV_FILE|printenv|env >|process\.env/);
});

test('authorized path creates a private backup and rolls back a failed restart', () => {
  assert.match(runner, /assert_root_private_directory "\$BACKUP_ROOT"/);
  assert.match(runner, /assert_root_private_directory "\$AUDIT_DIR"/);
  assert.match(runner, /install -o root -g root -m 0600 "\$ENV_FILE" "\$ENV_BACKUP"/);
  assert.match(runner, /PRIVATE_ENV_BACKUP_MISMATCH/);
  const cleanup = functionBody('cleanup');
  assert.match(cleanup, /restore_original_environment/);
  assert.match(cleanup, /ENVIRONMENT_ROLLBACK=PASS/);
  assert.match(cleanup, /rm -f -- "\$ENV_TEMP"/);
  const restore = functionBody('restore_original_environment');
  assert.ok(restore.indexOf('install -o root -g root -m 0600')
    < restore.indexOf('pm2 restart "$APP_NAME"'));
  assert.match(runner, /REMEDIATION_COMPLETE=YES/);
});

test('success verifies restart, unchanged PM2 dump, and no external writes', () => {
  assert.match(runner, /APP_PID_NOT_REPLACED/);
  assert.match(runner, /PM2_DUMP_CHANGED/);
  assert.match(runner, /OTHER_ENV_VALUES_CHANGED=NO/);
  assert.match(runner, /DATABASE_WRITE=NONE/);
  assert.match(runner, /OSS_REQUESTS=NONE/);
  assert.match(runner, /BLOCKCHAIN_WRITE=NONE/);
  assert.match(runner, /APPLICATION_CODE_CHANGED=NO/);
  assert.match(runner, /PRODUCTION_CLOUD_FALLBACK_DISABLE=PASS/);
});

test('runner contains no known rich-text corruption or embedded credentials', () => {
  for (const artifact of ['\\_', '\\:', '\\*', '\\--']) {
    assert.equal(runner.includes(artifact), false, `unexpected artifact ${artifact}`);
  }
  assert.doesNotMatch(runner, /\[https?:\/\/[^\]]+\]\(https?:\/\//);
  assert.doesNotMatch(runner, /AKID[A-Za-z0-9]|LTAI[A-Za-z0-9]/);
  assert.match(runner, /SECRET_VALUES_PRINTED=NO/);
});
