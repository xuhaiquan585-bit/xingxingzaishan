'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const runnerPath = path.join(root, 'scripts', 'ops', 'production-deployment-f9b827c.sh');
const runner = fs.readFileSync(runnerPath, 'utf8').replace(/\r\n/g, '\n');
const target = 'f9b827cf6245e3780841239139dda0e3bf7d84aa';
const targetTree = '8c3f5d2836a79f9fc22e6b21a9452512369fe5b9';
const acceptedCandidate = '89a1cbf08d73fdc16a1a1b3f458e791bbd7a4af6';
const previous = '749f3fdb2beecb773cc8e6845b5022b3cdf1df2c';
const previousTree = 'fe871b6816d09bfd0e1d5bf8b609c0d807660289';

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function functionBody(name) {
  const start = runner.indexOf(`${name}() {`);
  assert.notEqual(start, -1, `${name} must exist`);
  const next = runner.indexOf('\n}\n', start);
  assert.notEqual(next, -1, `${name} must terminate`);
  return runner.slice(start, next + 3);
}

test('runner pins the exact accepted candidate and rollback target', () => {
  assert.match(runner, new RegExp(`^TARGET_COMMIT=${target}$`, 'm'));
  assert.match(runner, new RegExp(`^TARGET_TREE=${targetTree}$`, 'm'));
  assert.match(runner, new RegExp(`^ACCEPTED_CANDIDATE_COMMIT=${acceptedCandidate}$`, 'm'));
  assert.match(runner, new RegExp(`^EXPECTED_PREVIOUS_COMMIT=${previous}$`, 'm'));
  assert.match(runner, new RegExp(`^EXPECTED_PREVIOUS_TREE=${previousTree}$`, 'm'));
  assert.equal(git(['rev-parse', `${target}^{tree}`]), targetTree);
  assert.equal(git(['rev-parse', `${previous}^{tree}`]), previousTree);
  assert.equal(git(['rev-parse', `${target}^`]), acceptedCandidate);
  assert.equal(git(['rev-parse', `${acceptedCandidate}^`]), previous);
  assert.deepEqual(
    git(['rev-list', '--reverse', `${previous}..${target}`]).split(/\r?\n/),
    [acceptedCandidate, target]
  );
  assert.match(runner, /TARGET_SYSTEM_ACCEPTANCE_COMMIT_CHAIN=PASS_EXACT_2/);
});

test('runner exact file allowlist matches the candidate diff', () => {
  const body = functionBody('assert_exact_target_diff');
  const expectedSection = body.split('expected="$(printf')[1].split('| LC_ALL=C sort)"')[0];
  const expected = expectedSection.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('\\'))
    .map((line) => line.slice(0, -1).trim())
    .filter((line) => /^[A-Za-z0-9_./-]+$/.test(line))
    .sort();
  const actual = git(['diff', '--name-only', previous, target]).split(/\r?\n/).filter(Boolean).sort();
  assert.equal(expected.length, 63);
  assert.deepEqual(expected, actual);
  assert.match(body, /TARGET_FILE_SET=PASS_EXACT_63/);
  assert.match(body, /src\/server\/migrations migrations/);
  assert.doesNotMatch(body, /scripts\/database src\/server\/migrations/);
});

test('dependency contract requires a staged npm ci and atomic rollbackable swap', () => {
  assert.match(runner, /DEPENDENCY_MANIFEST_DELTA=CHANGED_NPM_CI_REQUIRED/);
  assert.match(runner, /NODE_VERSION_UNSUPPORTED_REQUIRES_20_9_0/);
  assert.match(runner, /npm ci --omit=dev --no-audit --no-fund/);
  assert.match(runner, /DEPLOY_RUNTIME_ROOT="\$REPO\/\.git\/production-deploy-\$RUN_ID"/);
  const swap = functionBody('swap_dependencies');
  assert.ok(swap.indexOf('"$REPO/node_modules" "$NODE_MODULES_BACKUP"')
    < swap.indexOf('"$DEPENDENCY_STAGE/node_modules" "$REPO/node_modules"'));
  const rollback = functionBody('rollback_application');
  assert.ok(rollback.indexOf('git checkout --detach "$EXPECTED_PREVIOUS_COMMIT"')
    < rollback.indexOf('restore_previous_dependencies'));
  assert.ok(rollback.indexOf('restore_previous_dependencies')
    < rollback.indexOf('restart_application'));
});

test('preflight path cannot prepare dependencies, checkout, restart, or write backups', () => {
  const start = runner.indexOf('if [ "$MODE" = preflight ]; then');
  const end = runner.indexOf('\nfi\n', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const preflight = runner.slice(start, end + 4);
  assert.match(preflight, /PRE_DEPLOYMENT_BACKUP_EXECUTED=NO/);
  assert.match(preflight, /DEPENDENCY_PREPARATION=NOT_EXECUTED_PREFLIGHT/);
  assert.match(preflight, /DATABASE_WRITE=NONE/);
  assert.doesNotMatch(preflight, /prepare_dependencies|git checkout|restart_application|BACKUP_RUNNER/);
});

test('runner keeps deployment authorization explicit and separate from preflight', () => {
  assert.match(runner, /--preflight\) MODE=preflight/);
  assert.match(runner, /--authorize-deploy=YES\) MODE=deploy/);
  assert.match(runner, /\*\) fail DEPLOY_AUTHORIZATION_REQUIRED/);
  assert.doesNotMatch(runner, /--force|--yes|AUTO_DEPLOY/);
});

test('runner preserves only the known public verification file', () => {
  const clean = functionBody('assert_clean_worktree');
  assert.match(clean, /git status --porcelain=v1 --untracked-files=normal/);
  assert.match(clean, /\?\? src\/frontend\/5QJLlAJPza\.txt/);
  assert.match(clean, /PUBLIC_VERIFICATION_FILE_INVALID/);
  assert.match(clean, /\[ ! -L "\$REPO\/src\/frontend\/5QJLlAJPza\.txt" \]/);
  assert.match(runner, /assert_clean_worktree WORKTREE_NOT_CLEAN/);
  assert.match(runner, /assert_clean_worktree FINAL_WORKTREE_NOT_CLEAN/);
});

test('post-deploy probes cover config, dependencies, public credentials, and parser errors', () => {
  const deployed = functionBody('assert_deployed_acceptance_contract');
  assert.match(deployed, /assert_invalid_public_requests_rejected/);
  assert.match(deployed, /assert_runtime_auth_secret/);
  assert.match(deployed, /assert_unsigned_local_asset_rejected_if_present/);
  assert.match(deployed, /assert_dependency_runtime/);
  assert.match(deployed, /assert_malformed_json_rejected/);
  assert.match(runner, /assert_runtime_config_after_restart "\$APP_PID_AFTER"/);
  assert.match(runner, /listOperators\('admin'\)\.find/);
  assert.match(runner, /response\.status !== 200/);
});

test('runner contains no known rich-text shell corruption', () => {
  for (const artifact of ['\\_', '\\:', '\\*', '\\--']) {
    assert.equal(runner.includes(artifact), false, `unexpected artifact ${artifact}`);
  }
  assert.doesNotMatch(runner, /\[https?:\/\/[^\]]+\]\(https?:\/\//);
});

test('runner never embeds credential values', () => {
  assert.doesNotMatch(runner, /AKID[A-Za-z0-9]|LTAI[A-Za-z0-9]/);
  assert.doesNotMatch(runner, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/);
  assert.match(runner, /SECRET_VALUES_PRINTED=NO/);
});
