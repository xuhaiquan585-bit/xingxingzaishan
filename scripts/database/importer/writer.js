'use strict';

const crypto = require('node:crypto');

const IMPORT_ORDER = Object.freeze([
  'accounts',
  'users',
  'operators',
  'qr_batches',
  'products',
  'product_images',
  'product_scene_tags',
  'qr_codes',
  'records',
  'co_creations',
  'co_creation_comments',
  'quality_check_logs',
  'orders',
  'payment_transactions',
  'payment_events',
  'record_proofs',
  'proof_attempts',
  'record_archives',
  'miniapp_content',
  'audit_events'
]);

const TABLE_SPECS = Object.freeze({
  accounts: tableSpec([
    'id', 'status', 'display_name', 'avatar_url', 'created_from', 'created_at', 'updated_at'
  ], { timestamps: ['created_at', 'updated_at'] }),
  users: tableSpec([
    'id', 'legacy_id', 'account_id', 'phone', 'openid', 'unionid', 'source', 'created_at', 'updated_at'
  ], { generatedColumn: 'id', numbers: ['id'], timestamps: ['created_at', 'updated_at'] }),
  operators: tableSpec([
    'id', 'legacy_id', 'username', 'password_hash', 'role', 'name', 'enabled', 'created_at', 'updated_at'
  ], { generatedColumn: 'id', numbers: ['id'], timestamps: ['created_at', 'updated_at'] }),
  qr_batches: tableSpec([
    'id', 'name', 'brand_name', 'note', 'disclosure_text', 'show_brand_disclosure_default',
    'created_by_operator_id', 'created_by_snapshot', 'created_at', 'updated_at'
  ], {
    numbers: ['created_by_operator_id'],
    timestamps: ['created_at', 'updated_at']
  }),
  products: tableSpec([
    'id', 'title', 'subtitle', 'cover_image_url', 'cover_image_object_key', 'price_text',
    'price_cents', 'description', 'status', 'product_type', 'sticker_count', 'stock',
    'is_customizable', 'shipping_note', 'after_sale_note', 'buy_type', 'buy_url',
    'sort_order', 'created_at', 'updated_at'
  ], {
    numbers: ['price_cents', 'sticker_count', 'stock', 'sort_order'],
    timestamps: ['created_at', 'updated_at']
  }),
  product_images: tableSpec([
    'product_id', 'image_url', 'image_object_key', 'sort_order', 'created_at'
  ], { numbers: ['sort_order'], timestamps: ['created_at'] }),
  product_scene_tags: tableSpec([
    'product_id', 'scene_key', 'created_at'
  ], { timestamps: ['created_at'] }),
  qr_codes: tableSpec([
    'id', 'issue_status', 'lifecycle_status', 'hidden', 'batch_id', 'print_batch_id',
    'qr_image_url_snapshot', 'access_token', 'created_at', 'updated_at'
  ], { timestamps: ['created_at', 'updated_at'] }),
  records: tableSpec([
    'qr_id', 'account_id', 'content', 'image_url_snapshot', 'image_object_key', 'image_sha256',
    'phone_snapshot', 'sealed_at', 'show_brand_disclosure', 'brand_disclosure_text_snapshot',
    'created_at', 'updated_at'
  ], {
    timestamps: ['sealed_at', 'created_at', 'updated_at'],
    trimmed: ['image_sha256']
  }),
  co_creations: tableSpec([
    'id', 'qr_id', 'owner_account_id', 'owner_phone_snapshot', 'status', 'started_at',
    'finalized_at', 'created_at', 'updated_at'
  ], { timestamps: ['started_at', 'finalized_at', 'created_at', 'updated_at'] }),
  co_creation_comments: tableSpec([
    'id', 'co_creation_id', 'account_id', 'legacy_comment_id', 'source_position',
    'phone_snapshot', 'author_name', 'content', 'status', 'created_at', 'deleted_at'
  ], { numbers: ['source_position'], timestamps: ['created_at', 'deleted_at'] }),
  quality_check_logs: tableSpec([
    'id', 'legacy_id', 'qr_id', 'operator_id', 'checked_by_snapshot', 'result', 'checked_at'
  ], {
    generatedColumn: 'id',
    numbers: ['id', 'operator_id'],
    timestamps: ['checked_at']
  }),
  orders: tableSpec([
    'id', 'order_no', 'account_id', 'product_id', 'openid_snapshot', 'phone_snapshot',
    'product_snapshot', 'quantity', 'unit_price_cents', 'total_amount_cents', 'status',
    'payment_status', 'payment_method', 'payment_mock', 'provider_transaction_id',
    'provider_transaction_snapshot', 'paid_at', 'receiver_name', 'receiver_phone', 'region',
    'address', 'remark', 'express_company', 'express_no', 'shipped_at', 'refund_status',
    'admin_note', 'created_at', 'updated_at'
  ], {
    json: ['product_snapshot', 'provider_transaction_snapshot'],
    numbers: ['quantity', 'unit_price_cents', 'total_amount_cents'],
    timestamps: ['paid_at', 'shipped_at', 'created_at', 'updated_at']
  }),
  payment_transactions: tableSpec([
    'id', 'order_id', 'provider', 'merchant_order_no', 'provider_transaction_id', 'amount_cents',
    'status', 'paid_at', 'created_at', 'updated_at'
  ], {
    numbers: ['amount_cents'],
    timestamps: ['paid_at', 'created_at', 'updated_at']
  }),
  payment_events: tableSpec([
    'legacy_id', 'payment_transaction_id', 'order_id', 'event_type', 'status', 'payload_sha256',
    'sanitized_metadata', 'created_at'
  ], {
    json: ['sanitized_metadata'],
    timestamps: ['created_at'],
    trimmed: ['payload_sha256']
  }),
  record_proofs: tableSpec([
    'id', 'record_qr_id', 'provider', 'status', 'operation_id', 'manifest_object_key',
    'manifest_hash', 'transaction_hash', 'block_height', 'provider_record_id',
    'provider_certificate_url', 'certificate_object_key', 'certificate_object_url_snapshot',
    'confirmed_at', 'callback_received_at', 'retry_count', 'last_error', 'created_at', 'updated_at'
  ], {
    numbers: ['block_height', 'retry_count'],
    timestamps: ['confirmed_at', 'callback_received_at', 'created_at', 'updated_at'],
    trimmed: ['manifest_hash']
  }),
  proof_attempts: tableSpec([
    'proof_id', 'attempt_number', 'request_state', 'result_status', 'sanitized_error',
    'requested_at', 'completed_at'
  ], {
    numbers: ['attempt_number'],
    timestamps: ['requested_at', 'completed_at']
  }),
  record_archives: tableSpec([
    'record_qr_id', 'manifest_object_key', 'legacy_manifest_object_key', 'index_object_key',
    'status', 'last_error', 'created_at', 'updated_at'
  ], { timestamps: ['created_at', 'updated_at'] }),
  miniapp_content: tableSpec([
    'id', 'home_title', 'home_subtitle', 'logo_image', 'home_banner_image', 'home_slides',
    'scene_cards', 'project_title', 'project_body', 'brand_story_title', 'brand_story_body',
    'consult_label', 'consult_url', 'share_title', 'share_description', 'updated_by_operator_id',
    'updated_by_snapshot', 'updated_at'
  ], {
    json: ['home_slides', 'scene_cards'],
    numbers: ['id', 'updated_by_operator_id'],
    timestamps: ['updated_at']
  }),
  audit_events: tableSpec([
    'actor_type', 'actor_reference_hash', 'action', 'entity_type', 'entity_id',
    'entity_reference_hash', 'request_method', 'request_path', 'result_status', 'duration_ms',
    'metadata', 'created_at'
  ], {
    json: ['metadata'],
    numbers: ['duration_ms'],
    timestamps: ['created_at']
  })
});

const PLAN_COLLECTIONS = new Set([...IMPORT_ORDER, 'archived_legacy']);
const IDENTITY_TABLES = Object.freeze([
  'users', 'operators', 'quality_check_logs', 'product_images', 'payment_events',
  'proof_attempts', 'audit_events'
]);

function tableSpec(columns, {
  generatedColumn = null,
  json = [],
  numbers = [],
  timestamps = [],
  trimmed = []
} = {}) {
  return Object.freeze({
    columns: Object.freeze([...columns]),
    generatedColumn,
    jsonColumns: new Set(json),
    numberColumns: new Set(numbers),
    timestampColumns: new Set(timestamps),
    trimmedColumns: new Set(trimmed)
  });
}

function importWriterError(code, message, details = {}) {
  const error = new Error(message || code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function assertTransactionContext(transactionContext) {
  if (!transactionContext || typeof transactionContext.query !== 'function') {
    throw importWriterError(
      'POSTGRES_IMPORT_TRANSACTION_REQUIRED',
      'A PostgreSQL transaction context is required.'
    );
  }
}

function assertImportPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw importWriterError('POSTGRES_IMPORT_PLAN_INVALID', 'The import plan must be an object.');
  }
  Object.keys(plan).forEach((collection) => {
    if (!PLAN_COLLECTIONS.has(collection)) {
      throw importWriterError(
        'POSTGRES_IMPORT_PLAN_INVALID',
        'The import plan contains an unsupported collection.',
        { collection }
      );
    }
  });
  IMPORT_ORDER.forEach((collection) => {
    if (!Array.isArray(plan[collection])) {
      throw importWriterError(
        'POSTGRES_IMPORT_PLAN_INVALID',
        'Every import collection must be an array.',
        { collection }
      );
    }
  });
}

function assertPlanRow(collection, row, rowIndex) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw importWriterError(
      'POSTGRES_IMPORT_PLAN_INVALID',
      'Import rows must be objects.',
      { collection, rowIndex }
    );
  }
  const spec = TABLE_SPECS[collection];
  const allowed = new Set(spec.columns);
  Object.keys(row).forEach((field) => {
    if (!allowed.has(field)) {
      throw importWriterError(
        'POSTGRES_IMPORT_PLAN_INVALID',
        'An import row contains an unsupported field.',
        { collection, field, rowIndex }
      );
    }
  });
  spec.columns.forEach((field) => {
    if (field === spec.generatedColumn && (row[field] === null || row[field] === undefined)) return;
    if (!Object.prototype.hasOwnProperty.call(row, field)) {
      throw importWriterError(
        'POSTGRES_IMPORT_PLAN_INVALID',
        'An import row is missing a mapped field.',
        { collection, field, rowIndex }
      );
    }
  });
  if (collection === 'co_creation_comments'
    && (!Number.isSafeInteger(row.source_position) || row.source_position < 0)) {
    throw importWriterError(
      'POSTGRES_IMPORT_PLAN_INVALID',
      'A co-creation comment has an invalid source position.',
      { collection, field: 'source_position', rowIndex }
    );
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = stableValue(value[key]);
      return result;
    }, {});
  }
  return value;
}

function planSha256(plan) {
  assertImportPlan(plan);
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(plan))).digest('hex');
}

function insertColumnsForRow(spec, row) {
  return spec.columns.filter((field) => (
    field !== spec.generatedColumn || (row[field] !== null && row[field] !== undefined)
  ));
}

function valueForInsert(spec, field, value) {
  if (spec.jsonColumns.has(field)) return JSON.stringify(value);
  return value;
}

async function insertPlanRow(transactionContext, collection, row, rowIndex) {
  assertPlanRow(collection, row, rowIndex);
  const spec = TABLE_SPECS[collection];
  const columns = insertColumnsForRow(spec, row);
  const placeholders = columns.map((_field, index) => `$${index + 1}`);
  const values = columns.map((field) => valueForInsert(spec, field, row[field]));
  const sql = `INSERT INTO app.${collection} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`;
  await transactionContext.query(sql, values);
}

async function importPlanToPostgres({ plan, transactionContext }) {
  assertTransactionContext(transactionContext);
  assertImportPlan(plan);
  const importedCounts = {};
  for (const collection of IMPORT_ORDER) {
    const rows = plan[collection];
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      await insertPlanRow(transactionContext, collection, rows[rowIndex], rowIndex);
    }
    importedCounts[collection] = rows.length;
  }
  return importedCounts;
}

async function resetIdentitySequences(transactionContext) {
  assertTransactionContext(transactionContext);
  const sequenceValues = {};
  for (const table of IDENTITY_TABLES) {
    const result = await transactionContext.query(
      `SELECT setval(
        pg_get_serial_sequence('app.${table}', 'id'),
        GREATEST(COALESCE((SELECT MAX(id) FROM app.${table}), 1), 1),
        EXISTS (SELECT 1 FROM app.${table})
      ) AS sequence_value`
    );
    sequenceValues[table] = result.rows[0] ? String(result.rows[0].sequence_value) : null;
  }
  return sequenceValues;
}

module.exports = {
  IDENTITY_TABLES,
  IMPORT_ORDER,
  TABLE_SPECS,
  assertImportPlan,
  importPlanToPostgres,
  planSha256,
  resetIdentitySequences
};
