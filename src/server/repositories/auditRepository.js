'use strict';

const { AUDIT_FIELDS, mapAudit } = require('./mappers');
const { assertTransactionContext, executeQuery, oneOrNull } = require('./query');

const COLUMNS = AUDIT_FIELDS.join(', ');

class AuditRepository {
  constructor(transactionContext) {
    this.transactionContext = assertTransactionContext(transactionContext);
  }

  async append(event) {
    const insertFields = AUDIT_FIELDS.filter((field) => field !== 'id');
    const columns = insertFields.join(', ');
    const placeholders = insertFields.map((_, index) => `$${index + 1}`).join(', ');
    const result = await executeQuery(
      this.transactionContext,
      `INSERT INTO app.audit_events (${columns}) VALUES (${placeholders}) RETURNING ${COLUMNS}`,
      insertFields.map((field) => field === 'metadata' ? JSON.stringify(event[field] || {}) : event[field])
    );
    return oneOrNull(result, mapAudit, 'REPOSITORY_INSERT_RESULT_INVALID');
  }
}

module.exports = { AuditRepository };
