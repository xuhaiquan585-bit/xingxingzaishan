'use strict';

const { OUTBOX_FIELDS, mapOutboxJob } = require('./mappers');
const {
  assertTransactionContext,
  executeQuery,
  many,
  normalizeLimit,
  oneOrNull
} = require('./query');

const COLUMNS = OUTBOX_FIELDS.join(', ');
const JOB_COLUMNS = OUTBOX_FIELDS.map((field) => `job.${field}`).join(', ');

function normalizeScope(values, code) {
  if (values === undefined || values === null) return null;
  if (!Array.isArray(values) || values.length === 0 || values.length > 1000) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
  const normalized = [...new Set(values.map((value) => String(value || '').trim()))];
  if (normalized.some((value) => !value || value.length > 160 || /[\r\n\0]/.test(value))) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
  return normalized;
}

class OutboxRepository {
  constructor(transactionContext) {
    this.transactionContext = assertTransactionContext(transactionContext);
  }

  async insertPending(job) {
    const values = this.#pendingValues(job);
    const placeholders = OUTBOX_FIELDS.map((_, index) => `$${index + 1}`).join(', ');
    const result = await executeQuery(
      this.transactionContext,
      `INSERT INTO app.outbox_jobs (${COLUMNS})
       VALUES (${placeholders}) RETURNING ${COLUMNS}`,
      OUTBOX_FIELDS.map((field) => values[field])
    );
    return oneOrNull(result, mapOutboxJob, 'REPOSITORY_INSERT_RESULT_INVALID');
  }

  async insertPendingOnce(job) {
    const values = this.#pendingValues(job);
    const placeholders = OUTBOX_FIELDS.map((_, index) => `$${index + 1}`).join(', ');
    const result = await executeQuery(
      this.transactionContext,
      `INSERT INTO app.outbox_jobs (${COLUMNS})
       VALUES (${placeholders})
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING ${COLUMNS}`,
      OUTBOX_FIELDS.map((field) => values[field])
    );
    return oneOrNull(result, mapOutboxJob, 'REPOSITORY_INSERT_RESULT_INVALID');
  }

  async claimPending({
    worker_id: workerId,
    claimed_at: claimedAt,
    limit,
    job_types: jobTypes,
    aggregate_ids: aggregateIds
  } = {}) {
    const boundedLimit = normalizeLimit(limit, { defaultValue: 10, maximum: 50 });
    const normalizedJobTypes = normalizeScope(jobTypes, 'OUTBOX_JOB_TYPE_SCOPE_INVALID');
    const normalizedAggregateIds = normalizeScope(
      aggregateIds,
      'OUTBOX_AGGREGATE_SCOPE_INVALID'
    );
    const result = await executeQuery(
      this.transactionContext,
      `WITH candidates AS (
         SELECT id
         FROM app.outbox_jobs
         WHERE status = 'pending' AND available_at <= $2
           AND ($4::text[] IS NULL OR job_type = ANY($4::text[]))
           AND ($5::text[] IS NULL OR aggregate_id = ANY($5::text[]))
         ORDER BY available_at ASC, created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $3
       )
       UPDATE app.outbox_jobs job
       SET status = 'processing',
           attempt_count = job.attempt_count + 1,
           locked_at = $2,
           locked_by = $1,
           updated_at = $2
       FROM candidates
       WHERE job.id = candidates.id
       RETURNING ${JOB_COLUMNS}`,
      [workerId, claimedAt, boundedLimit, normalizedJobTypes, normalizedAggregateIds]
    );
    return many(result, mapOutboxJob);
  }

  async recoverStale({
    stale_before: staleBefore,
    recovered_at: recoveredAt,
    limit,
    job_types: jobTypes,
    aggregate_ids: aggregateIds
  } = {}) {
    const boundedLimit = normalizeLimit(limit, { defaultValue: 10, maximum: 50 });
    const normalizedJobTypes = normalizeScope(jobTypes, 'OUTBOX_JOB_TYPE_SCOPE_INVALID');
    const normalizedAggregateIds = normalizeScope(
      aggregateIds,
      'OUTBOX_AGGREGATE_SCOPE_INVALID'
    );
    const result = await executeQuery(
      this.transactionContext,
      `WITH stale AS (
         SELECT id
         FROM app.outbox_jobs
         WHERE status = 'processing' AND locked_at <= $1
           AND ($4::text[] IS NULL OR job_type = ANY($4::text[]))
           AND ($5::text[] IS NULL OR aggregate_id = ANY($5::text[]))
         ORDER BY locked_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $3
       )
       UPDATE app.outbox_jobs job
       SET status = 'pending', available_at = $2, locked_at = NULL, locked_by = NULL,
           last_error = 'OUTBOX_STALE_LOCK_RECOVERED', updated_at = $2
       FROM stale
       WHERE job.id = stale.id
       RETURNING ${JOB_COLUMNS}`,
      [
        staleBefore,
        recoveredAt,
        boundedLimit,
        normalizedJobTypes,
        normalizedAggregateIds
      ]
    );
    return many(result, mapOutboxJob);
  }

  async inspectStatus({
    inspected_at: inspectedAt,
    stale_before: staleBefore,
    job_types: jobTypes,
    aggregate_ids: aggregateIds
  } = {}) {
    const normalizedJobTypes = normalizeScope(jobTypes, 'OUTBOX_JOB_TYPE_SCOPE_INVALID');
    const normalizedAggregateIds = normalizeScope(
      aggregateIds,
      'OUTBOX_AGGREGATE_SCOPE_INVALID'
    );
    const result = await executeQuery(
      this.transactionContext,
      `SELECT
         count(*) FILTER (WHERE status = 'pending')::integer AS pending_count,
         count(*) FILTER (
           WHERE status = 'pending' AND available_at <= $1
         )::integer AS ready_count,
         count(*) FILTER (WHERE status = 'processing')::integer AS processing_count,
         count(*) FILTER (
           WHERE status = 'processing' AND locked_at <= $2
         )::integer AS stale_processing_count,
         count(*) FILTER (WHERE status = 'failed')::integer AS failed_count,
         count(*) FILTER (WHERE status = 'succeeded')::integer AS succeeded_count,
         coalesce(max(attempt_count), 0)::integer AS maximum_attempt_count
       FROM app.outbox_jobs
       WHERE ($3::text[] IS NULL OR job_type = ANY($3::text[]))
         AND ($4::text[] IS NULL OR aggregate_id = ANY($4::text[]))`,
      [inspectedAt, staleBefore, normalizedJobTypes, normalizedAggregateIds]
    );
    const row = result.rows && result.rows[0] || {};
    return Object.freeze({
      pending: Number(row.pending_count || 0),
      ready: Number(row.ready_count || 0),
      processing: Number(row.processing_count || 0),
      stale_processing: Number(row.stale_processing_count || 0),
      failed: Number(row.failed_count || 0),
      succeeded: Number(row.succeeded_count || 0),
      maximum_attempt_count: Number(row.maximum_attempt_count || 0)
    });
  }

  async markSucceeded({ id, worker_id: workerId, updated_at: updatedAt } = {}) {
    const result = await executeQuery(
      this.transactionContext,
      `UPDATE app.outbox_jobs
       SET status = 'succeeded', locked_at = NULL, locked_by = NULL,
           last_error = '', updated_at = $3
       WHERE id = $1 AND status = 'processing' AND locked_by = $2
       RETURNING ${COLUMNS}`,
      [id, workerId, updatedAt]
    );
    return oneOrNull(result, mapOutboxJob, 'REPOSITORY_UPDATE_RESULT_INVALID');
  }

  async releaseForRetry({
    id,
    worker_id: workerId,
    available_at: availableAt,
    last_error: lastError,
    updated_at: updatedAt
  } = {}) {
    const result = await executeQuery(
      this.transactionContext,
      `UPDATE app.outbox_jobs
       SET status = 'pending', available_at = $3, locked_at = NULL, locked_by = NULL,
           last_error = $4, updated_at = $5
       WHERE id = $1 AND status = 'processing' AND locked_by = $2
       RETURNING ${COLUMNS}`,
      [id, workerId, availableAt, lastError, updatedAt]
    );
    return oneOrNull(result, mapOutboxJob, 'REPOSITORY_UPDATE_RESULT_INVALID');
  }

  async markFailed({ id, worker_id: workerId, last_error: lastError, updated_at: updatedAt } = {}) {
    const result = await executeQuery(
      this.transactionContext,
      `UPDATE app.outbox_jobs
       SET status = 'failed', locked_at = NULL, locked_by = NULL,
           last_error = $3, updated_at = $4
       WHERE id = $1 AND status = 'processing' AND locked_by = $2
       RETURNING ${COLUMNS}`,
      [id, workerId, lastError, updatedAt]
    );
    return oneOrNull(result, mapOutboxJob, 'REPOSITORY_UPDATE_RESULT_INVALID');
  }

  #pendingValues(job) {
    return {
      ...job,
      payload: JSON.stringify(job.payload || {}),
      status: 'pending',
      attempt_count: 0,
      locked_at: null,
      locked_by: null,
      last_error: ''
    };
  }
}

module.exports = { OutboxRepository };
