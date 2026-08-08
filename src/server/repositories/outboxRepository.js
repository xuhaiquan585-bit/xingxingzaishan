'use strict';

const { OUTBOX_FIELDS, mapOutboxJob } = require('./mappers');
const { assertTransactionContext, executeQuery, oneOrNull } = require('./query');

const COLUMNS = OUTBOX_FIELDS.join(', ');

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
}

module.exports = { OutboxRepository };
