#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

TARGET_COMMIT=93a2471d612091ee00669692306630b79f8cb95f
TARGET_TREE=d332bd930da0dcc8cd4041d5644e2189016fd620
EXPECTED_PREVIOUS_COMMIT=2c1d6b4a372f9dbbb8093ccf5649ff243fee8239
EXPECTED_PREVIOUS_TREE=c7f156352d1ffd4091fadcd43e4d30a07a8b1d55

REPO=/www/wwwroot/xingxingzaishan
ENV_FILE="$REPO/.env"
PM2_DUMP=/root/.pm2/dump.pm2
LOCAL_READY_URL=http://127.0.0.1:3000/api/health/ready
EXTERNAL_READY_URL=https://xingxingzaishan.top/api/health/ready
LOCAL_ADMIN_BASE_URL=http://127.0.0.1:3000
EXTERNAL_ADMIN_BASE_URL=https://xingxingzaishan.top
DEPLOY_LOCK=/run/lock/xingxingzaishan-production-deploy.lock
AUDIT_ROOT=/root/production-admin-qr-print-workflow-deployment

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
  actual="$(git rev-list --reverse "$EXPECTED_PREVIOUS_COMMIT..$TARGET_COMMIT")"
  [ "$actual" = "$TARGET_COMMIT" ] || fail TARGET_COMMIT_CHAIN_MISMATCH
  printf 'TARGET_ADMIN_QR_PRINT_WORKFLOW_COMMIT_CHAIN=PASS_EXACT_1\n'
}

assert_exact_target_diff() {
  local actual
  local expected
  actual="$(git diff --name-only "$EXPECTED_PREVIOUS_COMMIT" "$TARGET_COMMIT" | LC_ALL=C sort)"
  expected="$(printf '%s\n' \
    src/admin/css/admin.css \
    src/admin/index.html \
    src/admin/js/admin.js \
    src/admin/js/print-batch-admin.js \
    tests/api.test.js \
    tests/print-batch-service.test.js \
    | LC_ALL=C sort)"
  [ "$actual" = "$expected" ] || fail TARGET_FILE_SET_MISMATCH
  [ "$(printf '%s\n' "$actual" | sed '/^$/d' | wc -l | tr -d ' ')" = 6 ] \
    || fail TARGET_FILE_COUNT_MISMATCH
  git diff --quiet "$EXPECTED_PREVIOUS_COMMIT" "$TARGET_COMMIT" -- \
    src/server migrations \
    || fail SERVER_OR_DATABASE_DELTA_UNEXPECTED
  git diff --quiet "$EXPECTED_PREVIOUS_COMMIT" "$TARGET_COMMIT" -- \
    package.json package-lock.json \
    || fail DEPENDENCY_MANIFEST_DELTA_UNEXPECTED
  printf 'TARGET_FILE_SET=PASS_EXACT_6\n'
  printf 'SERVER_CODE_DELTA=NONE\n'
  printf 'DATABASE_MIGRATION_DELTA=NONE\n'
  printf 'DEPENDENCY_MANIFEST_DELTA=NONE\n'
}

assert_target_acceptance_contract() {
  "$NODE_BIN" - "$TARGET_COMMIT" <<'NODE' \
    || fail TARGET_ADMIN_QR_PRINT_WORKFLOW_CONTRACT_INVALID
const { execFileSync } = require('node:child_process');
const commit = process.argv[2];
const read = (file) => execFileSync('git', ['show', `${commit}:${file}`], {
  encoding: 'utf8'
});
const must = (condition, code) => {
  if (!condition) {
    process.stderr.write(`${code}\n`);
    process.exit(1);
  }
};

const html = read('src/admin/index.html');
for (const marker of [
  'class="workflow-overview"',
  'id="recordManagementModal"',
  'id="batchPrintModal"',
  'id="showPrintBatchCreateBtn"',
  'id="printBatchProgress"',
  'id="printBatchDangerZone"'
]) must(html.includes(marker), `ADMIN_HTML_MARKER_MISSING_${marker}`);

const adminJs = read('src/admin/js/admin.js');
for (const marker of [
  'const MAX_PRINT_BATCH_SIZE = 500;',
  'function setRecordView(view)',
  'async function createPrintBatchFromCurrentBatch()',
  'function continueBatchPrint(sourceBatchId)',
  'eligibleIds.slice(0, MAX_PRINT_BATCH_SIZE)',
  'remainingCount'
]) must(adminJs.includes(marker), `ADMIN_JS_MARKER_MISSING_${marker}`);

const printJs = read('src/admin/js/print-batch-admin.js');
for (const marker of [
  'continuationContext: null',
  'function renderProgress(status)',
  'function renderActions()',
  'function openWithQrIds(ids, context = null)',
  'window.AdminQrProduction.continueBatchPrint'
]) must(printJs.includes(marker), `PRINT_JS_MARKER_MISSING_${marker}`);

const css = read('src/admin/css/admin.css');
for (const marker of [
  '.workflow-overview',
  '.record-selection-bar',
  '.print-progress',
  '.danger-zone'
]) must(css.includes(marker), `ADMIN_CSS_MARKER_MISSING_${marker}`);

const printTests = read('tests/print-batch-service.test.js');
for (const marker of [
  'id="batchPrintModal"',
  'eligibleIds\\.slice\\(0, MAX_PRINT_BATCH_SIZE\\)',
  'id="printBatchProgress"',
  'id="printBatchDangerZone"'
]) must(printTests.includes(marker), `PRINT_TEST_MARKER_MISSING_${marker}`);

const apiTests = read('tests/api.test.js');
must(apiTests.includes('class="workflow-overview"'),
  'ADMIN_WORKFLOW_REGRESSION_MISSING');

process.stdout.write('TARGET_ADMIN_QR_PRINT_WORKFLOW_CONTRACT=PASS\n');
NODE
}

assert_target_syntax() {
  local file
  for file in \
    src/admin/js/admin.js \
    src/admin/js/print-batch-admin.js \
    tests/api.test.js \
    tests/print-batch-service.test.js; do
    "$NODE_BIN" --check "$file" >/dev/null || fail TARGET_NODE_SYNTAX_INVALID
  done
  printf 'TARGET_SCRIPT_SYNTAX=PASS\n'
}

url_sha256() {
  curl -fsS --connect-timeout 5 --max-time 20 --retry 0 "$1" \
    | sha256sum | awk '{print $1}'
}

assert_static_file_deployed() {
  local path="$1"
  local file="$2"
  local cache_key
  local expected
  local actual
  cache_key="$(git rev-parse HEAD)"
  expected="$(sha256sum "$file" | awk '{print $1}')"
  actual="$(url_sha256 "$LOCAL_ADMIN_BASE_URL$path?deployment=$cache_key")" \
    || fail LOCAL_ADMIN_STATIC_ASSET_FETCH_FAILED
  [ "$actual" = "$expected" ] || fail LOCAL_ADMIN_STATIC_ASSET_MISMATCH
  actual="$(url_sha256 "$EXTERNAL_ADMIN_BASE_URL$path?deployment=$cache_key")" \
    || fail EXTERNAL_ADMIN_STATIC_ASSET_FETCH_FAILED
  [ "$actual" = "$expected" ] || fail EXTERNAL_ADMIN_STATIC_ASSET_MISMATCH
}

assert_admin_static_assets() {
  assert_static_file_deployed /admin/index.html src/admin/index.html
  assert_static_file_deployed /admin/css/admin.css src/admin/css/admin.css
  assert_static_file_deployed /admin/js/admin.js src/admin/js/admin.js
  assert_static_file_deployed \
    /admin/js/print-batch-admin.js src/admin/js/print-batch-admin.js
  printf 'ADMIN_STATIC_ASSETS=PASS_LOCAL_AND_EXTERNAL_EXACT\n'
}

rollback_checkout() {
  local rollback_ok=YES
  ROLLBACK_IN_PROGRESS=YES
  trap - ERR
  set +e
  printf 'ROLLBACK_TARGET=%s\n' "$EXPECTED_PREVIOUS_COMMIT" >&2
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
    (assert_admin_static_assets) >/dev/null 2>&1 || rollback_ok=NO
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
  printf 'PRODUCTION_ADMIN_QR_PRINT_WORKFLOW_DEPLOYMENT=FAIL\n' >&2
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
require_command sed SED
require_command sort SORT
require_command wc WC
require_command stat STAT
require_command install INSTALL
require_command awk AWK
require_command chmod CHMOD

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
[ "$(git rev-parse "$TARGET_COMMIT^{tree}")" = "$TARGET_TREE" ] \
  || fail TARGET_TREE_MISMATCH
[ "$(git rev-parse "$EXPECTED_PREVIOUS_COMMIT^{tree}")" = "$EXPECTED_PREVIOUS_TREE" ] \
  || fail PREVIOUS_TREE_MISMATCH
[ "$(git rev-parse HEAD)" = "$EXPECTED_PREVIOUS_COMMIT" ] \
  || fail ACTIVE_COMMIT_MISMATCH
[ "$(git rev-parse 'HEAD^{tree}')" = "$EXPECTED_PREVIOUS_TREE" ] \
  || fail ACTIVE_TREE_MISMATCH

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
  printf 'DEPENDENCY_INSTALL=NOT_REQUIRED_MANIFESTS_UNCHANGED\n'
  printf 'DATABASE_WRITE=NONE\n'
  printf 'OSS_REQUESTS=NONE\n'
  printf 'BLOCKCHAIN_WRITE=NONE\n'
  printf 'SECRET_VALUES_PRINTED=NO\n'
  printf 'READY_FOR_DEPLOYMENT=YES\n'
  printf 'PRODUCTION_ADMIN_QR_PRINT_WORKFLOW_DEPLOYMENT_PREFLIGHT=PASS\n'
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
assert_admin_static_assets

[ "$(git rev-parse HEAD)" = "$TARGET_COMMIT" ] || fail FINAL_COMMIT_MISMATCH
[ "$(git rev-parse 'HEAD^{tree}')" = "$TARGET_TREE" ] || fail FINAL_TREE_MISMATCH
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
  'DEPENDENCY_INSTALL=NOT_REQUIRED_MANIFESTS_UNCHANGED' \
  'DATABASE_MIGRATION_EXECUTED=NO' \
  'DATABASE_WRITE_BY_RUNNER=NONE' \
  'OSS_REQUESTS_BY_RUNNER=NONE' \
  'BLOCKCHAIN_WRITE_BY_RUNNER=NONE' \
  'ADMIN_STATIC_ASSETS=PASS_LOCAL_AND_EXTERNAL_EXACT' \
  'RESULT=PASS' > "$AUDIT_DIR/deployment-summary.txt"
chmod 0600 "$AUDIT_DIR/deployment-summary.txt"

CHECKOUT_STARTED=NO
trap - ERR

printf 'PRE_DEPLOYMENT_BACKUP=PASS_RECENT_WITHIN_2_HOURS\n'
printf 'PRODUCTION_CODE_CHANGED=YES_CHECKOUT_ONLY\n'
printf 'APPLICATION_RESTART=NO\n'
printf 'APP_PID_AFTER=%s\n' "$APP_PID_AFTER"
printf 'ENV_FILE_CHANGED=NO\n'
printf 'PM2_DUMP_CHANGED=NO\n'
printf 'DEPENDENCY_INSTALL=NOT_REQUIRED_MANIFESTS_UNCHANGED\n'
printf 'DATABASE_MIGRATION_EXECUTED=NO\n'
printf 'DATABASE_WRITE_BY_RUNNER=NONE\n'
printf 'OSS_REQUESTS_BY_RUNNER=NONE\n'
printf 'BLOCKCHAIN_WRITE_BY_RUNNER=NONE\n'
printf 'DEPLOYED_COMMIT=%s\n' "$TARGET_COMMIT"
printf 'DEPLOYED_TREE=%s\n' "$TARGET_TREE"
printf 'ROLLBACK_TARGET=%s\n' "$EXPECTED_PREVIOUS_COMMIT"
printf 'AUDIT_DIRECTORY=%s\n' "$AUDIT_DIR"
printf 'SECRET_VALUES_PRINTED=NO\n'
printf 'READY_FOR_ADMIN_QR_PRINT_WORKFLOW_SMOKE_TEST=YES\n'
printf 'PRODUCTION_ADMIN_QR_PRINT_WORKFLOW_DEPLOYMENT=PASS\n'
