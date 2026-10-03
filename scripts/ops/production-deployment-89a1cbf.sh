#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

TARGET_COMMIT=89a1cbf08d73fdc16a1a1b3f458e791bbd7a4af6
TARGET_TREE=41465a0f82fd388a63363d4d947851fb70a85452
EXPECTED_PREVIOUS_COMMIT=749f3fdb2beecb773cc8e6845b5022b3cdf1df2c
EXPECTED_PREVIOUS_TREE=fe871b6816d09bfd0e1d5bf8b609c0d807660289
EXPECTED_PACKAGE_BLOB=903a53f5f46f89460dab815b43c254620c23252d
EXPECTED_PACKAGE_LOCK_BLOB=fce309dbf39857c5435d033ed11d6e1885b08275

REPO=/www/wwwroot/xingxingzaishan
APP_NAME=xingxingzaishan
ENV_FILE="$REPO/.env"
BACKUP_RUNNER="$REPO/scripts/database/run-production-backup.sh"
EXPECTED_PASSWORD_FILE=/etc/xingxingzaishan/postgresql-clean-baseline-20260812.password
LOCAL_ROOT_URL=http://127.0.0.1:3000/
LOCAL_READY_URL=http://127.0.0.1:3000/api/health/ready
EXTERNAL_ROOT_URL=https://xingxingzaishan.top/
EXTERNAL_READY_URL=https://xingxingzaishan.top/api/health/ready
LOCAL_RECORD_JS_URL=http://127.0.0.1:3000/js/record.js
EXTERNAL_RECORD_JS_URL=https://xingxingzaishan.top/js/record.js
LOCAL_ME_JS_URL=http://127.0.0.1:3000/js/me.js
EXTERNAL_ME_JS_URL=https://xingxingzaishan.top/js/me.js
LOCAL_INVALID_RECORD_URL=http://127.0.0.1:3000/api/qr/SECURITY_DEPLOYMENT_INVALID_CREDENTIAL
EXTERNAL_INVALID_RECORD_URL=https://xingxingzaishan.top/api/qr/SECURITY_DEPLOYMENT_INVALID_CREDENTIAL
LOCAL_INVALID_SHARE_URL=http://127.0.0.1:3000/api/nft/SECURITY_DEPLOYMENT_INVALID_CREDENTIAL/share-meta
EXTERNAL_INVALID_SHARE_URL=https://xingxingzaishan.top/api/nft/SECURITY_DEPLOYMENT_INVALID_CREDENTIAL/share-meta
LOCAL_INVALID_QR_IMAGE_URL=http://127.0.0.1:3000/api/qr/image/SECURITY_DEPLOYMENT_INVALID_CREDENTIAL
EXTERNAL_INVALID_QR_IMAGE_URL=https://xingxingzaishan.top/api/qr/image/SECURITY_DEPLOYMENT_INVALID_CREDENTIAL
DEPLOY_LOCK=/run/lock/xingxingzaishan-production-deploy.lock
AUDIT_ROOT=/root/production-system-acceptance-deployment
PM2_DUMP=/root/.pm2/dump.pm2
PRODUCTION_DATABASE=xingxing_clean_baseline_20260812_staging

MODE=
CHECKOUT_STARTED=NO
ROLLBACK_IN_PROGRESS=NO
LAST_ERROR_CODE=UNCLASSIFIED_FAILURE
ENV_SHA256_BEFORE=
PM2_DUMP_SHA256_BEFORE=
RUN_ID=
DEPLOY_RUNTIME_ROOT=
DEPENDENCY_STAGE=
NODE_MODULES_BACKUP=
NODE_MODULES_BACKED_UP=NO
DEPENDENCIES_SWAPPED=NO

fail() {
  LAST_ERROR_CODE="$1"
  printf 'PRODUCTION_SYSTEM_ACCEPTANCE_DEPLOYMENT=FAIL\nERROR_CODE=%s\n' "$1" >&2
  if declare -F on_error >/dev/null 2>&1; then
    on_error 1 "${BASH_LINENO[0]:-0}"
  fi
  exit 1
}

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

http_code() {
  curl -sS -o /dev/null -w '%{http_code}' \
    --connect-timeout 5 --max-time 15 --retry 0 "$1"
}

wait_for_http_200() {
  local url="$1"
  local attempts="$2"
  local delay="$3"
  local code=
  local attempt
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    code="$(http_code "$url" 2>/dev/null || true)"
    if [ "$code" = 200 ]; then
      return 0
    fi
    sleep "$delay"
  done
  return 1
}

application_record() {
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
if (String(state.PGDATABASE || "") !== "xingxing_clean_baseline_20260812_staging") process.exit(7);
if (String(state.PGPASSWORD_FILE || "") !== "/etc/xingxingzaishan/postgresql-clean-baseline-20260812.password") process.exit(8);
if (String(state.CHAIN_ENABLED || "") !== "true") process.exit(9);
if (String(state.RECORD_PROOF_RUNTIME_ENABLED || "") !== "true") process.exit(10);
if (String(state.RECORD_PROOF_RUNTIME_SCOPE || "") !== "all") process.exit(11);
if (!row.pid || Number(row.pid) <= 0) process.exit(12);
process.stdout.write(`${row.pm_id}\t${row.pid}`);
'
}

application_pid() {
  local record
  local pm2_id
  local app_pid
  record="$(application_record)" || return 1
  IFS=$'\t' read -r pm2_id app_pid <<< "$record"
  printf '%s' "$app_pid"
}

validate_env_contract() {
  local app_pid="$1"
  "$NODE_BIN" - "$ENV_FILE" "$app_pid" <<'NODE'
const fs = require('node:fs');
const dotenv = require('dotenv');
const envFile = process.argv[2];
const pid = process.argv[3];
const fileValues = dotenv.parse(fs.readFileSync(envFile));
const processValues = Object.create(null);
for (const entry of fs.readFileSync(`/proc/${pid}/environ`).toString('utf8').split('\0')) {
  if (!entry) continue;
  const separator = entry.indexOf('=');
  if (separator > 0) processValues[entry.slice(0, separator)] = entry.slice(separator + 1);
}
const values = { ...fileValues, ...processValues };
function stop(code) {
  process.stderr.write(`ENVIRONMENT_VALIDATION=FAIL\nERROR_CODE=${code}\n`);
  process.exit(1);
}
function requirePositiveInteger(name, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = values[name];
  if (raw === undefined || String(raw).trim() === '') return;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    stop(`${name}_INVALID`);
  }
}
function safeBaseUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'https:' && Boolean(parsed.hostname)
      && !parsed.username && !parsed.password && parsed.pathname === '/'
      && !parsed.search && !parsed.hash;
  } catch (_error) {
    return false;
  }
}
if (values.NODE_ENV !== 'production') stop('NODE_ENV_NOT_PRODUCTION');
if (!['prod', 'production'].includes(values.AVATA_ENV)) stop('AVATA_ENV_NOT_PRODUCTION');
const base = String(values.AVATA_API_BASE || '').replace(/\/$/, '');
if (base && base !== 'https://apis.avata.bianjie.ai') stop('AVATA_API_BASE_INVALID');
if (!String(values.AVATA_API_KEY || '').trim()) stop('AVATA_API_KEY_MISSING');
if (!String(values.AVATA_API_SECRET || '').trim()) stop('AVATA_API_SECRET_MISSING');
if (values.STORAGE_MODE !== 'cloud') stop('STORAGE_MODE_NOT_CLOUD');
for (const key of ['OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET', 'OSS_BUCKET',
  'OSS_REGION', 'OSS_ENDPOINT']) {
  if (!String(values[key] || '').trim()) stop(`${key}_MISSING`);
}
if (!/^[a-f0-9]{64}$/.test(String(values.AUTH_SECRET || ''))) stop('AUTH_SECRET_NOT_HEX64');
if (String(values.UPLOAD_PROOF_SECRET || '').length < 32) stop('UPLOAD_PROOF_SECRET_TOO_SHORT');
if (values.AUTH_SECRET === values.UPLOAD_PROOF_SECRET) stop('SECURITY_SECRETS_MUST_DIFFER');
if (!safeBaseUrl(values.BASE_URL)) stop('BASE_URL_INVALID');
if (String(values.CLOUD_FALLBACK_TO_LOCAL || '').trim().toLowerCase() === 'true') {
  stop('CLOUD_FALLBACK_TO_LOCAL_ENABLED');
}
if (String(values.USER_LEGACY_LOGIN_ENABLED || '').trim().toLowerCase() !== 'false') {
  stop('USER_LEGACY_LOGIN_ENABLED');
}
if (String(values.USER_SESSION_SECURE || '').trim().toLowerCase() !== 'true') {
  stop('USER_SESSION_SECURE_DISABLED');
}
if (!['lax', 'strict'].includes(String(values.USER_SESSION_SAMESITE || 'Lax').trim().toLowerCase())) {
  stop('USER_SESSION_SAMESITE_INVALID');
}
if (String(values.SMS_PROVIDER || '').trim().toLowerCase() !== 'aliyun') stop('SMS_PROVIDER_INVALID');
for (const key of [
  'SMS_ACCESS_KEY_ID', 'SMS_ACCESS_KEY_SECRET', 'SMS_SIGN_NAME', 'SMS_TEMPLATE_CODE',
  'WECHAT_MINIAPP_APPID', 'WECHAT_MINIAPP_SECRET'
]) {
  if (!String(values[key] || '').trim()) stop(`${key}_MISSING`);
}
requirePositiveInteger('PORT', { maximum: 65535 });
for (const key of [
  'AUTH_TOKEN_TTL_SECONDS', 'MINIAPP_TOKEN_TTL_SECONDS', 'USER_SESSION_TTL_SECONDS',
  'SMS_CODE_TTL_MS', 'SMS_CODE_MAX_VERIFY_ATTEMPTS', 'RATE_LIMIT_LOGIN_WINDOW_MS',
  'RATE_LIMIT_LOGIN_MAX', 'RATE_LIMIT_WRITE_WINDOW_MS', 'RATE_LIMIT_WRITE_MAX',
  'OSS_SIGNED_URL_EXPIRES'
]) requirePositiveInteger(key);
requirePositiveInteger('SMS_SEND_COOLDOWN_MS', { minimum: 0 });
if (String(values.PGDATABASE || '') !== 'xingxing_clean_baseline_20260812_staging') {
  stop('PGDATABASE_UNEXPECTED');
}
process.stdout.write('ENVIRONMENT_VALIDATION=PASS\n');
process.stdout.write('AUTH_SECRET_STRENGTH=PASS_HEX64\n');
process.stdout.write('AVATA_ENVIRONMENT=PRODUCTION\n');
process.stdout.write('AVATA_ENDPOINT=PRODUCTION_ALLOWLISTED\n');
process.stdout.write('PRINT_ARTIFACT_STORAGE=PRIVATE_OSS_CONFIGURED\n');
process.stdout.write('BASE_URL=PASS_HTTPS_ORIGIN\n');
process.stdout.write('PRODUCTION_STORAGE_MODE=PASS_CLOUD_NO_LOCAL_FALLBACK\n');
process.stdout.write('PRODUCTION_SESSION_COOKIE=PASS_SECURE_SAMESITE\n');
process.stdout.write('SECRET_VALUES_PRINTED=NO\n');
NODE
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

assert_readiness_contract() {
  local local_code
  local external_code
  local_code="$(http_code "$LOCAL_READY_URL" 2>/dev/null || true)"
  external_code="$(http_code "$EXTERNAL_READY_URL" 2>/dev/null || true)"
  [ "$local_code" = "$external_code" ] || fail READINESS_ENDPOINTS_DISAGREE
  [ "$local_code" = 200 ] || fail READINESS_HTTP_INVALID
  printf 'CURRENT_READINESS=PASS_200_READY\n'
}

assert_exact_commit_chain() {
  [ "$(git rev-parse "$TARGET_COMMIT^")" = "$EXPECTED_PREVIOUS_COMMIT" ] \
    || fail TARGET_PARENT_MISMATCH
  local actual
  local expected
  actual="$(git rev-list --reverse "$EXPECTED_PREVIOUS_COMMIT..$TARGET_COMMIT")"
  expected="$TARGET_COMMIT"
  [ "$actual" = "$expected" ] || fail TARGET_COMMIT_CHAIN_MISMATCH
  printf 'TARGET_SYSTEM_ACCEPTANCE_COMMIT_CHAIN=PASS_EXACT_1\n'
}

assert_exact_target_diff() {
  local actual
  local expected
  actual="$(git diff --name-only "$EXPECTED_PREVIOUS_COMMIT" "$TARGET_COMMIT" | LC_ALL=C sort)"
  expected="$(printf '%s\n' \
    README.md \
    docs/PROJECT-REQUIREMENTS.md \
    docs/deploy.md \
    docs/manual-device-acceptance-20261002.md \
    docs/system-acceptance-20261001.md \
    package-lock.json \
    package.json \
    scripts/acceptance/local-runtime-soak.js \
    scripts/acceptance/read-running-postgres-client-config.js \
    scripts/acceptance/validate-object-mirror-state.js \
    scripts/acceptance/validate-running-production-config.js \
    scripts/database/install-production-object-mirror-systemd.sh \
    scripts/database/production-backup.js \
    scripts/database/production-object-mirror-cli.js \
    scripts/database/production-object-mirror.js \
    scripts/database/production-restore-drill.js \
    scripts/database/run-clean-postgres-candidate-e2e.sh \
    scripts/database/run-production-backup-scheduled.sh \
    scripts/database/run-production-backup.sh \
    scripts/database/run-production-object-mirror.sh \
    scripts/database/run-production-restore-drill.sh \
    scripts/database/run-system-acceptance-postgres-integration.sh \
    scripts/database/run-system-acceptance-production-observation.sh \
    scripts/systemd/xingxingzaishan-object-mirror.service \
    scripts/systemd/xingxingzaishan-object-mirror.timer \
    src/server/app.js \
    src/server/middlewares/rateLimit.js \
    src/server/middlewares/userSession.js \
    src/server/routes/admin.js \
    src/server/routes/miniapp.js \
    src/server/routes/qc.js \
    src/server/routes/qr.js \
    src/server/services/auditService.js \
    src/server/services/authService.js \
    src/server/services/chainProofService.js \
    src/server/services/configService.js \
    src/server/services/contentSafetyService.js \
    src/server/services/dbService.js \
    src/server/services/miniappAuthService.js \
    src/server/services/postgres/recordProofCertificateArchive.js \
    src/server/services/smsCodeService.js \
    src/server/services/smsProviderService.js \
    src/server/services/userSessionService.js \
    src/server/services/wechatPayService.js \
    src/server/utils/boundedResponse.js \
    tests/api.test.js \
    tests/audit-log-runtime.test.js \
    tests/database-infrastructure.test.js \
    tests/ephemeral-auth-state.test.js \
    tests/external-request-timeouts.test.js \
    tests/external-response-bounds.test.js \
    tests/local-runtime-soak.test.js \
    tests/postgresql-proof-certificate-archive.test.js \
    tests/postgresql-read-adapter.integration.test.js \
    tests/production-backup-schedule.test.js \
    tests/production-backup.test.js \
    tests/production-object-mirror.test.js \
    tests/provider-error-redaction.test.js \
    tests/qr-lifecycle-write-runtime.test.js \
    tests/rate-limit-runtime.test.js \
    tests/system-acceptance-postgres-runner.test.js \
    tests/system-acceptance-production-observation.test.js \
    tests/upload-proof.test.js \
    | LC_ALL=C sort)"
  [ "$actual" = "$expected" ] || fail TARGET_FILE_SET_MISMATCH
  [ "$(printf '%s\n' "$actual" | sed '/^$/d' | wc -l | tr -d ' ')" = 63 ] \
    || fail TARGET_FILE_COUNT_MISMATCH
  git diff --quiet "$EXPECTED_PREVIOUS_COMMIT" "$TARGET_COMMIT" -- \
    src/server/migrations migrations \
    || fail DATABASE_MIGRATION_DELTA_UNEXPECTED
  [ "$(git rev-parse "$TARGET_COMMIT:package.json")" = "$EXPECTED_PACKAGE_BLOB" ] \
    || fail PACKAGE_BLOB_MISMATCH
  [ "$(git rev-parse "$TARGET_COMMIT:package-lock.json")" = "$EXPECTED_PACKAGE_LOCK_BLOB" ] \
    || fail PACKAGE_LOCK_BLOB_MISMATCH
  printf 'TARGET_FILE_SET=PASS_EXACT_63\n'
}

assert_package_delta() {
  "$NODE_BIN" - "$EXPECTED_PREVIOUS_COMMIT" "$TARGET_COMMIT" <<'NODE'
const { execFileSync } = require('node:child_process');
const [oldCommit, newCommit] = process.argv.slice(2);
const read = (commit) => JSON.parse(execFileSync('git', ['show', `${commit}:package.json`], { encoding: 'utf8' }));
const oldPkg = read(oldCommit);
const newPkg = read(newCommit);
const unchangedKeys = ['name', 'version', 'private', 'type'];
if (unchangedKeys.some((key) => JSON.stringify(oldPkg[key]) !== JSON.stringify(newPkg[key]))) process.exit(2);
const oldDependencies = { ...(oldPkg.dependencies || {}) };
const newDependencies = { ...(newPkg.dependencies || {}) };
if (oldDependencies.sharp !== '^0.34.5' || newDependencies.sharp !== '^0.35.5') process.exit(3);
delete oldDependencies.sharp;
delete newDependencies.sharp;
if (JSON.stringify(oldDependencies) !== JSON.stringify(newDependencies)) process.exit(4);
if (oldPkg.overrides !== undefined) process.exit(5);
if (JSON.stringify(newPkg.overrides) !== JSON.stringify({
  'body-parser': '1.20.8',
  qs: '6.16.0',
  urllib: '2.44.1'
})) process.exit(6);
if (oldPkg.devDependencies !== undefined || newPkg.devDependencies !== undefined) process.exit(7);
const oldScripts = oldPkg.scripts || {};
const newScripts = newPkg.scripts || {};
for (const [name, value] of Object.entries(oldScripts)) {
  if (name === 'test') continue;
  if (newScripts[name] !== value) process.exit(8);
}
if (newScripts['acceptance:runtime-soak'] !== 'node --expose-gc scripts/acceptance/local-runtime-soak.js') process.exit(9);
if (newScripts['backup:objects:install-systemd']
    !== 'bash scripts/database/install-production-object-mirror-systemd.sh') process.exit(10);
const expectedExtraScripts = new Set(['acceptance:runtime-soak', 'backup:objects:install-systemd']);
for (const name of Object.keys(newScripts)) {
  if (name === 'test' || Object.hasOwn(oldScripts, name) || expectedExtraScripts.has(name)) continue;
  process.exit(11);
}
for (const requiredTest of [
  'tests/audit-log-runtime.test.js',
  'tests/ephemeral-auth-state.test.js',
  'tests/external-request-timeouts.test.js',
  'tests/external-response-bounds.test.js',
  'tests/production-object-mirror.test.js',
  'tests/provider-error-redaction.test.js',
  'tests/rate-limit-runtime.test.js',
  'tests/system-acceptance-postgres-runner.test.js',
  'tests/system-acceptance-production-observation.test.js'
]) {
  if (!String(newScripts.test || '').includes(requiredTest)) process.exit(12);
}
process.stdout.write('DEPENDENCY_MANIFEST_DELTA=CHANGED_NPM_CI_REQUIRED\n');
NODE
}

assert_target_acceptance_contract() {
  "$NODE_BIN" - "$TARGET_COMMIT" <<'NODE'
const { execFileSync } = require('node:child_process');
const commit = process.argv[2];
const read = (file) => execFileSync('git', ['show', `${commit}:${file}`], { encoding: 'utf8' });
const must = (condition, code) => { if (!condition) { process.stderr.write(`${code}\n`); process.exit(1); } };
const nft = read('src/server/routes/nft.js');
must(nft.includes('record.html?t=${encodeURIComponent(key)}'), 'NFT_SHARE_TOKEN_URL_MISSING');
must(!nft.includes('record.html?qr='), 'NFT_SHARE_ID_URL_PRESENT');
must(nft.includes('readSharedRecord(key'), 'NFT_SHARE_AUTH_READ_MISSING');
const publicAccess = read('src/server/services/publicRecordAccessService.js');
must(publicAccess.includes('findPublicQrReadContextByKey(normalizedKey)'), 'JSON_TOKEN_READ_MISSING');
must(publicAccess.includes('readPublicQrPrimary({'), 'POSTGRES_TOKEN_READ_MISSING');
const repo = read('src/server/repositories/qrRepository.js');
must(repo.includes('return this.findByAccessToken(key);'), 'REPOSITORY_TOKEN_ONLY_READ_MISSING');
must(repo.includes('return this.findByAccessTokenForUpdate(key);'), 'REPOSITORY_TOKEN_ONLY_LOCK_MISSING');
const db = read('src/server/services/dbService.js');
const start = db.indexOf('function findPublicQrReadContextByKey(key)');
const end = db.indexOf('\nfunction ', start + 10);
const publicFunction = db.slice(start, end < 0 ? undefined : end);
must(start >= 0, 'JSON_PUBLIC_LOOKUP_MISSING');
must(publicFunction.includes('item.qr_access_token === normalizedKey'), 'JSON_PUBLIC_TOKEN_LOOKUP_MISSING');
must(!publicFunction.includes('db.qr_codes.find((item) => item.id'), 'JSON_PUBLIC_ID_FALLBACK_PRESENT');
const app = read('src/server/app.js');
must(app.includes("app.use('/uploads', requireLocalAssetSignature('/uploads')"), 'UPLOAD_SIGNATURE_GATE_MISSING');
must(app.includes("app.use('/cloud', requireLocalAssetSignature('/cloud')"), 'CLOUD_SIGNATURE_GATE_MISSING');
must(!app.includes("app.use('/qrcodes', express.static"), 'QRCODE_STATIC_BYPASS_PRESENT');
const assets = read('src/server/services/assetAccessService.js');
must(assets.includes("createHmac('sha256', signingSecret(env))"), 'ASSET_HMAC_MISSING');
must(assets.includes('timingSafeEqual('), 'ASSET_TIMING_SAFE_COMPARE_MISSING');
must(assets.includes('remaining <= 0 || remaining > MAX_ASSET_TTL_SECONDS'), 'ASSET_EXPIRY_GATE_MISSING');
const audit = read('src/server/middlewares/auditLogger.js');
must((audit.match(/\[credential\]/g) || []).length >= 3, 'AUDIT_CREDENTIAL_REDACTION_MISSING');
const test = read('tests/public-qr-access-security.test.js');
must(test.includes('actual PostgreSQL repository and public adapter reject IDs on both channels'),
  'DISPLAY_ID_REJECTION_TEST_MISSING');
const pkg = JSON.parse(read('package.json'));
must(pkg.scripts.test.includes('tests/public-qr-access-security.test.js'), 'SECURITY_TEST_NOT_IN_SUITE');
must(pkg.scripts.test.includes('tests/system-acceptance-production-observation.test.js'),
  'PRODUCTION_OBSERVATION_TEST_NOT_IN_SUITE');
const config = read('src/server/services/configService.js');
must(config.includes('BASE_URL must be an HTTPS origin'), 'BASE_URL_PRODUCTION_GATE_MISSING');
must(config.includes('STORAGE_MODE must be cloud in production.'), 'PRODUCTION_CLOUD_GATE_MISSING');
must(config.includes('CLOUD_FALLBACK_TO_LOCAL must not be true in production.'),
  'PRODUCTION_LOCAL_FALLBACK_GATE_MISSING');
must(config.includes('USER_SESSION_SAMESITE must be Lax or Strict in production.'),
  'PRODUCTION_SAMESITE_GATE_MISSING');
must(app.includes("app.set('trust proxy', 'loopback')"), 'LOOPBACK_PROXY_TRUST_GATE_MISSING');
must(app.includes("code: 'INVALID_JSON'"), 'INVALID_JSON_CONTRACT_MISSING');
must(app.includes("code: 'REQUEST_BODY_TOO_LARGE'"), 'REQUEST_BODY_LIMIT_CONTRACT_MISSING');
const auth = read('src/server/services/authService.js');
must(auth.includes('crypto.timingSafeEqual('), 'AUTH_TIMING_SAFE_COMPARE_MISSING');
must(auth.includes('segments.length !== 3'), 'AUTH_STRICT_SEGMENT_GATE_MISSING');
must(auth.includes('auth_version: Number(admin.auth_version ?? 0)'), 'AUTH_VERSION_CLAIM_MISSING');
const bounded = read('src/server/utils/boundedResponse.js');
must(bounded.includes("response.on('close', onClose)"), 'UPSTREAM_CLOSE_GATE_MISSING');
must(bounded.includes('await reader.cancel(error)'), 'FETCH_READER_CANCEL_MISSING');
const auditService = read('src/server/services/auditService.js');
must(auditService.includes('rotateAuditLogIfNeeded'), 'AUDIT_ROTATION_MISSING');
const apiTest = read('tests/api.test.js');
must(apiTest.includes("assert.equal(malformedRes.body.code, 'INVALID_JSON')"),
  'INVALID_JSON_RUNTIME_TEST_MISSING');
must(apiTest.includes('payment-log-must-not-persist-this-openid'),
  'PAYMENT_LOG_REDACTION_TEST_MISSING');
for (const runner of [
  'scripts/database/run-system-acceptance-postgres-integration.sh',
  'scripts/database/run-system-acceptance-production-observation.sh',
  'scripts/database/run-production-object-mirror.sh',
  'scripts/database/run-production-restore-drill.sh'
]) must(read(runner).includes('WORKTREE_NOT_CLEAN'), `${runner}_CLEAN_TREE_GATE_MISSING`);
process.stdout.write('TARGET_SYSTEM_ACCEPTANCE_CONTRACT=PASS\n');
NODE
}

assert_nginx_proxy_contract() {
  local config_file
  local result
  config_file="$(mktemp)" || return 1
  if ! nginx -T >"$config_file" 2>/dev/null; then
    rm -f "$config_file"
    return 1
  fi
  result="$($NODE_BIN - "$config_file" <<'NODE'
const fs = require('node:fs');
let text = fs.readFileSync(process.argv[2], 'utf8');
  text = text.replace(/#[^\n]*/g, ' ');
  const blocks = [];
  const stack = [];
  let segmentStart = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '{') {
      const headerStart = Math.max(text.lastIndexOf(';', i - 1), text.lastIndexOf('}', i - 1), text.lastIndexOf('{', i - 1)) + 1;
      stack.push({ header: text.slice(headerStart, i).trim(), bodyStart: i + 1 });
    } else if (text[i] === '}' && stack.length) {
      const block = stack.pop();
      blocks.push({ header: block.header, body: text.slice(block.bodyStart, i) });
    }
  }
  const servers = blocks.filter((block) => /^server\s*$/.test(block.header));
  const targets = servers.filter((block) => /server_name\s+[^;]*\bxingxingzaishan\.top\b[^;]*;/.test(block.body));
  if (targets.length < 1) process.exit(2);
  for (const target of targets) {
    if (/(^|[;{}\s])(root|alias)\s+[^;]+;/.test(target.body)) process.exit(3);
    if (!/proxy_pass\s+http:\/\/127\.0\.0\.1:3000\s*;/.test(target.body)) process.exit(4);
    const sensitive = blocks.filter((block) => /^location\b/.test(block.header)
      && /\/(uploads|cloud|qrcodes)(?:\/|\s|$)/.test(block.header));
    if (sensitive.some((block) => /\b(root|alias|try_files)\b/.test(block.body))) process.exit(5);
  }
  process.stdout.write('NGINX_EFFECTIVE_ROUTE_CONTRACT=PASS_PROXY_ONLY\n');
NODE
  )" || {
    rm -f "$config_file"
    return 1
  }
  rm -f "$config_file"
  printf '%s' "$result"
}

assert_http_matches_target_file() {
  local url="$1"
  local target_path="$2"
  local expected_sha
  local actual_sha
  expected_sha="$(git show "$TARGET_COMMIT:$target_path" | sha256sum | awk '{print $1}')" \
    || fail TARGET_ASSET_HASH_FAILED
  actual_sha="$(curl -fsS -H 'Cache-Control: no-cache' --connect-timeout 5 --max-time 20 \
    --retry 0 "${url}?release=89a1cbf" | sha256sum | awk '{print $1}')" \
    || fail DEPLOYED_ASSET_FETCH_FAILED
  [ "$actual_sha" = "$expected_sha" ] || fail DEPLOYED_ASSET_HASH_MISMATCH
}

assert_dependency_runtime() {
  "$NODE_BIN" - <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const expected = {
  'sharp': '0.35.5',
  'body-parser': '1.20.8',
  'qs': '6.16.0',
  'urllib': '2.44.1'
};
function installedVersion(name) {
  let directory = path.dirname(require.resolve(name));
  while (true) {
    const manifest = path.join(directory, 'package.json');
    if (fs.existsSync(manifest)) {
      const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (pkg.name === name) return pkg.version;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}
for (const [name, version] of Object.entries(expected)) {
  const actual = installedVersion(name);
  if (actual !== version) process.exit(2);
}
process.stdout.write('RUNTIME_DEPENDENCIES=PASS_PINNED_SECURITY_VERSIONS\n');
NODE
}

assert_runtime_config_after_restart() {
  local app_pid="$1"
  local started_at_ms
  started_at_ms="$(pm2 jlist | "$NODE_BIN" -e '
const fs = require("node:fs");
const rows = JSON.parse(fs.readFileSync(0, "utf8"));
const matches = rows.filter((row) => row && row.name === "xingxingzaishan");
if (matches.length !== 1 || Number(matches[0].pid) <= 0) process.exit(2);
const value = Number((matches[0].pm2_env || {}).pm_uptime || 0);
if (!Number.isSafeInteger(value) || value <= 0) process.exit(3);
process.stdout.write(String(value));
')" || fail PM2_START_TIME_INVALID
  "$NODE_BIN" scripts/acceptance/validate-running-production-config.js \
    "$app_pid" "$REPO" "$PRODUCTION_DATABASE" "$started_at_ms" \
    || fail PRODUCTION_RUNTIME_CONFIG_INVALID
}

assert_malformed_json_rejected() {
  local url
  local code
  for url in \
    'http://127.0.0.1:3000/api/user/send-code' \
    'https://xingxingzaishan.top/api/user/send-code'; do
    code="$(curl -sS -o /dev/null -w '%{http_code}' \
      --connect-timeout 5 --max-time 15 --retry 0 \
      -H 'Content-Type: application/json' --data-binary '{' "$url" 2>/dev/null || true)"
    [ "$code" = 400 ] || fail INVALID_JSON_RUNTIME_CONTRACT_FAILED
  done
  printf 'RUNTIME_INVALID_JSON=PASS_400\n'
}

prepare_dependencies() {
  local current_kib
  local available_kib
  local required_kib
  current_kib="$(du -sk -- "$REPO/node_modules" | awk '{print $1}')" \
    || fail CURRENT_NODE_MODULES_SIZE_FAILED
  available_kib="$(df -Pk "$REPO" | awk 'NR == 2 { print $4 }')" \
    || fail DEPENDENCY_DISK_SPACE_READ_FAILED
  [[ "$current_kib" =~ ^[0-9]+$ ]] || fail CURRENT_NODE_MODULES_SIZE_INVALID
  [[ "$available_kib" =~ ^[0-9]+$ ]] || fail DEPENDENCY_DISK_SPACE_INVALID
  required_kib=$((current_kib * 3 + 262144))
  [ "$available_kib" -ge "$required_kib" ] || fail DEPENDENCY_DISK_SPACE_INSUFFICIENT

  DEPLOY_RUNTIME_ROOT="$REPO/.git/production-deploy-$RUN_ID"
  DEPENDENCY_STAGE="$DEPLOY_RUNTIME_ROOT/stage"
  NODE_MODULES_BACKUP="$DEPLOY_RUNTIME_ROOT/node_modules.previous"
  [ ! -e "$DEPLOY_RUNTIME_ROOT" ] || fail DEPLOY_RUNTIME_ROOT_ALREADY_EXISTS
  install -d -o root -g root -m 0700 "$DEPLOY_RUNTIME_ROOT" "$DEPENDENCY_STAGE"
  git show "$TARGET_COMMIT:package.json" > "$DEPENDENCY_STAGE/package.json" \
    || fail TARGET_PACKAGE_EXPORT_FAILED
  git show "$TARGET_COMMIT:package-lock.json" > "$DEPENDENCY_STAGE/package-lock.json" \
    || fail TARGET_PACKAGE_LOCK_EXPORT_FAILED
  (
    cd "$DEPENDENCY_STAGE"
    npm ci --omit=dev --no-audit --no-fund
    npm ls --omit=dev --depth=0 >/dev/null
  ) || fail TARGET_DEPENDENCY_INSTALL_FAILED
  [ -d "$DEPENDENCY_STAGE/node_modules" ] || fail TARGET_NODE_MODULES_MISSING
  [ ! -L "$DEPENDENCY_STAGE/node_modules" ] || fail TARGET_NODE_MODULES_UNSAFE
  printf 'DEPENDENCY_PREPARATION=PASS_STAGED_NPM_CI\n'
}

swap_dependencies() {
  [ -d "$REPO/node_modules" ] || fail CURRENT_NODE_MODULES_MISSING
  [ ! -L "$REPO/node_modules" ] || fail CURRENT_NODE_MODULES_UNSAFE
  [ -d "$DEPENDENCY_STAGE/node_modules" ] || fail TARGET_NODE_MODULES_MISSING
  [ ! -e "$NODE_MODULES_BACKUP" ] || fail NODE_MODULES_BACKUP_ALREADY_EXISTS
  mv -- "$REPO/node_modules" "$NODE_MODULES_BACKUP" \
    || fail CURRENT_NODE_MODULES_BACKUP_FAILED
  NODE_MODULES_BACKED_UP=YES
  mv -- "$DEPENDENCY_STAGE/node_modules" "$REPO/node_modules" \
    || fail TARGET_NODE_MODULES_SWAP_FAILED
  DEPENDENCIES_SWAPPED=YES
  printf 'DEPENDENCY_SWAP=PASS_ATOMIC_SAME_FILESYSTEM\n'
}

restore_previous_dependencies() {
  local restore_ok=YES
  if [ "$NODE_MODULES_BACKED_UP" != YES ]; then
    return 0
  fi
  if [ -e "$REPO/node_modules" ]; then
    mv -- "$REPO/node_modules" "$DEPLOY_RUNTIME_ROOT/node_modules.failed" \
      || restore_ok=NO
  fi
  if [ "$restore_ok" = YES ]; then
    mv -- "$NODE_MODULES_BACKUP" "$REPO/node_modules" || restore_ok=NO
  fi
  if [ "$restore_ok" = YES ]; then
    NODE_MODULES_BACKED_UP=NO
    DEPENDENCIES_SWAPPED=NO
    return 0
  fi
  return 1
}

cleanup_dependency_runtime() {
  if [ -n "$DEPLOY_RUNTIME_ROOT" ] && [ -d "$DEPLOY_RUNTIME_ROOT" ] \
      && [[ "$DEPLOY_RUNTIME_ROOT" == "$REPO/.git/production-deploy-"* ]]; then
    rm -rf -- "$DEPLOY_RUNTIME_ROOT"
  fi
}

assert_invalid_public_requests_rejected() {
  local url
  local code
  for url in \
    "$LOCAL_INVALID_RECORD_URL" "$EXTERNAL_INVALID_RECORD_URL" \
    "$LOCAL_INVALID_SHARE_URL" "$EXTERNAL_INVALID_SHARE_URL" \
    "$LOCAL_INVALID_QR_IMAGE_URL" "$EXTERNAL_INVALID_QR_IMAGE_URL"; do
    code="$(http_code "$url" 2>/dev/null || true)"
    [ "$code" = 404 ] || fail INVALID_PUBLIC_CREDENTIAL_NOT_REJECTED
  done
  printf 'INVALID_PUBLIC_CREDENTIAL_RUNTIME_REJECTION=PASS_404\n'
}

assert_runtime_auth_secret() {
  "$NODE_BIN" - "$ENV_FILE" <<'NODE'
const fs = require('node:fs');
const dotenv = require('dotenv');
const values = dotenv.parse(fs.readFileSync(process.argv[2]));
const secret = String(values.AUTH_SECRET || '');
if (!/^[a-f0-9]{64}$/.test(secret)) process.exit(2);
for (const [key, value] of Object.entries(values)) {
  if (process.env[key] === undefined) process.env[key] = value;
}
process.env.AUTH_SECRET = secret;
const { generateToken } = require('./src/server/services/authService');
const { getOperatorAuthState, listOperators } = require('./src/server/services/dbService');
const selected = listOperators('admin').find((item) => item && item.enabled !== false);
const operator = selected && getOperatorAuthState(selected.id);
if (!operator || operator.role !== 'admin' || !operator.enabled) process.exit(3);
const token = generateToken(operator, { ttl_seconds: 60 });
fetch('http://127.0.0.1:3000/api/admin/operators', {
  headers: { Authorization: `Bearer ${token}` }
}).then((response) => {
  if (response.status !== 200) process.exit(4);
  process.stdout.write('RUNTIME_AUTH_SECRET_ACCEPTED=YES\n');
}).catch(() => process.exit(5));
NODE
}

assert_unsigned_local_asset_rejected_if_present() {
  "$NODE_BIN" - "$ENV_FILE" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const values = dotenv.parse(fs.readFileSync(process.argv[2]));
const root = values.STORAGE_ROOT ? path.resolve(values.STORAGE_ROOT) : path.resolve('src/server');
const directories = [
  ['/uploads/', path.join(root, 'public', 'uploads')],
  ['/cloud/', path.join(root, 'public', 'cloud')]
];
let candidate = null;
for (const [prefix, dir] of directories) {
  if (!fs.existsSync(dir)) continue;
  const file = fs.readdirSync(dir, { withFileTypes: true }).find((entry) => entry.isFile());
  if (file) { candidate = `${prefix}${encodeURIComponent(file.name)}`; break; }
}
if (!candidate) {
  process.stdout.write('UNSIGNED_EXISTING_LOCAL_ASSET_PROBE=NOT_AVAILABLE\n');
  process.exit(0);
}
Promise.all([
  fetch(`http://127.0.0.1:3000${candidate}`, { redirect: 'manual' }),
  fetch(`https://xingxingzaishan.top${candidate}`, { redirect: 'manual' })
]).then((responses) => {
  if (responses.some((response) => response.status !== 404)) process.exit(2);
  process.stdout.write('UNSIGNED_EXISTING_LOCAL_ASSET_PROBE=PASS_404\n');
}).catch(() => process.exit(3));
NODE
}

assert_deployed_acceptance_contract() {
  assert_http_matches_target_file "$LOCAL_RECORD_JS_URL" src/frontend/js/record.js
  assert_http_matches_target_file "$EXTERNAL_RECORD_JS_URL" src/frontend/js/record.js
  assert_http_matches_target_file "$LOCAL_ME_JS_URL" src/frontend/js/me.js
  assert_http_matches_target_file "$EXTERNAL_ME_JS_URL" src/frontend/js/me.js
  assert_invalid_public_requests_rejected
  assert_runtime_auth_secret
  assert_unsigned_local_asset_rejected_if_present
  assert_dependency_runtime
  assert_malformed_json_rejected
  printf 'DEPLOYED_SYSTEM_ACCEPTANCE_CONTRACT=PASS\n'
}

restart_application() {
  pm2 restart "$APP_NAME" >/dev/null || return 1
}

rollback_application() {
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
    restore_previous_dependencies || rollback_ok=NO
  fi
  if [ "$rollback_ok" = YES ]; then
    restart_application || rollback_ok=NO
  fi
  if [ "$rollback_ok" = YES ]; then
    wait_for_http_200 "$LOCAL_ROOT_URL" 30 2 || rollback_ok=NO
  fi
  if [ "$rollback_ok" = YES ]; then
    wait_for_http_200 "$EXTERNAL_ROOT_URL" 15 4 || rollback_ok=NO
  fi
  if [ "$rollback_ok" = YES ]; then
    application_record >/dev/null 2>&1 || rollback_ok=NO
  fi
  if [ "$rollback_ok" = YES ]; then
    (assert_readiness_contract) >/dev/null 2>&1 || rollback_ok=NO
  fi
  if [ "$rollback_ok" = YES ]; then
    cleanup_dependency_runtime || true
    printf 'APPLICATION_ROLLBACK=PASS\nDEPENDENCY_ROLLBACK=PASS\nDATABASE_ROLLBACK=NOT_REQUIRED\n' >&2
  else
    printf 'APPLICATION_ROLLBACK=FAIL\nDEPENDENCY_ROLLBACK=REQUIRES_REVIEW\nMANUAL_RECOVERY_REQUIRED=YES\n' >&2
  fi
  set -e
}

on_error() {
  local exit_code="$1"
  local line_number="$2"
  if [ "$ROLLBACK_IN_PROGRESS" = YES ]; then
    exit "$exit_code"
  fi
  printf 'FAILURE_LINE=%s\nFAILURE_CODE=%s\n' "$line_number" "$LAST_ERROR_CODE" >&2
  if [ "$CHECKOUT_STARTED" = YES ]; then
    rollback_application
  else
    cleanup_dependency_runtime || true
    printf 'APPLICATION_ROLLBACK=NOT_REQUIRED\n' >&2
  fi
  exit "$exit_code"
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
require_command install INSTALL
require_command bash BASH
require_command awk AWK
require_command grep GREP
require_command sed SED
require_command sort SORT
require_command wc WC
require_command nginx NGINX
require_command mktemp MKTEMP
require_command npm NPM
require_command df DF
require_command du DU
require_command mv MV
require_command rm RM

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
[ -z "$(git status --porcelain=v1 --untracked-files=normal)" ] || fail WORKTREE_NOT_CLEAN
assert_root_private_regular_file "$ENV_FILE" || fail ENV_FILE_UNSAFE
assert_root_private_regular_file "$EXPECTED_PASSWORD_FILE" || fail POSTGRES_PASSWORD_FILE_UNSAFE
[ -f "$BACKUP_RUNNER" ] || fail BACKUP_RUNNER_MISSING
[ -f "$PM2_DUMP" ] || fail PM2_DUMP_MISSING

git fetch --no-tags origin main || fail REMOTE_FETCH_FAILED
[ "$(git rev-parse origin/main)" = "$TARGET_COMMIT" ] || fail REMOTE_MAIN_MISMATCH
[ "$(git cat-file -t "$TARGET_COMMIT")" = commit ] || fail TARGET_COMMIT_MISSING
[ "$(git rev-parse "$TARGET_COMMIT^{tree}")" = "$TARGET_TREE" ] || fail TARGET_TREE_MISMATCH
[ "$(git rev-parse "$EXPECTED_PREVIOUS_COMMIT^{tree}")" = "$EXPECTED_PREVIOUS_TREE" ] \
  || fail PREVIOUS_TREE_MISMATCH
assert_exact_commit_chain

[ "$(git rev-parse HEAD)" = "$EXPECTED_PREVIOUS_COMMIT" ] || fail ACTIVE_COMMIT_MISMATCH
[ "$(git rev-parse 'HEAD^{tree}')" = "$EXPECTED_PREVIOUS_TREE" ] || fail ACTIVE_TREE_MISMATCH
assert_exact_target_diff
assert_package_delta
assert_target_acceptance_contract
assert_nginx_proxy_contract || fail NGINX_EFFECTIVE_ROUTE_CONTRACT_INVALID

APP_PID_BEFORE="$(application_pid)" || fail PM2_APPLICATION_OR_RUNTIME_INVALID
printf 'APP_PID_BEFORE=%s\n' "$APP_PID_BEFORE"
validate_env_contract "$APP_PID_BEFORE" || fail ENVIRONMENT_GATE_FAILED
assert_recent_backup
assert_readiness_contract
[ "$(http_code "$LOCAL_ROOT_URL")" = 200 ] || fail LOCAL_ROOT_HTTP_INVALID
[ "$(http_code "$EXTERNAL_ROOT_URL")" = 200 ] || fail EXTERNAL_ROOT_HTTP_INVALID

printf 'PREVIOUS_DEPLOYED_COMMIT_CAPTURED=%s\n' "$EXPECTED_PREVIOUS_COMMIT"
printf 'PREVIOUS_DEPLOYED_TREE_CAPTURED=%s\n' "$EXPECTED_PREVIOUS_TREE"
printf 'TARGET_COMMIT_VERIFIED=%s\n' "$TARGET_COMMIT"
printf 'TARGET_TREE_VERIFIED=%s\n' "$TARGET_TREE"
printf 'DATABASE_MIGRATION_DELTA=NONE\n'

if [ "$MODE" = preflight ]; then
  trap - ERR
  printf 'PRE_DEPLOYMENT_BACKUP_EXECUTED=NO\n'
  printf 'PRODUCTION_CODE_CHANGED=NO\n'
  printf 'PM2_RESTARTED=NO\n'
  printf 'ENV_FILE_CHANGED=NO\n'
  printf 'DEPENDENCY_PREPARATION=NOT_EXECUTED_PREFLIGHT\n'
  printf 'DATABASE_WRITE=NONE\n'
  printf 'BLOCKCHAIN_WRITE=NONE\n'
  printf 'OSS_REQUESTS=NONE\n'
  printf 'QR_ACCESS_TOKEN_ROTATION=NO\n'
  printf 'AUTH_SECRET_ROTATION=NO\n'
  printf 'SECRET_VALUES_PRINTED=NO\n'
  printf 'READY_FOR_DEPLOYMENT=YES\n'
  printf 'PRODUCTION_SYSTEM_ACCEPTANCE_DEPLOYMENT_PREFLIGHT=PASS\n'
  exit 0
fi

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
AUDIT_DIR="$AUDIT_ROOT/$RUN_ID"
install -d -o root -g root -m 0700 "$AUDIT_DIR"

ENV_SHA256_BEFORE="$(sha256sum "$ENV_FILE" | awk '{print $1}')"
PM2_DUMP_SHA256_BEFORE="$(sha256sum "$PM2_DUMP" | awk '{print $1}')"

BACKUP_OUTPUT="$(bash "$BACKUP_RUNNER")" || fail PRE_DEPLOYMENT_BACKUP_FAILED
printf '%s\n' "$BACKUP_OUTPUT"
printf '%s\n' "$BACKUP_OUTPUT" | \
  grep -Fx 'PRODUCTION_MANUAL_OFFSITE_BACKUP_ACCEPTANCE=PASS' >/dev/null \
  || fail PRE_DEPLOYMENT_BACKUP_ACCEPTANCE_MISSING
printf 'BACKUP_GATE=PASS\n'

assert_readiness_contract
prepare_dependencies

CHECKOUT_STARTED=YES
git checkout --detach "$TARGET_COMMIT" || fail TARGET_CHECKOUT_FAILED
[ "$(git rev-parse HEAD)" = "$TARGET_COMMIT" ] || fail DEPLOYED_COMMIT_MISMATCH
[ "$(git rev-parse 'HEAD^{tree}')" = "$TARGET_TREE" ] || fail DEPLOYED_TREE_MISMATCH
swap_dependencies

restart_application || fail APPLICATION_RESTART_FAILED
wait_for_http_200 "$LOCAL_ROOT_URL" 30 2 || fail LOCAL_ROOT_HTTP_FAILED
wait_for_http_200 "$EXTERNAL_ROOT_URL" 15 4 || fail EXTERNAL_ROOT_HTTP_FAILED
assert_deployed_acceptance_contract
sleep 5

APP_PID_AFTER="$(application_pid)" || fail PM2_APPLICATION_OR_RUNTIME_INVALID
[ "$APP_PID_AFTER" != "$APP_PID_BEFORE" ] || fail APP_PID_DID_NOT_CHANGE
validate_env_contract "$APP_PID_AFTER" || fail ENVIRONMENT_GATE_FAILED_AFTER_RESTART
assert_runtime_config_after_restart "$APP_PID_AFTER"
assert_readiness_contract
assert_nginx_proxy_contract || fail NGINX_EFFECTIVE_ROUTE_CONTRACT_INVALID_AFTER_RESTART

[ "$(git rev-parse HEAD)" = "$TARGET_COMMIT" ] || fail FINAL_COMMIT_MISMATCH
[ "$(git rev-parse 'HEAD^{tree}')" = "$TARGET_TREE" ] || fail FINAL_TREE_MISMATCH
git diff --quiet || fail FINAL_TRACKED_WORKTREE_DIRTY
git diff --cached --quiet || fail FINAL_TRACKED_INDEX_DIRTY
[ -z "$(git status --porcelain=v1 --untracked-files=normal)" ] || fail FINAL_WORKTREE_NOT_CLEAN
[ "$(sha256sum "$ENV_FILE" | awk '{print $1}')" = "$ENV_SHA256_BEFORE" ] \
  || fail ENV_FILE_CHANGED
[ "$(sha256sum "$PM2_DUMP" | awk '{print $1}')" = "$PM2_DUMP_SHA256_BEFORE" ] \
  || fail PM2_DUMP_CHANGED

printf '%s\n' \
  "DEPLOYED_COMMIT=$TARGET_COMMIT" \
  "DEPLOYED_TREE=$TARGET_TREE" \
  "ROLLBACK_TARGET=$EXPECTED_PREVIOUS_COMMIT" \
  'ENV_FILE_CHANGED=NO' \
  'PM2_DUMP_CHANGED=NO' \
  'DEPENDENCY_PREPARATION=PASS_STAGED_NPM_CI_AND_ATOMIC_SWAP' \
  'DATABASE_MIGRATION_EXECUTED=NO' \
  'QR_ACCESS_TOKEN_ROTATION=NO' \
  'AUTH_SECRET_ROTATION=NO' \
  'DATABASE_WRITE_BY_RUNNER=NONE' \
  'BLOCKCHAIN_WRITE_BY_RUNNER=NONE' \
  'RESULT=PASS' > "$AUDIT_DIR/deployment-summary.txt"
chmod 0600 "$AUDIT_DIR/deployment-summary.txt"

CHECKOUT_STARTED=NO
if cleanup_dependency_runtime; then
  DEPENDENCY_RUNTIME_CLEANUP=PASS
else
  DEPENDENCY_RUNTIME_CLEANUP=REQUIRES_REVIEW
fi
NODE_MODULES_BACKED_UP=NO
DEPENDENCIES_SWAPPED=NO

trap - ERR
printf 'PRE_DEPLOYMENT_OFFSITE_BACKUP=PASS\n'
printf 'DEPENDENCY_PREPARATION=PASS_STAGED_NPM_CI_AND_ATOMIC_SWAP\n'
printf 'DEPENDENCY_RUNTIME_CLEANUP=%s\n' "$DEPENDENCY_RUNTIME_CLEANUP"
printf 'DATABASE_MIGRATION_EXECUTED=NO\n'
printf 'APPLICATION_RESTART=PASS_PM2\n'
printf 'APP_PID_AFTER=%s\n' "$APP_PID_AFTER"
printf 'ENV_FILE_CHANGED=NO\n'
printf 'PM2_DUMP_CHANGED=NO\n'
printf 'QR_ACCESS_TOKEN_ROTATION=NO\n'
printf 'AUTH_SECRET_ROTATION=NO\n'
printf 'DATABASE_WRITE_BY_RUNNER=NONE\n'
printf 'BLOCKCHAIN_WRITE_BY_RUNNER=NONE\n'
printf 'OSS_REQUESTS=PRE_DEPLOYMENT_BACKUP_ONLY\n'
printf 'DEPLOYED_COMMIT=%s\n' "$TARGET_COMMIT"
printf 'DEPLOYED_TREE=%s\n' "$TARGET_TREE"
printf 'ROLLBACK_TARGET=%s\n' "$EXPECTED_PREVIOUS_COMMIT"
printf 'AUDIT_DIRECTORY=%s\n' "$AUDIT_DIR"
printf 'SECRET_VALUES_PRINTED=NO\n'
printf 'NGINX_EFFECTIVE_ROUTE=PASS_PROXY_ONLY\n'
printf 'RUNTIME_INVALID_CREDENTIALS=PASS_404\n'
printf 'READY_FOR_EXISTING_STAR_STICKER_SMOKE_TEST=YES\n'
printf 'READY_FOR_SYSTEM_ACCEPTANCE_PRODUCTION_OBSERVATION=YES\n'
printf 'PRODUCTION_SYSTEM_ACCEPTANCE_DEPLOYMENT=PASS\n'
