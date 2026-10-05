#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

TARGET_COMMIT=7e7bbdd8714239f59dba50199ec2843e2a263ff6
TARGET_TREE=34d83ad54990827c5e30b8cd5849408cfe06e134
EXPECTED_PREVIOUS_COMMIT=5970420f7b61c7551ceb07099f0aa93e613e05d3
EXPECTED_PREVIOUS_TREE=dd5a574b4c78af7c162a3c5feb817b8f9b5703a6

REPO=/www/wwwroot/xingxingzaishan
APP_NAME=xingxingzaishan
ENV_FILE="$REPO/.env"
PM2_DUMP=/root/.pm2/dump.pm2
LOCAL_READY_URL=http://127.0.0.1:3000/api/health/ready
EXTERNAL_READY_URL=https://xingxingzaishan.top/api/health/ready
DEPLOY_LOCK=/run/lock/xingxingzaishan-production-deploy.lock
AUDIT_ROOT=/root/production-object-mirror-trust-boundary-deployment

MODE=
CHECKOUT_STARTED=NO
ROLLBACK_IN_PROGRESS=NO
LAST_ERROR_CODE=UNCLASSIFIED_FAILURE

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "${2}_REQUIRED"
}

assert_root_private_regular_file() {
  local file="$1"
  [ -f "$file" ] || return 1
  [ ! -L "$file" ] || return 1
  [ "$(stat -c '%U:%G' "$file")" = root:root ] || return 1
  [ "$(stat -c '%a' "$file")" = 600 ] || return 1
}

assert_clean_worktree() {
  local dirty_code="$1"
  local state
  state="$(git status --porcelain=v1 --untracked-files=normal)"
  case "$state" in
    '') ;;
    '?? src/frontend/5QJLlAJPza.txt')
      [ -f "$REPO/src/frontend/5QJLlAJPza.txt" ] \
        || fail PUBLIC_VERIFICATION_FILE_INVALID
      [ ! -L "$REPO/src/frontend/5QJLlAJPza.txt" ] \
        || fail PUBLIC_VERIFICATION_FILE_INVALID
      ;;
    *) fail "$dirty_code" ;;
  esac
}

http_code() {
  curl -sS -o /dev/null -w '%{http_code}' \
    --connect-timeout 5 --max-time 15 --retry 0 "$1"
}

application_pid() {
  pm2 jlist | "$NODE_BIN" -e '
const fs = require("node:fs");
const rows = JSON.parse(fs.readFileSync(0, "utf8"));
const matches = rows.filter((row) => row && row.name === "xingxingzaishan");
if (matches.length !== 1) process.exit(2);
const row = matches[0];
const state = row.pm2_env || {};
const forbidden = new Set([
  "DATABASE_URL", "PGPASSWORD", "OSS_ACCESS_KEY_ID", "OSS_ACCESS_KEY_SECRET",
  "AVATA_API_KEY", "AVATA_API_SECRET", "AUTH_SECRET", "UPLOAD_PROOF_SECRET",
  "SMS_ACCESS_KEY_SECRET", "WECHAT_MINIAPP_SECRET", "WECHAT_PAY_API_V3_KEY"
]);
function hasSecret(value) {
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key) && String(child || "") !== "") return true;
    if (hasSecret(child)) return true;
  }
  return false;
}
if (hasSecret(state)) process.exit(3);
if (state.status !== "online") process.exit(4);
if (state.pm_cwd !== "/www/wwwroot/xingxingzaishan") process.exit(5);
if (state.pm_exec_path !== "/www/wwwroot/xingxingzaishan/src/server/server.js") process.exit(6);
if (!row.pid || Number(row.pid) <= 0) process.exit(7);
process.stdout.write(String(row.pid));
'
}

assert_readiness_contract() {
  local local_code
  local external_code
  local_code="$(http_code "$LOCAL_READY_URL" 2>/dev/null || true)"
  external_code="$(http_code "$EXTERNAL_READY_URL" 2>/dev/null || true)"
  [ "$local_code" = "$external_code" ] || fail READINESS_ENDPOINTS_DISAGREE
  [ "$local_code" = 200 ] || fail READINESS_HTTP_INVALID
  printf 'CURRENT_READINESS=PASS_200_READY\n'
}

assert_recent_backup() {
  "$NODE_BIN" -e '
const service = require("./src/server/services/productionReadinessService");
try {
  service.readProtectedBackupAttempt();
  process.stdout.write("RECENT_BACKUP=PASS_WITHIN_2_HOURS\n");
} catch (_error) {
  process.exit(1);
}
' || fail RECENT_BACKUP_INVALID
}

assert_exact_commit_chain() {
  local actual
  local expected
  actual="$(git rev-list --reverse "$EXPECTED_PREVIOUS_COMMIT..$TARGET_COMMIT")"
  expected="$(printf '%s\n' \
    559ea3cff571e212f8980cff786d8e2705a56c10 \
    6923eaba137bf625b1081ee5ada4cb2ec803cb4a \
    1bc76a535e762606db5e094ddf2db44ed8bd7e2b \
    00c5009e4799d6126c880ab1c571f966fedf0592 \
    e48c588552948a128fe14dc31e5f22a32ecd160f \
    41deaf669a0cf2780d9a10a4ae194c5cd1c035c8 \
    c8876f3fd211d96b72fe03001b2c56b023228502 \
    a20e8dba6fae455acb9604aa88b6c0a84628ba84 \
    e98d0fe1b9d25cbed42062828c90d13962ec6bf1 \
    7e7bbdd8714239f59dba50199ec2843e2a263ff6)"
  [ "$actual" = "$expected" ] || fail TARGET_COMMIT_CHAIN_MISMATCH
  printf 'TARGET_OBJECT_MIRROR_TRUST_BOUNDARY_COMMIT_CHAIN=PASS_EXACT_10\n'
}

assert_exact_target_diff() {
  local actual
  local expected
  actual="$(git diff --name-only "$EXPECTED_PREVIOUS_COMMIT" "$TARGET_COMMIT" | LC_ALL=C sort)"
  expected="$(printf '%s\n' \
    docs/PROJECT-REQUIREMENTS.md \
    docs/deploy.md \
    scripts/database/audit-production-source-oss-public-dependencies.js \
    scripts/database/configure-production-object-mirror-destination.sh \
    scripts/database/install-production-object-mirror-systemd.sh \
    scripts/database/production-object-mirror-cli.js \
    scripts/database/production-object-mirror.js \
    scripts/database/production-object-restore-audit-cli.js \
    scripts/database/remediate-production-source-oss-logo-reference.js \
    scripts/database/run-production-object-mirror.sh \
    scripts/database/run-production-source-oss-logo-remediation.sh \
    scripts/database/run-production-source-oss-private-switch.sh \
    scripts/database/run-production-source-oss-public-dependency-audit.sh \
    scripts/database/source-oss-private-switch.js \
    scripts/systemd/xingxingzaishan-object-mirror-full-audit.service \
    scripts/systemd/xingxingzaishan-object-mirror-full-audit.timer \
    scripts/systemd/xingxingzaishan-object-mirror.service \
    src/miniprogram/assets/brand/star-logo.png \
    src/miniprogram/pages/home/home.js \
    src/miniprogram/pages/home/home.wxml \
    src/miniprogram/pages/home/home.wxss \
    tests/api.test.js \
    tests/production-object-mirror.test.js \
    | LC_ALL=C sort)"
  [ "$actual" = "$expected" ] || fail TARGET_FILE_SET_MISMATCH
  [ "$(printf '%s\n' "$actual" | sed '/^$/d' | wc -l | tr -d ' ')" = 23 ] \
    || fail TARGET_FILE_COUNT_MISMATCH
  git diff --quiet "$EXPECTED_PREVIOUS_COMMIT" "$TARGET_COMMIT" -- \
    src/server/migrations migrations \
    || fail DATABASE_MIGRATION_DELTA_UNEXPECTED
  git diff --quiet "$EXPECTED_PREVIOUS_COMMIT" "$TARGET_COMMIT" -- \
    package.json package-lock.json \
    || fail DEPENDENCY_MANIFEST_DELTA_UNEXPECTED
  printf 'TARGET_FILE_SET=PASS_EXACT_23\n'
  printf 'DATABASE_MIGRATION_DELTA=NONE\n'
  printf 'DEPENDENCY_MANIFEST_DELTA=NONE\n'
}

assert_target_acceptance_contract() {
  "$NODE_BIN" - "$TARGET_COMMIT" <<'NODE'
const { execFileSync } = require('node:child_process');
const commit = process.argv[2];
const read = (file) => execFileSync('git', ['show', `${commit}:${file}`], { encoding: 'utf8' });
const exists = (file) => {
  try {
    execFileSync('git', ['cat-file', '-e', `${commit}:${file}`], { stdio: 'ignore' });
    return true;
  } catch (_error) {
    return false;
  }
};
const must = (condition, code) => {
  if (!condition) {
    process.stderr.write(`${code}\n`);
    process.exit(1);
  }
};

const mirror = read('scripts/database/production-object-mirror.js');
must(mirror.includes('async function uploadMirrorObjectWriteOnly'),
  'WRITE_ONLY_UPLOADER_MISSING');
must(mirror.includes("'x-oss-forbid-overwrite': 'true'"),
  'DESTINATION_OVERWRITE_GUARD_MISSING');
must(mirror.includes("destination_object_read: 'NONE'"),
  'DESTINATION_READ_MARKER_MISSING');
must(mirror.includes("restore_verification: 'INDEPENDENT_AUDIT_REQUIRED'"),
  'INDEPENDENT_AUDIT_MARKER_MISSING');
must(mirror.includes('MIRROR_DESTINATION_COLLISION_REQUIRES_AUDIT'),
  'DESTINATION_COLLISION_STOP_MISSING');

const mirrorCli = read('scripts/database/production-object-mirror-cli.js');
must(mirrorCli.includes('PRODUCTION_OBJECT_MIRROR_WRITE_ONLY=PASS'),
  'WRITE_ONLY_PASS_MARKER_MISSING');
must(mirrorCli.includes('MIRROR_DESTINATION_OBJECT_READ=NONE'),
  'WRITE_ONLY_READ_MARKER_MISSING');
must(mirrorCli.includes('MIRROR_INDEPENDENT_RESTORE_AUDIT=REQUIRED'),
  'RESTORE_AUDIT_REQUIREMENT_MISSING');
must(!mirrorCli.includes('--restore-audit='), 'RESTORE_AUDIT_STILL_IN_PRODUCTION_CLI');

const restoreCli = read('scripts/database/production-object-restore-audit-cli.js');
must(restoreCli.includes('--authorize-restore-audit=YES'),
  'RESTORE_AUDIT_AUTHORIZATION_MISSING');
must(restoreCli.includes("readOssConfig(auditEnvironment, 'AUDIT_')"),
  'RESTORE_AUDIT_CREDENTIAL_SEPARATION_MISSING');
must(restoreCli.includes('INDEPENDENT_OBJECT_RESTORE_AUDIT=PASS'),
  'RESTORE_AUDIT_PASS_MARKER_MISSING');

const productionRunner = read('scripts/database/run-production-object-mirror.sh');
must(!productionRunner.includes('--restore-audit='),
  'RESTORE_AUDIT_STILL_IN_PRODUCTION_RUNNER');
must(productionRunner.includes('PRODUCTION_OBJECT_MIRROR_RUNNER=PASS'),
  'MIRROR_RUNNER_PASS_MARKER_MISSING');

const service = read('scripts/systemd/xingxingzaishan-object-mirror.service');
must(!service.includes('restore-audit'), 'RESTORE_AUDIT_STILL_IN_DAILY_SERVICE');
must(!exists('scripts/systemd/xingxingzaishan-object-mirror-full-audit.service'),
  'PRODUCTION_FULL_AUDIT_SERVICE_STILL_PRESENT');
must(!exists('scripts/systemd/xingxingzaishan-object-mirror-full-audit.timer'),
  'PRODUCTION_FULL_AUDIT_TIMER_STILL_PRESENT');

const installer = read('scripts/database/install-production-object-mirror-systemd.sh');
must(installer.includes('SYSTEMD_RESTORE_AUDIT_LOCATION=INDEPENDENT_HOST_NOT_INSTALLED_HERE'),
  'INDEPENDENT_RESTORE_LOCATION_MARKER_MISSING');
must(!installer.includes('object-mirror-full-audit'),
  'FULL_AUDIT_STILL_IN_PRODUCTION_INSTALLER');

const tests = read('tests/production-object-mirror.test.js');
for (const title of [
  'write-only uploader accepts a PUT receipt without destination read permission',
  'write-only mirror copies objects without reading destination bytes or metadata',
  'independent restore audit preflight uses a separate read-only credential contract',
  'restore audit downloads secondary bytes and rejects an integrity mismatch'
]) must(tests.includes(title), `REGRESSION_MISSING_${title.replace(/[^A-Za-z0-9]+/g, '_')}`);

must(exists('src/miniprogram/assets/brand/star-logo.png'), 'BRAND_LOGO_ASSET_MISSING');
process.stdout.write('TARGET_OBJECT_MIRROR_TRUST_BOUNDARY_CONTRACT=PASS\n');
NODE
}

assert_target_syntax() {
  local file
  for file in \
    scripts/database/audit-production-source-oss-public-dependencies.js \
    scripts/database/production-object-mirror-cli.js \
    scripts/database/production-object-mirror.js \
    scripts/database/production-object-restore-audit-cli.js \
    scripts/database/remediate-production-source-oss-logo-reference.js \
    scripts/database/source-oss-private-switch.js; do
    "$NODE_BIN" --check "$file" >/dev/null || fail TARGET_NODE_SYNTAX_INVALID
  done
  for file in \
    scripts/database/configure-production-object-mirror-destination.sh \
    scripts/database/install-production-object-mirror-systemd.sh \
    scripts/database/run-production-object-mirror.sh \
    scripts/database/run-production-source-oss-logo-remediation.sh \
    scripts/database/run-production-source-oss-private-switch.sh \
    scripts/database/run-production-source-oss-public-dependency-audit.sh; do
    bash -n "$file" || fail TARGET_SHELL_SYNTAX_INVALID
  done
  printf 'TARGET_SCRIPT_SYNTAX=PASS\n'
}

rollback_checkout() {
  local rollback_ok=YES
  ROLLBACK_IN_PROGRESS=YES
  trap - ERR
  set +e
  cd "$REPO" || rollback_ok=NO
  if [ "$rollback_ok" = YES ]; then
    git checkout --detach "$EXPECTED_PREVIOUS_COMMIT" >/dev/null 2>&1 || rollback_ok=NO
  fi
  if [ "$rollback_ok" = YES ]; then
    [ "$(git rev-parse HEAD)" = "$EXPECTED_PREVIOUS_COMMIT" ] || rollback_ok=NO
  fi
  if [ "$rollback_ok" = YES ]; then
    [ "$(application_pid 2>/dev/null)" = "$APP_PID_BEFORE" ] || rollback_ok=NO
  fi
  if [ "$rollback_ok" = YES ]; then
    (assert_readiness_contract) >/dev/null 2>&1 || rollback_ok=NO
  fi
  if [ "$rollback_ok" = YES ]; then
    printf 'APPLICATION_ROLLBACK=PASS_CHECKOUT_ONLY\n' >&2
  else
    printf 'APPLICATION_ROLLBACK=FAIL\nMANUAL_RECOVERY_REQUIRED=YES\n' >&2
  fi
  set -e
}

emit_failure() {
  local exit_code="$1"
  local line_number="$2"
  trap - ERR
  printf 'PRODUCTION_OBJECT_MIRROR_TRUST_BOUNDARY_DEPLOYMENT=FAIL\n' >&2
  printf 'ERROR_CODE=%s\nFAILURE_LINE=%s\n' "$LAST_ERROR_CODE" "$line_number" >&2
  if [ "$CHECKOUT_STARTED" = YES ] && [ "$ROLLBACK_IN_PROGRESS" = NO ]; then
    rollback_checkout
  else
    printf 'APPLICATION_ROLLBACK=NOT_REQUIRED\n' >&2
  fi
  exit "$exit_code"
}

fail() {
  LAST_ERROR_CODE="$1"
  emit_failure 1 "${BASH_LINENO[0]:-0}"
}

on_error() {
  local exit_code="$1"
  local line_number="$2"
  emit_failure "$exit_code" "$line_number"
}

trap 'on_error $? $LINENO' ERR

[ "$#" = 1 ] || fail DEPLOY_ARGUMENT_INVALID
case "${1:-}" in
  --preflight) MODE=preflight ;;
  --authorize-deploy=YES) MODE=deploy ;;
  *) fail DEPLOY_AUTHORIZATION_REQUIRED ;;
esac

[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED

require_command git GIT
require_command pm2 PM2
require_command node NODE
require_command curl CURL
require_command flock FLOCK
require_command sha256sum SHA256SUM
require_command bash BASH
require_command sed SED
require_command sort SORT
require_command wc WC
require_command stat STAT
require_command install INSTALL
require_command awk AWK

NODE_BIN="$(command -v node)"
NODE_VERSION="$($NODE_BIN -p 'process.versions.node')"
IFS=. read -r NODE_MAJOR NODE_MINOR NODE_PATCH <<< "$NODE_VERSION"
[[ "$NODE_MAJOR" =~ ^[0-9]+$ && "$NODE_MINOR" =~ ^[0-9]+$ && "$NODE_PATCH" =~ ^[0-9]+$ ]] \
  || fail NODE_VERSION_INVALID
if [ "$NODE_MAJOR" -lt 20 ] || { [ "$NODE_MAJOR" -eq 20 ] && [ "$NODE_MINOR" -lt 9 ]; }; then
  fail NODE_VERSION_UNSUPPORTED_REQUIRES_20_9_0
fi
printf 'NODE_VERSION=PASS_GE_20_9_0\n'

exec 9>"$DEPLOY_LOCK"
flock -n 9 || fail DEPLOYMENT_ALREADY_RUNNING

[ -d "$REPO/.git" ] || fail PRODUCTION_REPOSITORY_MISSING
cd "$REPO"

git diff --quiet || fail TRACKED_WORKTREE_DIRTY
git diff --cached --quiet || fail TRACKED_INDEX_DIRTY
assert_clean_worktree WORKTREE_NOT_CLEAN
assert_root_private_regular_file "$ENV_FILE" || fail ENV_FILE_UNSAFE
[ -f "$PM2_DUMP" ] || fail PM2_DUMP_MISSING

git fetch --no-tags origin main || fail REMOTE_FETCH_FAILED
[ "$(git rev-parse origin/main)" = "$TARGET_COMMIT" ] || fail REMOTE_MAIN_MISMATCH
[ "$(git cat-file -t "$TARGET_COMMIT")" = commit ] || fail TARGET_COMMIT_MISSING
[ "$(git rev-parse "$TARGET_COMMIT^{tree}")" = "$TARGET_TREE" ] || fail TARGET_TREE_MISMATCH
[ "$(git rev-parse "$EXPECTED_PREVIOUS_COMMIT^{tree}")" = "$EXPECTED_PREVIOUS_TREE" ] \
  || fail PREVIOUS_TREE_MISMATCH
[ "$(git rev-parse HEAD)" = "$EXPECTED_PREVIOUS_COMMIT" ] || fail ACTIVE_COMMIT_MISMATCH
[ "$(git rev-parse 'HEAD^{tree}')" = "$EXPECTED_PREVIOUS_TREE" ] || fail ACTIVE_TREE_MISMATCH

assert_exact_commit_chain
assert_exact_target_diff
assert_target_acceptance_contract

APP_PID_BEFORE="$(application_pid)" || fail PM2_APPLICATION_OR_RUNTIME_INVALID
printf 'APP_PID_BEFORE=%s\n' "$APP_PID_BEFORE"
assert_recent_backup
assert_readiness_contract

printf 'PREVIOUS_DEPLOYED_COMMIT_CAPTURED=%s\n' "$EXPECTED_PREVIOUS_COMMIT"
printf 'PREVIOUS_DEPLOYED_TREE_CAPTURED=%s\n' "$EXPECTED_PREVIOUS_TREE"
printf 'TARGET_COMMIT_VERIFIED=%s\n' "$TARGET_COMMIT"
printf 'TARGET_TREE_VERIFIED=%s\n' "$TARGET_TREE"

if [ "$MODE" = preflight ]; then
  trap - ERR
  printf 'PRODUCTION_CODE_CHANGED=NO\n'
  printf 'APPLICATION_RESTART=NO\n'
  printf 'ENV_FILE_CHANGED=NO\n'
  printf 'PM2_DUMP_CHANGED=NO\n'
  printf 'DATABASE_WRITE=NONE\n'
  printf 'OSS_REQUESTS=NONE\n'
  printf 'BLOCKCHAIN_WRITE=NONE\n'
  printf 'OBJECT_MIRROR_CONFIGURATION_WRITE=NONE\n'
  printf 'OBJECT_MIRROR_RUN=NOT_EXECUTED\n'
  printf 'OBJECT_MIRROR_SYSTEMD_INSTALL=NOT_EXECUTED\n'
  printf 'READY_FOR_DEPLOYMENT=YES\n'
  printf 'PRODUCTION_OBJECT_MIRROR_TRUST_BOUNDARY_DEPLOYMENT_PREFLIGHT=PASS\n'
  exit 0
fi

ENV_SHA256_BEFORE="$(sha256sum "$ENV_FILE" | awk '{print $1}')"
PM2_DUMP_SHA256_BEFORE="$(sha256sum "$PM2_DUMP" | awk '{print $1}')"

CHECKOUT_STARTED=YES
git checkout --detach "$TARGET_COMMIT" || fail TARGET_CHECKOUT_FAILED
[ "$(git rev-parse HEAD)" = "$TARGET_COMMIT" ] || fail DEPLOYED_COMMIT_MISMATCH
[ "$(git rev-parse 'HEAD^{tree}')" = "$TARGET_TREE" ] || fail DEPLOYED_TREE_MISMATCH
assert_target_syntax

APP_PID_AFTER="$(application_pid)" || fail PM2_APPLICATION_OR_RUNTIME_INVALID
[ "$APP_PID_AFTER" = "$APP_PID_BEFORE" ] || fail APP_PID_CHANGED_UNEXPECTEDLY
assert_readiness_contract

git diff --quiet || fail FINAL_TRACKED_WORKTREE_DIRTY
git diff --cached --quiet || fail FINAL_TRACKED_INDEX_DIRTY
assert_clean_worktree FINAL_WORKTREE_NOT_CLEAN
[ "$(sha256sum "$ENV_FILE" | awk '{print $1}')" = "$ENV_SHA256_BEFORE" ] \
  || fail ENV_FILE_CHANGED
[ "$(sha256sum "$PM2_DUMP" | awk '{print $1}')" = "$PM2_DUMP_SHA256_BEFORE" ] \
  || fail PM2_DUMP_CHANGED

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
AUDIT_DIR="$AUDIT_ROOT/$RUN_ID"
install -d -o root -g root -m 0700 "$AUDIT_DIR"
printf '%s\n' \
  "DEPLOYED_COMMIT=$TARGET_COMMIT" \
  "DEPLOYED_TREE=$TARGET_TREE" \
  "ROLLBACK_TARGET=$EXPECTED_PREVIOUS_COMMIT" \
  'APPLICATION_RESTART=NO' \
  'ENV_FILE_CHANGED=NO' \
  'PM2_DUMP_CHANGED=NO' \
  'DATABASE_MIGRATION_EXECUTED=NO' \
  'DATABASE_WRITE_BY_RUNNER=NONE' \
  'OSS_REQUESTS_BY_RUNNER=NONE' \
  'OBJECT_MIRROR_CONFIGURATION_WRITE=NONE' \
  'OBJECT_MIRROR_RUN=NOT_EXECUTED' \
  'OBJECT_MIRROR_SYSTEMD_INSTALL=NOT_EXECUTED' \
  'RESULT=PASS' > "$AUDIT_DIR/deployment-summary.txt"
chmod 0600 "$AUDIT_DIR/deployment-summary.txt"

CHECKOUT_STARTED=NO
trap - ERR

printf 'PRODUCTION_CODE_CHANGED=YES_CHECKOUT_ONLY\n'
printf 'APPLICATION_RESTART=NO\n'
printf 'APP_PID_AFTER=%s\n' "$APP_PID_AFTER"
printf 'ENV_FILE_CHANGED=NO\n'
printf 'PM2_DUMP_CHANGED=NO\n'
printf 'DATABASE_MIGRATION_EXECUTED=NO\n'
printf 'DATABASE_WRITE_BY_RUNNER=NONE\n'
printf 'OSS_REQUESTS_BY_RUNNER=NONE\n'
printf 'BLOCKCHAIN_WRITE_BY_RUNNER=NONE\n'
printf 'OBJECT_MIRROR_CONFIGURATION_WRITE=NONE\n'
printf 'OBJECT_MIRROR_RUN=NOT_EXECUTED\n'
printf 'OBJECT_MIRROR_SYSTEMD_INSTALL=NOT_EXECUTED\n'
printf 'DEPLOYED_COMMIT=%s\n' "$TARGET_COMMIT"
printf 'DEPLOYED_TREE=%s\n' "$TARGET_TREE"
printf 'ROLLBACK_TARGET=%s\n' "$EXPECTED_PREVIOUS_COMMIT"
printf 'AUDIT_DIRECTORY=%s\n' "$AUDIT_DIR"
printf 'SECRET_VALUES_PRINTED=NO\n'
printf 'READY_FOR_OBJECT_MIRROR_DESTINATION_CONFIGURATION=YES\n'
printf 'PRODUCTION_OBJECT_MIRROR_TRUST_BOUNDARY_DEPLOYMENT=PASS\n'
