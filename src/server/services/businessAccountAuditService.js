const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CATEGORY_NAMES = [
  'already_consistent',
  'existing_account_mismatch',
  'safe_match',
  'duplicate_identity',
  'missing_identity',
  'user_missing_account',
  'account_missing',
  'no_match'
];

function resolveDatabasePath() {
  if (process.env.DB_FILE) {
    return path.resolve(process.env.DB_FILE);
  }
  const dataDir = process.env.DB_DIR
    ? path.resolve(process.env.DB_DIR)
    : path.join(__dirname, '..', 'data');
  return path.join(dataDir, 'db.json');
}

function loadJsonReadOnly(filePath = resolveDatabasePath()) {
  if (!fs.existsSync(filePath)) {
    const error = new Error('BUSINESS_ACCOUNT_AUDIT_DB_NOT_FOUND');
    error.code = 'BUSINESS_ACCOUNT_AUDIT_DB_NOT_FOUND';
    throw error;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function normalizeIdentity(value) {
  return String(value || '').trim();
}

function normalizePhone(value) {
  return normalizeIdentity(value);
}

function normalizeOpenid(value) {
  return normalizeIdentity(value);
}

function maskPhone(phone) {
  const value = normalizePhone(phone);
  if (!/^1\d{10}$/.test(value)) return '';
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}

function maskOpenid(openid) {
  const value = normalizeOpenid(openid);
  if (!value) return '';
  if (value.length <= 10) return `${value.slice(0, 2)}***`;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function hashHint(value) {
  const normalized = normalizeIdentity(value);
  if (!normalized) return '';
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 10);
}

function maskAccountId(accountId) {
  const value = normalizeIdentity(accountId);
  if (!value) return '';
  return {
    tail: value.slice(-4),
    hash_prefix: hashHint(value)
  };
}

function getUsers(db) {
  return Array.isArray(db && db.users) ? db.users : [];
}

function getAccounts(db) {
  return Array.isArray(db && db.accounts) ? db.accounts : [];
}

function getQRCodes(db) {
  return Array.isArray(db && db.qr_codes) ? db.qr_codes : [];
}

function getOrders(db) {
  return Array.isArray(db && db.orders) ? db.orders : [];
}

function accountExists(db, accountId) {
  const target = normalizeIdentity(accountId);
  return !!target && getAccounts(db).some((item) => normalizeIdentity(item && item.id) === target);
}

function findUsersByIdentity(db, identityType, value) {
  const target = identityType === 'phone' ? normalizePhone(value) : normalizeOpenid(value);
  if (!target) return [];
  return getUsers(db).filter((user) => {
    const candidate = identityType === 'phone'
      ? normalizePhone(user && user.phone)
      : normalizeOpenid(user && user.openid);
    return candidate === target;
  });
}

function identityMask(identityType, value) {
  return identityType === 'phone' ? maskPhone(value) : maskOpenid(value);
}

function buildDetail({ dataType, dataId, identityType, identityValue, existingAccountId, category, matches }) {
  const detail = {
    data_type: dataType,
    data_id: normalizeIdentity(dataId),
    category,
    identity_type: identityType,
    identity_mask: identityMask(identityType, identityValue),
    candidate_count: matches.length
  };

  if (category === 'existing_account_mismatch') {
    detail.existing_account = maskAccountId(existingAccountId);
    if (matches.length === 1 && matches[0] && matches[0].account_id) {
      detail.mapped_account = maskAccountId(matches[0].account_id);
    }
  }

  return detail;
}

function classifyBusinessItem(db, { dataType, dataId, identityType, identityValue, existingAccountId }) {
  const normalizedExistingAccountId = normalizeIdentity(existingAccountId);
  const normalizedIdentity = identityType === 'phone' ? normalizePhone(identityValue) : normalizeOpenid(identityValue);
  const matches = normalizedIdentity ? findUsersByIdentity(db, identityType, identityValue) : [];

  let category;
  if (normalizedExistingAccountId) {
    category = matches.length === 1
      && normalizeIdentity(matches[0].account_id) === normalizedExistingAccountId
      && accountExists(db, normalizedExistingAccountId)
      ? 'already_consistent'
      : 'existing_account_mismatch';
  } else if (!normalizedIdentity) {
    category = 'missing_identity';
  } else if (matches.length > 1) {
    category = 'duplicate_identity';
  } else if (matches.length === 0) {
    category = 'no_match';
  } else if (!normalizeIdentity(matches[0].account_id)) {
    category = 'user_missing_account';
  } else if (!accountExists(db, matches[0].account_id)) {
    category = 'account_missing';
  } else {
    category = 'safe_match';
  }

  return buildDetail({
    dataType,
    dataId,
    identityType,
    identityValue,
    existingAccountId: normalizedExistingAccountId,
    category,
    matches
  });
}

function isSavedRecord(qrCode) {
  return qrCode && qrCode.activation_status === 'activated';
}

function isCoCreationOwner(qrCode) {
  return !!(
    qrCode
    && (
      qrCode.co_creation_enabled === true
      || normalizePhone(qrCode.co_creation_owner_phone)
      || qrCode.activation_status === 'co_creating'
    )
  );
}

function isIgnoredComment(comment) {
  if (!comment) return true;
  const status = normalizeIdentity(comment.status).toLowerCase();
  return !!comment.deleted_at || ['deleted', 'removed', 'withdrawn'].includes(status);
}

function makeInitialCounts() {
  return CATEGORY_NAMES.reduce((acc, name) => {
    acc[name] = 0;
    return acc;
  }, {});
}

function summarizeDetails(details) {
  return details.reduce((acc, item) => {
    acc[item.category] = (acc[item.category] || 0) + 1;
    return acc;
  }, makeInitialCounts());
}

function blockedReasonsFromCounts(counts) {
  return [
    'existing_account_mismatch',
    'duplicate_identity',
    'missing_identity',
    'user_missing_account',
    'account_missing',
    'no_match'
  ].filter((name) => Number(counts[name] || 0) > 0);
}

function auditBusinessAccountsFromDb(inputDb, { dbPath = resolveDatabasePath(), defaultLocal = !process.env.DB_FILE } = {}) {
  const db = inputDb && typeof inputDb === 'object' ? inputDb : {};
  const qrCodes = getQRCodes(db);
  const orders = getOrders(db);
  const details = [];
  let ignoredDeletedComments = 0;

  qrCodes.filter(isSavedRecord).forEach((qrCode) => {
    details.push(classifyBusinessItem(db, {
      dataType: 'record',
      dataId: qrCode.id || qrCode.qr_access_token || '',
      identityType: 'phone',
      identityValue: qrCode.phone,
      existingAccountId: qrCode.account_id
    }));
  });

  qrCodes.filter(isCoCreationOwner).forEach((qrCode) => {
    details.push(classifyBusinessItem(db, {
      dataType: 'co_creation_owner',
      dataId: qrCode.id || qrCode.qr_access_token || '',
      identityType: 'phone',
      identityValue: qrCode.co_creation_owner_phone,
      existingAccountId: qrCode.co_creation_owner_account_id
    }));
  });

  qrCodes.forEach((qrCode) => {
    const comments = Array.isArray(qrCode.co_creation_comments) ? qrCode.co_creation_comments : [];
    comments.forEach((comment, index) => {
      if (isIgnoredComment(comment)) {
        ignoredDeletedComments += 1;
        return;
      }
      details.push(classifyBusinessItem(db, {
        dataType: 'co_creation_comment',
        dataId: `${qrCode.id || qrCode.qr_access_token || 'qr'}:comment:${comment.id || index + 1}`,
        identityType: 'phone',
        identityValue: comment.phone,
        existingAccountId: comment.account_id
      }));
    });
  });

  orders.forEach((order) => {
    details.push(classifyBusinessItem(db, {
      dataType: 'order',
      dataId: order.id || order.order_no || '',
      identityType: 'openid',
      identityValue: order.openid,
      existingAccountId: order.account_id
    }));
  });

  const categoryCounts = summarizeDetails(details);
  const blockedReasons = blockedReasonsFromCounts(categoryCounts);

  return {
    database: {
      path: path.resolve(dbPath),
      default_local: defaultLocal === true,
      read_only: true
    },
    can_apply: blockedReasons.length === 0,
    blocked_reasons: blockedReasons,
    records_total: details.filter((item) => item.data_type === 'record').length,
    orders_total: details.filter((item) => item.data_type === 'order').length,
    co_creation_owners_total: details.filter((item) => item.data_type === 'co_creation_owner').length,
    co_creation_comments_total: details.filter((item) => item.data_type === 'co_creation_comment').length,
    ignored_deleted_comments: ignoredDeletedComments,
    category_counts: categoryCounts,
    details
  };
}

function auditBusinessAccounts({ dbFile = resolveDatabasePath() } = {}) {
  const dbPath = path.resolve(dbFile);
  const db = loadJsonReadOnly(dbPath);
  return auditBusinessAccountsFromDb(db, {
    dbPath,
    defaultLocal: !process.env.DB_FILE
  });
}

module.exports = {
  auditBusinessAccounts,
  auditBusinessAccountsFromDb,
  loadJsonReadOnly,
  maskPhone,
  maskOpenid,
  maskAccountId
};
