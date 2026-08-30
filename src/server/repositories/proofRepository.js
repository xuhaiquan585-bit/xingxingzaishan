'use strict';

const {
  PROOF_ATTEMPT_FIELDS,
  PROOF_FIELDS,
  mapProof,
  mapProofAttempt
} = require('./mappers');
const {
  assertTransactionContext,
  executeQuery,
  many,
  normalizeLimit,
  oneOrNull
} = require('./query');

const PROOF_COLUMNS = PROOF_FIELDS.join(', ');
const ATTEMPT_COLUMNS = PROOF_ATTEMPT_FIELDS.join(', ');
const QUERY_IN_PROGRESS_CODE = 'RECORD_PROOF_QUERY_IN_PROGRESS';
const MANUAL_QUERY_LIMIT_CODE = 'RECORD_PROOF_MANUAL_RECONCILIATION_QUERY_LIMIT';
const MANUAL_AGE_LIMIT_CODE = 'RECORD_PROOF_MANUAL_RECONCILIATION_AGE_LIMIT';

function proofColumns(alias) {
  return PROOF_FIELDS.map((field) => `${alias}.${field}`).join(', ');
}

function queryScope(recordQrIds) {
  const scope = recordQrIds === null || recordQrIds === undefined
    ? null
    : [...new Set(recordQrIds.map((value) => String(value || '').trim()))];
  if (scope && (
    !scope.length
    || scope.length > 1000
    || scope.some((value) => !value || value.length > 160 || /[\r\n\0]/.test(value))
  )) {
    const error = new Error('PROOF_QUERY_SCOPE_INVALID');
    error.code = 'PROOF_QUERY_SCOPE_INVALID';
    throw error;
  }
  return scope;
}

function positiveAttemptLimit(value) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > 100) {
    const error = new Error('PROOF_QUERY_ATTEMPT_LIMIT_INVALID');
    error.code = 'PROOF_QUERY_ATTEMPT_LIMIT_INVALID';
    throw error;
  }
  return normalized;
}

class ProofRepository {
  constructor(transactionContext) {
    this.transactionContext = assertTransactionContext(transactionContext);
  }

  async findByRecordId(recordQrId) {
    return this.#findByRecordId(recordQrId, false);
  }

  async findByRecordIdForUpdate(recordQrId) {
    return this.#findByRecordId(recordQrId, true);
  }

  async findByOperationId(provider, operationId) {
    return this.#findByOperationId(provider, operationId, false);
  }

  async findByOperationIdForUpdate(provider, operationId) {
    return this.#findByOperationId(provider, operationId, true);
  }

  async #findByOperationId(provider, operationId, forUpdate) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT ${PROOF_COLUMNS} FROM app.record_proofs
       WHERE provider = $1 AND operation_id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
      [provider, operationId]
    );
    return oneOrNull(result, mapProof);
  }

  async findForUpdate(proofId) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT ${PROOF_COLUMNS} FROM app.record_proofs WHERE id = $1 FOR UPDATE`,
      [proofId]
    );
    return oneOrNull(result, mapProof);
  }

  async findPendingAttemptForUpdate(proofId) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT ${ATTEMPT_COLUMNS} FROM app.proof_attempts
       WHERE proof_id = $1 AND result_status = 'pending'
       ORDER BY attempt_number DESC
       LIMIT 1 FOR UPDATE`,
      [proofId]
    );
    return oneOrNull(result, mapProofAttempt);
  }

  async findLatestAttemptForUpdate(proofId) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT ${ATTEMPT_COLUMNS} FROM app.proof_attempts
       WHERE proof_id = $1
       ORDER BY attempt_number DESC
       LIMIT 1 FOR UPDATE`,
      [proofId]
    );
    return oneOrNull(result, mapProofAttempt);
  }

  async findById(proofId) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT ${PROOF_COLUMNS} FROM app.record_proofs WHERE id = $1`,
      [proofId]
    );
    return oneOrNull(result, mapProof);
  }

  async claimSubmittedForQuery({
    provider,
    submitted_before: submittedBefore,
    stale_claim_before: staleClaimBefore,
    age_limit_before: ageLimitBefore,
    claimed_at: claimedAt,
    max_attempts: maxAttempts,
    record_qr_ids: recordQrIds,
    limit
  } = {}) {
    const boundedLimit = normalizeLimit(limit, { defaultValue: 5, maximum: 50 });
    const scope = queryScope(recordQrIds);
    const boundedAttempts = positiveAttemptLimit(maxAttempts);
    const result = await executeQuery(
      this.transactionContext,
      `WITH candidates AS (
         SELECT p.id, p.created_at, p.retry_count,
                COALESCE(first_attempt.requested_at, p.created_at) AS age_origin
         FROM app.record_proofs p
         LEFT JOIN LATERAL (
           SELECT MIN(attempt.requested_at) AS requested_at
           FROM app.proof_attempts attempt
           WHERE attempt.proof_id = p.id
         ) first_attempt ON TRUE
         WHERE p.provider = $1
           AND p.operation_id IS NOT NULL
           AND (
             (p.status = 'submitted' AND p.updated_at <= $2)
             OR (
               p.status = 'retrying'
               AND p.last_error = '${QUERY_IN_PROGRESS_CODE}'
               AND p.updated_at <= $3
             )
           )
           AND ($4::text[] IS NULL OR p.record_qr_id = ANY($4::text[]))
         ORDER BY p.updated_at ASC, p.id ASC
         LIMIT $5
         FOR UPDATE OF p SKIP LOCKED
       ), classified AS (
         SELECT candidates.*,
                CASE
                  WHEN age_origin IS NULL
                    OR age_origin < created_at
                    OR age_origin > $6
                    OR age_origin <= $7
                    THEN '${MANUAL_AGE_LIMIT_CODE}'
                  WHEN retry_count >= $8
                    THEN '${MANUAL_QUERY_LIMIT_CODE}'
                  ELSE NULL
                END AS cutoff_reason
         FROM candidates
       )
       UPDATE app.record_proofs p
       SET status = 'retrying',
           retry_count = CASE
             WHEN classified.cutoff_reason IS NULL THEN p.retry_count + 1
             ELSE p.retry_count
           END,
           last_error = COALESCE(
             classified.cutoff_reason,
             '${QUERY_IN_PROGRESS_CODE}'
           ),
           updated_at = $6
       FROM classified
       WHERE p.id = classified.id
       RETURNING ${proofColumns('p')},
                 classified.age_origin,
                 (classified.cutoff_reason IS NULL) AS query_claimed`,
      [
        provider,
        submittedBefore,
        staleClaimBefore,
        scope,
        boundedLimit,
        claimedAt,
        ageLimitBefore,
        boundedAttempts
      ]
    );
    return many(result, (row) => Object.freeze({
      proof: mapProof(row),
      age_origin: row.age_origin,
      query_claimed: row.query_claimed === true
    }));
  }

  async completeSubmittedQuery({
    id,
    last_error: lastError,
    completed_at: completedAt,
    age_limit_before: ageLimitBefore,
    max_attempts: maxAttempts
  }) {
    const boundedAttempts = positiveAttemptLimit(maxAttempts);
    const result = await executeQuery(
      this.transactionContext,
      `WITH current_state AS (
         SELECT p.id, p.created_at, p.retry_count,
                COALESCE(first_attempt.requested_at, p.created_at) AS age_origin
         FROM app.record_proofs p
         LEFT JOIN LATERAL (
           SELECT MIN(attempt.requested_at) AS requested_at
           FROM app.proof_attempts attempt
           WHERE attempt.proof_id = p.id
         ) first_attempt ON TRUE
         WHERE p.id = $1
           AND (
             p.status = 'submitted'
             OR (
               p.status = 'retrying'
               AND p.last_error = '${QUERY_IN_PROGRESS_CODE}'
             )
           )
         FOR UPDATE OF p
       ), classified AS (
         SELECT current_state.*,
                CASE
                  WHEN age_origin IS NULL
                    OR age_origin < created_at
                    OR age_origin > $3
                    OR age_origin <= $4
                    THEN '${MANUAL_AGE_LIMIT_CODE}'
                  WHEN retry_count >= $5
                    THEN '${MANUAL_QUERY_LIMIT_CODE}'
                  ELSE NULL
                END AS cutoff_reason
         FROM current_state
       )
       UPDATE app.record_proofs p
       SET status = CASE
             WHEN classified.cutoff_reason IS NULL THEN 'submitted'
             ELSE 'retrying'
           END,
           last_error = COALESCE(classified.cutoff_reason, $2),
           updated_at = $3
       FROM classified
       WHERE p.id = classified.id
       RETURNING ${proofColumns('p')}`,
      [id, lastError, completedAt, ageLimitBefore, boundedAttempts]
    );
    return oneOrNull(result, mapProof, 'REPOSITORY_UPDATE_RESULT_INVALID');
  }

  async listConfirmedForCertificateArchive({
    provider,
    record_qr_ids: recordQrIds,
    limit
  } = {}) {
    const boundedLimit = normalizeLimit(limit, { defaultValue: 5, maximum: 50 });
    const scope = recordQrIds === null || recordQrIds === undefined
      ? null
      : [...new Set(recordQrIds.map((value) => String(value || '').trim()))];
    if (scope && (
      !scope.length
      || scope.length > 1000
      || scope.some((value) => !value || value.length > 160 || /[\r\n\0]/.test(value))
    )) {
      const error = new Error('PROOF_QUERY_SCOPE_INVALID');
      error.code = 'PROOF_QUERY_SCOPE_INVALID';
      throw error;
    }
    const result = await executeQuery(
      this.transactionContext,
      `SELECT ${PROOF_COLUMNS} FROM app.record_proofs
       WHERE provider = $1 AND status = 'confirmed'
         AND provider_certificate_url IS NOT NULL
         AND certificate_object_key IS NULL
         AND ($2::text[] IS NULL OR record_qr_id = ANY($2::text[]))
       ORDER BY updated_at ASC, id ASC
       LIMIT $3`,
      [provider, scope, boundedLimit]
    );
    return many(result, mapProof);
  }

  async insertPending(proof) {
    const placeholders = PROOF_FIELDS.map((_, index) => `$${index + 1}`).join(', ');
    const result = await executeQuery(
      this.transactionContext,
      `INSERT INTO app.record_proofs (${PROOF_COLUMNS})
       VALUES (${placeholders}) RETURNING ${PROOF_COLUMNS}`,
      PROOF_FIELDS.map((field) => (field === 'legacy_hash_snapshot' ? null : proof[field]))
    );
    return oneOrNull(result, mapProof, 'REPOSITORY_INSERT_RESULT_INVALID');
  }

  async appendAttempt(attempt) {
    const insertFields = PROOF_ATTEMPT_FIELDS.filter((field) => field !== 'id');
    const columns = insertFields.join(', ');
    const placeholders = insertFields.map((_, index) => `$${index + 1}`).join(', ');
    const result = await executeQuery(
      this.transactionContext,
      `INSERT INTO app.proof_attempts (${columns}) VALUES (${placeholders}) RETURNING ${ATTEMPT_COLUMNS}`,
      insertFields.map((field) => attempt[field])
    );
    return oneOrNull(result, mapProofAttempt, 'REPOSITORY_INSERT_RESULT_INVALID');
  }

  async markManifestReady({
    id,
    operation_id: operationId,
    manifest_object_key: manifestObjectKey,
    manifest_hash: manifestHash,
    updated_at: updatedAt
  }) {
    return this.#updateProof(
      `UPDATE app.record_proofs
       SET status = 'manifest_ready', operation_id = $2,
           manifest_object_key = $3, manifest_hash = $4,
           legacy_hash_snapshot = NULL, last_error = '', updated_at = $5
       WHERE id = $1
         AND status IN ('not_started', 'manifest_ready', 'failed', 'retrying')
       RETURNING ${PROOF_COLUMNS}`,
      [id, operationId, manifestObjectKey, manifestHash, updatedAt]
    );
  }

  async markSubmitting({ id, retry_count: retryCount, updated_at: updatedAt }) {
    return this.#updateProof(
      `UPDATE app.record_proofs
       SET status = 'submitting', retry_count = $2, last_error = '', updated_at = $3
       WHERE id = $1
         AND status IN ('manifest_ready', 'failed', 'retrying', 'submitting')
         AND operation_id IS NOT NULL
         AND manifest_hash IS NOT NULL
       RETURNING ${PROOF_COLUMNS}`,
      [id, retryCount, updatedAt]
    );
  }

  async markSubmitted(input) {
    return this.#markSubmissionResult({ ...input, status: 'submitted' });
  }

  async markConfirmed(input) {
    return this.#markSubmissionResult({ ...input, status: 'confirmed' });
  }

  async markFailed({ id, last_error: lastError, updated_at: updatedAt }) {
    return this.#updateProof(
      `UPDATE app.record_proofs
       SET status = 'failed', last_error = $2, updated_at = $3
       WHERE id = $1
         AND status IN ('not_started', 'manifest_ready', 'submitting', 'failed', 'retrying')
       RETURNING ${PROOF_COLUMNS}`,
      [id, lastError, updatedAt]
    );
  }

  async applyProviderEvent({
    id,
    status,
    transaction_hash: transactionHash,
    block_height: blockHeight,
    provider_record_id: providerRecordId,
    provider_certificate_url: providerCertificateUrl,
    confirmed_at: confirmedAt,
    callback_received_at: callbackReceivedAt,
    last_error: lastError,
    updated_at: updatedAt
  }) {
    return this.#updateProof(
      `UPDATE app.record_proofs
       SET status = $2,
           transaction_hash = COALESCE($3, transaction_hash),
           block_height = COALESCE($4, block_height),
           provider_record_id = COALESCE($5, provider_record_id),
           provider_certificate_url = COALESCE(provider_certificate_url, $6),
           confirmed_at = COALESCE($7, confirmed_at),
           callback_received_at = COALESCE(callback_received_at, $8),
           last_error = $9, updated_at = $10
       WHERE id = $1
         AND (
           ($2 = 'submitted' AND status IN ('submitting', 'submitted', 'retrying'))
           OR ($2 = 'confirmed' AND status IN (
             'submitting', 'submitted', 'confirmed', 'failed', 'retrying'
           ))
           OR ($2 = 'failed' AND status IN (
             'submitting', 'submitted', 'failed', 'retrying'
           ))
         )
       RETURNING ${PROOF_COLUMNS}`,
      [
        id,
        status,
        transactionHash,
        blockHeight,
        providerRecordId,
        providerCertificateUrl,
        confirmedAt,
        callbackReceivedAt,
        lastError,
        updatedAt
      ]
    );
  }

  async markCertificateArchived({
    id,
    certificate_object_key: certificateObjectKey,
    certificate_object_url_snapshot: certificateObjectUrlSnapshot,
    updated_at: updatedAt
  }) {
    return this.#updateProof(
      `UPDATE app.record_proofs
       SET certificate_object_key = $2,
           certificate_object_url_snapshot = $3,
           updated_at = $4
       WHERE id = $1 AND status = 'confirmed'
         AND provider_certificate_url IS NOT NULL
         AND certificate_object_key IS NULL
       RETURNING ${PROOF_COLUMNS}`,
      [id, certificateObjectKey, certificateObjectUrlSnapshot || null, updatedAt]
    );
  }

  async markQueryDeferred({ id, last_error: lastError, updated_at: updatedAt }) {
    return this.#updateProof(
      `UPDATE app.record_proofs
       SET last_error = $2, updated_at = $3
       WHERE id = $1 AND status IN ('submitted', 'confirmed')
       RETURNING ${PROOF_COLUMNS}`,
      [id, lastError, updatedAt]
    );
  }

  async markRecoveryDeferred({ id, last_error: lastError, updated_at: updatedAt }) {
    return this.#updateProof(
      `UPDATE app.record_proofs
       SET status = 'retrying', last_error = $2, updated_at = $3
       WHERE id = $1
         AND status IN ('submitting', 'retrying', 'failed')
         AND operation_id IS NOT NULL
         AND manifest_hash IS NOT NULL
       RETURNING ${PROOF_COLUMNS}`,
      [id, lastError, updatedAt]
    );
  }

  async failPendingAttempts({ proof_id: proofId, sanitized_error: error, completed_at: completedAt }) {
    const result = await executeQuery(
      this.transactionContext,
      `UPDATE app.proof_attempts
       SET result_status = 'failed', sanitized_error = $2, completed_at = $3
       WHERE proof_id = $1 AND result_status = 'pending'`,
      [proofId, error, completedAt]
    );
    return Number(result.rowCount || 0);
  }

  async completeAttempt({
    proof_id: proofId,
    attempt_number: attemptNumber,
    result_status: resultStatus,
    sanitized_error: error,
    completed_at: completedAt
  }) {
    const result = await executeQuery(
      this.transactionContext,
      `UPDATE app.proof_attempts
       SET request_state = 'sent', result_status = $3,
           sanitized_error = $4, completed_at = $5
       WHERE proof_id = $1 AND attempt_number = $2
         AND result_status = 'pending'
       RETURNING ${ATTEMPT_COLUMNS}`,
      [proofId, attemptNumber, resultStatus, error, completedAt]
    );
    return oneOrNull(result, mapProofAttempt, 'REPOSITORY_UPDATE_RESULT_INVALID');
  }

  async #findByRecordId(recordQrId, forUpdate) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT ${PROOF_COLUMNS} FROM app.record_proofs
       WHERE record_qr_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [recordQrId]
    );
    return oneOrNull(result, mapProof);
  }

  async #markSubmissionResult({
    id,
    status,
    transaction_hash: transactionHash,
    block_height: blockHeight,
    provider_record_id: providerRecordId,
    provider_certificate_url: providerCertificateUrl,
    confirmed_at: confirmedAt,
    updated_at: updatedAt
  }) {
    return this.#updateProof(
      `UPDATE app.record_proofs
       SET status = $2, transaction_hash = COALESCE($3, transaction_hash),
           block_height = COALESCE($4, block_height),
           provider_record_id = COALESCE($5, provider_record_id),
           provider_certificate_url = COALESCE($6, provider_certificate_url),
           confirmed_at = COALESCE($7, confirmed_at), last_error = '', updated_at = $8
       WHERE id = $1 AND status IN ('submitting', 'submitted')
       RETURNING ${PROOF_COLUMNS}`,
      [
        id,
        status,
        transactionHash || null,
        blockHeight,
        providerRecordId || null,
        providerCertificateUrl || null,
        confirmedAt,
        updatedAt
      ]
    );
  }

  async #updateProof(sql, params) {
    const result = await executeQuery(this.transactionContext, sql, params);
    return oneOrNull(result, mapProof, 'REPOSITORY_UPDATE_RESULT_INVALID');
  }
}

module.exports = { ProofRepository };
