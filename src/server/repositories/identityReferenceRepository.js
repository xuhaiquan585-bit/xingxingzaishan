'use strict';

const { assertTransactionContext, executeQuery } = require('./query');

class IdentityReferenceRepository {
  constructor(transactionContext) {
    this.transactionContext = assertTransactionContext(transactionContext);
  }

  async hasBusinessReferences({ accountId, openid } = {}) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT
         EXISTS (SELECT 1 FROM app.records WHERE account_id = $1)
         OR EXISTS (SELECT 1 FROM app.co_creations WHERE owner_account_id = $1)
         OR EXISTS (SELECT 1 FROM app.co_creation_comments WHERE account_id = $1)
         OR EXISTS (SELECT 1 FROM app.orders WHERE account_id = $1)
         OR EXISTS (SELECT 1 FROM app.orders WHERE openid_snapshot = $2)
         OR EXISTS (
           SELECT 1
           FROM app.payment_events
           WHERE
             jsonb_path_exists(
               sanitized_metadata,
               '$.** ? (@ == $identity)',
               jsonb_build_object('identity', to_jsonb($1::text))
             )
             OR jsonb_path_exists(
               sanitized_metadata,
               '$.** ? (@ == $identity)',
               jsonb_build_object('identity', to_jsonb($2::text))
             )
         ) AS has_references`,
      [accountId, openid]
    );
    return Boolean(result.rows[0] && result.rows[0].has_references);
  }
}

module.exports = { IdentityReferenceRepository };
