'use strict';

const ACCOUNT_FIELDS = [
  'id', 'status', 'display_name', 'avatar_url', 'created_from', 'created_at', 'updated_at'
];
const IDENTITY_FIELDS = [
  'id', 'legacy_id', 'account_id', 'phone', 'openid', 'unionid', 'source', 'created_at', 'updated_at'
];
const QR_FIELDS = [
  'id', 'issue_status', 'lifecycle_status', 'hidden', 'batch_id', 'print_batch_id',
  'print_status', 'print_status_updated_at', 'print_void_reason',
  'qr_image_url_snapshot', 'access_token', 'created_at', 'updated_at'
];
const QR_BATCH_PUBLIC_FIELDS = [
  'id', 'brand_name', 'disclosure_text', 'show_brand_disclosure_default'
];
const RECORD_FIELDS = [
  'qr_id', 'account_id', 'content', 'image_url_snapshot', 'image_object_key', 'image_sha256',
  'phone_snapshot', 'sealed_at', 'show_brand_disclosure', 'brand_disclosure_text_snapshot',
  'created_at', 'updated_at'
];
const CO_CREATION_FIELDS = [
  'id', 'qr_id', 'owner_account_id', 'owner_phone_snapshot', 'status', 'started_at',
  'finalized_at', 'created_at', 'updated_at'
];
const COMMENT_FIELDS = [
  'id', 'co_creation_id', 'account_id', 'legacy_comment_id', 'source_position',
  'legacy_duplicate', 'phone_snapshot', 'author_name', 'content', 'status', 'created_at',
  'deleted_at'
];
const ORDER_FIELDS = [
  'id', 'order_no', 'account_id', 'product_id', 'openid_snapshot', 'phone_snapshot',
  'product_snapshot', 'quantity', 'unit_price_cents', 'total_amount_cents', 'status',
  'payment_status', 'payment_method', 'payment_mock', 'provider_transaction_id',
  'provider_transaction_snapshot', 'paid_at', 'receiver_name', 'receiver_phone', 'region',
  'address', 'remark', 'express_company', 'express_no', 'shipped_at', 'refund_status',
  'admin_note', 'created_at', 'updated_at'
];
const PAYMENT_FIELDS = [
  'id', 'order_id', 'provider', 'merchant_order_no', 'provider_transaction_id', 'amount_cents',
  'status', 'paid_at', 'created_at', 'updated_at'
];
const PAYMENT_EVENT_FIELDS = [
  'id', 'legacy_id', 'payment_transaction_id', 'order_id', 'event_type', 'status',
  'payload_sha256', 'sanitized_metadata', 'created_at'
];
const PROOF_FIELDS = [
  'id', 'record_qr_id', 'provider', 'status', 'operation_id', 'manifest_object_key',
  'manifest_hash', 'legacy_hash_snapshot', 'transaction_hash', 'block_height', 'provider_record_id',
  'provider_certificate_url', 'certificate_object_key', 'certificate_object_url_snapshot',
  'confirmed_at', 'callback_received_at', 'retry_count', 'last_error', 'created_at', 'updated_at'
];
const PROOF_ATTEMPT_FIELDS = [
  'id', 'proof_id', 'attempt_number', 'request_state', 'result_status', 'sanitized_error',
  'requested_at', 'completed_at'
];
const ARCHIVE_FIELDS = [
  'record_qr_id', 'manifest_object_key', 'legacy_manifest_object_key', 'index_object_key',
  'status', 'last_error', 'created_at', 'updated_at'
];
const AUDIT_FIELDS = [
  'id', 'actor_type', 'actor_reference', 'actor_reference_hash', 'action', 'entity_type',
  'entity_id', 'entity_reference_hash', 'request_method', 'request_path', 'result_status',
  'ip_hash', 'user_agent_family', 'duration_ms', 'metadata', 'created_at'
];
const OUTBOX_FIELDS = [
  'id', 'job_type', 'aggregate_type', 'aggregate_id', 'idempotency_key', 'payload',
  'status', 'attempt_count', 'available_at', 'locked_at', 'locked_by', 'last_error',
  'created_at', 'updated_at'
];

function cloneJson(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function mapFields(row, fields, jsonFields = []) {
  if (!row) return null;
  const jsonSet = new Set(jsonFields);
  return Object.freeze(Object.fromEntries(fields.map((field) => [
    field,
    jsonSet.has(field) ? cloneJson(row[field]) : row[field]
  ])));
}

const mapAccount = (row) => mapFields(row, ACCOUNT_FIELDS);
const mapIdentity = (row) => mapFields(row, IDENTITY_FIELDS);
const mapQr = (row) => mapFields(row, QR_FIELDS);
const mapQrBatchPublic = (row) => mapFields(row, QR_BATCH_PUBLIC_FIELDS);
const mapRecord = (row) => mapFields(row, RECORD_FIELDS);
const mapCoCreation = (row) => mapFields(row, CO_CREATION_FIELDS);
const mapComment = (row) => mapFields(row, COMMENT_FIELDS);
const mapOrder = (row) => mapFields(row, ORDER_FIELDS, ['product_snapshot', 'provider_transaction_snapshot']);
const mapPayment = (row) => mapFields(row, PAYMENT_FIELDS);
const mapPaymentEvent = (row) => mapFields(row, PAYMENT_EVENT_FIELDS, ['sanitized_metadata']);
const mapProof = (row) => mapFields(row, PROOF_FIELDS);
const mapProofAttempt = (row) => mapFields(row, PROOF_ATTEMPT_FIELDS);
const mapArchive = (row) => mapFields(row, ARCHIVE_FIELDS);
const mapAudit = (row) => mapFields(row, AUDIT_FIELDS, ['metadata']);
const mapOutboxJob = (row) => mapFields(row, OUTBOX_FIELDS, ['payload']);

module.exports = {
  ACCOUNT_FIELDS,
  ARCHIVE_FIELDS,
  AUDIT_FIELDS,
  COMMENT_FIELDS,
  CO_CREATION_FIELDS,
  IDENTITY_FIELDS,
  ORDER_FIELDS,
  OUTBOX_FIELDS,
  PAYMENT_EVENT_FIELDS,
  PAYMENT_FIELDS,
  PROOF_ATTEMPT_FIELDS,
  PROOF_FIELDS,
  QR_BATCH_PUBLIC_FIELDS,
  QR_FIELDS,
  RECORD_FIELDS,
  mapAccount,
  mapArchive,
  mapAudit,
  mapCoCreation,
  mapComment,
  mapIdentity,
  mapOrder,
  mapOutboxJob,
  mapPayment,
  mapPaymentEvent,
  mapProof,
  mapProofAttempt,
  mapQr,
  mapQrBatchPublic,
  mapRecord
};
