'use strict';

const {
  IDENTITY_TABLES,
  IMPORT_ORDER,
  TABLE_SPECS,
  assertImportPlan
} = require('./writer');

const INTEGRITY_CHECKS = Object.freeze([
  {
    name: 'users_account',
    sql: `SELECT COUNT(*)::text AS violation_count
      FROM app.users u
      LEFT JOIN app.accounts a ON a.id = u.account_id
      WHERE a.id IS NULL`
  },
  {
    name: 'records_relations',
    sql: `SELECT COUNT(*)::text AS violation_count
      FROM app.records r
      LEFT JOIN app.qr_codes q ON q.id = r.qr_id
      LEFT JOIN app.accounts a ON a.id = r.account_id
      WHERE q.id IS NULL OR a.id IS NULL`
  },
  {
    name: 'co_creation_relations',
    sql: `SELECT COUNT(*)::text AS violation_count
      FROM app.co_creations c
      LEFT JOIN app.qr_codes q ON q.id = c.qr_id
      LEFT JOIN app.accounts a ON a.id = c.owner_account_id
      WHERE q.id IS NULL OR a.id IS NULL`
  },
  {
    name: 'co_creation_comment_relations',
    sql: `SELECT COUNT(*)::text AS violation_count
      FROM app.co_creation_comments c
      LEFT JOIN app.co_creations parent ON parent.id = c.co_creation_id
      LEFT JOIN app.accounts a ON a.id = c.account_id
      WHERE parent.id IS NULL OR a.id IS NULL`
  },
  {
    name: 'co_creation_comment_positions',
    sql: `SELECT COUNT(*)::text AS violation_count
      FROM (
        SELECT co_creation_id
        FROM app.co_creation_comments
        GROUP BY co_creation_id
        HAVING MIN(source_position) <> 0
           OR MAX(source_position) <> COUNT(*) - 1
           OR COUNT(DISTINCT source_position) <> COUNT(*)
      ) invalid_positions`
  },
  {
    name: 'order_relations',
    sql: `SELECT COUNT(*)::text AS violation_count
      FROM app.orders o
      LEFT JOIN app.accounts a ON a.id = o.account_id
      LEFT JOIN app.products p ON p.id = o.product_id
      WHERE a.id IS NULL OR (o.product_id IS NOT NULL AND p.id IS NULL)`
  },
  {
    name: 'payment_relations',
    sql: `SELECT COUNT(*)::text AS violation_count
      FROM app.payment_transactions p
      LEFT JOIN app.orders o ON o.id = p.order_id
      WHERE o.id IS NULL`
  },
  {
    name: 'payment_event_relations',
    sql: `SELECT COUNT(*)::text AS violation_count
      FROM app.payment_events e
      LEFT JOIN app.payment_transactions p ON p.id = e.payment_transaction_id
      LEFT JOIN app.orders o ON o.id = e.order_id
      WHERE (e.payment_transaction_id IS NOT NULL AND p.id IS NULL)
         OR (e.order_id IS NOT NULL AND o.id IS NULL)`
  },
  {
    name: 'proof_relations',
    sql: `SELECT COUNT(*)::text AS violation_count
      FROM app.record_proofs p
      LEFT JOIN app.records r ON r.qr_id = p.record_qr_id
      WHERE r.qr_id IS NULL`
  },
  {
    name: 'archive_relations',
    sql: `SELECT COUNT(*)::text AS violation_count
      FROM app.record_archives a
      LEFT JOIN app.records r ON r.qr_id = a.record_qr_id
      WHERE r.qr_id IS NULL`
  },
  {
    name: 'qr_lifecycle_relations',
    sql: `SELECT COUNT(*)::text AS violation_count
      FROM app.qr_codes q
      LEFT JOIN app.records r ON r.qr_id = q.id
      LEFT JOIN app.co_creations c ON c.qr_id = q.id
      WHERE (q.lifecycle_status = 'unactivated' AND (r.qr_id IS NOT NULL OR c.id IS NOT NULL))
         OR (q.lifecycle_status = 'co_creating' AND (r.qr_id IS NULL OR c.id IS NULL OR c.status <> 'active'))
         OR (q.lifecycle_status = 'activated' AND (r.qr_id IS NULL OR r.sealed_at IS NULL))`
  },
  {
    name: 'order_amounts',
    sql: `SELECT COUNT(*)::text AS violation_count
      FROM app.orders
      WHERE total_amount_cents <> unit_price_cents * quantity`
  },
  {
    name: 'payment_amounts',
    sql: `SELECT COUNT(*)::text AS violation_count
      FROM app.payment_transactions p
      JOIN app.orders o ON o.id = p.order_id
      WHERE p.amount_cents <> o.total_amount_cents`
  },
  {
    name: 'proof_operation_ids',
    sql: `SELECT COUNT(*)::text AS violation_count
      FROM (
        SELECT provider, operation_id
        FROM app.record_proofs
        WHERE operation_id IS NOT NULL
        GROUP BY provider, operation_id
        HAVING COUNT(*) > 1
      ) duplicates`
  }
]);

function verificationError(code, message, details = {}) {
  const error = new Error(message || code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function assertTransactionContext(transactionContext) {
  if (!transactionContext || typeof transactionContext.query !== 'function') {
    throw verificationError(
      'POSTGRES_IMPORT_TRANSACTION_REQUIRED',
      'A PostgreSQL transaction context is required.'
    );
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = stableValue(value[key]);
      return result;
    }, {});
  }
  return value;
}

function normalizeValue(spec, field, value) {
  if (value === null || value === undefined) return null;
  if (spec.jsonColumns.has(field)) {
    if (typeof value === 'string') {
      try {
        return stableValue(JSON.parse(value));
      } catch (_error) {
        throw verificationError(
          'POSTGRES_IMPORT_VERIFICATION_FAILED',
          'A JSONB value could not be normalized.',
          { field }
        );
      }
    }
    return stableValue(value);
  }
  if (spec.timestampColumns.has(field)) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) {
      throw verificationError(
        'POSTGRES_IMPORT_VERIFICATION_FAILED',
        'A timestamp could not be normalized.',
        { field }
      );
    }
    return date.toISOString();
  }
  if (spec.numberColumns.has(field)) {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) {
      throw verificationError(
        'POSTGRES_IMPORT_VERIFICATION_FAILED',
        'A numeric value could not be normalized safely.',
        { field }
      );
    }
    return number;
  }
  if (spec.trimmedColumns.has(field) && typeof value === 'string') return value.trim();
  return value;
}

function comparableColumns(spec) {
  return spec.columns.filter((field) => field !== spec.generatedColumn);
}

function canonicalRows(spec, rows) {
  const columns = comparableColumns(spec);
  return rows.map((row) => {
    const normalized = {};
    columns.forEach((field) => {
      normalized[field] = normalizeValue(spec, field, row[field]);
    });
    return normalized;
  }).map((row) => JSON.stringify(row)).sort();
}

async function verifyExplicitIdentityIds(transactionContext, collection, planRows, spec) {
  if (!spec.generatedColumn) return;
  const expectedIds = planRows
    .map((row) => row[spec.generatedColumn])
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value))
    .sort();
  if (expectedIds.length === 0) return;
  const result = await transactionContext.query(
    `SELECT id::text AS id FROM app.${collection} WHERE id = ANY($1::bigint[]) ORDER BY id`,
    [expectedIds]
  );
  const actualIds = result.rows.map((row) => String(row.id)).sort();
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    throw verificationError(
      'POSTGRES_IMPORT_VERIFICATION_FAILED',
      'Imported historical identity values do not match the plan.',
      { collection }
    );
  }
}

async function verifyCollection(transactionContext, collection, planRows) {
  const spec = TABLE_SPECS[collection];
  const columns = comparableColumns(spec);
  const result = await transactionContext.query(
    `SELECT ${columns.join(', ')} FROM app.${collection}`
  );
  if (result.rows.length !== planRows.length) {
    throw verificationError(
      'POSTGRES_IMPORT_COUNT_MISMATCH',
      'An imported table count does not match the plan.',
      { collection, expectedCount: planRows.length, actualCount: result.rows.length }
    );
  }
  const expected = canonicalRows(spec, planRows);
  const actual = canonicalRows(spec, result.rows);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw verificationError(
      'POSTGRES_IMPORT_ROW_MISMATCH',
      'Imported rows do not match the in-memory plan.',
      { collection }
    );
  }
  await verifyExplicitIdentityIds(transactionContext, collection, planRows, spec);
  return result.rows.length;
}

async function verifyIntegrity(transactionContext) {
  const checks = {};
  for (const check of INTEGRITY_CHECKS) {
    const result = await transactionContext.query(check.sql);
    const violations = Number(result.rows[0] && result.rows[0].violation_count);
    if (!Number.isSafeInteger(violations) || violations !== 0) {
      throw verificationError(
        'POSTGRES_IMPORT_RELATION_MISMATCH',
        'An imported relationship or business invariant failed validation.',
        { check: check.name }
      );
    }
    checks[check.name] = 0;
  }
  return checks;
}

async function verifyIdentitySequences(transactionContext) {
  const checks = {};
  for (const table of IDENTITY_TABLES) {
    const maximumResult = await transactionContext.query(
      `SELECT COALESCE(MAX(id), 0)::text AS max_id FROM app.${table}`
    );
    const sequenceResult = await transactionContext.query(
      `SELECT last_value::text AS last_value, is_called FROM app.${table}_id_seq`
    );
    const maximum = Number(maximumResult.rows[0] && maximumResult.rows[0].max_id);
    const lastValue = Number(sequenceResult.rows[0] && sequenceResult.rows[0].last_value);
    const isCalled = sequenceResult.rows[0] && sequenceResult.rows[0].is_called === true;
    const valid = maximum > 0
      ? lastValue === maximum && isCalled
      : lastValue === 1 && !isCalled;
    if (!Number.isSafeInteger(maximum) || !Number.isSafeInteger(lastValue) || !valid) {
      throw verificationError(
        'POSTGRES_IMPORT_SEQUENCE_MISMATCH',
        'An identity sequence is not positioned after the imported values.',
        { table }
      );
    }
    checks[table] = { maximum, last_value: lastValue, is_called: isCalled };
  }
  return checks;
}

async function verifyImportedPlan({ plan, transactionContext }) {
  assertTransactionContext(transactionContext);
  assertImportPlan(plan);
  const counts = {};
  for (const collection of IMPORT_ORDER) {
    counts[collection] = await verifyCollection(
      transactionContext,
      collection,
      plan[collection]
    );
  }
  const integrity = await verifyIntegrity(transactionContext);
  const sequences = await verifyIdentitySequences(transactionContext);
  return { counts, integrity, sequences };
}

module.exports = {
  INTEGRITY_CHECKS,
  canonicalRows,
  verifyIdentitySequences,
  verifyImportedPlan
};
