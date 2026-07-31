'use strict';

const {
  PROOF_ATTEMPT_FIELDS,
  PROOF_FIELDS,
  mapProof,
  mapProofAttempt
} = require('./mappers');
const { assertTransactionContext, executeQuery, oneOrNull } = require('./query');

const PROOF_COLUMNS = PROOF_FIELDS.join(', ');
const ATTEMPT_COLUMNS = PROOF_ATTEMPT_FIELDS.join(', ');

class ProofRepository {
  constructor(transactionContext) {
    this.transactionContext = assertTransactionContext(transactionContext);
  }

  async findByRecordId(recordQrId) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT ${PROOF_COLUMNS} FROM app.record_proofs WHERE record_qr_id = $1`,
      [recordQrId]
    );
    return oneOrNull(result, mapProof);
  }

  async findByOperationId(provider, operationId) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT ${PROOF_COLUMNS} FROM app.record_proofs
       WHERE provider = $1 AND operation_id = $2`,
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

  async insertPending(proof) {
    const placeholders = PROOF_FIELDS.map((_, index) => `$${index + 1}`).join(', ');
    const result = await executeQuery(
      this.transactionContext,
      `INSERT INTO app.record_proofs (${PROOF_COLUMNS})
       VALUES (${placeholders}) RETURNING ${PROOF_COLUMNS}`,
      PROOF_FIELDS.map((field) => proof[field])
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
}

module.exports = { ProofRepository };
