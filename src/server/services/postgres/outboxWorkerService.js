'use strict';

const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;

class OutboxWorkerError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'OutboxWorkerError';
    this.code = code;
  }
}

function operationTimestamp(clock) {
  const candidate = clock();
  const value = candidate instanceof Date ? candidate : new Date(candidate);
  if (Number.isNaN(value.getTime())) {
    throw new OutboxWorkerError('OUTBOX_WORKER_CLOCK_INVALID');
  }
  return value;
}

function safeErrorCode(error) {
  const code = String(error && error.code || 'OUTBOX_HANDLER_FAILED').trim();
  return /^[A-Z][A-Z0-9_:-]{0,119}$/.test(code)
    ? code
    : 'OUTBOX_HANDLER_FAILED';
}

function positiveInteger(value, fallback, maximum, code) {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > maximum) {
    throw new OutboxWorkerError(code);
  }
  return candidate;
}

function optionalScope(values, code) {
  if (values === undefined || values === null) return null;
  if (!Array.isArray(values) || values.length === 0 || values.length > 1000) {
    throw new OutboxWorkerError(code);
  }
  const normalized = [...new Set(values.map((value) => String(value || '').trim()))];
  if (normalized.some((value) => !value || value.length > 160 || /[\r\n\0]/.test(value))) {
    throw new OutboxWorkerError(code);
  }
  return Object.freeze(normalized);
}

function optionalErrorCodes(values) {
  if (values === undefined || values === null) return new Set();
  if (!Array.isArray(values) || values.length === 0 || values.length > 100) {
    throw new OutboxWorkerError('OUTBOX_WORKER_RETRYABLE_ERROR_CODES_INVALID');
  }
  const normalized = new Set(values.map((value) => String(value || '').trim()));
  if ([...normalized].some((value) => !/^[A-Z][A-Z0-9_:-]{0,119}$/.test(value))) {
    throw new OutboxWorkerError('OUTBOX_WORKER_RETRYABLE_ERROR_CODES_INVALID');
  }
  return normalized;
}

function createOutboxWorker({
  pool,
  transactionRunner,
  repositoryTypes,
  handlers = {},
  workerId,
  clock = () => new Date(),
  batchSize = 10,
  maxAttempts = 5,
  retryBaseMs = 1000,
  lockTimeoutMs = 5 * 60 * 1000,
  retryableErrorCodes,
  jobTypes,
  aggregateIds
} = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new OutboxWorkerError('OUTBOX_WORKER_POOL_REQUIRED');
  }
  const normalizedWorkerId = String(workerId || '').trim();
  if (!normalizedWorkerId || normalizedWorkerId.length > 160) {
    throw new OutboxWorkerError('OUTBOX_WORKER_ID_REQUIRED');
  }
  const normalizedBatchSize = positiveInteger(
    batchSize,
    10,
    50,
    'OUTBOX_WORKER_BATCH_SIZE_INVALID'
  );
  const normalizedMaxAttempts = positiveInteger(
    maxAttempts,
    5,
    100,
    'OUTBOX_WORKER_MAX_ATTEMPTS_INVALID'
  );
  const normalizedRetryBaseMs = positiveInteger(
    retryBaseMs,
    1000,
    MAX_RETRY_DELAY_MS,
    'OUTBOX_WORKER_RETRY_DELAY_INVALID'
  );
  const normalizedLockTimeoutMs = positiveInteger(
    lockTimeoutMs,
    5 * 60 * 1000,
    24 * 60 * 60 * 1000,
    'OUTBOX_WORKER_LOCK_TIMEOUT_INVALID'
  );
  const normalizedJobTypes = optionalScope(jobTypes, 'OUTBOX_WORKER_JOB_TYPES_INVALID');
  const normalizedAggregateIds = optionalScope(
    aggregateIds,
    'OUTBOX_WORKER_AGGREGATE_IDS_INVALID'
  );
  const normalizedRetryableErrorCodes = optionalErrorCodes(retryableErrorCodes);
  const runTransaction = transactionRunner
    || require('../../database/transaction').withTransaction;
  const repositories = repositoryTypes || require('../../repositories');

  function repository(context) {
    return new repositories.OutboxRepository(context);
  }

  async function transition(method, input) {
    return runTransaction(pool, (context) => repository(context)[method](input), {
      isolationLevel: 'read committed'
    });
  }

  async function runOnce() {
    const claimedAt = operationTimestamp(clock);
    const claimResult = await runTransaction(pool, async (context) => {
      const currentRepository = repository(context);
      const recovered = await currentRepository.recoverStale({
        stale_before: new Date(claimedAt.getTime() - normalizedLockTimeoutMs).toISOString(),
        recovered_at: claimedAt.toISOString(),
        limit: normalizedBatchSize,
        job_types: normalizedJobTypes,
        aggregate_ids: normalizedAggregateIds
      });
      const jobs = await currentRepository.claimPending({
        worker_id: normalizedWorkerId,
        claimed_at: claimedAt.toISOString(),
        limit: normalizedBatchSize,
        job_types: normalizedJobTypes,
        aggregate_ids: normalizedAggregateIds
      });
      return { recovered, jobs };
    }, {
      isolationLevel: 'read committed'
    });
    const { recovered, jobs } = claimResult;
    const summary = {
      recovered: recovered.length,
      claimed: jobs.length,
      succeeded: 0,
      retried: 0,
      failed: 0
    };

    for (const job of jobs) {
      const handler = handlers[job.job_type];
      try {
        if (typeof handler !== 'function') {
          throw new OutboxWorkerError('OUTBOX_HANDLER_NOT_REGISTERED');
        }
        await handler(job);
        const completed = await transition('markSucceeded', {
          id: job.id,
          worker_id: normalizedWorkerId,
          updated_at: operationTimestamp(clock).toISOString()
        });
        if (!completed) throw new OutboxWorkerError('OUTBOX_JOB_OWNERSHIP_LOST');
        summary.succeeded += 1;
      } catch (error) {
        const updatedAt = operationTimestamp(clock);
        const errorCode = safeErrorCode(error);
        const terminal = error && error.code === 'OUTBOX_HANDLER_NOT_REGISTERED'
          || (
            Number(job.attempt_count) >= normalizedMaxAttempts
            && !normalizedRetryableErrorCodes.has(errorCode)
          );
        const input = {
          id: job.id,
          worker_id: normalizedWorkerId,
          last_error: errorCode,
          updated_at: updatedAt.toISOString()
        };
        const transitioned = terminal
          ? await transition('markFailed', input)
          : await transition('releaseForRetry', {
            ...input,
            available_at: new Date(
              updatedAt.getTime() + Math.min(
                MAX_RETRY_DELAY_MS,
                normalizedRetryBaseMs * (2 ** Math.max(0, Number(job.attempt_count) - 1))
              )
            ).toISOString()
          });
        if (!transitioned) throw new OutboxWorkerError('OUTBOX_JOB_OWNERSHIP_LOST');
        if (terminal) summary.failed += 1;
        else summary.retried += 1;
      }
    }

    return Object.freeze(summary);
  }

  async function inspect() {
    const inspectedAt = operationTimestamp(clock);
    return runTransaction(pool, (context) => repository(context).inspectStatus({
      inspected_at: inspectedAt.toISOString(),
      stale_before: new Date(
        inspectedAt.getTime() - normalizedLockTimeoutMs
      ).toISOString(),
      job_types: normalizedJobTypes,
      aggregate_ids: normalizedAggregateIds
    }), {
      isolationLevel: 'repeatable read',
      readOnly: true
    });
  }

  return Object.freeze({ inspect, runOnce });
}

module.exports = {
  MAX_RETRY_DELAY_MS,
  OutboxWorkerError,
  createOutboxWorker,
  safeErrorCode
};
