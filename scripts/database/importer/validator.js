'use strict';

const crypto = require('node:crypto');
const {
  createLegacyAccountResolver,
  deterministicUuid,
  ENTITY_FIELDS,
  isSha256,
  ROOT_FIELDS
} = require('./mapping');

const REQUIRED_ARRAYS = [
  'accounts', 'users', 'qr_codes', 'admins', 'quality_check_logs', 'batches', 'products',
  'content_pages', 'banners', 'orders', 'payment_logs'
];
const ACCOUNT_STATUSES = new Set(['active', 'disabled', 'closed']);
const USER_SOURCES = new Set(['web', 'miniapp', 'web+miniapp', 'migration']);
const QR_ISSUE_STATUSES = new Set(['unissued', 'issued']);
const QR_LIFECYCLES = new Set(['unactivated', 'co_creating', 'activated']);
const ORDER_STATUSES = new Set(['pending_payment', 'paid', 'shipped', 'completed', 'cancelled', 'refunding', 'refunded']);
const PAYMENT_STATUSES = new Set(['unpaid', 'paid', 'failed', 'refunded']);
const PROOF_STATUSES = new Set(['not_started', 'manifest_ready', 'submitting', 'submitted', 'confirmed', 'failed', 'retrying']);
const ARCHIVE_STATUSES = new Set(['not_started', 'pending', 'ready', 'failed']);
const PRODUCT_STATUSES = new Set(['draft', 'published', 'hidden']);
const PRODUCT_TYPES = new Set(['wine_sticker', 'sticker_set', 'custom_sticker', 'wine_gift', 'custom_wine']);
const PRODUCT_BUY_TYPES = new Set(['miniapp_order', 'copy_link']);
const SCENE_KEYS = new Set(['lover', 'elder', 'birthday', 'wedding', 'party', 'free', 'coming_of_age']);

function array(value) {
  return Array.isArray(value) ? value : [];
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function referenceHash(entityType, value) {
  return crypto.createHash('sha256').update(`${entityType}:${String(value ?? '')}`).digest('hex').slice(0, 12);
}

function createCollector() {
  const anomalies = [];
  return {
    anomalies,
    add(category, entityType, reference, field, { blocking = true, count = 1 } = {}) {
      anomalies.push({
        category,
        entity_type: entityType,
        entity_reference_hash: referenceHash(entityType, reference),
        field: field || null,
        count,
        blocking
      });
    }
  };
}

function validateKnownFields(collector, value, allowedFields, entityType, reference) {
  if (!object(value)) {
    collector.add('INVALID_TYPE', entityType, reference, null);
    return;
  }
  const allowed = new Set(allowedFields);
  Object.keys(value).forEach((field) => {
    if (!allowed.has(field)) collector.add('UNKNOWN_FIELD', entityType, reference, field);
  });
}

function validateRequiredFields(collector, value, fields, entityType, reference) {
  if (!object(value)) return;
  fields.forEach((field) => {
    if (value[field] === undefined || value[field] === null || value[field] === '') {
      collector.add('MISSING_REQUIRED_FIELD', entityType, reference, field);
    }
  });
}

function validateTimestamp(collector, value, entityType, reference, field, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) collector.add('MISSING_REQUIRED_FIELD', entityType, reference, field);
    return;
  }
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    collector.add('INVALID_TIMESTAMP', entityType, reference, field);
  }
}

function validateInteger(collector, value, entityType, reference, field, { min = 0, required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) collector.add('MISSING_REQUIRED_FIELD', entityType, reference, field);
    return;
  }
  if (!Number.isSafeInteger(Number(value)) || Number(value) < min) {
    collector.add('INVALID_AMOUNT', entityType, reference, field);
  }
}

function validateHash(collector, value, entityType, reference, field) {
  if (value === undefined || value === null || value === '') return;
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    collector.add('INVALID_HASH', entityType, reference, field);
  }
}

function detectDuplicates(collector, items, field, entityType, category, normalize = (value) => String(value ?? '').trim()) {
  const counts = new Map();
  items.forEach((item) => {
    const value = normalize(item && item[field]);
    if (!value) return;
    counts.set(value, (counts.get(value) || 0) + 1);
  });
  counts.forEach((count, value) => {
    if (count > 1) collector.add(category, entityType, value, field, { count });
  });
}

function validateStructure(source, collector) {
  if (!object(source)) {
    collector.add('INVALID_SOURCE', 'source', 'root', null);
    return;
  }
  validateKnownFields(collector, source, ROOT_FIELDS, 'source', 'root');
  REQUIRED_ARRAYS.forEach((field) => {
    if (!Array.isArray(source[field])) collector.add('INVALID_TYPE', 'source', 'root', field);
  });
  if (!object(source.meta)) collector.add('INVALID_TYPE', 'source', 'root', 'meta');
  if (!object(source.miniapp_content)) collector.add('INVALID_TYPE', 'source', 'root', 'miniapp_content');

  if (object(source.meta)) {
    validateKnownFields(collector, source.meta, ENTITY_FIELDS.meta, 'meta', 'meta');
    if (source.meta.schema_version && source.meta.schema_version !== 'json-runtime-v1') {
      collector.add('SCHEMA_VERSION_UNSUPPORTED', 'meta', 'meta', 'schema_version');
    }
  }

  const entityCollections = ['accounts', 'users', 'admins', 'batches', 'quality_check_logs', 'products', 'orders', 'payment_logs', 'qr_codes'];
  entityCollections.forEach((collection) => {
    array(source[collection]).forEach((item, index) => {
      validateKnownFields(collector, item, ENTITY_FIELDS[collection], collection, item && item.id !== undefined ? item.id : index);
    });
  });

  array(source.qr_codes).forEach((qr, qrIndex) => {
    if (!object(qr)) return;
    if (qr.quality_check !== undefined && qr.quality_check !== null) {
      validateKnownFields(collector, qr.quality_check, ENTITY_FIELDS.quality_check, 'qr_quality_check', qr.id || qrIndex);
    }
    if (qr.co_creation_comments !== undefined && !Array.isArray(qr.co_creation_comments)) {
      collector.add('INVALID_TYPE', 'qr_codes', qr.id || qrIndex, 'co_creation_comments');
    }
    array(qr.co_creation_comments).forEach((comment, commentIndex) => {
      validateKnownFields(
        collector,
        comment,
        ENTITY_FIELDS.co_creation_comments,
        'co_creation_comments',
        `${qr.id || qrIndex}:${comment && comment.id !== undefined ? comment.id : commentIndex}`
      );
    });
  });

  if (object(source.miniapp_content)) {
    validateKnownFields(collector, source.miniapp_content, ENTITY_FIELDS.miniapp_content, 'miniapp_content', 'singleton');
    if (source.miniapp_content.home_slides !== undefined && !Array.isArray(source.miniapp_content.home_slides)) {
      collector.add('INVALID_TYPE', 'miniapp_content', 'singleton', 'home_slides');
    }
    if (source.miniapp_content.scene_cards !== undefined && !Array.isArray(source.miniapp_content.scene_cards)) {
      collector.add('INVALID_TYPE', 'miniapp_content', 'singleton', 'scene_cards');
    }
    array(source.miniapp_content.home_slides).forEach((item, index) => {
      validateKnownFields(collector, item, ENTITY_FIELDS.home_slides, 'home_slides', index);
    });
    array(source.miniapp_content.scene_cards).forEach((item, index) => {
      validateKnownFields(collector, item, ENTITY_FIELDS.scene_cards, 'scene_cards', index);
    });
  }
}

function validateAccountsAndUsers(source, collector) {
  const accounts = array(source.accounts);
  const users = array(source.users);
  detectDuplicates(collector, accounts, 'id', 'accounts', 'DUPLICATE_BUSINESS_ID');
  detectDuplicates(collector, users, 'id', 'users', 'DUPLICATE_BUSINESS_ID');
  detectDuplicates(collector, users, 'phone', 'users', 'DUPLICATE_IDENTITY');
  detectDuplicates(collector, users, 'openid', 'users', 'DUPLICATE_IDENTITY');
  const accountIds = new Set(accounts.map((item) => item && item.id).filter(Boolean));

  accounts.forEach((item, index) => {
    const reference = item && item.id !== undefined ? item.id : index;
    validateRequiredFields(collector, item, ['id', 'status', 'created_from', 'created_at'], 'accounts', reference);
    if (item && !ACCOUNT_STATUSES.has(item.status)) collector.add('INVALID_STATUS', 'accounts', reference, 'status');
    validateTimestamp(collector, item && item.created_at, 'accounts', reference, 'created_at', { required: true });
    validateTimestamp(collector, item && item.updated_at, 'accounts', reference, 'updated_at');
  });

  users.forEach((item, index) => {
    const reference = item && item.id !== undefined ? item.id : index;
    validateRequiredFields(collector, item, ['id', 'account_id', 'source', 'created_at'], 'users', reference);
    if (!item || (!item.phone && !item.openid && !item.unionid)) collector.add('MISSING_REQUIRED_FIELD', 'users', reference, 'identity');
    if (item && !USER_SOURCES.has(item.source)) collector.add('INVALID_STATUS', 'users', reference, 'source');
    if (item && item.account_id && !accountIds.has(item.account_id)) collector.add('MISSING_REFERENCE', 'users', reference, 'account_id');
    validateTimestamp(collector, item && item.created_at, 'users', reference, 'created_at', { required: true });
    validateTimestamp(collector, item && item.updated_at, 'users', reference, 'updated_at');
  });
}

function validateQrData(source, collector) {
  const accounts = new Set(array(source.accounts).map((item) => item && item.id).filter(Boolean));
  const batches = new Set(array(source.batches).map((item) => item && item.id).filter(Boolean));
  const qrs = array(source.qr_codes);
  const resolveLegacyAccount = createLegacyAccountResolver(source);
  detectDuplicates(collector, qrs, 'id', 'qr_codes', 'DUPLICATE_BUSINESS_ID');
  detectDuplicates(collector, qrs, 'qr_access_token', 'qr_codes', 'DUPLICATE_BUSINESS_ID');
  detectDuplicates(collector, qrs, 'chain_operation_id', 'record_proofs', 'DUPLICATE_BUSINESS_ID');

  qrs.forEach((qr, index) => {
    const reference = qr && qr.id !== undefined ? qr.id : index;
    validateRequiredFields(collector, qr, ['id', 'issue_status', 'activation_status', 'created_at'], 'qr_codes', reference);
    if (!qr || !QR_ISSUE_STATUSES.has(qr.issue_status)) collector.add('INVALID_STATUS', 'qr_codes', reference, 'issue_status');
    if (!qr || !QR_LIFECYCLES.has(qr.activation_status)) collector.add('INVALID_QR_LIFECYCLE', 'qr_codes', reference, 'activation_status');
    if (qr && qr.issue_status !== 'issued' && qr.activation_status !== 'unactivated') {
      collector.add('INVALID_QR_ISSUE_LIFECYCLE', 'qr_codes', reference, 'issue_status');
    }
    if (qr && qr.batch_id && !batches.has(qr.batch_id)) collector.add('MISSING_REFERENCE', 'qr_codes', reference, 'batch_id');
    validateTimestamp(collector, qr && qr.created_at, 'qr_codes', reference, 'created_at', { required: true });
    ['updated_at', 'activated_at', 'co_creation_started_at', 'chain_confirmed_at', 'chain_callback_received_at', 'archive_updated_at'].forEach((field) => {
      validateTimestamp(collector, qr && qr[field], 'qr_codes', reference, field);
    });
    validateHash(collector, qr && qr.image_sha256, 'qr_codes', reference, 'image_sha256');
    if (qr && qr.blockchain_hash && qr.manifest_hash && qr.blockchain_hash !== qr.manifest_hash) {
      collector.add('MANIFEST_HASH_CONFLICT', 'qr_codes', reference, 'manifest_hash');
    }
    const proofHash = qr && (qr.manifest_hash || qr.blockchain_hash);
    if (proofHash && !isSha256(proofHash)) {
      collector.add(
        'LEGACY_NON_SHA_HASH_PRESERVED',
        'record_proofs',
        reference,
        'legacy_hash_snapshot',
        { blocking: false }
      );
    }
    if (qr && qr.chain_status && !PROOF_STATUSES.has(qr.chain_status)) collector.add('INVALID_STATUS', 'record_proofs', reference, 'chain_status');
    if (qr && qr.archive_status && !ARCHIVE_STATUSES.has(qr.archive_status)) collector.add('INVALID_STATUS', 'record_archives', reference, 'archive_status');
    if (qr && qr.quality_check && qr.quality_check.checked === true) {
      validateRequiredFields(collector, qr.quality_check, ['checked_at', 'result'], 'qr_quality_check', reference);
      validateTimestamp(collector, qr.quality_check.checked_at, 'qr_quality_check', reference, 'checked_at', { required: true });
      if (!['pass', 'bound', 'duplicate'].includes(qr.quality_check.result)) {
        collector.add('INVALID_STATUS', 'qr_quality_check', reference, 'result');
      }
    }

    const hasRecordData = qr && ['content', 'image_url', 'image_object_key', 'image_sha256', 'phone', 'account_id', 'activated_at']
      .some((field) => qr[field] !== undefined && qr[field] !== null && qr[field] !== '');
    const hasCoCreationData = qr && (qr.co_creation_enabled === true
      || qr.co_creation_owner_phone || qr.co_creation_owner_account_id || qr.co_creation_started_at
      || array(qr.co_creation_comments).length > 0);
    const hasProofData = qr && (qr.chain_status && qr.chain_status !== 'not_started'
      || qr.blockchain_hash || qr.manifest_hash || qr.chain_operation_id || qr.manifest_object_key);
    const hasArchiveData = qr && (qr.archive_status && qr.archive_status !== 'not_started'
      || qr.legacy_manifest_object_key || qr.archive_index_object_key);

    if (qr && qr.activation_status === 'unactivated' && (hasRecordData || hasCoCreationData)) {
      collector.add('INVALID_QR_LIFECYCLE', 'qr_codes', reference, 'activation_status');
    }
    if (qr && ['co_creating', 'activated'].includes(qr.activation_status)) {
      const recordAccount = resolveLegacyAccount(qr.account_id, qr.phone);
      if (!recordAccount.valid) {
        collector.add('MISSING_REFERENCE', 'records', reference, 'account_id');
      } else if (recordAccount.recovered) {
        collector.add(
          'LEGACY_ACCOUNT_LINK_RECOVERED',
          'records',
          reference,
          'account_id',
          { blocking: false }
        );
      }
    }
    if (qr && qr.activation_status === 'activated' && !qr.activated_at) {
      collector.add('MISSING_REQUIRED_FIELD', 'records', reference, 'activated_at');
    }
    if (qr && qr.activation_status === 'co_creating') {
      if (qr.co_creation_enabled !== true) collector.add('INVALID_QR_LIFECYCLE', 'co_creations', reference, 'co_creation_enabled');
      if (!qr.co_creation_started_at) collector.add('MISSING_REQUIRED_FIELD', 'co_creations', reference, 'co_creation_started_at');
      if (!qr.co_creation_owner_account_id || !accounts.has(qr.co_creation_owner_account_id)) {
        collector.add('MISSING_REFERENCE', 'co_creations', reference, 'co_creation_owner_account_id');
      }
    }
    if (hasCoCreationData && qr.co_creation_owner_account_id && !accounts.has(qr.co_creation_owner_account_id)) {
      collector.add('MISSING_REFERENCE', 'co_creations', reference, 'co_creation_owner_account_id');
    }
    if ((hasProofData || hasArchiveData) && !hasRecordData && qr.activation_status === 'unactivated') {
      collector.add('MISSING_REFERENCE', 'record_integrity', reference, 'record');
    }

    const effectiveAccounts = new Set();
    array(qr && qr.co_creation_comments).forEach((comment, commentIndex) => {
      const commentReference = `${reference}:${comment && comment.id !== undefined ? comment.id : commentIndex}`;
      validateRequiredFields(collector, comment, ['id', 'content', 'status', 'created_at'], 'co_creation_comments', commentReference);
      const commentAccount = resolveLegacyAccount(
        comment && comment.account_id,
        comment && comment.phone
      );
      if (!commentAccount.valid) {
        if (comment && comment.account_id) {
          collector.add('MISSING_REFERENCE', 'co_creation_comments', commentReference, 'account_id');
        } else {
          collector.add('MISSING_REQUIRED_FIELD', 'co_creation_comments', commentReference, 'account_id');
        }
      } else if (commentAccount.recovered) {
        collector.add(
          'LEGACY_ACCOUNT_LINK_RECOVERED',
          'co_creation_comments',
          commentReference,
          'account_id',
          { blocking: false }
        );
      }
      if (comment && !['kept', 'deleted'].includes(comment.status)) collector.add('INVALID_STATUS', 'co_creation_comments', commentReference, 'status');
      validateTimestamp(collector, comment && comment.created_at, 'co_creation_comments', commentReference, 'created_at', { required: true });
      validateTimestamp(collector, comment && comment.deleted_at, 'co_creation_comments', commentReference, 'deleted_at');
      if (comment && comment.status === 'deleted' && !comment.deleted_at) collector.add('MISSING_REQUIRED_FIELD', 'co_creation_comments', commentReference, 'deleted_at');
      if (comment && comment.status !== 'deleted' && commentAccount.accountId) {
        if (effectiveAccounts.has(commentAccount.accountId)) {
          collector.add(
            'LEGACY_DUPLICATE_COMMENT_ACCOUNT_PRESERVED',
            'co_creation_comments',
            commentAccount.accountId,
            'account_id',
            { blocking: false }
          );
        }
        effectiveAccounts.add(commentAccount.accountId);
      }
    });
  });
}

function validateCommerce(source, collector) {
  const accounts = new Set(array(source.accounts).map((item) => item && item.id).filter(Boolean));
  const products = array(source.products);
  const productIds = new Set(products.map((item) => item && item.id).filter(Boolean));
  const orders = array(source.orders);
  const orderIds = new Set(orders.map((item) => item && item.id).filter(Boolean));
  const orderNumbers = new Set(orders.map((item) => item && item.order_no).filter(Boolean));

  detectDuplicates(collector, products, 'id', 'products', 'DUPLICATE_BUSINESS_ID');
  detectDuplicates(collector, orders, 'id', 'orders', 'DUPLICATE_BUSINESS_ID');
  detectDuplicates(collector, orders, 'order_no', 'orders', 'DUPLICATE_BUSINESS_ID');
  detectDuplicates(collector, array(source.payment_logs), 'id', 'payment_logs', 'DUPLICATE_BUSINESS_ID');
  const paymentGroupsByTransaction = new Map();

  products.forEach((item, index) => {
    const reference = item && item.id !== undefined ? item.id : index;
    validateRequiredFields(collector, item, ['id', 'title', 'price_cents', 'status', 'product_type', 'sticker_count', 'stock', 'buy_type', 'created_at'], 'products', reference);
    validateInteger(collector, item && item.price_cents, 'products', reference, 'price_cents');
    validateInteger(collector, item && item.sticker_count, 'products', reference, 'sticker_count', { min: 1 });
    validateInteger(collector, item && item.stock, 'products', reference, 'stock');
    if (item && !PRODUCT_STATUSES.has(item.status)) collector.add('INVALID_STATUS', 'products', reference, 'status');
    if (item && !PRODUCT_TYPES.has(item.product_type)) collector.add('INVALID_STATUS', 'products', reference, 'product_type');
    if (item && !PRODUCT_BUY_TYPES.has(item.buy_type)) collector.add('INVALID_STATUS', 'products', reference, 'buy_type');
    array(item && item.scene_tags).forEach((sceneKey) => {
      if (!SCENE_KEYS.has(sceneKey)) collector.add('INVALID_STATUS', 'products', reference, 'scene_tags');
    });
    validateTimestamp(collector, item && item.created_at, 'products', reference, 'created_at', { required: true });
    validateTimestamp(collector, item && item.updated_at, 'products', reference, 'updated_at');
  });

  orders.forEach((item, index) => {
    const reference = item && item.id !== undefined ? item.id : index;
    validateRequiredFields(collector, item, ['id', 'order_no', 'account_id', 'quantity', 'unit_price_cents', 'total_amount_cents', 'status', 'payment_status', 'created_at'], 'orders', reference);
    if (item && item.account_id && !accounts.has(item.account_id)) collector.add('MISSING_REFERENCE', 'orders', reference, 'account_id');
    if (item && item.product_id && !productIds.has(item.product_id)) collector.add('MISSING_REFERENCE', 'orders', reference, 'product_id');
    validateInteger(collector, item && item.quantity, 'orders', reference, 'quantity', { min: 1 });
    validateInteger(collector, item && item.unit_price_cents, 'orders', reference, 'unit_price_cents');
    validateInteger(collector, item && item.total_amount_cents, 'orders', reference, 'total_amount_cents');
    if (item && Number(item.total_amount_cents) !== Number(item.unit_price_cents) * Number(item.quantity)) {
      collector.add('ORDER_AMOUNT_MISMATCH', 'orders', reference, 'total_amount_cents');
    }
    if (item && !ORDER_STATUSES.has(item.status)) collector.add('INVALID_STATUS', 'orders', reference, 'status');
    if (item && !PAYMENT_STATUSES.has(item.payment_status)) collector.add('INVALID_STATUS', 'orders', reference, 'payment_status');
    ['created_at', 'updated_at', 'paid_at', 'shipped_at'].forEach((field) => validateTimestamp(collector, item && item[field], 'orders', reference, field, { required: field === 'created_at' }));
  });

  array(source.payment_logs).forEach((item, index) => {
    const reference = item && item.id !== undefined ? item.id : index;
    validateRequiredFields(collector, item, ['id', 'status', 'amount_cents', 'created_at'], 'payment_logs', reference);
    const relatedOrder = item && (orderIds.has(item.order_id) || orderNumbers.has(item.order_no));
    const safelyUnlinked = item && ['notify_rejected', 'order_not_found'].includes(item.status);
    if (!relatedOrder && !safelyUnlinked) collector.add('MISSING_REFERENCE', 'payment_logs', reference, 'order_id');
    validateInteger(collector, item && item.amount_cents, 'payment_logs', reference, 'amount_cents');
    validateTimestamp(collector, item && item.created_at, 'payment_logs', reference, 'created_at', { required: true });
    if (relatedOrder) {
      const order = orders.find((candidate) => candidate.id === item.order_id || candidate.order_no === item.order_no);
      const provider = item.method === 'wechat_mock' ? 'wechat_mock' : 'wechat';
      const groupKey = `${provider}:${order.order_no}`;
      if (item.transaction_id) {
        if (!paymentGroupsByTransaction.has(item.transaction_id)) paymentGroupsByTransaction.set(item.transaction_id, new Set());
        paymentGroupsByTransaction.get(item.transaction_id).add(groupKey);
      }
    }
  });
  paymentGroupsByTransaction.forEach((groups, transactionId) => {
    if (groups.size > 1) {
      collector.add('PAYMENT_IDEMPOTENCY_CONFLICT', 'payment_logs', transactionId, 'transaction_id', { count: groups.size });
    }
  });

  const groupedLogs = new Map();
  array(source.payment_logs).forEach((item) => {
    const order = orders.find((candidate) => candidate.id === item.order_id || candidate.order_no === item.order_no);
    if (!order) return;
    const provider = item.method === 'wechat_mock' ? 'wechat_mock' : 'wechat';
    const key = `${provider}:${order.order_no}`;
    if (!groupedLogs.has(key)) groupedLogs.set(key, []);
    groupedLogs.get(key).push(item);
  });
  groupedLogs.forEach((logs, key) => {
    const amounts = new Set(logs.map((item) => Number(item.amount_cents)).filter(Number.isFinite));
    const transactionIds = new Set(logs.map((item) => String(item.transaction_id || '')).filter(Boolean));
    if (amounts.size > 1 || transactionIds.size > 1) {
      collector.add(
        'PAYMENT_IDEMPOTENCY_CONFLICT',
        'payment_transactions',
        key,
        amounts.size > 1 ? 'amount_cents' : 'transaction_id'
      );
    }
  });
}

function validateSupportingData(source, collector) {
  const qrIds = new Set(array(source.qr_codes).map((item) => item && item.id).filter(Boolean));
  detectDuplicates(collector, array(source.admins), 'id', 'admins', 'DUPLICATE_BUSINESS_ID');
  detectDuplicates(collector, array(source.admins), 'username', 'admins', 'DUPLICATE_IDENTITY');
  detectDuplicates(collector, array(source.batches), 'id', 'batches', 'DUPLICATE_BUSINESS_ID');
  detectDuplicates(collector, array(source.quality_check_logs), 'id', 'quality_check_logs', 'DUPLICATE_BUSINESS_ID');
  array(source.admins).forEach((item, index) => {
    const reference = item && item.id !== undefined ? item.id : index;
    validateRequiredFields(collector, item, ['id', 'username', 'password', 'role'], 'admins', reference);
    if (item && (typeof item.password !== 'string' || !item.password.startsWith('scrypt$'))) {
      collector.add('UNSUPPORTED_LEGACY_SHAPE', 'admins', reference, 'password');
    }
    if (item && !['admin', 'qc'].includes(item.role)) collector.add('INVALID_STATUS', 'admins', reference, 'role');
  });
  array(source.batches).forEach((item, index) => {
    const reference = item && item.id !== undefined ? item.id : index;
    validateRequiredFields(collector, item, ['id', 'name', 'created_at'], 'batches', reference);
    validateTimestamp(collector, item && item.created_at, 'batches', reference, 'created_at', { required: true });
  });
  array(source.quality_check_logs).forEach((item, index) => {
    const reference = item && item.id !== undefined ? item.id : index;
    if (item && item.qr_id && !qrIds.has(item.qr_id)) collector.add('MISSING_REFERENCE', 'quality_check_logs', reference, 'qr_id');
    validateTimestamp(collector, item && item.checked_at, 'quality_check_logs', reference, 'checked_at', { required: true });
    if (item && !['pass', 'bound', 'duplicate'].includes(item.result)) collector.add('INVALID_STATUS', 'quality_check_logs', reference, 'result');
  });
}

function validatePlanConservation(source, plan, qrSplits, collector) {
  if (plan.qr_codes.length !== array(source.qr_codes).length) {
    collector.add('COUNT_CONSERVATION_FAILED', 'qr_codes', 'all', null);
  }
  if (qrSplits.length !== array(source.qr_codes).length || qrSplits.some((item) => item.qr_codes !== 1)) {
    collector.add('COUNT_CONSERVATION_FAILED', 'qr_split', 'all', 'qr_codes');
  }
  const expected = qrSplits.reduce((total, item) => ({
    records: total.records + item.records,
    co_creations: total.co_creations + item.co_creations,
    comments: total.comments + item.comments,
    proofs: total.proofs + item.proofs,
    archives: total.archives + item.archives
  }), { records: 0, co_creations: 0, comments: 0, proofs: 0, archives: 0 });
  const actual = {
    records: plan.records.length,
    co_creations: plan.co_creations.length,
    comments: plan.co_creation_comments.length,
    proofs: plan.record_proofs.length,
    archives: plan.record_archives.length
  };
  Object.keys(expected).forEach((key) => {
    if (expected[key] !== actual[key]) collector.add('COUNT_CONSERVATION_FAILED', 'qr_split', 'all', key);
  });
  const entityExpected = {
    accounts: array(source.accounts).length,
    users: array(source.users).length,
    operators: array(source.admins).length,
    qr_batches: array(source.batches).length,
    products: array(source.products).length,
    product_images: array(source.products).reduce((count, item) => count + array(item && item.images).length, 0),
    product_scene_tags: array(source.products).reduce((count, item) => count + array(item && item.scene_tags).length, 0),
    orders: array(source.orders).length,
    payment_log_dispositions: array(source.payment_logs).length,
    archived_legacy_objects: array(source.content_pages).length + array(source.banners).length,
    miniapp_content: object(source.miniapp_content) ? 1 : 0
  };
  const entityActual = {
    accounts: plan.accounts.length,
    users: plan.users.length,
    operators: plan.operators.length,
    qr_batches: plan.qr_batches.length,
    products: plan.products.length,
    product_images: plan.product_images.length,
    product_scene_tags: plan.product_scene_tags.length,
    orders: plan.orders.length,
    payment_log_dispositions: plan.payment_events.length + plan.audit_events.length,
    archived_legacy_objects: plan.archived_legacy.reduce((count, item) => count + Number(item.count || 0), 0),
    miniapp_content: plan.miniapp_content.length
  };
  Object.keys(entityExpected).forEach((key) => {
    if (entityExpected[key] !== entityActual[key]) {
      collector.add('COUNT_CONSERVATION_FAILED', 'source_disposition', 'all', key);
    }
  });
  const qrPassed = Object.keys(expected).every((key) => expected[key] === actual[key]);
  const entityPassed = Object.keys(entityExpected).every((key) => entityExpected[key] === entityActual[key]);
  return {
    expected,
    actual,
    entities: { expected: entityExpected, actual: entityActual, passed: entityPassed },
    passed: qrPassed && entityPassed
  };
}

function validateCommentSourcePositions(source, plan, collector) {
  const rowsByCreation = new Map();
  array(plan.co_creation_comments).forEach((comment, index) => {
    const reference = comment && (comment.legacy_comment_id ?? index);
    if (!comment || !Number.isSafeInteger(comment.source_position) || comment.source_position < 0) {
      collector.add(
        'INVALID_SOURCE_POSITION',
        'co_creation_comments',
        reference,
        'source_position'
      );
      return;
    }
    const rows = rowsByCreation.get(comment.co_creation_id) || [];
    if (rows.some((item) => item.source_position === comment.source_position)) {
      collector.add(
        'DUPLICATE_SOURCE_POSITION',
        'co_creation_comments',
        reference,
        'source_position'
      );
    }
    rows.push(comment);
    rowsByCreation.set(comment.co_creation_id, rows);
  });

  array(source.qr_codes).forEach((qr, qrIndex) => {
    const sourceComments = array(qr && qr.co_creation_comments);
    if (sourceComments.length === 0) return;
    const qrReference = qr && qr.id !== undefined ? qr.id : qrIndex;
    const coCreationId = deterministicUuid(`co-creation:${String(qrReference)}`);
    const plannedComments = rowsByCreation.get(coCreationId) || [];
    if (plannedComments.length !== sourceComments.length) {
      collector.add(
        'SOURCE_POSITION_MISMATCH',
        'co_creation_comments',
        qrReference,
        'source_position'
      );
      return;
    }
    sourceComments.forEach((sourceComment, sourcePosition) => {
      const plannedComment = plannedComments.find((item) => (
        item.source_position === sourcePosition
      ));
      const expectedLegacyId = String(sourceComment && sourceComment.id !== undefined
        ? sourceComment.id
        : sourcePosition);
      if (!plannedComment || plannedComment.legacy_comment_id !== expectedLegacyId) {
        collector.add(
          'SOURCE_POSITION_MISMATCH',
          'co_creation_comments',
          `${qrReference}:${sourcePosition}`,
          'source_position'
        );
      }
    });
  });
}

function validateImportSource(source, { plan, qrSplits }) {
  const collector = createCollector();
  validateStructure(source, collector);
  if (object(source)) {
    validateAccountsAndUsers(source, collector);
    validateQrData(source, collector);
    validateCommerce(source, collector);
    validateSupportingData(source, collector);
  }
  validateCommentSourcePositions(object(source) ? source : {}, plan, collector);
  const conservation = validatePlanConservation(object(source) ? source : {}, plan, qrSplits, collector);
  return { anomalies: collector.anomalies, conservation };
}

module.exports = {
  referenceHash,
  validateImportSource
};
