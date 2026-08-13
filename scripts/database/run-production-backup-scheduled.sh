#!/usr/bin/env bash

set -u
umask 077

REPO=/www/wwwroot/xingxingzaishan
STATE_DIR=/var/lib/xingxingzaishan-production-backup
LOG_DIR=/var/log/xingxingzaishan-production-backup
STATUS_SCRIPT="$REPO/scripts/database/production-backup-schedule-state.js"
NPM=/usr/local/bin/npm
NODE=/usr/local/bin/node

fail() {
  printf 'SCHEDULED_PRODUCTION_BACKUP=FAIL\nERROR_CODE=%s\n' "$1" >&2
  exit "${2:-70}"
}

assert_root_private_directory() {
  local directory="$1"
  [ -d "$directory" ] || return 1
  [ ! -L "$directory" ] || return 1
  [ "$(stat -c '%U:%G' "$directory")" = root:root ] || return 1
  [ "$(stat -c '%a' "$directory")" = 700 ] || return 1
}

assert_directory_target_safe() {
  local directory="$1"
  if [ -e "$directory" ] || [ -L "$directory" ]; then
    [ -d "$directory" ] || return 1
    [ ! -L "$directory" ] || return 1
  fi
}

[ "$#" = 0 ] || fail SCHEDULE_ARGUMENT_INVALID
[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
[ -d "$REPO" ] || fail REPOSITORY_MISSING
[ -x "$NPM" ] || fail NPM_REQUIRED
[ -x "$NODE" ] || fail NODE_REQUIRED
[ -f "$STATUS_SCRIPT" ] || fail STATUS_SCRIPT_MISSING
[ ! -L "$STATUS_SCRIPT" ] || fail STATUS_SCRIPT_UNSAFE

assert_directory_target_safe "$STATE_DIR" || fail STATE_DIRECTORY_UNSAFE
assert_directory_target_safe "$LOG_DIR" || fail LOG_DIRECTORY_UNSAFE
install -d -o root -g root -m 0700 "$STATE_DIR" "$LOG_DIR" \
  || fail OBSERVABILITY_DIRECTORY_CREATE_FAILED
assert_root_private_directory "$STATE_DIR" || fail STATE_DIRECTORY_UNSAFE
assert_root_private_directory "$LOG_DIR" || fail LOG_DIRECTORY_UNSAFE

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
LOG_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_FILE="$(mktemp "$LOG_DIR/${LOG_STAMP}.XXXXXX.log")" \
  || fail LOG_CREATE_FAILED
chmod 0600 "$LOG_FILE" || fail LOG_MODE_FAILED

cd "$REPO" || fail REPOSITORY_UNAVAILABLE
set +e
"$NPM" run backup:production:manual > "$LOG_FILE" 2>&1
BACKUP_EXIT_CODE="$?"
set -e

FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RUN_ID="$({ sed -n 's/^RUN_ID=\([0-9]\{8\}T[0-9]\{6\}Z-[a-f0-9]\{8\}\)$/\1/p' "$LOG_FILE" || true; } | tail -n 1)"
[ -n "$RUN_ID" ] || RUN_ID=ABSENT

if [ "$BACKUP_EXIT_CODE" = 0 ]; then
  STATUS=PASS
else
  STATUS=FAIL
fi

STATE_EXIT_CODE=0
"$NODE" "$STATUS_SCRIPT" \
  "--state-dir=$STATE_DIR" \
  "--started-at=$STARTED_AT" \
  "--finished-at=$FINISHED_AT" \
  "--status=$STATUS" \
  "--exit-code=$BACKUP_EXIT_CODE" \
  "--run-id=$RUN_ID" \
  "--log-path=$LOG_FILE" \
  || STATE_EXIT_CODE="$?"

if [ "$BACKUP_EXIT_CODE" != 0 ]; then
  echo 'SCHEDULED_PRODUCTION_BACKUP=FAIL'
  echo "ATTEMPT_FINISHED_AT_UTC=$FINISHED_AT"
  echo "BACKUP_EXIT_CODE=$BACKUP_EXIT_CODE"
  echo "RUN_ID=$RUN_ID"
  echo "LOG_PATH=$LOG_FILE"
  echo "LAST_ATTEMPT_PATH=$STATE_DIR/last-attempt.env"
  exit "$BACKUP_EXIT_CODE"
fi
[ "$STATE_EXIT_CODE" = 0 ] || fail SCHEDULE_STATE_UPDATE_FAILED "$STATE_EXIT_CODE"

echo 'SCHEDULED_PRODUCTION_BACKUP=PASS'
echo "ATTEMPT_FINISHED_AT_UTC=$FINISHED_AT"
echo "BACKUP_EXIT_CODE=$BACKUP_EXIT_CODE"
echo "RUN_ID=$RUN_ID"
echo "LOG_PATH=$LOG_FILE"
echo "LAST_ATTEMPT_PATH=$STATE_DIR/last-attempt.env"
echo "LAST_SUCCESS_PATH=$STATE_DIR/last-success.env"
echo 'SCHEDULED_PRODUCTION_BACKUP_ACCEPTANCE=PASS'
