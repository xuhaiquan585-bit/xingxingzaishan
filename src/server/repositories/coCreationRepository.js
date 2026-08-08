'use strict';

const {
  COMMENT_FIELDS,
  CO_CREATION_FIELDS,
  mapCoCreation,
  mapComment
} = require('./mappers');
const { assertTransactionContext, executeQuery, many, oneOrNull } = require('./query');

const CREATION_COLUMNS = CO_CREATION_FIELDS.join(', ');
const COMMENT_COLUMNS = COMMENT_FIELDS.join(', ');

class CoCreationRepository {
  constructor(transactionContext) {
    this.transactionContext = assertTransactionContext(transactionContext);
  }

  async findByQrId(qrId) {
    return this.#findByQrId(qrId, false);
  }

  async findByQrIdForUpdate(qrId) {
    return this.#findByQrId(qrId, true);
  }

  async listEffectiveComments(coCreationId) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT ${COMMENT_COLUMNS} FROM app.co_creation_comments
       WHERE co_creation_id = $1 AND status = 'kept'
       ORDER BY source_position ASC`,
      [coCreationId]
    );
    return many(result, mapComment);
  }

  async listPublicCommentsCandidate(coCreationId, { limit = 13 } = {}) {
    const safeLimit = Number(limit);
    if (!Number.isSafeInteger(safeLimit) || safeLimit < 1 || safeLimit > 13) {
      const error = new Error('PUBLIC_QR_COMMENT_LIMIT_INVALID');
      error.code = 'PUBLIC_QR_COMMENT_LIMIT_INVALID';
      throw error;
    }
    const result = await executeQuery(
      this.transactionContext,
      `SELECT ${COMMENT_COLUMNS} FROM app.co_creation_comments
       WHERE co_creation_id = $1 AND status = 'kept'
       ORDER BY created_at DESC, source_position ASC
       LIMIT $2`,
      [coCreationId, safeLimit]
    );
    return many(result, mapComment);
  }

  async hasEffectiveComment(coCreationId, accountId) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT EXISTS (
         SELECT 1 FROM app.co_creation_comments
         WHERE co_creation_id = $1 AND account_id = $2 AND status = 'kept'
       ) AS exists`,
      [coCreationId, accountId]
    );
    return Boolean(result.rows[0] && result.rows[0].exists);
  }

  async insert(coCreation) {
    const placeholders = CO_CREATION_FIELDS.map((_, index) => `$${index + 1}`).join(', ');
    const result = await executeQuery(
      this.transactionContext,
      `INSERT INTO app.co_creations (${CREATION_COLUMNS})
       VALUES (${placeholders}) RETURNING ${CREATION_COLUMNS}`,
      CO_CREATION_FIELDS.map((field) => coCreation[field])
    );
    return oneOrNull(result, mapCoCreation, 'REPOSITORY_INSERT_RESULT_INVALID');
  }

  async insertComment(comment) {
    const placeholders = COMMENT_FIELDS.map((_, index) => `$${index + 1}`).join(', ');
    const result = await executeQuery(
      this.transactionContext,
      `INSERT INTO app.co_creation_comments (${COMMENT_COLUMNS})
       VALUES (${placeholders}) RETURNING ${COMMENT_COLUMNS}`,
      COMMENT_FIELDS.map((field) => (field === 'legacy_duplicate' ? false : comment[field]))
    );
    return oneOrNull(result, mapComment, 'REPOSITORY_INSERT_RESULT_INVALID');
  }

  async nextCommentSourcePosition(coCreationId) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT COALESCE(MAX(source_position), -1) + 1 AS source_position
       FROM app.co_creation_comments
       WHERE co_creation_id = $1`,
      [coCreationId]
    );
    const value = Number(result.rows[0] && result.rows[0].source_position);
    if (!Number.isSafeInteger(value) || value < 0) {
      const error = new Error('CO_CREATION_COMMENT_POSITION_INVALID');
      error.code = 'CO_CREATION_COMMENT_POSITION_INVALID';
      throw error;
    }
    return value;
  }

  async findEffectiveCommentByPublicIdForUpdate(coCreationId, publicCommentId) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT ${COMMENT_COLUMNS} FROM app.co_creation_comments
       WHERE co_creation_id = $1
         AND status = 'kept'
         AND (
           legacy_comment_id = $2
           OR (legacy_comment_id IS NULL AND id::text = $2)
         )
       FOR UPDATE`,
      [coCreationId, publicCommentId]
    );
    return oneOrNull(result, mapComment);
  }

  async deleteEffectiveComment({ id, deleted_at }) {
    const result = await executeQuery(
      this.transactionContext,
      `UPDATE app.co_creation_comments
       SET status = 'deleted', deleted_at = $2
       WHERE id = $1 AND status = 'kept'
       RETURNING ${COMMENT_COLUMNS}`,
      [id, deleted_at]
    );
    return oneOrNull(result, mapComment);
  }

  async finalize({ id, finalized_at, updated_at }) {
    const result = await executeQuery(
      this.transactionContext,
      `UPDATE app.co_creations
       SET status = 'finalized', finalized_at = $2, updated_at = $3
       WHERE id = $1 AND status = 'active'
       RETURNING ${CREATION_COLUMNS}`,
      [id, finalized_at, updated_at]
    );
    return oneOrNull(result, mapCoCreation);
  }

  async #findByQrId(qrId, forUpdate) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT ${CREATION_COLUMNS} FROM app.co_creations
       WHERE qr_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [qrId]
    );
    return oneOrNull(result, mapCoCreation);
  }
}

module.exports = { CoCreationRepository };
