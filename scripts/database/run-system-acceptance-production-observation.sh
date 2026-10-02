#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

REPO=/www/wwwroot/xingxingzaishan
APP_NAME=xingxingzaishan
PRODUCTION_DATABASE=xingxing_clean_baseline_20260812_staging
BACKUP_SERVICE=xingxingzaishan-production-backup.service
BACKUP_TIMER=xingxingzaishan-production-backup.timer
BACKUP_ATTEMPT_STATE=/var/lib/xingxingzaishan-production-backup/last-attempt.env
BACKUP_SUCCESS_STATE=/var/lib/xingxingzaishan-production-backup/last-success.env
OBJECT_MIRROR_SERVICE=xingxingzaishan-object-mirror.service
OBJECT_MIRROR_TIMER=xingxingzaishan-object-mirror.timer
BACKUP_ROOT=/root/xingxingzaishan-production-backup
MIRROR_ROOT=/root/xingxingzaishan-object-mirror
RUNTIME_CONFIG_CHECK="$REPO/scripts/acceptance/validate-running-production-config.js"
OBJECT_MIRROR_STATE_CHECK="$REPO/scripts/acceptance/validate-object-mirror-state.js"
MAX_BACKUP_AGE_SECONDS=7200
MAX_ROOT_DISK_USED_PERCENT=90
OBSERVATION_CYCLES=3
OBSERVATION_INTERVAL_SECONDS=10
MAX_OBJECT_MIRROR_AGE_SECONDS=129600
APP_PID_INITIAL=''

fail() {
  printf 'SYSTEM_ACCEPTANCE_PRODUCTION_OBSERVATION=FAIL\n'
  printf 'ERROR_CODE=%s\n' "$1"
  printf 'PRODUCTION_DATABASE_WRITE=NONE\n'
  printf 'APPLICATION_RESTART=NO\n'
  printf 'EXTERNAL_PROVIDER_CALLS=NONE\n'
  printf 'SECRET_VALUES_PRINTED=NO\n'
  exit 1
}

assert_private_state_file() {
  local file="$1"
  [ -f "$file" ] || return 1
  [ ! -L "$file" ] || return 1
  [ "$(stat -c '%U:%G' "$file")" = root:root ] || return 1
  [ "$(stat -c '%a' "$file")" = 600 ] || return 1
}

state_value() {
  local file="$1"
  local key="$2"
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$file"
}

unit_exists() {
  systemctl cat "$1" >/dev/null 2>&1
}

directory_kib() {
  local directory="$1"
  if [ -d "$directory" ] && [ ! -L "$directory" ]; then
    du -sk -- "$directory" | awk '{print $1}'
  else
    printf '0\n'
  fi
}

directory_run_count() {
  local directory="$1"
  if [ -d "$directory" ] && [ ! -L "$directory" ]; then
    find "$directory" -mindepth 1 -maxdepth 1 -type d \
      -regextype posix-extended \
      -regex '.*/[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}' -printf '.' |
      wc -c | awk '{print $1}'
  else
    printf '0\n'
  fi
}

observe_database() {
  runuser -u postgres -- env \
    -u DATABASE_URL -u PGHOST -u PGPORT -u PGUSER -u PGPASSWORD \
    -u PGPASSWORD_FILE -u PGPASSFILE -u PGDATABASE -u PGSSL -u PGSSLMODE \
    /usr/pgsql-15/bin/psql -X -qAt -F '|' -d "$PRODUCTION_DATABASE" \
      -v ON_ERROR_STOP=1 <<'SQL'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '10000ms';
SELECT
  count(*) FILTER (WHERE status = 'pending'),
  count(*) FILTER (WHERE status = 'pending' AND available_at <= CURRENT_TIMESTAMP),
  count(*) FILTER (WHERE status = 'processing'),
  count(*) FILTER (
    WHERE status = 'processing'
      AND locked_at <= CURRENT_TIMESTAMP - INTERVAL '5 minutes'
  ),
  count(*) FILTER (WHERE status = 'failed'),
  count(*) FILTER (WHERE status = 'succeeded'),
  coalesce(max(attempt_count), 0)
FROM app.outbox_jobs;
SELECT
  count(*) FILTER (WHERE status = 'not_started'),
  count(*) FILTER (WHERE status = 'manifest_ready'),
  count(*) FILTER (WHERE status = 'submitting'),
  count(*) FILTER (WHERE status = 'submitted'),
  count(*) FILTER (WHERE status = 'confirmed'),
  count(*) FILTER (WHERE status = 'failed'),
  count(*) FILTER (WHERE status = 'retrying')
FROM app.record_proofs;
SELECT
  count(*) FILTER (WHERE status = 'pending'),
  count(*) FILTER (WHERE status = 'ready'),
  count(*) FILTER (WHERE status = 'failed')
FROM app.record_archives;
COMMIT;
SQL
}

[ "$#" = 1 ] || fail ARGUMENT_INVALID
[ "$1" = --check ] || fail ARGUMENT_INVALID
[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
[ -d "$REPO/.git" ] || fail REPOSITORY_REQUIRED
for command in awk curl date df du find git pm2 runuser seq sleep stat systemctl tr wc; do
  command -v "$command" >/dev/null 2>&1 || fail "${command^^}_REQUIRED"
done
[ -x /usr/local/bin/node ] || fail NODE_REQUIRED
[ -x /usr/pgsql-15/bin/psql ] || fail PSQL_REQUIRED
[ -f "$RUNTIME_CONFIG_CHECK" ] || fail RUNTIME_CONFIG_CHECK_MISSING
[ ! -L "$RUNTIME_CONFIG_CHECK" ] || fail RUNTIME_CONFIG_CHECK_UNSAFE
[ -f "$OBJECT_MIRROR_STATE_CHECK" ] || fail OBJECT_MIRROR_STATE_CHECK_MISSING
[ ! -L "$OBJECT_MIRROR_STATE_CHECK" ] || fail OBJECT_MIRROR_STATE_CHECK_UNSAFE

cd "$REPO"
[ -z "$(git status --porcelain=v1 --untracked-files=normal)" ] || fail WORKTREE_NOT_CLEAN
ACTIVE_COMMIT="$(git rev-parse HEAD)"
ACTIVE_TREE="$(git rev-parse 'HEAD^{tree}')"
[[ "$ACTIVE_COMMIT" =~ ^[a-f0-9]{40}$ ]] || fail ACTIVE_COMMIT_INVALID
[[ "$ACTIVE_TREE" =~ ^[a-f0-9]{40}$ ]] || fail ACTIVE_TREE_INVALID

APP_PID_INITIAL="$(pm2 pid "$APP_NAME" | awk '$1 != "0" { print $1 }')"
[[ "$APP_PID_INITIAL" =~ ^[0-9]+$ ]] || fail APP_SINGLE_PID_REQUIRED
[ -r "/proc/$APP_PID_INITIAL/environ" ] || fail APP_ENVIRONMENT_UNREADABLE
PM2_STATE="$(pm2 jlist | /usr/local/bin/node -e '
const fs = require("node:fs");
const rows = JSON.parse(fs.readFileSync(0, "utf8"));
const app = rows.filter((row) => row.name === "xingxingzaishan");
if (app.length !== 1) process.exit(2);
const env = app[0].pm2_env || {};
const startedAt = Number(env.pm_uptime || 0);
process.stdout.write([
  String(Number(app[0].pid || 0)),
  String(env.status || "UNKNOWN"),
  String(Number(env.restart_time || 0)),
  String(startedAt)
].join("|"));
')" || fail PM2_STATE_INVALID
IFS='|' read -r PM2_PID PM2_STATUS PM2_RESTART_COUNT PM2_STARTED_AT_MS <<< "$PM2_STATE"
[ "$PM2_PID" = "$APP_PID_INITIAL" ] || fail APP_PID_CHANGED
[ "$PM2_STATUS" = online ] || fail APP_NOT_ONLINE
[[ "$PM2_RESTART_COUNT" =~ ^[0-9]+$ ]] || fail PM2_STATE_INVALID
[[ "$PM2_STARTED_AT_MS" =~ ^[0-9]+$ ]] || fail PM2_STATE_INVALID
[ "$PM2_STARTED_AT_MS" -gt 0 ] || fail PM2_STATE_INVALID
"/usr/local/bin/node" "$RUNTIME_CONFIG_CHECK" \
  "$APP_PID_INITIAL" "$REPO" "$PRODUCTION_DATABASE" "$PM2_STARTED_AT_MS" \
  || fail RUNTIME_CONFIG_INVALID
[ "$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 10 \
  http://127.0.0.1:3000/api/health/ready)" = 200 ] || fail CURRENT_READINESS_FAILED

ROOT_DISK_USED_PERCENT="$(df -P / | awk 'NR == 2 { sub(/%$/, "", $5); print $5 }')"
[[ "$ROOT_DISK_USED_PERCENT" =~ ^[0-9]+$ ]] || fail ROOT_DISK_USAGE_INVALID
[ "$ROOT_DISK_USED_PERCENT" -lt "$MAX_ROOT_DISK_USED_PERCENT" ] \
  || fail ROOT_DISK_USAGE_TOO_HIGH

unit_exists "$BACKUP_TIMER" || fail BACKUP_TIMER_NOT_INSTALLED
systemctl is-enabled --quiet "$BACKUP_TIMER" || fail BACKUP_TIMER_NOT_ENABLED
systemctl is-active --quiet "$BACKUP_TIMER" || fail BACKUP_TIMER_NOT_ACTIVE
unit_exists "$BACKUP_SERVICE" || fail BACKUP_SERVICE_NOT_INSTALLED
BACKUP_SERVICE_RESULT="$(systemctl show "$BACKUP_SERVICE" -p Result --value)"
BACKUP_SERVICE_EXIT="$(systemctl show "$BACKUP_SERVICE" -p ExecMainStatus --value)"
[ "$BACKUP_SERVICE_RESULT" = success ] || fail BACKUP_SERVICE_RESULT_INVALID
[ "$BACKUP_SERVICE_EXIT" = 0 ] || fail BACKUP_SERVICE_EXIT_INVALID
assert_private_state_file "$BACKUP_ATTEMPT_STATE" || fail BACKUP_ATTEMPT_STATE_INVALID
[ "$(state_value "$BACKUP_ATTEMPT_STATE" STATUS)" = PASS ] \
  || fail BACKUP_LAST_ATTEMPT_NOT_PASS
[ "$(state_value "$BACKUP_ATTEMPT_STATE" EXIT_CODE)" = 0 ] \
  || fail BACKUP_LAST_ATTEMPT_EXIT_INVALID
assert_private_state_file "$BACKUP_SUCCESS_STATE" || fail BACKUP_SUCCESS_STATE_INVALID
[ "$(state_value "$BACKUP_SUCCESS_STATE" STATUS)" = PASS ] \
  || fail BACKUP_SUCCESS_STATE_NOT_PASS
[ "$(state_value "$BACKUP_SUCCESS_STATE" EXIT_CODE)" = 0 ] \
  || fail BACKUP_SUCCESS_EXIT_INVALID
BACKUP_FINISHED_AT="$(state_value "$BACKUP_SUCCESS_STATE" ATTEMPT_FINISHED_AT_UTC)"
BACKUP_FINISHED_EPOCH="$(date -u -d "$BACKUP_FINISHED_AT" +%s 2>/dev/null)" \
  || fail BACKUP_SUCCESS_TIME_INVALID
NOW_EPOCH="$(date -u +%s)"
BACKUP_AGE_SECONDS=$((NOW_EPOCH - BACKUP_FINISHED_EPOCH))
[ "$BACKUP_AGE_SECONDS" -ge 0 ] || fail BACKUP_SUCCESS_TIME_IN_FUTURE
[ "$BACKUP_AGE_SECONDS" -le "$MAX_BACKUP_AGE_SECONDS" ] \
  || fail BACKUP_SUCCESS_STALE

if unit_exists "$OBJECT_MIRROR_TIMER"; then
  if systemctl is-enabled --quiet "$OBJECT_MIRROR_TIMER" \
      && systemctl is-active --quiet "$OBJECT_MIRROR_TIMER" \
      && unit_exists "$OBJECT_MIRROR_SERVICE"; then
    OBJECT_MIRROR_SCHEDULE=ACTIVE
    OBJECT_MIRROR_SERVICE_RESULT="$(systemctl show "$OBJECT_MIRROR_SERVICE" -p Result --value)"
    OBJECT_MIRROR_SERVICE_EXIT="$(systemctl show "$OBJECT_MIRROR_SERVICE" -p ExecMainStatus --value)"
    [ "$OBJECT_MIRROR_SERVICE_RESULT" = success ] \
      || fail OBJECT_MIRROR_SERVICE_RESULT_INVALID
    [ "$OBJECT_MIRROR_SERVICE_EXIT" = 0 ] || fail OBJECT_MIRROR_SERVICE_EXIT_INVALID
    "/usr/local/bin/node" "$OBJECT_MIRROR_STATE_CHECK" "$MAX_OBJECT_MIRROR_AGE_SECONDS" \
      || fail OBJECT_MIRROR_STATE_INVALID
    OBJECT_MIRROR_P0_GATE=CLOSED
  else
    OBJECT_MIRROR_SCHEDULE=INVALID
    OBJECT_MIRROR_P0_GATE=OPEN
  fi
else
  OBJECT_MIRROR_SCHEDULE=NOT_CONFIGURED
  OBJECT_MIRROR_P0_GATE=OPEN
fi

printf 'ACTIVE_COMMIT=%s\n' "$ACTIVE_COMMIT"
printf 'ACTIVE_TREE=%s\n' "$ACTIVE_TREE"
printf 'APP_PID=%s\n' "$APP_PID_INITIAL"
printf 'PM2_STATUS=%s\n' "$PM2_STATUS"
printf 'PM2_RESTART_COUNT=%s\n' "$PM2_RESTART_COUNT"
printf 'PM2_STARTED_AT_MS=%s\n' "$PM2_STARTED_AT_MS"
printf 'CURRENT_READINESS=PASS_200_READY\n'
printf 'PRODUCTION_RUNTIME_CONFIG=PASS\n'
printf 'ROOT_DISK_USED_PERCENT=%s\n' "$ROOT_DISK_USED_PERCENT"
printf 'BACKUP_TIMER=ENABLED_ACTIVE\n'
printf 'BACKUP_SERVICE_RESULT=%s\n' "$BACKUP_SERVICE_RESULT"
printf 'BACKUP_SERVICE_EXIT=%s\n' "$BACKUP_SERVICE_EXIT"
printf 'BACKUP_LAST_SUCCESS_AGE_SECONDS=%s\n' "$BACKUP_AGE_SECONDS"
printf 'LOCAL_BACKUP_RUN_COUNT=%s\n' "$(directory_run_count "$BACKUP_ROOT")"
printf 'LOCAL_BACKUP_SIZE_KIB=%s\n' "$(directory_kib "$BACKUP_ROOT")"
printf 'OBJECT_MIRROR_TIMER=%s\n' "$OBJECT_MIRROR_SCHEDULE"
printf 'OBJECT_MIRROR_P0_GATE=%s\n' "$OBJECT_MIRROR_P0_GATE"
printf 'LOCAL_MIRROR_RUN_COUNT=%s\n' "$(directory_run_count "$MIRROR_ROOT")"
printf 'LOCAL_MIRROR_SIZE_KIB=%s\n' "$(directory_kib "$MIRROR_ROOT")"

for cycle in $(seq 1 "$OBSERVATION_CYCLES"); do
  APP_PID_CURRENT="$(pm2 pid "$APP_NAME" | awk '$1 != "0" { print $1 }')"
  [ "$APP_PID_CURRENT" = "$APP_PID_INITIAL" ] || fail APP_PID_CHANGED
  [ "$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 10 \
    http://127.0.0.1:3000/api/health/ready)" = 200 ] || fail READINESS_FAILED
  mapfile -t DATABASE_ROWS < <(observe_database)
  [ "${#DATABASE_ROWS[@]}" = 3 ] || fail DATABASE_OBSERVATION_INVALID
  IFS='|' read -r OUTBOX_PENDING OUTBOX_READY OUTBOX_PROCESSING \
    OUTBOX_STALE OUTBOX_FAILED OUTBOX_SUCCEEDED OUTBOX_MAX_ATTEMPTS \
    <<< "${DATABASE_ROWS[0]}"
  IFS='|' read -r PROOF_NOT_STARTED PROOF_MANIFEST_READY PROOF_SUBMITTING \
    PROOF_SUBMITTED PROOF_CONFIRMED PROOF_FAILED PROOF_RETRYING \
    <<< "${DATABASE_ROWS[1]}"
  IFS='|' read -r ARCHIVE_PENDING ARCHIVE_READY ARCHIVE_FAILED \
    <<< "${DATABASE_ROWS[2]}"
  for value in \
    "$OUTBOX_PENDING" "$OUTBOX_READY" "$OUTBOX_PROCESSING" "$OUTBOX_STALE" \
    "$OUTBOX_FAILED" "$OUTBOX_SUCCEEDED" "$OUTBOX_MAX_ATTEMPTS" \
    "$PROOF_NOT_STARTED" "$PROOF_MANIFEST_READY" "$PROOF_SUBMITTING" \
    "$PROOF_SUBMITTED" "$PROOF_CONFIRMED" "$PROOF_FAILED" "$PROOF_RETRYING" \
    "$ARCHIVE_PENDING" "$ARCHIVE_READY" "$ARCHIVE_FAILED"
  do
    [[ "$value" =~ ^[0-9]+$ ]] || fail DATABASE_OBSERVATION_INVALID
  done
  [ "$OUTBOX_STALE" = 0 ] || fail OUTBOX_STALE_PROCESSING_PRESENT
  [ "$OUTBOX_FAILED" = 0 ] || fail OUTBOX_FAILED_PRESENT
  printf 'OBSERVATION_CYCLE_%s=PASS\n' "$cycle"
  printf 'OBSERVATION_CYCLE_%s_OUTBOX=%s|%s|%s|%s|%s|%s|%s\n' \
    "$cycle" "$OUTBOX_PENDING" "$OUTBOX_READY" "$OUTBOX_PROCESSING" \
    "$OUTBOX_STALE" "$OUTBOX_FAILED" "$OUTBOX_SUCCEEDED" "$OUTBOX_MAX_ATTEMPTS"
  printf 'OBSERVATION_CYCLE_%s_PROOFS=%s|%s|%s|%s|%s|%s|%s\n' \
    "$cycle" "$PROOF_NOT_STARTED" "$PROOF_MANIFEST_READY" "$PROOF_SUBMITTING" \
    "$PROOF_SUBMITTED" "$PROOF_CONFIRMED" "$PROOF_FAILED" "$PROOF_RETRYING"
  printf 'OBSERVATION_CYCLE_%s_ARCHIVES=%s|%s|%s\n' \
    "$cycle" "$ARCHIVE_PENDING" "$ARCHIVE_READY" "$ARCHIVE_FAILED"
  if [ "$cycle" -lt "$OBSERVATION_CYCLES" ]; then
    sleep "$OBSERVATION_INTERVAL_SECONDS"
  fi
done

printf 'PRODUCTION_DATABASE_WRITE=NONE\n'
printf 'APPLICATION_RESTART=NO\n'
printf 'CONFIGURATION_WRITE=NONE\n'
printf 'OSS_REQUESTS=NONE\n'
printf 'BLOCKCHAIN_WRITE=NONE\n'
printf 'EXTERNAL_PROVIDER_CALLS=NONE\n'
printf 'SECRET_VALUES_PRINTED=NO\n'
printf 'SYSTEM_ACCEPTANCE_PRODUCTION_OBSERVATION=COLLECTED\n'
