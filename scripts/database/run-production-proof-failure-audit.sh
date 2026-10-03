#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

REPO=/www/wwwroot/xingxingzaishan
PRODUCTION_DATABASE=xingxing_clean_baseline_20260812_staging
EXPECTED_ACTIVE_COMMIT=f9b827cf6245e3780841239139dda0e3bf7d84aa
EXPECTED_ACTIVE_TREE=8c3f5d2836a79f9fc22e6b21a9452512369fe5b9
PSQL=/usr/pgsql-15/bin/psql

fail() {
  printf 'PRODUCTION_PROOF_FAILURE_AUDIT=FAIL\n'
  printf 'ERROR_CODE=%s\n' "$1"
  printf 'PRODUCTION_DATABASE_WRITE=NONE\n'
  printf 'APPLICATION_RESTART=NO\n'
  printf 'EXTERNAL_PROVIDER_CALLS=NONE\n'
  printf 'SECRET_VALUES_PRINTED=NO\n'
  exit 1
}

assert_clean_worktree() {
  local state
  state="$(git status --porcelain=v1 --untracked-files=normal)"
  case "$state" in
    '') ;;
    '?? src/frontend/5QJLlAJPza.txt')
      [ -f "$REPO/src/frontend/5QJLlAJPza.txt" ] || return 1
      [ ! -L "$REPO/src/frontend/5QJLlAJPza.txt" ] || return 1
      ;;
    *) return 1 ;;
  esac
}

[ "$#" = 1 ] || fail ARGUMENT_INVALID
[ "$1" = --check ] || fail ARGUMENT_INVALID
[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
[ -d "$REPO/.git" ] || fail REPOSITORY_REQUIRED
[ -x "$PSQL" ] || fail PSQL_REQUIRED

cd "$REPO"
assert_clean_worktree || fail WORKTREE_NOT_CLEAN
[ "$(git rev-parse HEAD)" = "$EXPECTED_ACTIVE_COMMIT" ] || fail ACTIVE_COMMIT_MISMATCH
[ "$(git rev-parse 'HEAD^{tree}')" = "$EXPECTED_ACTIVE_TREE" ] || fail ACTIVE_TREE_MISMATCH

mapfile -t AUDIT_ROWS < <(
  runuser -u postgres -- env \
    -u DATABASE_URL -u PGHOST -u PGPORT -u PGUSER -u PGPASSWORD \
    -u PGPASSWORD_FILE -u PGPASSFILE -u PGDATABASE -u PGSSL -u PGSSLMODE \
    "$PSQL" -X -qAt -F '|' -d "$PRODUCTION_DATABASE" \
      -v ON_ERROR_STOP=1 <<'SQL'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '10000ms';

SELECT
  'PROOF_FAILURE_SUMMARY',
  count(*),
  count(*) FILTER (WHERE updated_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours'),
  count(*) FILTER (WHERE updated_at >= CURRENT_TIMESTAMP - INTERVAL '7 days'),
  count(*) FILTER (WHERE operation_id IS NULL),
  count(*) FILTER (WHERE manifest_hash IS NULL),
  coalesce(max(retry_count), 0),
  coalesce(to_char(min(updated_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'NONE'),
  coalesce(to_char(max(updated_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'NONE')
FROM app.record_proofs
WHERE status = 'failed';

SELECT
  'PROOF_FAILURE_CLASS',
  CASE
    WHEN last_error = '' THEN 'EMPTY'
    WHEN last_error ~ '^[A-Z0-9_]{1,80}$' THEN last_error
    ELSE 'NON_CODE'
  END,
  count(*),
  min(retry_count),
  max(retry_count),
  to_char(min(updated_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  to_char(max(updated_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
FROM app.record_proofs
WHERE status = 'failed'
GROUP BY 2
ORDER BY count(*) DESC, 2 ASC;

WITH failed_proofs AS (
  SELECT record_qr_id FROM app.record_proofs WHERE status = 'failed'
)
SELECT
  'PROOF_FAILURE_OUTBOX',
  count(*),
  count(*) FILTER (WHERE NOT EXISTS (
    SELECT 1 FROM app.outbox_jobs job
    WHERE job.aggregate_type = 'record' AND job.aggregate_id = proof.record_qr_id
  )),
  count(*) FILTER (WHERE EXISTS (
    SELECT 1 FROM app.outbox_jobs job
    WHERE job.aggregate_type = 'record' AND job.aggregate_id = proof.record_qr_id
      AND job.status = 'pending'
  )),
  count(*) FILTER (WHERE EXISTS (
    SELECT 1 FROM app.outbox_jobs job
    WHERE job.aggregate_type = 'record' AND job.aggregate_id = proof.record_qr_id
      AND job.status = 'processing'
  )),
  count(*) FILTER (WHERE EXISTS (
    SELECT 1 FROM app.outbox_jobs job
    WHERE job.aggregate_type = 'record' AND job.aggregate_id = proof.record_qr_id
      AND job.status = 'failed'
  )),
  count(*) FILTER (WHERE EXISTS (
    SELECT 1 FROM app.outbox_jobs job
    WHERE job.aggregate_type = 'record' AND job.aggregate_id = proof.record_qr_id
      AND job.status = 'succeeded'
  ))
FROM failed_proofs proof;

SELECT
  'PROOF_FAILURE_ATTEMPTS',
  count(*),
  count(*) FILTER (WHERE attempt.result_status = 'pending'),
  count(*) FILTER (WHERE attempt.result_status = 'failed'),
  count(*) FILTER (WHERE attempt.result_status = 'succeeded')
FROM app.proof_attempts attempt
JOIN app.record_proofs proof ON proof.id = attempt.proof_id
WHERE proof.status = 'failed';

COMMIT;
SQL
) || fail DATABASE_READ_FAILED

[ "${#AUDIT_ROWS[@]}" -ge 3 ] || fail AUDIT_RESULT_INVALID
for row in "${AUDIT_ROWS[@]}"; do
  case "$row" in
    PROOF_FAILURE_SUMMARY\|*|PROOF_FAILURE_CLASS\|*|PROOF_FAILURE_OUTBOX\|*|PROOF_FAILURE_ATTEMPTS\|*) ;;
    *) fail AUDIT_RESULT_INVALID ;;
  esac
  printf '%s\n' "$row"
done

printf 'ACTIVE_COMMIT=%s\n' "$EXPECTED_ACTIVE_COMMIT"
printf 'ACTIVE_TREE=%s\n' "$EXPECTED_ACTIVE_TREE"
printf 'PRODUCTION_DATABASE=%s\n' "$PRODUCTION_DATABASE"
printf 'PRODUCTION_DATABASE_WRITE=NONE\n'
printf 'APPLICATION_RESTART=NO\n'
printf 'CONFIGURATION_WRITE=NONE\n'
printf 'OSS_REQUESTS=NONE\n'
printf 'BLOCKCHAIN_WRITE=NONE\n'
printf 'EXTERNAL_PROVIDER_CALLS=NONE\n'
printf 'RECORD_IDENTIFIERS_PRINTED=NO\n'
printf 'ERROR_TEXT_PRINTED=CLASSIFIED_ONLY\n'
printf 'SECRET_VALUES_PRINTED=NO\n'
printf 'PRODUCTION_PROOF_FAILURE_AUDIT=COLLECTED\n'
