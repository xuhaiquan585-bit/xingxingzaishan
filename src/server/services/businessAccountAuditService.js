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

const BLOCKING_CATEGORIES = [
  'existing_account_mismatch',
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

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function hashFile(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function loadJsonReadOnly(filePath = resolveDatabasePath()) {
  if (!fs.existsSync(filePath)) {
    const error = new Error('BUSINESS_ACCOUNT_AUDIT_DB_NOT_FOUND');
    error.code = 'BUSINESS_ACCOUNT_AUDIT_DB_NOT_FOUND';
    throw error;
  }
  return parseJsonBytes(fs.readFileSync(filePath));
}

function parseJsonBytes(bytes) {
  return JSON.parse(bytes.toString('utf-8').replace(/^\uFEFF/, ''));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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

function classifyBusinessItem(db, item) {
  const {
    dataType,
    dataId,
    identityType,
    identityValue,
    existingAccountId,
    planPath
  } = item;
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

  const detail = buildDetail({
    dataType,
    dataId,
    identityType,
    identityValue,
    existingAccountId: normalizedExistingAccountId,
    category,
    matches
  });

  const targetAccountId = category === 'safe_match' && matches.length === 1
    ? normalizeIdentity(matches[0].account_id)
    : '';
  const action = targetAccountId
    ? {
      data_type: dataType,
      category,
      path: planPath,
      account_id: targetAccountId
    }
    : null;

  return { detail, action };
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
  return BLOCKING_CATEGORIES.filter((name) => Number(counts[name] || 0) > 0);
}

function countActionsByType(actions, dataType) {
  return actions.filter((item) => item.data_type === dataType).length;
}

function objectCounts(db) {
  const qrCodes = getQRCodes(db);
  const orders = getOrders(db);
  return {
    users: getUsers(db).length,
    accounts: getAccounts(db).length,
    qr_codes: qrCodes.length,
    orders: orders.length,
    co_creation_comments: qrCodes.reduce((sum, qrCode) => (
      sum + (Array.isArray(qrCode.co_creation_comments) ? qrCode.co_creation_comments.length : 0)
    ), 0)
  };
}

function addClassifiedItem(db, details, actions, item) {
  const classified = classifyBusinessItem(db, item);
  details.push(classified.detail);
  if (classified.action) actions.push(classified.action);
}

function buildBusinessAccountAudit(inputDb, {
  dbPath = resolveDatabasePath(),
  defaultLocal = !process.env.DB_FILE,
  sourceHashBefore = null,
  applied = false,
  sourceHashAfter = null,
  objectCountsAfter = null
} = {}) {
  const db = inputDb && typeof inputDb === 'object' ? inputDb : {};
  const qrCodes = getQRCodes(db);
  const orders = getOrders(db);
  const details = [];
  const actions = [];
  let ignoredDeletedComments = 0;

  qrCodes.forEach((qrCode, qrIndex) => {
    if (!isSavedRecord(qrCode)) return;
    addClassifiedItem(db, details, actions, {
      dataType: 'record',
      dataId: qrCode.id || qrCode.qr_access_token || '',
      identityType: 'phone',
      identityValue: qrCode.phone,
      existingAccountId: qrCode.account_id,
      planPath: ['qr_codes', qrIndex, 'account_id']
    });
  });

  qrCodes.forEach((qrCode, qrIndex) => {
    if (!isCoCreationOwner(qrCode)) return;
    addClassifiedItem(db, details, actions, {
      dataType: 'co_creation_owner',
      dataId: qrCode.id || qrCode.qr_access_token || '',
      identityType: 'phone',
      identityValue: qrCode.co_creation_owner_phone,
      existingAccountId: qrCode.co_creation_owner_account_id,
      planPath: ['qr_codes', qrIndex, 'co_creation_owner_account_id']
    });
  });

  qrCodes.forEach((qrCode, qrIndex) => {
    const comments = Array.isArray(qrCode.co_creation_comments) ? qrCode.co_creation_comments : [];
    comments.forEach((comment, commentIndex) => {
      if (isIgnoredComment(comment)) {
        ignoredDeletedComments += 1;
        return;
      }
      addClassifiedItem(db, details, actions, {
        dataType: 'co_creation_comment',
        dataId: `${qrCode.id || qrCode.qr_access_token || 'qr'}:comment:${comment.id || commentIndex + 1}`,
        identityType: 'phone',
        identityValue: comment.phone,
        existingAccountId: comment.account_id,
        planPath: ['qr_codes', qrIndex, 'co_creation_comments', commentIndex, 'account_id']
      });
    });
  });

  orders.forEach((order, orderIndex) => {
    addClassifiedItem(db, details, actions, {
      dataType: 'order',
      dataId: order.id || order.order_no || '',
      identityType: 'openid',
      identityValue: order.openid,
      existingAccountId: order.account_id,
      planPath: ['orders', orderIndex, 'account_id']
    });
  });

  const categoryCounts = summarizeDetails(details);
  const blockedReasons = blockedReasonsFromCounts(categoryCounts);
  const countsBefore = objectCounts(db);
  const countsAfter = objectCountsAfter || countsBefore;

  const report = {
    database: {
      path: path.resolve(dbPath),
      default_local: defaultLocal === true,
      read_only: applied !== true
    },
    can_apply: blockedReasons.length === 0,
    blocked_reasons: blockedReasons,
    records_total: details.filter((item) => item.data_type === 'record').length,
    orders_total: details.filter((item) => item.data_type === 'order').length,
    co_creation_owners_total: details.filter((item) => item.data_type === 'co_creation_owner').length,
    co_creation_comments_total: details.filter((item) => item.data_type === 'co_creation_comment').length,
    records_to_update: countActionsByType(actions, 'record'),
    orders_to_update: countActionsByType(actions, 'order'),
    co_creation_owners_to_update: countActionsByType(actions, 'co_creation_owner'),
    co_creation_comments_to_update: countActionsByType(actions, 'co_creation_comment'),
    already_consistent: categoryCounts.already_consistent,
    ignored_deleted_comments: ignoredDeletedComments,
    category_counts: categoryCounts,
    applied: applied === true,
    source_hash_before: sourceHashBefore,
    object_counts_before: countsBefore,
    object_counts_after: countsAfter,
    object_counts_unchanged: JSON.stringify(countsBefore) === JSON.stringify(countsAfter),
    details
  };

  if (sourceHashAfter) {
    report.source_hash_after = sourceHashAfter;
  }

  return {
    report,
    plan: {
      actions,
      blocked_reasons: blockedReasons
    }
  };
}

function auditBusinessAccountsFromDb(inputDb, options = {}) {
  return buildBusinessAccountAudit(inputDb, options).report;
}

function auditBusinessAccounts({ dbFile = resolveDatabasePath() } = {}) {
  const dbPath = path.resolve(dbFile);
  const bytes = fs.readFileSync(dbPath);
  const db = parseJsonBytes(bytes);
  return buildBusinessAccountAudit(db, {
    dbPath,
    defaultLocal: !process.env.DB_FILE,
    sourceHashBefore: sha256Buffer(bytes)
  }).report;
}

function getValueByPath(target, targetPath) {
  return targetPath.reduce((current, key) => (current === undefined ? undefined : current[key]), target);
}

function setValueByPath(target, targetPath, value) {
  const parent = getValueByPath(target, targetPath.slice(0, -1));
  if (!parent || typeof parent !== 'object') {
    const error = new Error('BUSINESS_ACCOUNT_BACKFILL_INVALID_PLAN_PATH');
    error.code = 'BUSINESS_ACCOUNT_BACKFILL_INVALID_PLAN_PATH';
    throw error;
  }
  parent[targetPath[targetPath.length - 1]] = value;
}

function pathKey(targetPath) {
  return targetPath.map((item) => String(item)).join('\u0000');
}

function collectDiffPaths(before, after, currentPath = [], output = []) {
  if (JSON.stringify(before) === JSON.stringify(after)) {
    return output;
  }
  if (
    before === null
    || after === null
    || typeof before !== 'object'
    || typeof after !== 'object'
    || Array.isArray(before) !== Array.isArray(after)
  ) {
    output.push(currentPath);
    return output;
  }
  if (Array.isArray(before) || Array.isArray(after)) {
    if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) {
      output.push(currentPath);
      return output;
    }
    before.forEach((item, index) => collectDiffPaths(item, after[index], currentPath.concat(index), output));
    return output;
  }

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  [...keys].forEach((key) => collectDiffPaths(before[key], after[key], currentPath.concat(key), output));
  return output;
}

function validateAllowedChanges(originalDb, nextDb, actions) {
  const allowedPaths = new Set(actions.map((item) => pathKey(item.path)));
  const diffs = collectDiffPaths(originalDb, nextDb);
  const disallowed = diffs.filter((item) => !allowedPaths.has(pathKey(item)));
  if (disallowed.length > 0) {
    const error = new Error('BUSINESS_ACCOUNT_BACKFILL_UNEXPECTED_DIFF');
    error.code = 'BUSINESS_ACCOUNT_BACKFILL_UNEXPECTED_DIFF';
    error.paths = disallowed.map((item) => item.join('.'));
    throw error;
  }
}

function applyBackfillPlanToSnapshot(db, plan) {
  const nextDb = clone(db);
  (plan.actions || []).forEach((action) => {
    const currentValue = getValueByPath(nextDb, action.path);
    if (normalizeIdentity(currentValue)) {
      const error = new Error('BUSINESS_ACCOUNT_BACKFILL_PLAN_NOT_IDEMPOTENT');
      error.code = 'BUSINESS_ACCOUNT_BACKFILL_PLAN_NOT_IDEMPOTENT';
      throw error;
    }
    setValueByPath(nextDb, action.path, action.account_id);
  });
  validateAllowedChanges(db, nextDb, plan.actions || []);
  return nextDb;
}

function writeJsonAtomic(filePath, db) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tempFile = path.join(
    dir,
    `.${base}.business-account-backfill-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.tmp`
  );
  const mode = fs.statSync(filePath).mode;
  try {
    fs.writeFileSync(tempFile, JSON.stringify(db, null, 2), 'utf-8');
    fs.chmodSync(tempFile, mode);
    fs.renameSync(tempFile, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    } catch (_cleanupError) {
      // Keep the original write failure.
    }
    throw error;
  }
}

function applyBusinessAccountBackfill({
  dbFile,
  expectedSourceSha256,
  backupConfirmed = false,
  singleInstanceConfirmed = false,
  beforeWrite = null
} = {}) {
  if (!dbFile) {
    const error = new Error('BUSINESS_ACCOUNT_BACKFILL_DB_FILE_REQUIRED');
    error.code = 'BUSINESS_ACCOUNT_BACKFILL_DB_FILE_REQUIRED';
    throw error;
  }
  if (backupConfirmed !== true || singleInstanceConfirmed !== true) {
    const error = new Error('BUSINESS_ACCOUNT_BACKFILL_CONFIRMATION_REQUIRED');
    error.code = 'BUSINESS_ACCOUNT_BACKFILL_CONFIRMATION_REQUIRED';
    throw error;
  }
  if (!/^[a-f0-9]{64}$/i.test(String(expectedSourceSha256 || ''))) {
    const error = new Error('BUSINESS_ACCOUNT_BACKFILL_EXPECTED_HASH_REQUIRED');
    error.code = 'BUSINESS_ACCOUNT_BACKFILL_EXPECTED_HASH_REQUIRED';
    throw error;
  }

  const dbPath = path.resolve(dbFile);
  const sourceBytes = fs.readFileSync(dbPath);
  const sourceHashBefore = sha256Buffer(sourceBytes);
  if (sourceHashBefore !== expectedSourceSha256) {
    const error = new Error('BUSINESS_ACCOUNT_BACKFILL_SOURCE_HASH_MISMATCH');
    error.code = 'BUSINESS_ACCOUNT_BACKFILL_SOURCE_HASH_MISMATCH';
    throw error;
  }

  const originalDb = parseJsonBytes(sourceBytes);
  const { report, plan } = buildBusinessAccountAudit(originalDb, {
    dbPath,
    defaultLocal: false,
    sourceHashBefore
  });
  if (!report.can_apply) {
    const error = new Error('BUSINESS_ACCOUNT_BACKFILL_BLOCKED');
    error.code = 'BUSINESS_ACCOUNT_BACKFILL_BLOCKED';
    error.report = report;
    throw error;
  }

  if ((plan.actions || []).length === 0) {
    return {
      ...report,
      database: {
        ...report.database,
        read_only: false
      },
      applied: true,
      source_hash_after: sourceHashBefore,
      object_counts_after: report.object_counts_before,
      object_counts_unchanged: true
    };
  }

  const nextDb = applyBackfillPlanToSnapshot(originalDb, plan);
  if (typeof beforeWrite === 'function') {
    beforeWrite({ dbPath, report, plan, nextDb });
  }
  const sourceHashBeforeWrite = hashFile(dbPath);
  if (sourceHashBeforeWrite !== expectedSourceSha256) {
    const error = new Error('BUSINESS_ACCOUNT_BACKFILL_SOURCE_CHANGED');
    error.code = 'BUSINESS_ACCOUNT_BACKFILL_SOURCE_CHANGED';
    throw error;
  }

  writeJsonAtomic(dbPath, nextDb);
  const sourceHashAfter = hashFile(dbPath);
  const countsAfter = objectCounts(nextDb);
  return {
    ...report,
    database: {
      ...report.database,
      read_only: false
    },
    applied: true,
    source_hash_after: sourceHashAfter,
    object_counts_after: countsAfter,
    object_counts_unchanged: JSON.stringify(report.object_counts_before) === JSON.stringify(countsAfter)
  };
}

module.exports = {
  auditBusinessAccounts,
  auditBusinessAccountsFromDb,
  applyBackfillPlanToSnapshot,
  applyBusinessAccountBackfill,
  buildBusinessAccountAudit,
  loadJsonReadOnly,
  maskPhone,
  maskOpenid,
  maskAccountId,
  sha256Buffer
};
