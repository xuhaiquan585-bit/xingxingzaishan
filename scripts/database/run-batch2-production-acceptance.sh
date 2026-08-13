#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

REPO=/www/wwwroot/xingxingzaishan
MIGRATION_SHA=f2404ceef14280f4025f5a00d0586ce58597007c4a2cdfae2ce4a26487b8f70e
PRODUCTION_DB=xingxing_clean_baseline_20260812_staging
BACKUP_SERVICE=xingxingzaishan-production-backup.service
BACKUP_TIMER=xingxingzaishan-production-backup.timer
BACKUP_STATE=/var/lib/xingxingzaishan-production-backup/last-attempt.env
AUDIT_ROOT=/root/batch2-production-acceptance-20260814
AUDIT_DIR="$AUDIT_ROOT/$(date -u +%Y%m%dT%H%M%SZ)-$$"
TEST_DB_CREATED=NO

fail() {
  echo "BATCH_2_PRODUCTION_ACCEPTANCE=FAIL"
  echo "ERROR_CODE=$1"
  exit 1
}

runtime_value() {
  local app_pid="$1"
  local key="$2"
  tr '\0' '\n' < "/proc/$app_pid/environ" | sed -n "s/^${key}=//p" | tail -n 1
}

admin_psql() {
  runuser -u postgres -- env -u DATABASE_URL -u PGHOST -u PGPORT -u PGUSER -u PGPASSWORD -u PGPASSWORD_FILE -u PGPASSFILE -u PGDATABASE -u PGSSL -u PGSSLMODE /usr/pgsql-15/bin/psql "$@"
}

database_count() {
  admin_psql -X -At -d postgres -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM pg_database WHERE datname = '$1';"
}

cleanup_test_database() {
  local cleanup_status=0
  if [ "$TEST_DB_CREATED" = YES ]; then
    admin_psql -X -d postgres -v ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$TEST_DB' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || cleanup_status=1
    runuser -u postgres -- env -u DATABASE_URL -u PGHOST -u PGPORT -u PGUSER -u PGPASSWORD -u PGPASSWORD_FILE -u PGPASSFILE -u PGDATABASE -u PGSSL -u PGSSLMODE /usr/pgsql-15/bin/dropdb --if-exists "$TEST_DB" >/dev/null 2>&1 || cleanup_status=1
    if [ "$cleanup_status" -eq 0 ]; then
      TEST_DB_CREATED=NO
    fi
  fi
  return "$cleanup_status"
}

on_exit() {
  local original_status=$?
  local cleanup_status=0
  trap - EXIT INT TERM
  set +e
  cleanup_test_database
  cleanup_status=$?
  if [ "$original_status" -ne 0 ]; then
    echo "FAILED_AUDIT_DIRECTORY=$AUDIT_DIR"
    exit "$original_status"
  fi
  if [ "$cleanup_status" -ne 0 ]; then
    echo "BATCH_2_PRODUCTION_ACCEPTANCE=FAIL"
    echo "ERROR_CODE=TEST_DATABASE_CLEANUP_FAILED"
    exit 1
  fi
}

trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
cd "$REPO"
[ -z "$(git status --porcelain --untracked-files=no)" ] || fail TRACKED_WORKTREE_DIRTY
TARGET_HEAD="${BATCH2_TARGET_HEAD:-}"
[[ "$TARGET_HEAD" =~ ^[a-f0-9]{40}$ ]] || fail TARGET_HEAD_INVALID
TEST_DB="xingxing_issued_qr_007_${TARGET_HEAD:0:8}_test"

install -d -o root -g root -m 0700 "$AUDIT_ROOT" "$AUDIT_DIR"

OLD_BACKUP_RUN_ID="$(sed -n 's/^RUN_ID=//p' "$BACKUP_STATE" 2>/dev/null | tail -n 1 || true)"
while systemctl is-active --quiet "$BACKUP_SERVICE"; do
  sleep 2
done
systemctl reset-failed "$BACKUP_SERVICE" >/dev/null 2>&1 || true
if ! systemctl start "$BACKUP_SERVICE"; then
  journalctl -u "$BACKUP_SERVICE" -n 50 --no-pager
  fail PRE_MIGRATION_BACKUP_FAILED
fi

[ "$(systemctl show "$BACKUP_SERVICE" -p Result --value)" = success ] || fail BACKUP_SYSTEMD_RESULT_INVALID
[ "$(systemctl show "$BACKUP_SERVICE" -p ExecMainStatus --value)" = 0 ] || fail BACKUP_SYSTEMD_EXIT_INVALID
systemctl is-enabled --quiet "$BACKUP_TIMER" || fail BACKUP_TIMER_NOT_ENABLED
systemctl is-active --quiet "$BACKUP_TIMER" || fail BACKUP_TIMER_NOT_ACTIVE
[ -f "$BACKUP_STATE" ] || fail BACKUP_STATE_MISSING
[ ! -L "$BACKUP_STATE" ] || fail BACKUP_STATE_SYMLINK
[ "$(stat -c '%U:%G' "$BACKUP_STATE")" = root:root ] || fail BACKUP_STATE_OWNER_INVALID
[ "$(stat -c '%a' "$BACKUP_STATE")" = 600 ] || fail BACKUP_STATE_MODE_INVALID
grep -qx 'STATUS=PASS' "$BACKUP_STATE" || fail BACKUP_STATE_NOT_PASS
grep -qx 'EXIT_CODE=0' "$BACKUP_STATE" || fail BACKUP_STATE_EXIT_INVALID
NEW_BACKUP_RUN_ID="$(sed -n 's/^RUN_ID=//p' "$BACKUP_STATE" | tail -n 1)"
[[ "$NEW_BACKUP_RUN_ID" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$ ]] || fail BACKUP_RUN_ID_INVALID
[ "$NEW_BACKUP_RUN_ID" != "$OLD_BACKUP_RUN_ID" ] || fail BACKUP_RUN_ID_NOT_NEW
BACKUP_LOG="$(sed -n 's/^LOG_PATH=//p' "$BACKUP_STATE" | tail -n 1)"
[[ "$BACKUP_LOG" == /var/log/xingxingzaishan-production-backup/*.log ]] || fail BACKUP_LOG_PATH_INVALID
[ -f "$BACKUP_LOG" ] || fail BACKUP_LOG_MISSING
[ ! -L "$BACKUP_LOG" ] || fail BACKUP_LOG_SYMLINK
[ "$(stat -c '%U:%G' "$BACKUP_LOG")" = root:root ] || fail BACKUP_LOG_OWNER_INVALID
[ "$(stat -c '%a' "$BACKUP_LOG")" = 600 ] || fail BACKUP_LOG_MODE_INVALID
grep -qx 'PRODUCTION_MANUAL_OFFSITE_BACKUP_ACCEPTANCE=PASS' "$BACKUP_LOG" || fail BACKUP_ARTIFACT_ACCEPTANCE_MISSING

echo "PRE_MIGRATION_BACKUP_RUN_ID=$NEW_BACKUP_RUN_ID"
echo "PRE_MIGRATION_BACKUP_LOG=$BACKUP_LOG"
echo 'PRE_MIGRATION_OFFSITE_BACKUP=PASS'

git fetch --prune origin
[ "$(git rev-parse origin/main)" = "$TARGET_HEAD" ] || fail REMOTE_HEAD_INVALID
TARGET_TREE="$(git rev-parse "${TARGET_HEAD}^{tree}")"
git merge-base --is-ancestor HEAD origin/main || fail CURRENT_HEAD_NOT_ANCESTOR
git merge --ff-only origin/main
[ "$(git rev-parse HEAD)" = "$TARGET_HEAD" ] || fail DEPLOYED_HEAD_INVALID
[ "$(git rev-parse 'HEAD^{tree}')" = "$TARGET_TREE" ] || fail DEPLOYED_TREE_INVALID
[ "$(sha256sum database/migrations/007_prevent_issued_qr_deletion.sql | awk '{print $1}')" = "$MIGRATION_SHA" ] || fail MIGRATION_SHA_INVALID
[ -z "$(git status --porcelain --untracked-files=no)" ] || fail TRACKED_WORKTREE_DIRTY_AFTER_PULL
git diff --check

npm test > "$AUDIT_DIR/npm-test.log" 2>&1
tail -n 20 "$AUDIT_DIR/npm-test.log"
grep -q '^# tests 419$' "$AUDIT_DIR/npm-test.log" || fail OFFLINE_TEST_COUNT_INVALID
grep -q '^# fail 0$' "$AUDIT_DIR/npm-test.log" || fail OFFLINE_TESTS_FAILED
echo 'BATCH_2_OFFLINE_TESTS=PASS_419'

APP_PID_BEFORE="$(pm2 pid xingxingzaishan | tail -n 1)"
[ -n "$APP_PID_BEFORE" ] || fail APP_PID_MISSING
[ "$APP_PID_BEFORE" != 0 ] || fail APP_NOT_ONLINE
PGHOST="$(runtime_value "$APP_PID_BEFORE" PGHOST)"
PGPORT="$(runtime_value "$APP_PID_BEFORE" PGPORT)"
PGUSER="$(runtime_value "$APP_PID_BEFORE" PGUSER)"
PGSSL="$(runtime_value "$APP_PID_BEFORE" PGSSL)"
PGSSL_REJECT_UNAUTHORIZED="$(runtime_value "$APP_PID_BEFORE" PGSSL_REJECT_UNAUTHORIZED)"
PGPASSWORD_FILE="$(runtime_value "$APP_PID_BEFORE" PGPASSWORD_FILE)"
RUNTIME_DATABASE="$(runtime_value "$APP_PID_BEFORE" PGDATABASE)"
[ "$RUNTIME_DATABASE" = "$PRODUCTION_DB" ] || fail PRODUCTION_DATABASE_INVALID
[ "$PGUSER" = xingxing_staging_app ] || fail POSTGRES_USER_INVALID
[ -f "$PGPASSWORD_FILE" ] || fail POSTGRES_PASSWORD_FILE_MISSING
[ ! -L "$PGPASSWORD_FILE" ] || fail POSTGRES_PASSWORD_FILE_SYMLINK
[ "$(stat -c '%U:%G' "$PGPASSWORD_FILE")" = root:root ] || fail POSTGRES_PASSWORD_FILE_OWNER_INVALID
[ "$(stat -c '%a' "$PGPASSWORD_FILE")" = 600 ] || fail POSTGRES_PASSWORD_FILE_MODE_INVALID
[ "$(database_count "$TEST_DB")" = 0 ] || fail TEST_DATABASE_ALREADY_EXISTS

runuser -u postgres -- env -u DATABASE_URL -u PGHOST -u PGPORT -u PGUSER -u PGPASSWORD -u PGPASSWORD_FILE -u PGPASSFILE -u PGDATABASE -u PGSSL -u PGSSLMODE /usr/pgsql-15/bin/createdb -O "$PGUSER" -E UTF8 -T template0 --lc-collate=C.utf8 --lc-ctype=C.utf8 "$TEST_DB"
TEST_DB_CREATED=YES
admin_psql -X -d postgres -v ON_ERROR_STOP=1 -c "REVOKE ALL ON DATABASE $TEST_DB FROM PUBLIC; GRANT CONNECT, TEMPORARY ON DATABASE $TEST_DB TO $PGUSER;" >/dev/null

unset DATABASE_URL PGPASSWORD PGPASSFILE
export PGHOST PGPORT PGUSER PGSSL PGSSL_REJECT_UNAUTHORIZED PGPASSWORD_FILE
export PGDATABASE="$TEST_DB"
export PGAPPLICATION_NAME=xingxingzaishan-issued-qr-007-integration
export NODE_ENV=test
export RUN_POSTGRES_INTEGRATION=true

node --test tests/postgresql-read-adapter.integration.test.js > "$AUDIT_DIR/postgresql-integration.log" 2>&1
tail -n 25 "$AUDIT_DIR/postgresql-integration.log"
grep -q '^# tests 1$' "$AUDIT_DIR/postgresql-integration.log" || fail POSTGRES_INTEGRATION_COUNT_INVALID
grep -q '^# pass 1$' "$AUDIT_DIR/postgresql-integration.log" || fail POSTGRES_INTEGRATION_NOT_PASS
grep -q '^# fail 0$' "$AUDIT_DIR/postgresql-integration.log" || fail POSTGRES_INTEGRATION_FAILED

cleanup_test_database || fail TEST_DATABASE_CLEANUP_FAILED
[ "$(database_count "$TEST_DB")" = 0 ] || fail TEST_DATABASE_REMAINS
unset PGHOST PGPORT PGUSER PGSSL PGSSL_REJECT_UNAUTHORIZED PGPASSWORD_FILE PGDATABASE PGAPPLICATION_NAME NODE_ENV RUN_POSTGRES_INTEGRATION

[ "$(pm2 pid xingxingzaishan | tail -n 1)" = "$APP_PID_BEFORE" ] || fail APP_CHANGED_DURING_INTEGRATION
[ "$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 10 http://127.0.0.1:3000/)" = 200 ] || fail APP_HTTP_INVALID_AFTER_INTEGRATION
echo 'ISSUED_QR_007_DISPOSABLE_POSTGRES_INTEGRATION=PASS'
echo 'DISPOSABLE_TEST_DATABASE_REMOVED=YES'

if ! npm run db:protect-issued-qr:production > "$AUDIT_DIR/migration-007.log" 2>&1; then
  cat "$AUDIT_DIR/migration-007.log"
  fail PRODUCTION_MIGRATION_007_FAILED
fi
cat "$AUDIT_DIR/migration-007.log"
grep -qx 'MIGRATION=007_prevent_issued_qr_deletion.sql' "$AUDIT_DIR/migration-007.log" || fail PRODUCTION_MIGRATION_NAME_INVALID
grep -qx "MIGRATION_SHA256=$MIGRATION_SHA" "$AUDIT_DIR/migration-007.log" || fail PRODUCTION_MIGRATION_SHA_INVALID
grep -Eq '^MIGRATION_STATUS=(APPLIED_NOW|ALREADY_APPLIED)$' "$AUDIT_DIR/migration-007.log" || fail PRODUCTION_MIGRATION_STATUS_INVALID
grep -qx 'ISSUED_QR_DIRECT_DELETE=REJECTED_23514' "$AUDIT_DIR/migration-007.log" || fail DIRECT_DELETE_PROBE_FAILED
grep -qx 'ISSUED_QR_STATUS_DOWNGRADE=REJECTED_23514' "$AUDIT_DIR/migration-007.log" || fail STATUS_DOWNGRADE_PROBE_FAILED
grep -qx 'ISSUED_QR_TRUNCATE=REJECTED_23514' "$AUDIT_DIR/migration-007.log" || fail TRUNCATE_PROBE_FAILED
grep -qx 'ISSUED_QR_MULTI_DELETE=REJECTED_23514' "$AUDIT_DIR/migration-007.log" || fail MULTI_DELETE_PROBE_FAILED
grep -qx 'QR_COUNT_UNCHANGED=YES' "$AUDIT_DIR/migration-007.log" || fail QR_COUNT_CHANGED
grep -qx 'ISSUED_QR_DATABASE_PROTECTION=PASS' "$AUDIT_DIR/migration-007.log" || fail DATABASE_PROTECTION_NOT_PASS
grep -qx 'ISSUED_QR_PRODUCTION_MIGRATION=PASS' "$AUDIT_DIR/migration-007.log" || fail PRODUCTION_MIGRATION_NOT_PASS

pm2 restart xingxingzaishan
APP_HTTP=000
for attempt in {1..30}; do
  APP_HTTP="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 5 http://127.0.0.1:3000/ || true)"
  [ "$APP_HTTP" = 200 ] && break
  sleep 1
done
[ "$APP_HTTP" = 200 ] || fail APP_HTTP_INVALID_AFTER_RESTART

if ! npm run db:protect-issued-qr:production > "$AUDIT_DIR/post-restart-verification.log" 2>&1; then
  cat "$AUDIT_DIR/post-restart-verification.log"
  fail POST_RESTART_DATABASE_VERIFICATION_FAILED
fi
cat "$AUDIT_DIR/post-restart-verification.log"
grep -qx 'MIGRATION_STATUS=ALREADY_APPLIED' "$AUDIT_DIR/post-restart-verification.log" || fail POST_RESTART_MIGRATION_STATUS_INVALID
grep -qx "MIGRATION_SHA256=$MIGRATION_SHA" "$AUDIT_DIR/post-restart-verification.log" || fail POST_RESTART_MIGRATION_SHA_INVALID
grep -qx 'ISSUED_QR_DIRECT_DELETE=REJECTED_23514' "$AUDIT_DIR/post-restart-verification.log" || fail POST_RESTART_DIRECT_DELETE_FAILED
grep -qx 'ISSUED_QR_STATUS_DOWNGRADE=REJECTED_23514' "$AUDIT_DIR/post-restart-verification.log" || fail POST_RESTART_STATUS_DOWNGRADE_FAILED
grep -qx 'ISSUED_QR_TRUNCATE=REJECTED_23514' "$AUDIT_DIR/post-restart-verification.log" || fail POST_RESTART_TRUNCATE_FAILED
grep -qx 'ISSUED_QR_MULTI_DELETE=REJECTED_23514' "$AUDIT_DIR/post-restart-verification.log" || fail POST_RESTART_MULTI_DELETE_FAILED
grep -qx 'QR_COUNT_UNCHANGED=YES' "$AUDIT_DIR/post-restart-verification.log" || fail POST_RESTART_QR_COUNT_CHANGED
grep -qx 'ISSUED_QR_DATABASE_PROTECTION=PASS' "$AUDIT_DIR/post-restart-verification.log" || fail POST_RESTART_PROTECTION_NOT_PASS

[ -f src/server/data/db.json ] || fail PRODUCTION_JSON_MISSING
[ ! -L src/server/data/db.json ] || fail PRODUCTION_JSON_SYMLINK
[ "$(stat -c '%U:%G' src/server/data/db.json)" = root:root ] || fail PRODUCTION_JSON_OWNER_INVALID
JSON_MODE="$(stat -c '%a' src/server/data/db.json)"
[ "$((8#$JSON_MODE & 022))" -eq 0 ] || fail PRODUCTION_JSON_MODE_INVALID
node -e "const fs=require('node:fs');const d=JSON.parse(fs.readFileSync('src/server/data/db.json','utf8'));for(const k of ['users','qr_codes','admins','products','orders','accounts'])if(!Array.isArray(d[k]))process.exit(1)"

APP_PID_AFTER="$(pm2 pid xingxingzaishan | tail -n 1)"
[ -n "$APP_PID_AFTER" ] || fail FINAL_APP_PID_MISSING
[ "$APP_PID_AFTER" != 0 ] || fail FINAL_APP_NOT_ONLINE
[ "$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 10 http://127.0.0.1:3000/)" = 200 ] || fail FINAL_APP_HTTP_INVALID
[ "$(database_count "$TEST_DB")" = 0 ] || fail FINAL_TEST_DATABASE_REMAINS
[ -z "$(git status --porcelain --untracked-files=no)" ] || fail FINAL_TRACKED_WORKTREE_DIRTY

trap - EXIT INT TERM
echo "DEPLOYED_HEAD=$(git rev-parse HEAD)"
echo "PRE_MIGRATION_BACKUP_RUN_ID=$NEW_BACKUP_RUN_ID"
echo 'OFFLINE_TESTS=PASS_419'
echo 'DISPOSABLE_POSTGRES_INTEGRATION=PASS'
echo 'MIGRATION_007=APPLIED_AND_VERIFIED'
echo 'ISSUED_QR_DATABASE_PROTECTION=PASS'
echo 'PRODUCTION_JSON_VALID=YES'
echo 'AVATA_ENABLED=NO'
echo "APP_PID=$APP_PID_AFTER"
echo 'APP_HTTP=200'
echo "AUDIT_DIRECTORY=$AUDIT_DIR"
echo 'BATCH_2_PRODUCTION_ACCEPTANCE=PASS'
