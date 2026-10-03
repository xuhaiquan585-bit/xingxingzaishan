#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

EXPECTED_ACTIVE_COMMIT=749f3fdb2beecb773cc8e6845b5022b3cdf1df2c
EXPECTED_ACTIVE_TREE=fe871b6816d09bfd0e1d5bf8b609c0d807660289
REPO=/www/wwwroot/xingxingzaishan
APP_NAME=xingxingzaishan
ENV_FILE="$REPO/.env"
PM2_DUMP=/root/.pm2/dump.pm2
READY_URL=http://127.0.0.1:3000/api/health/ready
BACKUP_ROOT=/root/production-cloud-fallback-disable
NODE=/usr/local/bin/node

MODE=
RUN_ID=
AUDIT_DIR=
ENV_BACKUP=
ENV_SHA256_BEFORE=
PM2_DUMP_SHA256_BEFORE=
APP_PID_BEFORE=
ENV_TEMP=
CONFIG_CHANGE_STARTED=NO
REMEDIATION_COMPLETE=NO

fail() {
  printf 'PRODUCTION_CLOUD_FALLBACK_DISABLE=FAIL\n'
  printf 'ERROR_CODE=%s\n' "$1"
  exit 1
}

assert_root_private_regular_file() {
  local file="$1"
  [ -f "$file" ] || return 1
  [ ! -L "$file" ] || return 1
  [ "$(stat -c '%U:%G' "$file")" = root:root ] || return 1
  [ "$(stat -c '%a' "$file")" = 600 ] || return 1
}

assert_root_private_directory() {
  local directory="$1"
  [ -d "$directory" ] || return 1
  [ ! -L "$directory" ] || return 1
  [ "$(stat -c '%U:%G' "$directory")" = root:root ] || return 1
  [ "$(stat -c '%a' "$directory")" = 700 ] || return 1
}

assert_clean_worktree() {
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
    *) fail WORKTREE_NOT_CLEAN ;;
  esac
}

application_pid() {
  pm2 jlist | "$NODE" -e '
const fs = require("node:fs");
const rows = JSON.parse(fs.readFileSync(0, "utf8"));
const apps = rows.filter((row) => row && row.name === "xingxingzaishan");
if (apps.length !== 1) process.exit(2);
const app = apps[0];
if (app.pm2_env?.status !== "online") process.exit(3);
if (!Number.isInteger(Number(app.pid)) || Number(app.pid) <= 0) process.exit(4);
process.stdout.write(String(app.pid));
'
}

assert_no_runtime_or_pm2_override() {
  local app_pid="$1"
  if tr '\0' '\n' < "/proc/$app_pid/environ" | \
    grep -q '^CLOUD_FALLBACK_TO_LOCAL='; then
    return 1
  fi
  pm2 jlist | "$NODE" -e '
const fs = require("node:fs");
const rows = JSON.parse(fs.readFileSync(0, "utf8"));
const app = rows.find((row) => row && row.name === "xingxingzaishan");
if (!app || Object.hasOwn(app.pm2_env || {}, "CLOUD_FALLBACK_TO_LOCAL")) process.exit(1);
' || return 1
  "$NODE" - "$PM2_DUMP" <<'NODE'
const fs = require('node:fs');
const rows = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const app = rows.find((row) => row && row.name === 'xingxingzaishan');
if (!app || Object.hasOwn(app.pm2_env || {}, 'CLOUD_FALLBACK_TO_LOCAL')) process.exit(1);
NODE
}

assert_env_value() {
  local expected="$1"
  "$NODE" - "$ENV_FILE" "$expected" <<'NODE'
const fs = require('node:fs');
const [file, expected] = process.argv.slice(2);
const raw = fs.readFileSync(file);
const text = raw.toString('utf8');
if (!Buffer.from(text, 'utf8').equals(raw)) process.exit(1);
const assignments = text.split(/\n/)
  .map((line) => line.endsWith('\r') ? line.slice(0, -1) : line)
  .filter((line) => line.startsWith('CLOUD_FALLBACK_TO_LOCAL='));
if (assignments.length !== 1) process.exit(2);
if (assignments[0] !== `CLOUD_FALLBACK_TO_LOCAL=${expected}`) process.exit(3);
NODE
}

http_ready() {
  [ "$(curl -sS -o /dev/null -w '%{http_code}' \
    --connect-timeout 5 --max-time 10 --retry 0 "$READY_URL")" = 200 ]
}

wait_ready() {
  local attempt
  for attempt in $(seq 1 30); do
    if http_ready 2>/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

restore_original_environment() {
  [ -n "$ENV_BACKUP" ] || return 1
  assert_root_private_regular_file "$ENV_BACKUP" || return 1
  install -o root -g root -m 0600 "$ENV_BACKUP" "$ENV_FILE" || return 1
  [ "$(sha256sum "$ENV_FILE" | awk '{print $1}')" = "$ENV_SHA256_BEFORE" ] || return 1
  pm2 restart "$APP_NAME" >/dev/null || return 1
  wait_ready || return 1
  return 0
}

cleanup() {
  local exit_code=$?
  trap - EXIT
  if [ -n "$ENV_TEMP" ] && [ -e "$ENV_TEMP" ] && [ ! -L "$ENV_TEMP" ]; then
    rm -f -- "$ENV_TEMP"
  fi
  if [ "$exit_code" -ne 0 ] && [ "$CONFIG_CHANGE_STARTED" = YES ] && \
    [ "$REMEDIATION_COMPLETE" != YES ]; then
    if restore_original_environment; then
      printf 'ENVIRONMENT_ROLLBACK=PASS\n' >&2
    else
      printf 'ENVIRONMENT_ROLLBACK=FAIL_OPERATOR_ACTION_REQUIRED\n' >&2
    fi
  fi
  exit "$exit_code"
}

case "${1:-}" in
  --preflight) MODE=preflight ;;
  --authorize-disable=YES) MODE=authorized ;;
  *) fail AUTHORIZATION_MODE_REQUIRED ;;
esac
[ "$#" = 1 ] || fail ARGUMENT_INVALID
[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED

for command in awk curl date git grep install openssl pm2 rm sed seq sha256sum sleep stat tr; do
  command -v "$command" >/dev/null 2>&1 || fail "${command^^}_REQUIRED"
done
[ -x "$NODE" ] || fail NODE_REQUIRED
[ -d "$REPO/.git" ] || fail REPOSITORY_REQUIRED
assert_root_private_regular_file "$ENV_FILE" || fail ENV_FILE_UNSAFE
assert_root_private_regular_file "$PM2_DUMP" || fail PM2_DUMP_UNSAFE

cd "$REPO"
assert_clean_worktree
[ "$(git rev-parse HEAD)" = "$EXPECTED_ACTIVE_COMMIT" ] || fail ACTIVE_COMMIT_MISMATCH
[ "$(git rev-parse 'HEAD^{tree}')" = "$EXPECTED_ACTIVE_TREE" ] || fail ACTIVE_TREE_MISMATCH

APP_PID_BEFORE="$(application_pid)" || fail APP_RUNTIME_INVALID
[ -r "/proc/$APP_PID_BEFORE/environ" ] || fail APP_ENVIRONMENT_UNREADABLE
http_ready || fail CURRENT_READINESS_FAILED
assert_env_value true || fail ENV_FILE_SOURCE_CONTRACT_MISMATCH
assert_no_runtime_or_pm2_override "$APP_PID_BEFORE" \
  || fail CLOUD_FALLBACK_OVERRIDE_PRESENT

ENV_SHA256_BEFORE="$(sha256sum "$ENV_FILE" | awk '{print $1}')"
PM2_DUMP_SHA256_BEFORE="$(sha256sum "$PM2_DUMP" | awk '{print $1}')"

printf 'ACTIVE_COMMIT=%s\n' "$EXPECTED_ACTIVE_COMMIT"
printf 'ACTIVE_TREE=%s\n' "$EXPECTED_ACTIVE_TREE"
printf 'APP_PID_BEFORE=%s\n' "$APP_PID_BEFORE"
printf 'CURRENT_READINESS=PASS_200_READY\n'
printf 'CLOUD_FALLBACK_SOURCE=ENV_FILE_ONLY_TRUE\n'
printf 'ENV_REPLACEMENT_CONTRACT=PASS_EXACT_ONE_SETTING\n'
printf 'SECRET_VALUES_PRINTED=NO\n'

if [ "$MODE" = preflight ]; then
  printf 'ENV_FILE_CHANGED=NO\n'
  printf 'APPLICATION_RESTART=NO\n'
  printf 'DATABASE_WRITE=NONE\n'
  printf 'OSS_REQUESTS=NONE\n'
  printf 'BLOCKCHAIN_WRITE=NONE\n'
  printf 'READY_FOR_CLOUD_FALLBACK_DISABLE=YES\n'
  printf 'PRODUCTION_CLOUD_FALLBACK_DISABLE_PREFLIGHT=PASS\n'
  exit 0
fi

trap cleanup EXIT
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4)"
AUDIT_DIR="$BACKUP_ROOT/$RUN_ID"
ENV_BACKUP="$AUDIT_DIR/app.env.before"
[ ! -e "$BACKUP_ROOT" ] || assert_root_private_directory "$BACKUP_ROOT" \
  || fail BACKUP_ROOT_UNSAFE
install -d -o root -g root -m 0700 "$BACKUP_ROOT" "$AUDIT_DIR"
assert_root_private_directory "$BACKUP_ROOT" || fail BACKUP_ROOT_UNSAFE
assert_root_private_directory "$AUDIT_DIR" || fail AUDIT_DIRECTORY_UNSAFE
install -o root -g root -m 0600 "$ENV_FILE" "$ENV_BACKUP"
[ "$(sha256sum "$ENV_BACKUP" | awk '{print $1}')" = "$ENV_SHA256_BEFORE" ] \
  || fail PRIVATE_ENV_BACKUP_MISMATCH

CONFIG_CHANGE_STARTED=YES
ENV_TEMP="$REPO/.env.cloud-fallback-$RUN_ID.tmp"
"$NODE" - "$ENV_BACKUP" "$ENV_FILE" "$ENV_TEMP" <<'NODE'
const fs = require('node:fs');
const [backup, target, temporary] = process.argv.slice(2);
const source = fs.readFileSync(backup);
const needle = Buffer.from('CLOUD_FALLBACK_TO_LOCAL=true');
const replacement = Buffer.from('CLOUD_FALLBACK_TO_LOCAL=false');
const first = source.indexOf(needle);
if (first < 0 || source.indexOf(needle, first + 1) >= 0) process.exit(1);
const output = Buffer.concat([
  source.subarray(0, first),
  replacement,
  source.subarray(first + needle.length)
]);
const descriptor = fs.openSync(temporary, 'wx', 0o600);
try {
  fs.writeFileSync(descriptor, output);
  fs.fsyncSync(descriptor);
} finally {
  fs.closeSync(descriptor);
}
fs.renameSync(temporary, target);
fs.chmodSync(target, 0o600);
fs.chownSync(target, 0, 0);
NODE
assert_root_private_regular_file "$ENV_FILE" || fail UPDATED_ENV_FILE_UNSAFE
assert_env_value false || fail UPDATED_ENV_VALUE_INVALID
"$NODE" - "$ENV_BACKUP" "$ENV_FILE" <<'NODE'
const fs = require('node:fs');
const [beforePath, afterPath] = process.argv.slice(2);
const before = fs.readFileSync(beforePath);
const after = fs.readFileSync(afterPath);
const needle = Buffer.from('CLOUD_FALLBACK_TO_LOCAL=true');
const replacement = Buffer.from('CLOUD_FALLBACK_TO_LOCAL=false');
const first = before.indexOf(needle);
if (first < 0 || before.indexOf(needle, first + 1) >= 0) process.exit(1);
const expected = Buffer.concat([
  before.subarray(0, first), replacement, before.subarray(first + needle.length)
]);
if (!expected.equals(after)) process.exit(2);
NODE

pm2 restart "$APP_NAME" >/dev/null || fail APPLICATION_RESTART_FAILED
wait_ready || fail READINESS_AFTER_RESTART_FAILED
APP_PID_AFTER="$(application_pid)" || fail APP_RUNTIME_AFTER_INVALID
[ "$APP_PID_AFTER" != "$APP_PID_BEFORE" ] || fail APP_PID_NOT_REPLACED
assert_no_runtime_or_pm2_override "$APP_PID_AFTER" \
  || fail CLOUD_FALLBACK_OVERRIDE_AFTER_RESTART
assert_env_value false || fail FINAL_ENV_VALUE_INVALID
[ "$(sha256sum "$PM2_DUMP" | awk '{print $1}')" = "$PM2_DUMP_SHA256_BEFORE" ] \
  || fail PM2_DUMP_CHANGED
[ "$(git rev-parse HEAD)" = "$EXPECTED_ACTIVE_COMMIT" ] || fail FINAL_COMMIT_MISMATCH
[ "$(git rev-parse 'HEAD^{tree}')" = "$EXPECTED_ACTIVE_TREE" ] || fail FINAL_TREE_MISMATCH
assert_clean_worktree

REMEDIATION_COMPLETE=YES
trap - EXIT
printf 'PRIVATE_ENV_BACKUP=PASS\n'
printf 'OTHER_ENV_VALUES_CHANGED=NO\n'
printf 'CLOUD_FALLBACK_TO_LOCAL=FALSE\n'
printf 'APPLICATION_RESTART=PASS_PM2\n'
printf 'APP_PID_AFTER=%s\n' "$APP_PID_AFTER"
printf 'CURRENT_READINESS=PASS_200_READY\n'
printf 'PM2_DUMP_CHANGED=NO\n'
printf 'DATABASE_WRITE=NONE\n'
printf 'OSS_REQUESTS=NONE\n'
printf 'BLOCKCHAIN_WRITE=NONE\n'
printf 'APPLICATION_CODE_CHANGED=NO\n'
printf 'AUDIT_DIRECTORY=%s\n' "$AUDIT_DIR"
printf 'SECRET_VALUES_PRINTED=NO\n'
printf 'PRODUCTION_CLOUD_FALLBACK_DISABLE=PASS\n'
