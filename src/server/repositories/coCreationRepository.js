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
      COMMENT_FIELDS.map((field) => comment[field])
    );
    return oneOrNull(result, mapComment, 'REPOSITORY_INSERT_RESULT_INVALID');
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
