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

class OutboxRepository {
  constructor(transactionContext) {
    this.transactionContext = assertTransactionContext(transactionContext);
  }

  async insertPending(job) {
    const values = {
      ...job,
      payload: JSON.stringify(job.payload || {}),
      status: 'pending',
      attempt_count: 0,
      locked_at: null,
      locked_by: null,
      last_error: ''
    };
    const placeholders = OUTBOX_FIELDS.map((_, index) => `$${index + 1}`).join(', ');
    const result = await executeQuery(
      this.transactionContext,
      `INSERT INTO app.outbox_jobs (${COLUMNS})
       VALUES (${placeholders}) RETURNING ${COLUMNS}`,
      OUTBOX_FIELDS.map((field) => values[field])
    );
    return oneOrNull(result, mapOutboxJob, 'REPOSITORY_INSERT_RESULT_INVALID');
  }

  async claimPending({ worker_id: workerId, claimed_at: claimedAt, limit } = {}) {
    const boundedLimit = normalizeLimit(limit, { defaultValue: 10, maximum: 50 });
    const result = await executeQuery(
      this.transactionContext,
      `WITH candidates AS (
         SELECT id
         FROM app.outbox_jobs
         WHERE status = 'pending' AND available_at <= $2
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
      [workerId, claimedAt, boundedLimit]
    );
    return many(result, mapOutboxJob);
  }

  async recoverStale({ stale_before: staleBefore, recovered_at: recoveredAt, limit } = {}) {
    const boundedLimit = normalizeLimit(limit, { defaultValue: 10, maximum: 50 });
    const result = await executeQuery(
      this.transactionContext,
      `WITH stale AS (
         SELECT id
         FROM app.outbox_jobs
         WHERE status = 'processing' AND locked_at <= $1
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
      [staleBefore, recoveredAt, boundedLimit]
    );
    return many(result, mapOutboxJob);
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
}

module.exports = { OutboxRepository };
