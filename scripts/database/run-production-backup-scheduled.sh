#!/usr/bin/env bash

set -u
umask 077

REPO=/www/wwwroot/xingxingzaishan
STATE_DIR=/var/lib/xingxingzaishan-production-backup
LOG_DIR=/var/log/xingxingzaishan-production-backup
LOG_RETENTION_COUNT=168
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

prune_schedule_logs() {
  local current_file="$1"
  local kept=0
  local name
  local candidate

  [[ "$LOG_RETENTION_COUNT" =~ ^[1-9][0-9]*$ ]] \
    || fail LOG_RETENTION_INVALID
  while IFS= read -r name; do
    [[ "$name" =~ ^[0-9]{8}T[0-9]{6}Z\.[A-Za-z0-9]{6}\.log$ ]] || continue
    candidate="$LOG_DIR/$name"
    [ -f "$candidate" ] || fail LOG_RETENTION_FILE_INVALID
    [ ! -L "$candidate" ] || fail LOG_RETENTION_FILE_INVALID
    [ "$(stat -c '%U:%G' "$candidate")" = root:root ] \
      || fail LOG_RETENTION_FILE_INVALID
    [ "$(stat -c '%a' "$candidate")" = 600 ] \
      || fail LOG_RETENTION_FILE_INVALID
    kept=$((kept + 1))
    if [ "$kept" -gt "$LOG_RETENTION_COUNT" ] \
        && [ "$candidate" != "$current_file" ]; then
      rm -f -- "$candidate" || fail LOG_RETENTION_CLEANUP_FAILED
    fi
  done < <(
    {
      printf '%s\n' "$(basename "$current_file")"
      find "$LOG_DIR" -mindepth 1 -maxdepth 1 -printf '%f\n' \
        | LC_ALL=C sort -r \
        | grep -Fvx -- "$(basename "$current_file")"
    }
  )
}

[ "$#" = 0 ] || fail SCHEDULE_ARGUMENT_INVALID
[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
[ -d "$REPO" ] || fail REPOSITORY_MISSING
[ -x "$NPM" ] || fail NPM_REQUIRED
[ -x "$NODE" ] || fail NODE_REQUIRED
[ -f "$STATUS_SCRIPT" ] || fail STATUS_SCRIPT_MISSING
[ ! -L "$STATUS_SCRIPT" ] || fail STATUS_SCRIPT_UNSAFE
for command in basename find grep rm sort stat; do
  command -v "$command" >/dev/null 2>&1 || fail "${command^^}_REQUIRED"
done

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
prune_schedule_logs "$LOG_FILE"

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
echo "LOG_RETENTION_COUNT=$LOG_RETENTION_COUNT"
echo "LAST_ATTEMPT_PATH=$STATE_DIR/last-attempt.env"
echo "LAST_SUCCESS_PATH=$STATE_DIR/last-success.env"
echo 'SCHEDULED_PRODUCTION_BACKUP_ACCEPTANCE=PASS'
