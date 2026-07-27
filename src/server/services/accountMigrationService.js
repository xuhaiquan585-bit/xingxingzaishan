const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ACCOUNT_ID_PREFIX = 'ACC';
const ACCOUNT_ID_WIDTH = 6;
const ACCOUNT_STATUS_ACTIVE = 'active';
const ACCOUNT_MIGRATION_VERSION = 'accounts_foundation_v1';
const dataDir = process.env.DB_DIR
  ? path.resolve(process.env.DB_DIR)
  : path.join(__dirname, '..', 'data');
const dataFile = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(dataDir, 'db.json');

function nowISO() {
  return new Date().toISOString();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readRawDatabaseFile() {
  if (!fs.existsSync(dataFile)) {
    const error = new Error('ACCOUNT_MIGRATION_DB_NOT_FOUND');
    error.code = 'ACCOUNT_MIGRATION_DB_NOT_FOUND';
    throw error;
  }
  return JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
}

function writeRawDatabaseFile(db) {
  const dir = path.dirname(dataFile);
  const base = path.basename(dataFile);
  const tempFile = path.join(
    dir,
    `.${base}.accounts-migration-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.tmp`
  );
  try {
    fs.writeFileSync(tempFile, JSON.stringify(db, null, 2), 'utf-8');
    fs.renameSync(tempFile, dataFile);
  } catch (error) {
    try {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    } catch (_cleanupError) {
      // Best effort cleanup only; preserve the original migration error.
    }
    throw error;
  }
}

function normalizePhone(phone) {
  return String(phone || '').trim();
}

function normalizeOpenid(openid) {
  return String(openid || '').trim();
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

function normalizePositiveInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : null;
}

function parseAccountNumber(id) {
  const match = String(id || '').match(/^ACC(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function makeAccountId(index) {
  return `${ACCOUNT_ID_PREFIX}${String(index).padStart(ACCOUNT_ID_WIDTH, '0')}`;
}

function maxExistingAccountNumber(accounts = []) {
  return Math.max(0, ...accounts.map((item) => parseAccountNumber(item && item.id)));
}

function getInitialNextAccountIndex(db) {
  const fromMeta = normalizePositiveInteger(db && db.meta && db.meta.next_account_id);
  const fromAccounts = maxExistingAccountNumber(Array.isArray(db.accounts) ? db.accounts : []) + 1;
  return Math.max(fromMeta || 1, fromAccounts);
}

function groupDuplicateUsers(users, field, masker) {
  const groups = new Map();
  users.forEach((user) => {
    const value = field === 'phone' ? normalizePhone(user.phone) : normalizeOpenid(user.openid);
    if (!value) return;
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(user);
  });

  return [...groups.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([value, items]) => ({
      value: masker(value),
      count: items.length,
      user_ids: items.map((item) => item.id)
    }));
}

function duplicateValueSet(users, field) {
  const groups = new Map();
  users.forEach((user) => {
    const value = field === 'phone' ? normalizePhone(user.phone) : normalizeOpenid(user.openid);
    if (!value) return;
    if (!groups.has(value)) groups.set(value, 0);
    groups.set(value, groups.get(value) + 1);
  });
  return new Set([...groups.entries()].filter(([, count]) => count > 1).map(([value]) => value));
}

function accountExists(accounts, accountId) {
  return accounts.some((item) => item && item.id === accountId);
}

function createdFromForUser(user) {
  const source = user.source || '';
  const hasPhone = !!normalizePhone(user.phone);
  const hasOpenid = !!normalizeOpenid(user.openid);
  if (source === 'web' && hasPhone && !hasOpenid) return 'web_phone';
  if (source === 'miniapp' && hasOpenid && !hasPhone) return 'miniapp_openid';
  return 'migration';
}

function getOrderIdsForOpenid(orders, openid) {
  const target = normalizeOpenid(openid);
  if (!target) return [];
  return orders
    .filter((item) => normalizeOpenid(item.openid) === target)
    .map((item) => item.id)
    .filter(Boolean);
}

function summarizeDbForAccountMigration(inputDb = {}) {
  const db = clone(inputDb);
  const users = Array.isArray(db.users) ? db.users : [];
  const accounts = Array.isArray(db.accounts) ? db.accounts : [];
  const orders = Array.isArray(db.orders) ? db.orders : [];
  const qrCodes = Array.isArray(db.qr_codes) ? db.qr_codes : [];
  const duplicatePhones = duplicateValueSet(users, 'phone');
  const duplicateOpenids = duplicateValueSet(users, 'openid');

  const missingAccountUsers = users
    .filter((user) => user.account_id && !accountExists(accounts, user.account_id))
    .map((user) => ({ user_id: user.id, account_id: user.account_id }));
  const noIdentifierUsers = users
    .filter((user) => !normalizePhone(user.phone) && !normalizeOpenid(user.openid) && !user.account_id)
    .map((user) => ({ user_id: user.id, source: user.source || '' }));

  const mappableUsers = users.filter((user) => {
    if (user.account_id) return false;
    const phone = normalizePhone(user.phone);
    const openid = normalizeOpenid(user.openid);
    if (!phone && !openid) return false;
    if (phone && duplicatePhones.has(phone)) return false;
    if (openid && duplicateOpenids.has(openid)) return false;
    return true;
  });

  const openidOnlyUsers = users.filter((user) => normalizeOpenid(user.openid) && !normalizePhone(user.phone));
  const temporaryUsersWithOrders = openidOnlyUsers
    .map((user) => ({
      user_id: user.id,
      order_ids: getOrderIdsForOpenid(orders, user.openid)
    }))
    .filter((item) => item.order_ids.length > 0);

  const duplicatePhoneGroups = groupDuplicateUsers(users, 'phone', maskPhone);
  const duplicateOpenidGroups = groupDuplicateUsers(users, 'openid', maskOpenid);
  const blockedReasons = [];
  if (duplicatePhoneGroups.length > 0) blockedReasons.push('duplicate_phone');
  if (duplicateOpenidGroups.length > 0) blockedReasons.push('duplicate_openid');
  if (missingAccountUsers.length > 0) blockedReasons.push('missing_account_reference');
  if (noIdentifierUsers.length > 0) blockedReasons.push('user_without_identity');

  return {
    can_apply: blockedReasons.length === 0,
    blocked_reasons: blockedReasons,
    users_total: users.length,
    accounts_total: accounts.length,
    mapped_users: users.filter((user) => !!user.account_id).length,
    mappable_users: mappableUsers.length,
    duplicate_phone_groups: duplicatePhoneGroups,
    duplicate_openid_groups: duplicateOpenidGroups,
    missing_account_users: missingAccountUsers,
    users_without_identity: noIdentifierUsers,
    temporary_users_with_orders: temporaryUsersWithOrders,
    data_ownership: {
      star_records: 'phone',
      co_creation_owner: 'phone',
      co_creation_comments: 'phone',
      miniapp_orders: 'openid',
      h5_records: 'phone'
    },
    records_total: qrCodes.length,
    activated_records_with_phone: qrCodes.filter((item) =>
      item.activation_status === 'activated' && normalizePhone(item.phone)
    ).length
  };
}

function createAccountForUser({ user, accountId, createdAt }) {
  return {
    id: accountId,
    status: ACCOUNT_STATUS_ACTIVE,
    display_name: '',
    avatar_url: '',
    created_from: createdFromForUser(user),
    created_at: createdAt,
    updated_at: createdAt
  };
}

function applyAccountMigrationToSnapshot(inputDb = {}) {
  const db = clone(inputDb);
  const summary = summarizeDbForAccountMigration(db);
  if (!summary.can_apply) {
    const error = new Error('ACCOUNT_MIGRATION_BLOCKED');
    error.code = 'ACCOUNT_MIGRATION_BLOCKED';
    error.summary = summary;
    throw error;
  }

  if (!Array.isArray(db.accounts)) db.accounts = [];
  if (!db.meta || typeof db.meta !== 'object' || Array.isArray(db.meta)) db.meta = {};
  if (!Array.isArray(db.users)) db.users = [];

  const previousMigrationVersion = db.meta.accounts_migration_version || '';
  const previousMigratedAt = db.meta.accounts_migrated_at || '';
  let nextAccountIndex = getInitialNextAccountIndex(db);
  const createdAt = nowISO();
  let createdAccounts = 0;
  let mappedUsers = 0;

  db.users = db.users.map((user) => {
    if (user.account_id) return user;
    const phone = normalizePhone(user.phone);
    const openid = normalizeOpenid(user.openid);
    if (!phone && !openid) return user;

    const accountId = makeAccountId(nextAccountIndex);
    nextAccountIndex += 1;
    db.accounts.push(createAccountForUser({
      user,
      accountId,
      createdAt
    }));
    createdAccounts += 1;
    mappedUsers += 1;
    return {
      ...user,
      account_id: accountId
    };
  });

  db.meta.next_account_id = Math.max(nextAccountIndex, getInitialNextAccountIndex(db));
  db.meta.accounts_migration_version = ACCOUNT_MIGRATION_VERSION;
  db.meta.accounts_migrated_at = (createdAccounts > 0 || mappedUsers > 0 ||
    previousMigrationVersion !== ACCOUNT_MIGRATION_VERSION || !previousMigratedAt)
    ? createdAt
    : previousMigratedAt;

  return {
    db,
    summary: {
      ...summarizeDbForAccountMigration(db),
      created_accounts: createdAccounts,
      mapped_users_in_run: mappedUsers
    }
  };
}

function auditAccountMigration() {
  if (!fs.existsSync(dataFile)) {
    return summarizeDbForAccountMigration({});
  }
  return summarizeDbForAccountMigration(readRawDatabaseFile());
}

function applyAccountMigration() {
  const result = applyAccountMigrationToSnapshot(readRawDatabaseFile());
  writeRawDatabaseFile(result.db);
  return {
    ...result.summary,
    applied: true
  };
}

module.exports = {
  summarizeDbForAccountMigration,
  applyAccountMigrationToSnapshot,
  auditAccountMigration,
  applyAccountMigration,
  maskPhone,
  maskOpenid
};
