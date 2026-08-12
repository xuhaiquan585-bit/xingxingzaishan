'use strict';

const crypto = require('node:crypto');

const LEGACY_TIMESTAMP = '1970-01-01T00:00:00.000Z';

const ROOT_FIELDS = [
  'meta', 'accounts', 'users', 'qr_codes', 'admins', 'quality_check_logs', 'batches',
  'products', 'content_pages', 'banners', 'orders', 'payment_logs', 'miniapp_content'
];

const ENTITY_FIELDS = {
  meta: ['schema_version', 'next_user_id', 'next_account_id', 'accounts_migration_version', 'accounts_migrated_at'],
  accounts: ['id', 'status', 'display_name', 'avatar_url', 'created_from', 'created_at', 'updated_at'],
  users: ['id', 'phone', 'openid', 'unionid', 'source', 'created_at', 'updated_at', 'account_id'],
  admins: ['id', 'username', 'password', 'role', 'name', 'enabled', 'created_at', 'updated_at'],
  batches: ['id', 'name', 'brand_name', 'note', 'brand_disclosure_text', 'brand_disclosure_default', 'created_at', 'updated_at', 'created_by'],
  quality_check_logs: ['id', 'qr_id', 'checked_at', 'checked_by', 'result'],
  products: [
    'id', 'title', 'subtitle', 'cover_image', 'images', 'price_text', 'price_cents', 'description',
    'status', 'product_type', 'sticker_count', 'stock', 'is_customizable', 'shipping_note',
    'after_sale_note', 'buy_type', 'buy_url', 'scene_tags', 'sort_order', 'created_at', 'updated_at'
  ],
  orders: [
    'id', 'order_no', 'openid', 'phone', 'account_id', 'product_id', 'product_snapshot', 'quantity',
    'unit_price_cents', 'total_amount_cents', 'status', 'payment_status', 'payment_method',
    'payment_mock', 'wechat_transaction_id', 'paid_at', 'receiver_name', 'receiver_phone',
    'region', 'address', 'remark', 'express_company', 'express_no', 'shipped_at', 'refund_status',
    'admin_note', 'created_at', 'updated_at'
  ],
  payment_logs: ['id', 'order_id', 'order_no', 'account_id', 'openid', 'method', 'status', 'amount_cents', 'transaction_id', 'raw', 'error', 'created_at'],
  qr_codes: [
    'id', 'issue_status', 'activation_status', 'hidden', 'batch_id', 'print_batch_id', 'quality_check',
    'content', 'image_url', 'image_object_key', 'image_sha256', 'phone', 'account_id', 'activated_at',
    'record_created_at', 'record_updated_at',
    'blockchain_hash', 'chain_provider', 'chain_status', 'chain_operation_id', 'manifest_object_key',
    'manifest_hash', 'chain_tx_hash', 'chain_block_height', 'chain_record_id', 'chain_certificate_url',
    'chain_certificate_object_key', 'chain_certificate_object_url', 'chain_confirmed_at',
    'chain_callback_received_at', 'chain_last_error', 'chain_retry_count', 'chain_proof_id',
    'chain_created_at', 'chain_updated_at', 'legacy_manifest_object_key',
    'archive_index_object_key', 'archive_status', 'archive_last_error', 'archive_updated_at',
    'archive_created_at',
    'co_creation_enabled', 'co_creation_owner_phone', 'co_creation_owner_account_id',
    'co_creation_comments', 'co_creation_started_at', 'show_brand_disclosure',
    'brand_disclosure_text_snapshot', 'qr_image_url', 'qr_access_token', 'created_at', 'updated_at'
  ],
  quality_check: ['checked', 'checked_at', 'checked_by', 'result'],
  co_creation_comments: ['id', 'phone', 'account_id', 'author_name', 'content', 'status', 'created_at', 'deleted_at'],
  miniapp_content: [
    'home_title', 'home_subtitle', 'logo_image', 'home_banner_image', 'home_slides', 'scene_cards',
    'project_title', 'project_body', 'brand_story_title', 'brand_story_body', 'consult_label',
    'consult_url', 'share_title', 'share_description', 'updated_at', 'updated_by'
  ],
  home_slides: ['image', 'title', 'subtitle', 'button_text', 'action_type', 'scene_key'],
  scene_cards: ['key', 'label', 'title', 'description', 'image', 'button_text']
};

function deterministicUuid(value) {
  const hex = crypto.createHash('sha256').update(String(value)).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function timestamp(value, fallback = LEGACY_TIMESTAMP) {
  return value || fallback;
}

function textOrNull(value) {
  const valueText = String(value || '').trim();
  return valueText || null;
}

function isSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function createLegacyAccountResolver(source) {
  const accountIds = new Set(array(source && source.accounts)
    .map((item) => item && item.id)
    .filter(Boolean));
  const accountIdsByPhone = new Map();

  array(source && source.users).forEach((user) => {
    const phone = String((user && user.phone) || '').trim();
    const accountId = user && user.account_id;
    if (!phone || !accountId || !accountIds.has(accountId)) return;
    const candidates = accountIdsByPhone.get(phone) || new Set();
    candidates.add(accountId);
    accountIdsByPhone.set(phone, candidates);
  });

  return (accountIdValue, phoneValue) => {
    const explicitAccountId = textOrNull(accountIdValue);
    if (explicitAccountId) {
      const valid = accountIds.has(explicitAccountId);
      return {
        accountId: explicitAccountId,
        valid,
        recovered: false,
        resolution: valid ? 'explicit' : 'invalid_explicit'
      };
    }

    const phone = String(phoneValue || '').trim();
    const candidates = phone ? accountIdsByPhone.get(phone) : null;
    if (candidates && candidates.size === 1) {
      return {
        accountId: [...candidates][0],
        valid: true,
        recovered: true,
        resolution: 'unique_legacy_phone'
      };
    }
    return {
      accountId: null,
      valid: false,
      recovered: false,
      resolution: candidates && candidates.size > 1
        ? 'ambiguous_legacy_phone'
        : (phone ? 'unresolved_legacy_phone' : 'missing')
    };
  };
}

function hasAny(item, fields) {
  return fields.some((field) => item[field] !== undefined && item[field] !== null && item[field] !== '' && item[field] !== false);
}

function mapSourceToPlan(source) {
  const plan = {
    accounts: [], users: [], operators: [], qr_batches: [], qr_codes: [], records: [],
    co_creations: [], co_creation_comments: [], quality_check_logs: [], products: [],
    product_images: [], product_scene_tags: [], orders: [], payment_transactions: [],
    payment_events: [], record_proofs: [], proof_attempts: [], record_archives: [],
    miniapp_content: [], audit_events: [], archived_legacy: []
  };
  const qrSplits = [];
  const resolveLegacyAccount = createLegacyAccountResolver(source);

  array(source.accounts).forEach((item) => {
    plan.accounts.push({
      id: item.id,
      status: item.status,
      display_name: item.display_name || '',
      avatar_url: item.avatar_url || '',
      created_from: item.created_from,
      created_at: timestamp(item.created_at),
      updated_at: timestamp(item.updated_at, timestamp(item.created_at))
    });
  });

  array(source.users).forEach((item) => {
    const numericId = Number(item.id);
    plan.users.push({
      id: Number.isSafeInteger(numericId) && numericId > 0 ? numericId : null,
      legacy_id: Number.isSafeInteger(numericId) && numericId > 0 ? null : String(item.id || ''),
      account_id: item.account_id,
      phone: textOrNull(item.phone),
      openid: textOrNull(item.openid),
      unionid: textOrNull(item.unionid),
      source: item.source,
      created_at: timestamp(item.created_at),
      updated_at: timestamp(item.updated_at, timestamp(item.created_at))
    });
  });

  array(source.admins).forEach((item) => {
    const numericId = Number(item.id);
    plan.operators.push({
      id: Number.isSafeInteger(numericId) && numericId > 0 ? numericId : null,
      legacy_id: Number.isSafeInteger(numericId) && numericId > 0 ? null : String(item.id || ''),
      username: item.username,
      password_hash: item.password,
      role: item.role,
      name: item.name || item.username || '',
      enabled: item.enabled !== false,
      created_at: timestamp(item.created_at),
      updated_at: timestamp(item.updated_at, timestamp(item.created_at))
    });
  });

  array(source.batches).forEach((item) => {
    plan.qr_batches.push({
      id: item.id,
      name: item.name,
      brand_name: item.brand_name || '',
      note: item.note || '',
      disclosure_text: item.brand_disclosure_text || '',
      show_brand_disclosure_default: item.brand_disclosure_default === true,
      created_by_operator_id: null,
      created_by_snapshot: item.created_by || '',
      created_at: timestamp(item.created_at),
      updated_at: timestamp(item.updated_at, timestamp(item.created_at))
    });
  });

  const rootQualityChecks = new Set(array(source.quality_check_logs).map((item) => (
    `${String(item.qr_id || '')}|${String(item.checked_at || '')}|${String(item.result || '')}`
  )));

  array(source.qr_codes).forEach((item) => {
    const createdAt = timestamp(item.created_at);
    const updatedAt = timestamp(item.updated_at, item.activated_at || item.co_creation_started_at || createdAt);
    const recordPresent = item.activation_status !== 'unactivated' || hasAny(item, [
      'content', 'image_url', 'image_object_key', 'image_sha256', 'phone', 'account_id', 'activated_at'
    ]);
    const coCreationPresent = item.co_creation_enabled === true || item.activation_status === 'co_creating' || hasAny(item, [
      'co_creation_owner_phone', 'co_creation_owner_account_id', 'co_creation_started_at'
    ]) || array(item.co_creation_comments).length > 0;
    const proofPresent = hasAny(item, [
      'blockchain_hash', 'chain_operation_id', 'manifest_object_key', 'manifest_hash', 'chain_tx_hash',
      'chain_block_height', 'chain_record_id', 'chain_certificate_url', 'chain_certificate_object_key',
      'chain_certificate_object_url', 'chain_confirmed_at', 'chain_callback_received_at', 'chain_last_error'
    ]) || (item.chain_status && item.chain_status !== 'not_started') || Number(item.chain_retry_count || 0) > 0;
    const archivePresent = hasAny(item, ['legacy_manifest_object_key', 'archive_index_object_key', 'archive_last_error', 'archive_updated_at'])
      || (item.archive_status && item.archive_status !== 'not_started');
    const recordAccount = resolveLegacyAccount(item.account_id, item.phone);

    plan.qr_codes.push({
      id: item.id,
      issue_status: item.issue_status,
      lifecycle_status: item.activation_status,
      hidden: item.hidden === true,
      batch_id: textOrNull(item.batch_id),
      print_batch_id: textOrNull(item.print_batch_id),
      qr_image_url_snapshot: item.qr_image_url || '',
      access_token: textOrNull(item.qr_access_token),
      created_at: createdAt,
      updated_at: updatedAt
    });

    if (item.quality_check && item.quality_check.checked === true) {
      const qualityKey = `${String(item.id || '')}|${String(item.quality_check.checked_at || '')}|${String(item.quality_check.result || '')}`;
      if (!rootQualityChecks.has(qualityKey)) {
        plan.quality_check_logs.push({
          id: null,
          legacy_id: `embedded:${String(item.id || '')}`,
          qr_id: item.id,
          operator_id: null,
          checked_by_snapshot: item.quality_check.checked_by || '',
          result: item.quality_check.result,
          checked_at: timestamp(item.quality_check.checked_at, createdAt)
        });
      }
    }

    if (recordPresent) {
      plan.records.push({
        qr_id: item.id,
        account_id: recordAccount.accountId,
        content: item.content || '',
        image_url_snapshot: item.image_url || '',
        image_object_key: textOrNull(item.image_object_key),
        image_sha256: textOrNull(item.image_sha256),
        phone_snapshot: item.phone || '',
        sealed_at: item.activation_status === 'activated' ? item.activated_at : null,
        show_brand_disclosure: item.show_brand_disclosure === true,
        brand_disclosure_text_snapshot: item.brand_disclosure_text_snapshot || '',
        created_at:
          item.record_created_at || item.co_creation_started_at || item.activated_at || createdAt,
        updated_at: item.record_updated_at || updatedAt
      });
    }

    let coCreationId = null;
    if (coCreationPresent) {
      coCreationId = deterministicUuid(`co-creation:${item.id}`);
      const startedAt = timestamp(item.co_creation_started_at, createdAt);
      plan.co_creations.push({
        id: coCreationId,
        qr_id: item.id,
        owner_account_id: item.co_creation_owner_account_id,
        owner_phone_snapshot: item.co_creation_owner_phone || '',
        status: item.activation_status === 'activated' ? 'finalized' : 'active',
        started_at: startedAt,
        finalized_at: item.activation_status === 'activated' ? item.activated_at : null,
        created_at: startedAt,
        updated_at: updatedAt
      });
      const effectiveCommentAccounts = new Set();
      array(item.co_creation_comments).forEach((comment, commentIndex) => {
        const commentCreatedAt = timestamp(comment.created_at, startedAt);
        const commentAccount = resolveLegacyAccount(comment.account_id, comment.phone);
        const status = comment.status === 'deleted' ? 'deleted' : 'kept';
        const legacyDuplicate = status === 'kept'
          && commentAccount.accountId
          && effectiveCommentAccounts.has(commentAccount.accountId);
        if (status === 'kept' && commentAccount.accountId) {
          effectiveCommentAccounts.add(commentAccount.accountId);
        }
        plan.co_creation_comments.push({
          id: deterministicUuid(`co-comment:${item.id}:${String(comment.id ?? commentIndex)}`),
          co_creation_id: coCreationId,
          account_id: commentAccount.accountId,
          legacy_comment_id: String(comment.id ?? commentIndex),
          source_position: commentIndex,
          legacy_duplicate: legacyDuplicate,
          phone_snapshot: comment.phone || '',
          author_name: comment.author_name || '',
          content: comment.content || '',
          status,
          created_at: commentCreatedAt,
          deleted_at: comment.status === 'deleted' ? timestamp(comment.deleted_at, commentCreatedAt) : null
        });
      });
    }

    if (proofPresent) {
      const proofId = item.chain_proof_id
        || deterministicUuid(`proof:${item.id}:${item.chain_provider || 'avata_wenchang'}`);
      const proofHash = item.manifest_hash || item.blockchain_hash || null;
      plan.record_proofs.push({
        id: proofId,
        record_qr_id: item.id,
        provider: item.chain_provider || 'avata_wenchang',
        status: item.chain_status || (item.manifest_hash || item.blockchain_hash ? 'confirmed' : 'not_started'),
        operation_id: textOrNull(item.chain_operation_id),
        manifest_object_key: textOrNull(item.manifest_object_key),
        manifest_hash: isSha256(proofHash) ? proofHash : null,
        legacy_hash_snapshot: proofHash && !isSha256(proofHash) ? String(proofHash) : null,
        transaction_hash: textOrNull(item.chain_tx_hash),
        block_height: item.chain_block_height === null || item.chain_block_height === undefined ? null : Number(item.chain_block_height),
        provider_record_id: textOrNull(item.chain_record_id),
        provider_certificate_url: textOrNull(item.chain_certificate_url),
        certificate_object_key: textOrNull(item.chain_certificate_object_key),
        certificate_object_url_snapshot: textOrNull(item.chain_certificate_object_url),
        confirmed_at: item.chain_confirmed_at || null,
        callback_received_at: item.chain_callback_received_at || null,
        retry_count: Number(item.chain_retry_count || 0),
        last_error: item.chain_last_error || '',
        created_at: timestamp(item.chain_created_at, createdAt),
        updated_at: timestamp(item.chain_updated_at, updatedAt)
      });
    }

    if (archivePresent) {
      plan.record_archives.push({
        record_qr_id: item.id,
        manifest_object_key: textOrNull(item.manifest_object_key),
        legacy_manifest_object_key: textOrNull(item.legacy_manifest_object_key),
        index_object_key: textOrNull(item.archive_index_object_key),
        status: item.archive_status || 'not_started',
        last_error: item.archive_last_error || '',
        created_at: timestamp(item.archive_created_at, createdAt),
        updated_at: timestamp(item.archive_updated_at, updatedAt)
      });
    }

    qrSplits.push({
      source_qr_hash: crypto.createHash('sha256').update(`qr:${String(item.id)}`).digest('hex').slice(0, 12),
      qr_codes: 1,
      records: recordPresent ? 1 : 0,
      co_creations: coCreationPresent ? 1 : 0,
      comments: array(item.co_creation_comments).length,
      proofs: proofPresent ? 1 : 0,
      archives: archivePresent ? 1 : 0
    });
  });

  array(source.quality_check_logs).forEach((item) => {
    const numericId = Number(item.id);
    plan.quality_check_logs.push({
      id: Number.isSafeInteger(numericId) && numericId > 0 ? numericId : null,
      legacy_id: Number.isSafeInteger(numericId) && numericId > 0 ? null : String(item.id || ''),
      qr_id: item.qr_id,
      operator_id: null,
      checked_by_snapshot: item.checked_by || '',
      result: item.result,
      checked_at: timestamp(item.checked_at)
    });
  });

  array(source.products).forEach((item) => {
    const createdAt = timestamp(item.created_at);
    plan.products.push({
      id: item.id, title: item.title, subtitle: item.subtitle || '', cover_image_url: item.cover_image || '',
      cover_image_object_key: null, price_text: item.price_text || '', price_cents: Number(item.price_cents),
      description: item.description || '', status: item.status, product_type: item.product_type,
      sticker_count: Number(item.sticker_count), stock: Number(item.stock), is_customizable: item.is_customizable === true,
      shipping_note: item.shipping_note || '', after_sale_note: item.after_sale_note || '', buy_type: item.buy_type,
      buy_url: item.buy_url || '', sort_order: Number(item.sort_order || 0), created_at: createdAt,
      updated_at: timestamp(item.updated_at, createdAt)
    });
    array(item.images).forEach((image, imageIndex) => {
      plan.product_images.push({
        product_id: item.id,
        image_url: String(image || ''),
        image_object_key: null,
        sort_order: imageIndex,
        created_at: createdAt
      });
    });
    array(item.scene_tags).forEach((sceneKey) => {
      plan.product_scene_tags.push({
        product_id: item.id,
        scene_key: sceneKey,
        created_at: createdAt
      });
    });
  });

  array(source.orders).forEach((item) => {
    plan.orders.push({
      id: item.id, order_no: item.order_no, account_id: item.account_id, product_id: textOrNull(item.product_id),
      openid_snapshot: item.openid || '', phone_snapshot: item.phone || '', product_snapshot: item.product_snapshot || {},
      quantity: Number(item.quantity), unit_price_cents: Number(item.unit_price_cents),
      total_amount_cents: Number(item.total_amount_cents), status: item.status, payment_status: item.payment_status,
      payment_method: item.payment_method || '', payment_mock: item.payment_mock === true,
      provider_transaction_id: textOrNull(item.wechat_transaction_id), provider_transaction_snapshot: {},
      paid_at: item.paid_at || null, receiver_name: item.receiver_name || '', receiver_phone: item.receiver_phone || '',
      region: item.region || '', address: item.address || '', remark: item.remark || '',
      express_company: item.express_company || '', express_no: item.express_no || '', shipped_at: item.shipped_at || null,
      refund_status: item.refund_status || '', admin_note: item.admin_note || '', created_at: timestamp(item.created_at),
      updated_at: timestamp(item.updated_at, timestamp(item.created_at))
    });
  });

  const ordersById = new Map(array(source.orders).map((item) => [String(item.id || ''), item]));
  const ordersByNumber = new Map(array(source.orders).map((item) => [String(item.order_no || ''), item]));
  const paymentTransactions = new Map();
  const statusPriority = { pending: 0, failed: 1, paid: 2, refunded: 3 };

  array(source.payment_logs).forEach((item, index) => {
    const createdAt = timestamp(item.created_at);
    const provider = item.method === 'wechat_mock' ? 'wechat_mock' : 'wechat';
    const status = ['paid', 'failed', 'refunded'].includes(item.status) ? item.status : 'pending';
    const rawHash = item.raw === undefined
      ? null
      : crypto.createHash('sha256').update(JSON.stringify(item.raw)).digest('hex');
    const order = ordersById.get(String(item.order_id || '')) || ordersByNumber.get(String(item.order_no || ''));

    if (!order) {
      plan.audit_events.push({
        actor_type: 'external',
        actor_reference_hash: null,
        action: 'legacy_payment_callback_unlinked',
        entity_type: 'payment_callback',
        entity_id: null,
        entity_reference_hash: crypto.createHash('sha256').update(`payment-log:${String(item.id || index)}`).digest('hex'),
        request_method: 'POST',
        request_path: '/api/payment/wechat/notify',
        result_status: 'denied',
        duration_ms: null,
        metadata: { status: item.status || 'unknown', payload_sha256: rawHash },
        created_at: createdAt
      });
      return;
    }

    const merchantOrderNo = order.order_no;
    const transactionKey = `${provider}:${merchantOrderNo}`;
    const transactionId = deterministicUuid(`payment:${transactionKey}`);
    if (!paymentTransactions.has(transactionKey)) {
      const transaction = {
        id: transactionId,
        order_id: order.id,
        provider,
        merchant_order_no: merchantOrderNo,
        provider_transaction_id: textOrNull(item.transaction_id),
        amount_cents: Number(item.amount_cents || order.total_amount_cents || 0),
        status,
        paid_at: status === 'paid' ? createdAt : null,
        created_at: createdAt,
        updated_at: createdAt
      };
      paymentTransactions.set(transactionKey, transaction);
      plan.payment_transactions.push(transaction);
    } else {
      const transaction = paymentTransactions.get(transactionKey);
      if (statusPriority[status] > statusPriority[transaction.status]) transaction.status = status;
      if (!transaction.provider_transaction_id && item.transaction_id) transaction.provider_transaction_id = item.transaction_id;
      if (status === 'paid' && !transaction.paid_at) transaction.paid_at = createdAt;
      if (createdAt > transaction.updated_at) transaction.updated_at = createdAt;
    }

    plan.payment_events.push({
      legacy_id: String(item.id || ''),
      payment_transaction_id: transactionId,
      order_id: order.id,
      event_type: item.method || 'legacy_payment',
      status: item.status || 'unknown',
      payload_sha256: rawHash,
      sanitized_metadata: {
        raw_present: item.raw !== undefined,
        error_present: Boolean(item.error),
        payment_mock: item.method === 'wechat_mock'
      },
      created_at: createdAt
    });
  });

  if (source.miniapp_content && typeof source.miniapp_content === 'object' && !Array.isArray(source.miniapp_content)) {
    const item = source.miniapp_content;
    plan.miniapp_content.push({
      id: 1,
      home_title: item.home_title || '', home_subtitle: item.home_subtitle || '', logo_image: item.logo_image || '',
      home_banner_image: item.home_banner_image || '', home_slides: array(item.home_slides), scene_cards: array(item.scene_cards),
      project_title: item.project_title || '', project_body: item.project_body || '',
      brand_story_title: item.brand_story_title || '', brand_story_body: item.brand_story_body || '',
      consult_label: item.consult_label || '', consult_url: item.consult_url || '', share_title: item.share_title || '',
      share_description: item.share_description || '', updated_by_operator_id: null,
      updated_by_snapshot: item.updated_by || '', updated_at: timestamp(item.updated_at)
    });
  }

  if (array(source.content_pages).length > 0) plan.archived_legacy.push({ source: 'content_pages', count: source.content_pages.length });
  if (array(source.banners).length > 0) plan.archived_legacy.push({ source: 'banners', count: source.banners.length });

  return { plan, qrSplits };
}

module.exports = {
  createLegacyAccountResolver,
  ENTITY_FIELDS,
  isSha256,
  LEGACY_TIMESTAMP,
  ROOT_FIELDS,
  deterministicUuid,
  mapSourceToPlan
};
