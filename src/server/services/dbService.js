const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { hashPassword, verifyPassword, isPasswordHashed } = require('./passwordService');
const {
  qrImagePath,
  renderQrImage,
  stageFileReplacement
} = require('./qrImageService');
const {
  publicQrDomainSha256FromSource
} = require('../../../scripts/database/importer/domain-markers');
const {
  hasCrossAccountPhoneReference
} = require('./contentPrivacyService');

const dataDir = process.env.DB_DIR
  ? path.resolve(process.env.DB_DIR)
  : path.join(__dirname, '..', 'data');
const dataFile = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(dataDir, 'db.json');
const CO_CREATION_COMMENT_LIMIT = 12;
const ACCOUNT_ID_PREFIX = 'ACC';
const ACCOUNT_ID_WIDTH = 6;
const ACCOUNT_STATUS_ACTIVE = 'active';

const DEFAULT_MINIAPP_CONTENT = {
  home_title: '给这瓶酒，贴上一颗星',
  home_subtitle: '酒瓶星贴，不含酒水；贴上后扫码，留下照片和一句话。',
  logo_image: '',
  home_banner_image: '',
  home_slides: [
    {
      image: '',
      title: '给这瓶酒，贴上一颗星',
      subtitle: '一张照片，一句话，让这瓶酒有自己的故事。',
      button_text: '去封存',
      action_type: 'products',
      scene_key: 'free'
    },
    {
      image: '',
      title: '把说不出口的话，留在酒里',
      subtitle: '贴上星贴，扫码后就能留下这一次举杯。',
      button_text: '选择星贴',
      action_type: 'products',
      scene_key: 'lover'
    },
    {
      image: '',
      title: '已有星贴，直接扫码记录',
      subtitle: '拿到酒瓶星贴后，扫码上传照片和一句话。',
      button_text: '扫码记录',
      action_type: 'scan',
      scene_key: 'free'
    }
  ],
  scene_cards: [
    { key: 'lover', label: '恋人', title: '恋人', description: '把说不出口的话，贴在这一瓶酒上。', image: '', button_text: '查看恋人星贴' },
    { key: 'elder', label: '长辈', title: '长辈', description: '把感谢和祝福，认真留给重要的人。', image: '', button_text: '查看长辈星贴' },
    { key: 'birthday', label: '生日', title: '生日', description: '把今天的祝福，留到以后还能看见。', image: '', button_text: '查看生日星贴' },
    { key: 'wedding', label: '婚礼', title: '婚礼', description: '把承诺和祝福，留在共同举杯时。', image: '', button_text: '查看婚礼星贴' },
    { key: 'party', label: '聚会', title: '聚会', description: '让一桌人的话，一起留在这瓶酒里。', image: '', button_text: '查看聚会星贴' }
  ],
  project_title: '星星在闪',
  project_body: '把值得记住的时刻，存在这瓶酒里。适合成年礼、婚礼、生日、纪念日和送礼。',
  brand_story_title: '关于记在星上',
  brand_story_body: '我们希望每一瓶被送出的酒，都能留下属于它和收礼人的一段记忆。',
  consult_label: '咨询购买',
  consult_url: '',
  share_title: '记在星上，闪到永远',
  share_description: '让故事与时间一同酝酿，区块链存证，一经封存，不可篡改。',
  updated_at: null,
  updated_by: null
};

const PRODUCT_SCENE_KEYS = ['lover', 'elder', 'birthday', 'wedding', 'party', 'free', 'coming_of_age'];
const PRODUCT_TYPES = ['wine_sticker', 'sticker_set', 'custom_sticker', 'wine_gift', 'custom_wine'];
const ORDER_STATUSES = ['pending_payment', 'paid', 'shipped', 'completed', 'cancelled', 'refunding', 'refunded'];
const PAYMENT_STATUSES = ['unpaid', 'paid', 'failed', 'refunded'];
const CHAIN_STATUSES = ['not_started', 'manifest_ready', 'submitting', 'submitted', 'confirmed', 'failed', 'retrying'];
const DETERMINISTIC_MIGRATION_TIMESTAMP = '1970-01-01T00:00:00.000Z';
const REQUIRED_DATABASE_ARRAYS = [
  'users',
  'accounts',
  'qr_codes',
  'admins',
  'quality_check_logs',
  'batches',
  'products',
  'content_pages',
  'banners',
  'orders',
  'payment_logs'
];
const databaseSourceHashes = new WeakMap();
let publicQrDomainHashCache = null;

function normalizeProductSceneTags(value, existing = []) {
  const hasValue = value !== undefined && value !== null;
  const raw = Array.isArray(value)
    ? value
    : String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  const fallback = Array.isArray(existing) ? existing : [];
  const tags = (hasValue ? raw : fallback).filter((item) => PRODUCT_SCENE_KEYS.includes(item));
  return [...new Set(tags)];
}

function nowISO() {
  return new Date().toISOString();
}

function normalizePositiveInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : null;
}

function maxNumericId(items = []) {
  return Math.max(0, ...items.map((item) => Number(item && item.id) || 0));
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

function ensureDbMeta(db) {
  if (!db.meta || typeof db.meta !== 'object' || Array.isArray(db.meta)) {
    db.meta = {};
  }
  return db.meta;
}

function getNextUserId(db) {
  const meta = ensureDbMeta(db);
  const nextFromMeta = normalizePositiveInteger(meta.next_user_id);
  const nextFromUsers = maxNumericId(Array.isArray(db.users) ? db.users : []) + 1;
  const nextId = Math.max(nextFromMeta || 1, nextFromUsers);
  meta.next_user_id = nextId + 1;
  return nextId;
}

function getNextAccountId(db) {
  const meta = ensureDbMeta(db);
  if (!Array.isArray(db.accounts)) db.accounts = [];
  const nextFromMeta = normalizePositiveInteger(meta.next_account_id);
  const nextFromAccounts = maxExistingAccountNumber(db.accounts) + 1;
  const nextIndex = Math.max(nextFromMeta || 1, nextFromAccounts);
  meta.next_account_id = nextIndex + 1;
  return makeAccountId(nextIndex);
}

function createAccountForUser(db, { createdFrom, createdAt }) {
  if (!Array.isArray(db.accounts)) db.accounts = [];
  const accountId = getNextAccountId(db);
  db.accounts.push({
    id: accountId,
    status: ACCOUNT_STATUS_ACTIVE,
    display_name: '',
    avatar_url: '',
    created_from: createdFrom,
    created_at: createdAt,
    updated_at: createdAt
  });
  return accountId;
}

function accountExists(db, accountId) {
  return !!accountId && Array.isArray(db.accounts) && db.accounts.some((item) => item && item.id === accountId);
}

function accountMappingError(code = 'ACCOUNT_MAPPING_REQUIRED') {
  const error = new Error(code);
  error.code = code;
  return error;
}

function requireMappedUser(db, user, { accountId = null, openid = null } = {}) {
  if (!user || !user.account_id || !accountExists(db, user.account_id)) {
    throw accountMappingError('ACCOUNT_MAPPING_REQUIRED');
  }
  if (accountId && accountId !== user.account_id) {
    throw accountMappingError('ACCOUNT_MAPPING_MISMATCH');
  }
  if (openid && normalizeUserOpenid(user.openid) !== normalizeUserOpenid(openid)) {
    throw accountMappingError('ACCOUNT_IDENTITY_MISMATCH');
  }
  return user;
}

function normalizeAccountId(value) {
  return String(value || '').trim();
}

function payloadAccountId(payload) {
  return normalizeAccountId(payload && payload.account_id);
}

function violatesContentPrivacy(db, accountId, content) {
  return hasCrossAccountPhoneReference({
    content,
    ownerAccountId: accountId,
    identities: db.users
  });
}

function findUniqueUserByPhone(db, phone) {
  const targetPhone = normalizeUserPhone(phone);
  if (!targetPhone) return null;
  const matches = db.users.filter((item) => normalizeUserPhone(item.phone) === targetPhone);
  if (matches.length > 1) {
    throw accountMappingError('DUPLICATE_PHONE_IDENTITY');
  }
  return matches[0] || null;
}

function findUniqueUserByOpenid(db, openid) {
  const targetOpenid = normalizeUserOpenid(openid);
  if (!targetOpenid) return null;
  const matches = db.users.filter((item) => normalizeUserOpenid(item.openid) === targetOpenid);
  if (matches.length > 1) {
    throw accountMappingError('DUPLICATE_OPENID_IDENTITY');
  }
  return matches[0] || null;
}

function normalizeChainStatus(value, hasHash = false) {
  if (CHAIN_STATUSES.includes(value)) return value;
  return hasHash ? 'confirmed' : 'not_started';
}

function defaultChainFields(item = {}) {
  const manifestHash = item.manifest_hash || item.blockchain_hash || null;
  return {
    chain_provider: item.chain_provider || 'avata_wenchang',
    chain_status: normalizeChainStatus(item.chain_status, !!manifestHash),
    chain_operation_id: item.chain_operation_id || null,
    manifest_object_key: item.manifest_object_key || null,
    manifest_hash: manifestHash,
    chain_tx_hash: item.chain_tx_hash || null,
    chain_block_height: Object.prototype.hasOwnProperty.call(item, 'chain_block_height') ? item.chain_block_height : null,
    chain_record_id: item.chain_record_id || null,
    chain_certificate_url: item.chain_certificate_url || null,
    chain_certificate_object_key: item.chain_certificate_object_key || null,
    chain_certificate_object_url: item.chain_certificate_object_url || null,
    chain_confirmed_at: item.chain_confirmed_at || (manifestHash && item.blockchain_hash ? item.activated_at || null : null),
    chain_callback_received_at: item.chain_callback_received_at || null,
    chain_last_error: item.chain_last_error || '',
    chain_retry_count: Number.isFinite(Number(item.chain_retry_count)) ? Number(item.chain_retry_count) : 0,
    image_sha256: item.image_sha256 || null,
    legacy_manifest_object_key: item.legacy_manifest_object_key || null,
    archive_index_object_key: item.archive_index_object_key || null,
    archive_status: item.archive_status || 'not_started',
    archive_last_error: item.archive_last_error || '',
    archive_updated_at: item.archive_updated_at || null
  };
}

function seedQRCodes(createdAt = nowISO()) {
  const qrCodes = [];
  for (let i = 1; i <= 100; i += 1) {
    const id = `STAR${String(i).padStart(4, '0')}`;
    qrCodes.push({
      id,
      issue_status: i <= 10 ? 'unissued' : 'issued',
      activation_status: 'unactivated',
      hidden: false,
      batch_id: null,
      print_batch_id: null,
      quality_check: {
        checked: false,
        checked_at: null,
        checked_by: null,
        result: null
      },
      content: null,
      image_url: null,
      image_object_key: null,
      phone: null,
      activated_at: null,
      blockchain_hash: null,
      ...defaultChainFields(),
      co_creation_enabled: false,
      co_creation_owner_phone: null,
      co_creation_comments: [],
      co_creation_started_at: null,
      show_brand_disclosure: false,
      brand_disclosure_text_snapshot: '',
      qr_image_url: null,
      qr_access_token: null,
      created_at: createdAt
    });
  }
  return qrCodes;
}

function parseInitialAdminsFromEnv() {
  const raw = process.env.ADMIN_INIT_ACCOUNTS_JSON;
  if (!raw) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_error) {
    const error = new Error('ADMIN_INIT_ACCOUNTS_JSON must be valid JSON.');
    error.code = 'CONFIG_VALIDATION_FAILED';
    throw error;
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    const error = new Error('ADMIN_INIT_ACCOUNTS_JSON must be a non-empty array.');
    error.code = 'CONFIG_VALIDATION_FAILED';
    throw error;
  }

  const usernames = new Set();

  return parsed.map((item, idx) => {
    const username = typeof item.username === 'string' ? item.username.trim() : '';
    const password = typeof item.password === 'string' ? item.password : '';
    const role = item.role === 'admin' ? 'admin' : 'qc';

    if (!username || !password) {
      const error = new Error(`ADMIN_INIT_ACCOUNTS_JSON[${idx}] requires non-empty username and password.`);
      error.code = 'CONFIG_VALIDATION_FAILED';
      throw error;
    }

    if (usernames.has(username)) {
      const error = new Error(`ADMIN_INIT_ACCOUNTS_JSON contains duplicate username: ${username}`);
      error.code = 'CONFIG_VALIDATION_FAILED';
      throw error;
    }

    usernames.add(username);

    return {
      id: idx + 1,
      username,
      password: hashPassword(password),
      role,
      name: (typeof item.name === 'string' && item.name.trim()) ? item.name.trim() : username,
      enabled: item.enabled !== false
    };
  });
}

function ensureAdminsInitialized(db) {
  if (!Array.isArray(db.admins)) {
    db.admins = [];
  }

  if (db.admins.length > 0) {
    return;
  }

  const bootstrapAdmins = parseInitialAdminsFromEnv();
  if (bootstrapAdmins.length > 0) {
    db.admins = bootstrapAdmins;
    return;
  }

  if (process.env.NODE_ENV === 'production') {
    const error = new Error(
      'ADMIN_INIT_ACCOUNTS_JSON is required on first startup in production when no admin account exists.'
    );
    error.code = 'CONFIG_VALIDATION_FAILED';
    throw error;
  }
}

function databaseError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function migrateDatabaseSnapshot(input) {
  const db = input && typeof input === 'object' && !Array.isArray(input)
    ? JSON.parse(JSON.stringify(input))
    : {};
  if (!Array.isArray(db.users)) {
    db.users = [];
  }
  if (!Array.isArray(db.accounts)) {
    db.accounts = [];
  }

  db.users = db.users.map((item, idx) => ({
    id: item.id || idx + 1,
    phone: item.phone || null,
    openid: item.openid || null,
    unionid: item.unionid || null,
    source: item.source || (item.openid ? 'miniapp' : 'web'),
    created_at: item.created_at || DETERMINISTIC_MIGRATION_TIMESTAMP,
    ...(Object.prototype.hasOwnProperty.call(item, 'account_id') ? { account_id: item.account_id || null } : {})
  }));

  if (!Array.isArray(db.qr_codes)) {
    db.qr_codes = seedQRCodes(DETERMINISTIC_MIGRATION_TIMESTAMP);
  }

  db.admins = db.admins.map((item, idx) => ({
    id: item.id || idx + 1,
    username: item.username,
    password: (() => {
      if (!isPasswordHashed(item.password)) {
        throw databaseError(
          'DB_MIGRATION_PLAINTEXT_ADMIN_PASSWORD',
          'Admin passwords must be hashed before schema migration.'
        );
      }
      return item.password;
    })(),
    role: item.role || 'qc',
    name: item.name || item.username,
    enabled: item.enabled !== false
  }));

  if (!Array.isArray(db.quality_check_logs)) {
    db.quality_check_logs = [];
  }

  if (!Array.isArray(db.batches)) {
    db.batches = [];
  }

  if (!Array.isArray(db.products)) {
    db.products = [];
  }

  if (!Array.isArray(db.content_pages)) {
    db.content_pages = [];
  }

  if (!Array.isArray(db.banners)) {
    db.banners = [];
  }

  if (!Array.isArray(db.orders)) {
    db.orders = [];
  }

  if (!Array.isArray(db.payment_logs)) {
    db.payment_logs = [];
  }

  if (!db.miniapp_content || typeof db.miniapp_content !== 'object' || Array.isArray(db.miniapp_content)) {
    db.miniapp_content = {};
  }
  db.miniapp_content = normalizeMiniappContent(db.miniapp_content);

  db.products = db.products.map((item, idx) => ({
    id: item.id || `PROD_${String(idx + 1).padStart(4, '0')}`,
    title: item.title || '',
    subtitle: item.subtitle || '',
    cover_image: item.cover_image || '',
    images: Array.isArray(item.images) ? item.images : [],
    price_text: item.price_text || '',
    price_cents: Number.isFinite(Number(item.price_cents)) ? Number(item.price_cents) : 0,
    description: item.description || '',
    status: ['draft', 'published', 'hidden'].includes(item.status) ? item.status : 'draft',
    product_type: PRODUCT_TYPES.includes(item.product_type) ? item.product_type : 'wine_sticker',
    sticker_count: Number.isFinite(Number(item.sticker_count)) ? Number(item.sticker_count) : 1,
    stock: Number.isFinite(Number(item.stock)) ? Number(item.stock) : 0,
    is_customizable: item.is_customizable === true,
    shipping_note: item.shipping_note || '现货贴纸通常 48 小时内发出。',
    after_sale_note: item.after_sale_note || '贴纸为印刷品，不含酒水。如有印刷或物流问题请联系客服处理。',
    buy_type: item.buy_type || 'miniapp_order',
    buy_url: item.buy_url || '',
    scene_tags: normalizeProductSceneTags(item.scene_tags),
    sort_order: Number.isFinite(Number(item.sort_order)) ? Number(item.sort_order) : idx + 1,
    created_at: item.created_at || DETERMINISTIC_MIGRATION_TIMESTAMP,
    updated_at: item.updated_at || item.created_at || DETERMINISTIC_MIGRATION_TIMESTAMP
  }));

  db.orders = db.orders.map((item, idx) => ({
    id: item.id || `ORDER_${String(idx + 1).padStart(6, '0')}`,
    order_no: item.order_no || `LEGACY_ORDER_${String(idx + 1).padStart(6, '0')}`,
    openid: item.openid || '',
    phone: item.phone || '',
    ...(Object.prototype.hasOwnProperty.call(item, 'account_id') ? { account_id: item.account_id || null } : {}),
    product_id: item.product_id || '',
    product_snapshot: item.product_snapshot || {},
    quantity: Number.isFinite(Number(item.quantity)) ? Number(item.quantity) : 1,
    unit_price_cents: Number.isFinite(Number(item.unit_price_cents)) ? Number(item.unit_price_cents) : 0,
    total_amount_cents: Number.isFinite(Number(item.total_amount_cents)) ? Number(item.total_amount_cents) : 0,
    status: ORDER_STATUSES.includes(item.status) ? item.status : 'pending_payment',
    payment_status: PAYMENT_STATUSES.includes(item.payment_status) ? item.payment_status : 'unpaid',
    payment_method: item.payment_method || '',
    payment_mock: item.payment_mock === true,
    wechat_transaction_id: item.wechat_transaction_id || '',
    paid_at: item.paid_at || null,
    receiver_name: item.receiver_name || '',
    receiver_phone: item.receiver_phone || '',
    region: item.region || '',
    address: item.address || '',
    remark: item.remark || '',
    express_company: item.express_company || '',
    express_no: item.express_no || '',
    shipped_at: item.shipped_at || null,
    refund_status: item.refund_status || '',
    admin_note: item.admin_note || '',
    created_at: item.created_at || DETERMINISTIC_MIGRATION_TIMESTAMP,
    updated_at: item.updated_at || item.created_at || DETERMINISTIC_MIGRATION_TIMESTAMP
  }));

  db.qr_codes = db.qr_codes.map((item) => ({
    ...item,
    issue_status: item.issue_status || 'issued',
    activation_status: item.activation_status || 'unactivated',
    hidden: item.hidden === true,
    batch_id: Object.prototype.hasOwnProperty.call(item, 'batch_id') ? item.batch_id : null,
    print_batch_id: Object.prototype.hasOwnProperty.call(item, 'print_batch_id') ? item.print_batch_id : null,
    image_object_key: Object.prototype.hasOwnProperty.call(item, 'image_object_key') ? item.image_object_key : null,
    ...defaultChainFields(item),
    co_creation_enabled: item.co_creation_enabled === true,
    co_creation_owner_phone: item.co_creation_owner_phone || null,
    co_creation_comments: Array.isArray(item.co_creation_comments) ? item.co_creation_comments : [],
    co_creation_started_at: item.co_creation_started_at || null,
    show_brand_disclosure: item.show_brand_disclosure === true,
    brand_disclosure_text_snapshot: typeof item.brand_disclosure_text_snapshot === 'string' ? item.brand_disclosure_text_snapshot : '',
    qr_image_url: item.qr_image_url || null,
    qr_access_token: item.qr_access_token || null,
    quality_check: item.quality_check || {
      checked: false,
      checked_at: null,
      checked_by: null,
      result: null
    }
  }));

  if (!db.meta || typeof db.meta !== 'object' || Array.isArray(db.meta)) {
    db.meta = {};
  }

  return db;
}

function assertRuntimeDatabaseSchema(db) {
  if (!db || typeof db !== 'object' || Array.isArray(db)) {
    throw databaseError('DB_SCHEMA_MIGRATION_REQUIRED', 'Database root must be an object.');
  }

  const missingCollections = REQUIRED_DATABASE_ARRAYS.filter((key) => !Array.isArray(db[key]));
  if (missingCollections.length > 0) {
    throw databaseError(
      'DB_SCHEMA_MIGRATION_REQUIRED',
      `Database schema migration required for: ${missingCollections.join(', ')}`
    );
  }

  if (!db.miniapp_content || typeof db.miniapp_content !== 'object' || Array.isArray(db.miniapp_content)) {
    throw databaseError('DB_SCHEMA_MIGRATION_REQUIRED', 'Database miniapp_content schema is missing.');
  }

  if (db.admins.some((item) => !item || !isPasswordHashed(item.password))) {
    throw databaseError('DB_SCHEMA_MIGRATION_REQUIRED', 'Database contains an unhashed admin password.');
  }

  if (process.env.NODE_ENV === 'production' && db.admins.length === 0) {
    throw databaseError(
      'CONFIG_VALIDATION_FAILED',
      'Production database must contain at least one initialized admin account.'
    );
  }

  return db;
}

function createInitialDatabaseSnapshot() {
  const initialData = {
    meta: {},
    users: [],
    accounts: [],
    qr_codes: seedQRCodes(),
    admins: [],
    quality_check_logs: [],
    batches: [],
    products: [],
    content_pages: [],
    banners: [],
    orders: [],
    payment_logs: [],
    miniapp_content: normalizeMiniappContent(DEFAULT_MINIAPP_CONTENT)
  };
  ensureAdminsInitialized(initialData);
  return assertRuntimeDatabaseSchema(initialData);
}

function buildDatabaseTempFile() {
  const basename = path.basename(dataFile);
  const nonce = crypto.randomBytes(6).toString('hex');
  return path.join(path.dirname(dataFile), `.${basename}.${process.pid}.${Date.now()}.${nonce}.tmp`);
}

function writeSerializedDatabaseAtomically(serialized, { beforeRename } = {}) {
  const tempFile = buildDatabaseTempFile();
  const stat = fs.existsSync(dataFile) ? fs.statSync(dataFile) : null;
  let descriptor = null;

  try {
    descriptor = fs.openSync(tempFile, 'wx', stat ? stat.mode & 0o777 : 0o600);
    fs.writeFileSync(descriptor, serialized, { encoding: 'utf-8' });
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;

    if (typeof beforeRename === 'function') {
      beforeRename();
    }

    fs.renameSync(tempFile, dataFile);
    fsyncDatabaseDirectory();
  } catch (error) {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch (_closeError) {
        // Preserve the original write error.
      }
    }
    unlinkTempFile(tempFile);
    throw error;
  }
}

function fsyncDatabaseDirectory() {
  if (process.platform === 'win32') return false;
  let descriptor = null;
  try {
    descriptor = fs.openSync(path.dirname(dataFile), 'r');
    fs.fsyncSync(descriptor);
    return true;
  } catch (_error) {
    // The database was already atomically replaced. Do not report a false rollback.
    return false;
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch (_closeError) {
        // Best-effort directory durability only.
      }
    }
  }
}

function initializeDB() {
  if (!fs.existsSync(dataFile)) {
    if (process.env.NODE_ENV === 'production') {
      throw databaseError('DB_FILE_NOT_FOUND', `Production database file does not exist: ${dataFile}`);
    }
    const databaseDir = path.dirname(dataFile);
    if (!fs.existsSync(databaseDir)) {
      fs.mkdirSync(databaseDir, { recursive: true });
    }
    const initialData = createInitialDatabaseSnapshot();
    writeSerializedDatabaseAtomically(JSON.stringify(initialData, null, 2));
    return;
  }

  const raw = fs.readFileSync(dataFile, 'utf-8');
  assertRuntimeDatabaseSchema(JSON.parse(raw));
}

function readDB() {
  return readDBWithHash().db;
}

function writeDB(db) {
  const expectedSourceHash = databaseSourceHashes.get(db);
  if (!expectedSourceHash) {
    throw databaseError('DB_WRITE_SOURCE_REQUIRED', 'Database writes require a snapshot read from the current source file.');
  }
  writeDBAtomicallyIfUnchanged(db, expectedSourceHash);
}

function sha256Content(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function assertDatabaseSourceHash(expectedSourceHash, conflictCode = 'DB_WRITE_CONFLICT') {
  const currentHash = fs.existsSync(dataFile)
    ? sha256Content(fs.readFileSync(dataFile, 'utf-8'))
    : null;
  if (currentHash !== expectedSourceHash) {
    throw databaseError(conflictCode, conflictCode);
  }
}

function readDBWithHash() {
  if (!fs.existsSync(dataFile)) {
    throw databaseError('DB_FILE_NOT_FOUND', `Database file does not exist: ${dataFile}`);
  }
  const raw = fs.readFileSync(dataFile, 'utf-8');
  const db = assertRuntimeDatabaseSchema(JSON.parse(raw));
  const sourceHash = sha256Content(raw);
  databaseSourceHashes.set(db, sourceHash);
  return { db, sourceHash };
}

function unlinkTempFile(tempFile) {
  try {
    if (tempFile && fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
  } catch (_error) {
    // Best-effort cleanup; the caller still receives the original write error.
  }
}

function writeDBAtomicallyIfUnchanged(db, expectedSourceHash, conflictCode = 'DB_WRITE_CONFLICT') {
  assertRuntimeDatabaseSchema(db);
  const serialized = JSON.stringify(db, null, 2);
  const assertSourceUnchanged = () => assertDatabaseSourceHash(expectedSourceHash, conflictCode);

  assertSourceUnchanged();
  writeSerializedDatabaseAtomically(serialized, {
    beforeRename: assertSourceUnchanged
  });
  databaseSourceHashes.set(db, sha256Content(serialized));
}

function createOrGetUser(phone) {
  const db = readDB();
  const targetPhone = normalizeUserPhone(phone);
  let user = findUniqueUserByPhone(db, targetPhone);
  if (user) {
    return requireMappedUser(db, user);
  }
  if (!user) {
    const createdAt = nowISO();
    const accountId = createAccountForUser(db, {
      createdFrom: 'web_phone',
      createdAt
    });
    user = {
      id: getNextUserId(db),
      phone: targetPhone,
      openid: null,
      unionid: null,
      source: 'web',
      created_at: createdAt,
      account_id: accountId
    };
    db.users.push(user);
    writeDB(db);
  }
  return user;
}

function findUserById(userId) {
  const db = readDB();
  const matches = db.users.filter((item) => String(item.id) === String(userId));
  return matches.length === 1 ? matches[0] : null;
}

function authenticateUserFromDatabase(db, { userId, accountId = null, openid = null }) {
  const matches = db.users.filter((item) => String(item.id) === String(userId));
  if (matches.length !== 1) {
    return { error: 'UNAUTHORIZED' };
  }
  try {
    return { data: requireMappedUser(db, matches[0], { accountId, openid }) };
  } catch (error) {
    return { error: error.code || 'UNAUTHORIZED' };
  }
}

function getAuthenticatedUserReadContext(input) {
  const { db, sourceHash } = readDBWithHash();
  return { result: authenticateUserFromDatabase(db, input), sourceHash };
}

function getAuthenticatedUserById(input) {
  return getAuthenticatedUserReadContext(input).result;
}

function getAuthenticatedMiniappUserReadContext(input) {
  const { db, sourceHash } = readDBWithHash();
  return {
    result: authenticateUserFromDatabase(db, input),
    sourceHash
  };
}

function getAuthenticatedMiniappUser(input) {
  return getAuthenticatedMiniappUserReadContext(input).result;
}

function findUserByOpenid(openid) {
  const db = readDB();
  return db.users.find((item) => item.openid === openid) || null;
}

function normalizeUserPhone(phone) {
  return String(phone || '').trim();
}

function normalizeUserOpenid(openid) {
  return String(openid || '').trim();
}

function logMiniappBindConflict(reason, details = {}) {
  const userCount = Array.isArray(details.userIds) ? details.userIds.length : 0;
  const orderCount = Array.isArray(details.orderIds) ? details.orderIds.length : 0;
  console.warn('[miniapp-bind-phone]', {
    reason,
    user_count: userCount,
    order_count: orderCount
  });
}

function isMiniappOnlySource(source) {
  const value = String(source || 'miniapp').trim() || 'miniapp';
  return value === 'miniapp';
}

function sourceWithMiniapp(source) {
  const value = String(source || '').trim();
  if (!value) return 'miniapp';
  if (value.split('+').includes('miniapp')) return value;
  if (value === 'web') return 'web+miniapp';
  return `${value}+miniapp`;
}

function containsValueDeep(value, target) {
  if (!target || value === null || value === undefined) return false;
  if (typeof value === 'string') return value === target;
  if (typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some((item) => containsValueDeep(item, target));
  }
  return Object.values(value).some((item) => containsValueDeep(item, target));
}

function usersForAccount(db, accountId) {
  const target = normalizeAccountId(accountId);
  return (Array.isArray(db.users) ? db.users : [])
    .filter((item) => normalizeAccountId(item.account_id) === target);
}

function collectMiniappIdentityReferences(db, { accountId, openid }) {
  const account = normalizeAccountId(accountId);
  const userOpenid = normalizeUserOpenid(openid);
  const refs = [];

  (Array.isArray(db.qr_codes) ? db.qr_codes : []).forEach((qr) => {
    if (account && normalizeAccountId(qr.account_id) === account) {
      refs.push({ type: 'qr_account', id: qr.id });
    }
    if (account && normalizeAccountId(qr.co_creation_owner_account_id) === account) {
      refs.push({ type: 'qr_co_creation_owner', id: qr.id });
    }
    (Array.isArray(qr.co_creation_comments) ? qr.co_creation_comments : []).forEach((comment) => {
      if (account && normalizeAccountId(comment.account_id) === account) {
        refs.push({ type: 'qr_co_creation_comment', id: qr.id, comment_id: comment.id });
      }
    });
  });

  (Array.isArray(db.orders) ? db.orders : []).forEach((order) => {
    if (account && normalizeAccountId(order.account_id) === account) {
      refs.push({ type: 'order_account', id: order.id });
    }
    if (userOpenid && normalizeUserOpenid(order.openid) === userOpenid) {
      refs.push({ type: 'order_openid', id: order.id });
    }
  });

  (Array.isArray(db.payment_logs) ? db.payment_logs : []).forEach((log) => {
    if (account && containsValueDeep(log, account)) {
      refs.push({ type: 'payment_log_account', id: log.id });
    }
    if (userOpenid && containsValueDeep(log, userOpenid)) {
      refs.push({ type: 'payment_log_openid', id: log.id });
    }
  });

  return refs;
}

function ensureSingleUserAccount(db, user, reason) {
  const accountUsers = usersForAccount(db, user && user.account_id);
  if (!user || accountUsers.length !== 1 || String(accountUsers[0].id) !== String(user.id)) {
    logMiniappBindConflict(reason, { userIds: accountUsers.map((item) => item.id) });
    return false;
  }
  return true;
}

function ensureDisposableMiniappUser(db, user, targetOpenid) {
  if (
    !user ||
    normalizeUserPhone(user.phone) ||
    normalizeUserOpenid(user.openid) !== normalizeUserOpenid(targetOpenid) ||
    !isMiniappOnlySource(user.source)
  ) {
    logMiniappBindConflict('temporary_user_not_disposable', { userIds: user ? [user.id] : [] });
    return false;
  }
  if (!ensureSingleUserAccount(db, user, 'temporary_account_not_unique')) {
    return false;
  }
  const refs = collectMiniappIdentityReferences(db, {
    accountId: user.account_id,
    openid: user.openid
  });
  if (refs.length > 0) {
    logMiniappBindConflict('temporary_identity_has_linked_data', {
      userIds: [user.id],
      orderIds: refs.filter((item) => item.type.startsWith('order')).map((item) => item.id)
    });
    return false;
  }
  return true;
}

function createOrGetMiniappUser({ openid, unionid = null }) {
  const db = readDB();
  const targetOpenid = normalizeUserOpenid(openid);
  let user = findUniqueUserByOpenid(db, targetOpenid);
  if (user) {
    requireMappedUser(db, user);
    if (unionid && user.unionid !== unionid) {
      user = { ...user, unionid };
      db.users = db.users.map((item) => (String(item.id) === String(user.id) ? user : item));
      writeDB(db);
    }
    return user;
  }

  const createdAt = nowISO();
  const accountId = createAccountForUser(db, {
    createdFrom: 'miniapp_openid',
    createdAt
  });
  user = {
    id: getNextUserId(db),
    phone: null,
    openid: targetOpenid,
    unionid,
    source: 'miniapp',
    created_at: createdAt,
    account_id: accountId
  };
  db.users.push(user);
  writeDB(db);
  return user;
}

function bindMiniappUserPhone({ openid, phone, unionid = null }) {
  let context;
  try {
    context = readDBWithHash();
  } catch (error) {
    logMiniappBindConflict('read_failed');
    return { error: 'MINIAPP_ACCOUNT_CONFLICT' };
  }

  const { db, sourceHash } = context;
  const targetOpenid = normalizeUserOpenid(openid);
  const targetPhone = normalizeUserPhone(phone);
  const openidUsers = db.users.filter((item) => normalizeUserOpenid(item.openid) === targetOpenid);
  if (openidUsers.length !== 1) {
    logMiniappBindConflict('openid_not_unique', { userIds: openidUsers.map((item) => item.id) });
    return { error: openidUsers.length === 0 ? 'MINIAPP_USER_NOT_FOUND' : 'MINIAPP_ACCOUNT_CONFLICT' };
  }

  const miniUser = openidUsers[0];
  try {
    requireMappedUser(db, miniUser);
  } catch (error) {
    return { error: error.code || 'MINIAPP_ACCOUNT_CONFLICT' };
  }
  if (!ensureSingleUserAccount(db, miniUser, 'current_account_not_unique')) {
    return { error: 'MINIAPP_ACCOUNT_CONFLICT' };
  }

  const phoneUsers = db.users.filter((item) => normalizeUserPhone(item.phone) === targetPhone);
  if (phoneUsers.length > 1) {
    logMiniappBindConflict('phone_not_unique', { userIds: phoneUsers.map((item) => item.id) });
    return { error: 'MINIAPP_ACCOUNT_CONFLICT' };
  }

  const nextUnionid = unionid || miniUser.unionid || null;
  const miniUserPhone = normalizeUserPhone(miniUser.phone);
  let finalUser = null;
  let changed = false;

  if (miniUserPhone) {
    if (miniUserPhone !== targetPhone) {
      return { error: 'MINIAPP_PHONE_REPLACE_REQUIRED' };
    }
    finalUser = {
      ...miniUser,
      phone: targetPhone,
      unionid: nextUnionid,
      source: miniUser.source || 'miniapp'
    };
    changed = JSON.stringify(finalUser) !== JSON.stringify(miniUser);
    if (changed) {
      db.users = db.users.map((item) => (item.id === miniUser.id ? finalUser : item));
    }
  } else {
    const phoneUser = phoneUsers[0] || null;
    if (!phoneUser || phoneUser.id === miniUser.id) {
      finalUser = {
        ...miniUser,
        phone: targetPhone,
        unionid: nextUnionid,
        source: miniUser.source || 'miniapp'
      };
      db.users = db.users.map((item) => (item.id === miniUser.id ? finalUser : item));
      changed = true;
    } else {
      try {
        requireMappedUser(db, phoneUser);
      } catch (_error) {
        logMiniappBindConflict('phone_user_missing_account', { userIds: [phoneUser.id, miniUser.id] });
        return { error: 'MINIAPP_ACCOUNT_CONFLICT' };
      }
      if (!ensureSingleUserAccount(db, phoneUser, 'target_account_not_unique')) {
        return { error: 'MINIAPP_ACCOUNT_CONFLICT' };
      }
      if (!ensureDisposableMiniappUser(db, miniUser, targetOpenid)) {
        return { error: 'MINIAPP_ACCOUNT_CONFLICT' };
      }

      finalUser = {
        ...phoneUser,
        phone: targetPhone,
        openid: targetOpenid,
        unionid: nextUnionid,
        source: sourceWithMiniapp(phoneUser.source)
      };
      db.users = db.users
        .filter((item) => item.id !== miniUser.id)
        .map((item) => (item.id === phoneUser.id ? finalUser : item));
      db.accounts = (Array.isArray(db.accounts) ? db.accounts : [])
        .filter((item) => item.id !== miniUser.account_id);
      changed = true;
    }
  }

  if (changed) {
    try {
      writeDBAtomicallyIfUnchanged(db, sourceHash, 'DB_CHANGED_DURING_BIND');
    } catch (error) {
      logMiniappBindConflict(error.code || 'atomic_write_failed', { userIds: [miniUser.id] });
      return { error: 'MINIAPP_ACCOUNT_CONFLICT' };
    }
  }

  return { data: finalUser };
}

function getQRCode(qrId) {
  const db = readDB();
  return db.qr_codes.find((item) => item.id === qrId) || null;
}

function findRecordByChainOperationId(operationId) {
  const db = readDB();
  const target = String(operationId || '').trim();
  if (!target) return null;
  return db.qr_codes.find((item) => item.chain_operation_id === target) || null;
}

function updateRecordChainProof(qrId, patch = {}) {
  const db = readDB();
  const index = db.qr_codes.findIndex((item) => item.id === qrId);
  if (index === -1) return null;

  const current = db.qr_codes[index];
  const manifestHash = patch.manifest_hash || current.manifest_hash || current.blockchain_hash || null;
  const next = {
    ...current,
    ...patch,
    chain_provider: patch.chain_provider || current.chain_provider || 'avata_wenchang',
    chain_status: normalizeChainStatus(patch.chain_status || current.chain_status, !!manifestHash),
    manifest_hash: manifestHash,
    blockchain_hash: patch.blockchain_hash || current.blockchain_hash || manifestHash
  };
  db.qr_codes[index] = next;
  writeDB(db);
  return next;
}

function getDatabaseSnapshot() {
  const { db, sourceHash } = readDBWithHash();
  const snapshot = JSON.parse(JSON.stringify(db));
  databaseSourceHashes.set(snapshot, sourceHash);
  return snapshot;
}

function getDatabaseSnapshotWithHash() {
  const { db, sourceHash } = readDBWithHash();
  const snapshot = JSON.parse(JSON.stringify(db));
  databaseSourceHashes.set(snapshot, sourceHash);
  return { snapshot, sourceHash };
}

function writeDatabaseSnapshot(snapshot, { expectedSourceHash } = {}) {
  const sourceHash = expectedSourceHash || databaseSourceHashes.get(snapshot);
  if (!sourceHash) {
    throw databaseError(
      'DB_SNAPSHOT_SOURCE_HASH_REQUIRED',
      'Snapshot writes require the source hash captured when the database was read.'
    );
  }
  writeDBAtomicallyIfUnchanged(snapshot, sourceHash, 'DB_WRITE_CONFLICT');
  return readDB();
}

function findQRByToken(token) {
  const db = readDB();
  return db.qr_codes.find((item) => item.qr_access_token === token) || null;
}

function findQRByKey(key) {
  const byToken = findQRByToken(key);
  if (byToken) return byToken;
  return getQRCode(key);
}

function findPublicQrReadContextByKey(key) {
  const normalizedKey = String(key || '').trim();
  const { db, sourceHash } = readDBWithHash();
  const publicQrDomainHash = getPublicQrDomainHash(db, sourceHash);
  if (!normalizedKey) {
    return { qr: null, batch: null, sourceHash, publicQrDomainHash };
  }

  const qr = db.qr_codes.find((item) => item.qr_access_token === normalizedKey)
    || db.qr_codes.find((item) => item.id === normalizedKey)
    || null;
  const batch = qr && qr.batch_id
    ? db.batches.find((item) => item.id === qr.batch_id) || null
    : null;
  return { qr, batch, sourceHash, publicQrDomainHash };
}

function getPublicQrDomainHash(db, sourceHash) {
  if (!publicQrDomainHashCache || publicQrDomainHashCache.sourceHash !== sourceHash) {
    publicQrDomainHashCache = {
      sourceHash,
      domainHash: publicQrDomainSha256FromSource(db)
    };
  }
  return publicQrDomainHashCache.domainHash;
}

function getSampleUnactivated() {
  const db = readDB();
  // 优先返回有 token 的（新数据），旧数据无 token 跳过
  return db.qr_codes.find((item) =>
    item.activation_status === 'unactivated' &&
    item.hidden !== true &&
    item.qr_access_token
  ) || null;
}

function findRecordImageUploadEligibilityByAccessToken(accessToken) {
  const token = String(accessToken || '').trim();
  if (!token) return null;
  const db = readDB();
  const qr = db.qr_codes.find((item) => item.qr_access_token === token) || null;
  if (!qr || qr.issue_status !== 'issued' || qr.activation_status !== 'unactivated') {
    return null;
  }
  return Object.freeze({ id: String(qr.id) });
}

function verifiedRecordImageClaim(payload, qrCode, accountId) {
  const claim = payload && payload.upload_claim;
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)
      || String(claim.account_id || '') !== accountId
      || String(claim.qr_id || '') !== String(qrCode.id)
      || typeof claim.object_key !== 'string'
      || !claim.object_key.trim()) {
    return null;
  }
  return claim;
}

function activateQRCodeOnce(qrId, payload) {
  const accountId = payloadAccountId(payload);
  if (!accountId) {
    return { error: 'ACCOUNT_CONTEXT_REQUIRED' };
  }

  const db = readDB();
  const index = db.qr_codes.findIndex((item) => item.id === qrId);
  if (index === -1) {
    return { error: 'QR_NOT_FOUND' };
  }

  const qrCode = db.qr_codes[index];
  if (qrCode.issue_status !== 'issued') {
    return { error: 'QR_NOT_ISSUED' };
  }
  if (qrCode.activation_status !== 'unactivated') {
    return { error: 'QR_ALREADY_ACTIVATED', data: qrCode };
  }
  const uploadClaim = verifiedRecordImageClaim(payload, qrCode, accountId);
  if (!uploadClaim) {
    return { error: 'UPLOAD_PROOF_INVALID' };
  }
  if (violatesContentPrivacy(db, accountId, payload.content)) {
    return { error: 'CONTENT_PRIVACY_REJECTED' };
  }

  const showBrandDisclosure = payload.show_brand_disclosure === true;
  const batch = qrCode.batch_id ? db.batches.find((item) => item.id === qrCode.batch_id) : null;
  const batchDisclosure = batch ? String(batch.brand_disclosure_text || '') : '';

  const updated = {
    ...qrCode,
    activation_status: 'activated',
    content: payload.content,
    image_url: null,
    image_object_key: uploadClaim.object_key,
    phone: payload.phone,
    account_id: accountId,
    activated_at: nowISO(),
    blockchain_hash: payload.blockchain_hash,
    co_creation_enabled: qrCode.co_creation_enabled === true,
    co_creation_owner_phone: qrCode.co_creation_owner_phone || null,
    co_creation_comments: (qrCode.co_creation_comments || []).map((comment) => ({
      ...comment,
      status: comment.status || 'kept'
    })),
    show_brand_disclosure: showBrandDisclosure,
    brand_disclosure_text_snapshot: showBrandDisclosure ? batchDisclosure : ''
  };

  db.qr_codes[index] = updated;
  writeDB(db);

  return { data: updated };
}

function activateQRByKey(key, payload) {
  const db = readDB();
  const byToken = db.qr_codes.findIndex((item) => item.qr_access_token === key);
  if (byToken !== -1) {
    const qr = db.qr_codes[byToken];
    return activateQRCodeOnce(qr.id, payload);
  }
  return { error: 'QR_NOT_FOUND' };
}

function startCoCreationOnce(qrId, payload) {
  const accountId = payloadAccountId(payload);
  if (!accountId) {
    return { error: 'ACCOUNT_CONTEXT_REQUIRED' };
  }

  const db = readDB();
  const index = db.qr_codes.findIndex((item) => item.id === qrId);
  if (index === -1) {
    return { error: 'QR_NOT_FOUND' };
  }

  const qrCode = db.qr_codes[index];
  if (qrCode.issue_status !== 'issued') {
    return { error: 'QR_NOT_ISSUED' };
  }
  if (qrCode.activation_status !== 'unactivated') {
    return { error: 'QR_ALREADY_ACTIVATED', data: qrCode };
  }
  const uploadClaim = verifiedRecordImageClaim(payload, qrCode, accountId);
  if (!uploadClaim) {
    return { error: 'UPLOAD_PROOF_INVALID' };
  }
  if (violatesContentPrivacy(db, accountId, payload.content)) {
    return { error: 'CONTENT_PRIVACY_REJECTED' };
  }
  const showBrandDisclosure = payload.show_brand_disclosure === true;
  const batch = qrCode.batch_id ? db.batches.find((item) => item.id === qrCode.batch_id) : null;
  const batchDisclosure = batch ? String(batch.brand_disclosure_text || '') : '';

  const updated = {
    ...qrCode,
    activation_status: 'co_creating',
    co_creation_enabled: true,
    co_creation_owner_phone: payload.phone,
    co_creation_owner_account_id: accountId,
    co_creation_comments: [],
    co_creation_started_at: nowISO(),
    content: payload.content,
    image_url: null,
    image_object_key: uploadClaim.object_key,
    phone: payload.phone,
    account_id: accountId,
    show_brand_disclosure: showBrandDisclosure,
    brand_disclosure_text_snapshot: showBrandDisclosure ? batchDisclosure : ''
  };

  db.qr_codes[index] = updated;
  writeDB(db);

  return { data: updated };
}

function startCoCreationByKey(key, payload) {
  const db = readDB();
  const byToken = db.qr_codes.findIndex((item) => item.qr_access_token === key);
  if (byToken !== -1) {
    return startCoCreationOnce(db.qr_codes[byToken].id, payload);
  }
  return { error: 'QR_NOT_FOUND' };
}

function addCoCreationCommentByKey(key, { phone, account_id: accountIdValue, authorName, content }) {
  const accountId = normalizeAccountId(accountIdValue);
  if (!accountId) {
    return { error: 'ACCOUNT_CONTEXT_REQUIRED' };
  }

  const db = readDB();
  const index = db.qr_codes.findIndex((item) => item.qr_access_token === key || item.id === key);
  if (index === -1) {
    return { error: 'QR_NOT_FOUND' };
  }

  const qrCode = db.qr_codes[index];
  if (qrCode.activation_status !== 'co_creating' || qrCode.co_creation_enabled !== true) {
    return { error: 'CO_CREATION_CLOSED' };
  }

  const comments = Array.isArray(qrCode.co_creation_comments) ? qrCode.co_creation_comments.slice() : [];
  const activeComments = comments.filter((item) => item.status !== 'deleted');
  if (activeComments.some((item) => normalizeAccountId(item.account_id) === accountId)) {
    return { error: 'CO_CREATION_COMMENT_EXISTS' };
  }
  if (activeComments.length >= CO_CREATION_COMMENT_LIMIT) {
    return { error: 'CO_CREATION_COMMENT_LIMIT_REACHED' };
  }
  if (violatesContentPrivacy(db, accountId, content)) {
    return { error: 'CONTENT_PRIVACY_REJECTED' };
  }

  const comment = {
    id: comments.length > 0 ? Math.max(...comments.map((item) => Number(item.id) || 0)) + 1 : 1,
    phone,
    account_id: accountId,
    author_name: authorName,
    content,
    status: 'kept',
    created_at: nowISO()
  };

  comments.push(comment);
  db.qr_codes[index] = {
    ...qrCode,
    co_creation_comments: comments
  };
  writeDB(db);

  return { data: comment };
}

function deleteCoCreationCommentByKey(key, { commentId, account_id: accountIdValue }) {
  const accountId = normalizeAccountId(accountIdValue);
  if (!accountId) {
    return { error: 'ACCOUNT_CONTEXT_REQUIRED' };
  }

  const db = readDB();
  const index = db.qr_codes.findIndex((item) => item.qr_access_token === key || item.id === key);
  if (index === -1) {
    return { error: 'QR_NOT_FOUND' };
  }

  const qrCode = db.qr_codes[index];
  const ownerAccountId = normalizeAccountId(qrCode.co_creation_owner_account_id);
  if (qrCode.activation_status !== 'co_creating' || !ownerAccountId || ownerAccountId !== accountId) {
    return { error: 'FORBIDDEN' };
  }

  const comments = Array.isArray(qrCode.co_creation_comments) ? qrCode.co_creation_comments : [];
  const found = comments.some((item) => String(item.id) === String(commentId) && item.status !== 'deleted');
  if (!found) {
    return { error: 'COMMENT_NOT_FOUND' };
  }

  const next = {
    ...qrCode,
    co_creation_comments: comments.map((item) => (
      String(item.id) === String(commentId)
        ? { ...item, status: 'deleted', deleted_at: nowISO() }
        : item
    ))
  };

  db.qr_codes[index] = next;
  writeDB(db);

  return { data: next };
}

function finalizeCoCreationByKey(key, { account_id: accountIdValue, blockchain_hash: blockchainHash }) {
  const accountId = normalizeAccountId(accountIdValue);
  if (!accountId) {
    return { error: 'ACCOUNT_CONTEXT_REQUIRED' };
  }

  const db = readDB();
  const index = db.qr_codes.findIndex((item) => item.qr_access_token === key || item.id === key);
  if (index === -1) {
    return { error: 'QR_NOT_FOUND' };
  }

  const qrCode = db.qr_codes[index];
  if (qrCode.activation_status !== 'co_creating' || qrCode.co_creation_enabled !== true) {
    return { error: 'CO_CREATION_CLOSED' };
  }
  const ownerAccountId = normalizeAccountId(qrCode.co_creation_owner_account_id);
  if (!ownerAccountId || ownerAccountId !== accountId) {
    return { error: 'FORBIDDEN' };
  }

  const updated = {
    ...qrCode,
    activation_status: 'activated',
    activated_at: nowISO(),
    blockchain_hash: blockchainHash,
    account_id: ownerAccountId,
    co_creation_comments: (qrCode.co_creation_comments || []).map((comment) => ({
      ...comment,
      status: comment.status || 'kept'
    }))
  };

  db.qr_codes[index] = updated;
  writeDB(db);

  return { data: updated };
}

function findAdmin(username, password) {
  const db = readDB();
  return db.admins.find((item) => (
    item.username === username
    && item.enabled !== false
    && verifyPassword(password, item.password)
  )) || null;
}


function listOperators(role) {
  const db = readDB();
  let records = db.admins.slice();
  if (role) {
    records = records.filter((item) => item.role === role);
  }
  return records.map((item) => ({
    id: item.id,
    username: item.username,
    role: item.role,
    name: item.name,
    enabled: item.enabled !== false
  }));
}

function createOperator({ username, password, role, name }) {
  const db = readDB();
  const existed = db.admins.find((item) => item.username === username);
  if (existed) {
    return { error: 'USERNAME_EXISTS' };
  }

  const operator = {
    id: db.admins.length + 1,
    username,
    password: hashPassword(password),
    role,
    name,
    enabled: true
  };
  db.admins.push(operator);
  writeDB(db);

  return {
    data: {
      id: operator.id,
      username: operator.username,
      role: operator.role,
      name: operator.name,
      enabled: true
    }
  };
}

function setOperatorEnabled(id, enabled) {
  const db = readDB();
  const index = db.admins.findIndex((item) => String(item.id) === String(id));
  if (index === -1) {
    return null;
  }

  db.admins[index] = {
    ...db.admins[index],
    enabled
  };
  writeDB(db);

  return {
    id: db.admins[index].id,
    username: db.admins[index].username,
    role: db.admins[index].role,
    name: db.admins[index].name,
    enabled: db.admins[index].enabled
  };
}

function changeOperatorPassword(id, newPassword) {
  const db = readDB();
  const index = db.admins.findIndex((item) => String(item.id) === String(id));
  if (index === -1) {
    return null;
  }

  db.admins[index] = {
    ...db.admins[index],
    password: hashPassword(newPassword)
  };
  writeDB(db);

  return {
    id: db.admins[index].id,
    username: db.admins[index].username
  };
}

function localDateKey(value = new Date()) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localDayBoundary(value, endOfDay = false) {
  if (!value) return null;
  const [year, month, day] = String(value).split('-').map(Number);
  if (!year || !month || !day) return null;
  const date = new Date(year, month - 1, day);
  if (endOfDay) {
    date.setHours(23, 59, 59, 999);
  }
  return date.getTime();
}

function sameLocalDate(value, datePrefix) {
  if (!value) return false;
  return localDateKey(value) === datePrefix;
}

function chainPayload(item = {}) {
  return {
    chain_provider: item.chain_provider || 'avata_wenchang',
    chain_status: item.chain_status || 'not_started',
    chain_operation_id: item.chain_operation_id || null,
    manifest_object_key: item.manifest_object_key || null,
    manifest_hash: item.manifest_hash || item.blockchain_hash || null,
    chain_tx_hash: item.chain_tx_hash || null,
    chain_block_height: item.chain_block_height || null,
    chain_record_id: item.chain_record_id || null,
    chain_certificate_url: item.chain_certificate_url || null,
    chain_certificate_object_key: item.chain_certificate_object_key || null,
    chain_certificate_object_url: item.chain_certificate_object_url || null,
    chain_confirmed_at: item.chain_confirmed_at || null,
    chain_callback_received_at: item.chain_callback_received_at || null,
    chain_last_error: item.chain_last_error || '',
    chain_retry_count: Number(item.chain_retry_count || 0),
    image_sha256: item.image_sha256 || null,
    legacy_manifest_object_key: item.legacy_manifest_object_key || null,
    archive_index_object_key: item.archive_index_object_key || null,
    archive_status: item.archive_status || 'not_started',
    archive_last_error: item.archive_last_error || '',
    archive_updated_at: item.archive_updated_at || null
  };
}

function getDashboardStats({ dateFrom, dateTo }) {
  const db = readDB();

  const totalIssued = db.qr_codes.filter((item) => item.issue_status === 'issued').length;
  const totalActivated = db.qr_codes.filter((item) => item.activation_status === 'activated').length;
  const coCreating = db.qr_codes.filter((item) => item.activation_status === 'co_creating').length;
  const circulatingPending = db.qr_codes.filter(
    (item) => item.issue_status === 'issued' && item.activation_status === 'unactivated'
  ).length;
  const hiddenRecords = db.qr_codes.filter((item) => item.hidden === true).length;
  const publishedProducts = db.products.filter((item) => item.status === 'published').length;
  const today = localDateKey();
  const todayNewRecords = db.qr_codes.filter((item) => (
    item.activation_status === 'activated' && sameLocalDate(item.activated_at, today)
  ) || (
    item.activation_status === 'co_creating' && sameLocalDate(item.co_creation_started_at, today)
  )).length;
  const todayQualityLogs = db.quality_check_logs.filter((item) => sameLocalDate(item.checked_at, today));
  const todayQualityAbnormal = todayQualityLogs.filter((item) => item.result !== 'pass').length;
  const chainPending = db.qr_codes.filter((item) => item.activation_status === 'activated' && ['not_started', 'manifest_ready'].includes(item.chain_status)).length;
  const chainProcessing = db.qr_codes.filter((item) => ['submitting', 'submitted', 'retrying'].includes(item.chain_status)).length;
  const chainConfirmed = db.qr_codes.filter((item) => item.chain_status === 'confirmed').length;
  const chainFailed = db.qr_codes.filter((item) => item.chain_status === 'failed').length;

  const from = localDayBoundary(dateFrom);
  const to = localDayBoundary(dateTo, true);

  const filteredIssued = db.qr_codes.filter((item) => {
    if (!item.created_at) return false;
    const ts = new Date(item.created_at).getTime();
    if (Number.isNaN(ts)) return false;
    if (from && ts < from) return false;
    if (to && ts > to) return false;
    return item.issue_status === 'issued';
  }).length;

  const filteredActivated = db.qr_codes.filter((item) => {
    if (!item.activated_at) return false;
    const ts = new Date(item.activated_at).getTime();
    if (Number.isNaN(ts)) return false;
    if (from && ts < from) return false;
    if (to && ts > to) return false;
    return item.activation_status === 'activated';
  }).length;

  const activationRate = filteredIssued > 0 ? Number(((filteredActivated / filteredIssued) * 100).toFixed(2)) : 0;

  return {
    total_issued: totalIssued,
    total_activated: totalActivated,
    total_co_creating: coCreating,
    circulating_pending: circulatingPending,
    today_new_records: todayNewRecords,
    published_products: publishedProducts,
    hidden_records: hiddenRecords,
    today_quality_checked: todayQualityLogs.length,
    today_quality_abnormal: todayQualityAbnormal,
    chain_pending: chainPending,
    chain_processing: chainProcessing,
    chain_confirmed: chainConfirmed,
    chain_failed: chainFailed,
    period_issued: filteredIssued,
    period_activated: filteredActivated,
    period_activation_rate: activationRate
  };
}

function listQRRecords({ issueStatus, activationStatus, hidden, idPrefix, batchId, dateFrom, dateTo, page = 1, limit = 20 }) {
  const db = readDB();
  const from = localDayBoundary(dateFrom);
  const to = localDayBoundary(dateTo, true);

  let records = db.qr_codes.slice();

  if (issueStatus) {
    records = records.filter((item) => item.issue_status === issueStatus);
  }

  if (activationStatus === 'content') {
    records = records.filter((item) => ['activated', 'co_creating'].includes(item.activation_status));
  } else if (activationStatus) {
    records = records.filter((item) => item.activation_status === activationStatus);
  }

  if (hidden === 'true' || hidden === 'false') {
    const hiddenValue = hidden === 'true';
    records = records.filter((item) => item.hidden === hiddenValue);
  }

  if (idPrefix) {
    const keyword = String(idPrefix).toUpperCase();
    records = records.filter((item) => item.id.toUpperCase().startsWith(keyword));
  }

  if (batchId) {
    records = records.filter((item) => item.batch_id === batchId);
  }

  if (from || to) {
    records = records.filter((item) => {
      const baseTime = item.activated_at || item.co_creation_started_at || item.created_at;
      const ts = new Date(baseTime).getTime();
      if (Number.isNaN(ts)) return false;
      if (from && ts < from) return false;
      if (to && ts > to) return false;
      return true;
    });
  }

  records.sort((a, b) => {
    const aTime = a.activated_at || a.co_creation_started_at || a.created_at;
    const bTime = b.activated_at || b.co_creation_started_at || b.created_at;
    return new Date(bTime) - new Date(aTime);
  });

  const total = records.length;
  const start = (Number(page) - 1) * Number(limit);
  const end = start + Number(limit);

  return {
    total,
    page: Number(page),
    limit: Number(limit),
    records: records.slice(start, end)
  };
}

function listActivatedRecordsByPhone(phone) {
  const db = readDB();
  const target = String(phone || '').trim();
  if (!target) return [];

  return db.qr_codes
    .filter((item) => (
      (item.activation_status === 'activated' && item.phone === target)
      || (item.activation_status === 'co_creating' && item.co_creation_owner_phone === target)
    ))
    .sort((a, b) => {
      const aTime = a.activated_at || a.co_creation_started_at || a.created_at;
      const bTime = b.activated_at || b.co_creation_started_at || b.created_at;
      return new Date(bTime) - new Date(aTime);
    })
    .map((item) => ({
      id: item.id,
      content: item.content || '',
      image_url: item.image_url || null,
      image_object_key: item.image_object_key || null,
      activated_at: item.activated_at || null,
      display_at: item.activated_at || item.co_creation_started_at || item.created_at,
      activation_status: item.activation_status,
      blockchain_hash: item.blockchain_hash || null,
      ...chainPayload(item),
      co_creation_enabled: item.co_creation_enabled === true,
      co_creation_comments: Array.isArray(item.co_creation_comments) ? item.co_creation_comments : []
    }));
}

function attachRecordMediaAuthority(record, item) {
  Object.defineProperty(record, 'record_media_authority', {
    value: Object.freeze({
      qrId: String(item.id || ''),
      accessToken: String(item.qr_access_token || '')
    }),
    enumerable: false,
    configurable: false,
    writable: false
  });
  return record;
}

function mapPersonalRecord(item) {
  return attachRecordMediaAuthority({
    id: item.id,
    content: item.content || '',
    image_url: item.image_url || null,
    image_object_key: item.image_object_key || null,
    activated_at: item.activated_at || null,
    display_at: item.activated_at || item.co_creation_started_at || item.created_at,
    activation_status: item.activation_status,
    blockchain_hash: item.blockchain_hash || null,
    ...chainPayload(item),
    co_creation_enabled: item.co_creation_enabled === true,
    co_creation_comments: Array.isArray(item.co_creation_comments) ? item.co_creation_comments : [],
    show_brand_disclosure: item.show_brand_disclosure === true,
    brand_disclosure_text_snapshot: item.brand_disclosure_text_snapshot || '',
    batch_id: item.batch_id || null
  }, item);
}

function mapActivatedRecordDetail(item) {
  return attachRecordMediaAuthority({
    id: item.id,
    content: item.content || '',
    image_url: item.image_url || null,
    image_object_key: item.image_object_key || null,
    activated_at: item.activated_at,
    blockchain_hash: item.blockchain_hash || null,
    ...chainPayload(item),
    co_creation_enabled: item.co_creation_enabled === true,
    co_creation_comments: Array.isArray(item.co_creation_comments) ? item.co_creation_comments : [],
    show_brand_disclosure: item.show_brand_disclosure === true,
    brand_disclosure_text_snapshot: item.brand_disclosure_text_snapshot || '',
    batch_id: item.batch_id || null
  }, item);
}

function findPersonalRecordListContextByAccountId(accountIdValue) {
  const { db, sourceHash } = readDBWithHash();
  const publicQrDomainHash = getPublicQrDomainHash(db, sourceHash);
  const target = normalizeAccountId(accountIdValue);
  if (!target) return { records: [], sourceHash, publicQrDomainHash };

  const records = db.qr_codes
    .filter((item) => (
      (item.activation_status === 'activated' && normalizeAccountId(item.account_id) === target)
      || (item.activation_status === 'co_creating' && normalizeAccountId(item.co_creation_owner_account_id) === target)
    ))
    .sort((a, b) => {
      const aTime = a.activated_at || a.co_creation_started_at || a.created_at;
      const bTime = b.activated_at || b.co_creation_started_at || b.created_at;
      const timeDifference = new Date(bTime) - new Date(aTime);
      return timeDifference || String(a.id).localeCompare(String(b.id));
    })
    .map(mapPersonalRecord);
  return { records, sourceHash, publicQrDomainHash };
}

function listActivatedRecordsByAccountId(accountIdValue) {
  return findPersonalRecordListContextByAccountId(accountIdValue).records;
}

function listActivatedRecordsByMiniappOpenid(openid) {
  const user = findUserByOpenid(openid);
  if (!user || !user.phone) {
    return [];
  }
  return listActivatedRecordsByPhone(user.phone);
}

function getActivatedRecordByPhoneAndId({ phone, id }) {
  const db = readDB();
  const targetPhone = String(phone || '').trim();
  const targetId = String(id || '').trim();
  if (!targetPhone || !targetId) return null;

  const matched = db.qr_codes.find((item) =>
    item.activation_status === 'activated'
    && item.phone === targetPhone
    && item.id === targetId
  );

  if (!matched) return null;

  return {
    id: matched.id,
    content: matched.content || '',
    image_url: matched.image_url || null,
    image_object_key: matched.image_object_key || null,
    activated_at: matched.activated_at,
    blockchain_hash: matched.blockchain_hash || null,
    ...chainPayload(matched),
    co_creation_enabled: matched.co_creation_enabled === true,
    co_creation_comments: Array.isArray(matched.co_creation_comments) ? matched.co_creation_comments : [],
    show_brand_disclosure: matched.show_brand_disclosure === true,
    brand_disclosure_text_snapshot: matched.brand_disclosure_text_snapshot || '',
    batch_id: matched.batch_id || null
  };
}

function findPersonalRecordDetailContext({ account_id: accountIdValue, id }) {
  const { db, sourceHash } = readDBWithHash();
  const publicQrDomainHash = getPublicQrDomainHash(db, sourceHash);
  const targetAccountId = normalizeAccountId(accountIdValue);
  const targetId = String(id || '').trim();
  if (!targetAccountId || !targetId) {
    return { record: null, batch: null, sourceHash, publicQrDomainHash };
  }

  const matched = db.qr_codes.find((item) =>
    item.activation_status === 'activated'
    && normalizeAccountId(item.account_id) === targetAccountId
    && item.id === targetId
  );

  if (!matched) return { record: null, batch: null, sourceHash, publicQrDomainHash };

  const record = mapActivatedRecordDetail(matched);
  const batch = record.batch_id
    ? db.batches.find((item) => item.id === record.batch_id) || null
    : null;
  return { record, batch, sourceHash, publicQrDomainHash };
}

function getActivatedRecordByAccountIdAndId(input) {
  return findPersonalRecordDetailContext(input).record;
}

function getActivatedRecordByMiniappOpenidAndId({ openid, id }) {
  const user = findUserByOpenid(openid);
  if (!user || !user.phone) {
    return null;
  }
  return getActivatedRecordByPhoneAndId({ phone: user.phone, id });
}

function normalizeProductInput(input = {}, existing = {}) {
  const images = Array.isArray(input.images)
    ? input.images
    : String(input.images || '')
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean);
  const hasCustomizableInput = input.is_customizable !== undefined && input.is_customizable !== null;

  return {
    title: String(input.title ?? existing.title ?? '').trim(),
    subtitle: String(input.subtitle ?? existing.subtitle ?? '').trim(),
    cover_image: String(input.cover_image ?? existing.cover_image ?? '').trim(),
    images,
    price_text: String(input.price_text ?? existing.price_text ?? '').trim(),
    price_cents: Math.max(0, Math.round(Number(input.price_cents ?? existing.price_cents ?? 0) || 0)),
    description: String(input.description ?? existing.description ?? '').trim(),
    status: ['draft', 'published', 'hidden'].includes(input.status) ? input.status : (existing.status || 'draft'),
    product_type: PRODUCT_TYPES.includes(input.product_type) ? input.product_type : (existing.product_type || 'wine_sticker'),
    sticker_count: Math.max(1, Math.round(Number(input.sticker_count ?? existing.sticker_count ?? 1) || 1)),
    stock: Math.max(0, Math.round(Number(input.stock ?? existing.stock ?? 0) || 0)),
    is_customizable: hasCustomizableInput
      ? input.is_customizable === true || input.is_customizable === 'true'
      : existing.is_customizable === true,
    shipping_note: String(input.shipping_note ?? existing.shipping_note ?? '现货贴纸通常 48 小时内发出。').trim(),
    after_sale_note: String(input.after_sale_note ?? existing.after_sale_note ?? '贴纸为印刷品，不含酒水。如有印刷或物流问题请联系客服处理。').trim(),
    buy_type: 'miniapp_order',
    buy_url: String(input.buy_url ?? existing.buy_url ?? '').trim(),
    scene_tags: normalizeProductSceneTags(input.scene_tags, existing.scene_tags),
    sort_order: Number.isFinite(Number(input.sort_order ?? existing.sort_order))
      ? Number(input.sort_order ?? existing.sort_order)
      : 0
  };
}

function isSafeProductImageReference(value) {
  const reference = String(value || '').trim();
  if (!reference) return true;
  if (reference.includes('\\') || reference.startsWith('//')) return false;
  let decoded = reference;
  try {
    decoded = decodeURIComponent(decodeURIComponent(reference));
  } catch (_error) {
    return false;
  }
  if (decoded.includes('\\') || decoded.split('/').includes('..')) return false;
  if (reference.startsWith('/')) return true;
  try {
    const parsed = new URL(reference);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch (_error) {
    return false;
  }
}

function validateProductData(data) {
  if (!data.title) {
    return '商品名称不能为空。';
  }
  if (data.price_cents < 0) {
    return '商品价格不能为负数。';
  }
  if (data.stock < 0) {
    return '单笔购买上限不能为负数。';
  }
  if (data.status === 'published' && data.price_cents < 1) {
    return '商品上架前必须填写有效价格。';
  }
  if (data.status === 'published' && (!Number.isInteger(data.sticker_count) || data.sticker_count < 1)) {
    return '商品上架前必须填写有效贴纸数量。';
  }
  if (data.buy_url && !/^https?:\/\//i.test(data.buy_url)) {
    return '购买链接必须以 http:// 或 https:// 开头。';
  }
  if (!isSafeProductImageReference(data.cover_image)) {
    return '商品封面图地址无效。';
  }
  if (data.images.some((image) => !isSafeProductImageReference(image))) {
    return '商品详情图地址无效。';
  }
  return '';
}

function createProduct(input) {
  const db = readDB();
  const data = normalizeProductInput(input);
  const validationMessage = validateProductData(data);
  if (validationMessage) {
    return { error: 'VALIDATION_ERROR', message: validationMessage };
  }

  const product = {
    id: `PROD_${Date.now()}_${String(db.products.length + 1).padStart(3, '0')}`,
    ...data,
    created_at: nowISO(),
    updated_at: nowISO()
  };
  db.products.push(product);
  writeDB(db);
  return { data: product };
}

function updateProduct(id, input) {
  const db = readDB();
  const index = db.products.findIndex((item) => item.id === id);
  if (index === -1) {
    return { error: 'PRODUCT_NOT_FOUND' };
  }

  const expectedUpdatedAt = String(input.expected_updated_at || '').trim();
  const currentUpdatedAt = String(db.products[index].updated_at || '').trim();
  if (!expectedUpdatedAt || expectedUpdatedAt !== currentUpdatedAt) {
    return { error: 'PRODUCT_UPDATE_CONFLICT', data: db.products[index] };
  }

  const data = normalizeProductInput(input, db.products[index]);
  const validationMessage = validateProductData(data);
  if (validationMessage) {
    return { error: 'VALIDATION_ERROR', message: validationMessage };
  }

  const now = new Date();
  const previousUpdatedAt = new Date(db.products[index].updated_at || db.products[index].created_at || 0);
  const updatedAt = now > previousUpdatedAt
    ? now.toISOString()
    : new Date(previousUpdatedAt.getTime() + 1).toISOString();
  const updated = {
    ...db.products[index],
    ...data,
    updated_at: updatedAt
  };
  db.products[index] = updated;
  writeDB(db);
  return { data: updated };
}

function listProducts({ publicOnly = false } = {}) {
  const db = readDB();
  let products = db.products.slice();
  if (publicOnly) {
    products = products.filter((item) => item.status === 'published');
  }

  return products.sort((a, b) => {
    const sortDiff = Number(a.sort_order || 0) - Number(b.sort_order || 0);
    if (sortDiff !== 0) return sortDiff;
    return new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at);
  });
}

function getProduct(id, { publicOnly = false } = {}) {
  const product = listProducts({ publicOnly }).find((item) => item.id === id);
  return product || null;
}

function orderStatusText(status) {
  return {
    pending_payment: '待支付',
    paid: '已支付',
    shipped: '已发货',
    completed: '已完成',
    cancelled: '已取消',
    refunding: '退款中',
    refunded: '已退款'
  }[status] || status || '';
}

function adminOrderStatusText(status) {
  if (status === 'paid') return '待发货';
  return orderStatusText(status);
}

function orderPayload(order) {
  if (!order) return null;
  const { account_id: _accountId, ...publicOrder } = order;
  return {
    ...publicOrder,
    status_text: orderStatusText(order.status),
    amount_text: `¥${(Number(order.total_amount_cents || 0) / 100).toFixed(2)}`
  };
}

function createMiniappOrder({ openid, phone, account_id: accountIdValue, productId, quantity, receiverName, receiverPhone, region, address, remark }) {
  const accountId = normalizeAccountId(accountIdValue);
  if (!accountId) {
    return { error: 'ACCOUNT_CONTEXT_REQUIRED' };
  }

  const db = readDB();
  const product = db.products.find((item) => item.id === productId && item.status === 'published');
  if (!product) {
    return { error: 'PRODUCT_NOT_FOUND' };
  }
  const count = Math.max(1, Math.min(99, Math.round(Number(quantity || 1))));
  if (Number(product.stock || 0) > 0 && count > Number(product.stock || 0)) {
    return { error: 'OUT_OF_STOCK' };
  }
  const normalizedReceiverName = String(receiverName || '').trim();
  const normalizedReceiverPhone = String(receiverPhone || '').trim();
  const normalizedRegion = String(region || '').trim();
  const normalizedAddress = String(address || '').trim();
  if (!normalizedReceiverName || !/^1\d{10}$/.test(normalizedReceiverPhone) || !normalizedRegion || !normalizedAddress) {
    return { error: 'VALIDATION_ERROR', message: '请填写完整收货信息。' };
  }

  const unitPrice = Math.max(0, Number(product.price_cents || 0));
  const createdAt = nowISO();
  const order = {
    id: `ORDER_${Date.now()}_${String(db.orders.length + 1).padStart(4, '0')}`,
    order_no: `JS${Date.now()}${String(db.orders.length + 1).padStart(4, '0')}`,
    openid: String(openid || ''),
    phone: String(phone || ''),
    account_id: accountId,
    product_id: product.id,
    product_snapshot: {
      id: product.id,
      title: product.title,
      subtitle: product.subtitle,
      cover_image: product.cover_image,
      price_text: product.price_text,
      price_cents: unitPrice,
      product_type: product.product_type,
      sticker_count: product.sticker_count,
      scene_tags: product.scene_tags
    },
    quantity: count,
    unit_price_cents: unitPrice,
    total_amount_cents: unitPrice * count,
    status: 'pending_payment',
    payment_status: 'unpaid',
    payment_method: '',
    payment_mock: false,
    wechat_transaction_id: '',
    paid_at: null,
    receiver_name: normalizedReceiverName,
    receiver_phone: normalizedReceiverPhone,
    region: normalizedRegion,
    address: normalizedAddress,
    remark: String(remark || '').trim(),
    express_company: '',
    express_no: '',
    shipped_at: null,
    refund_status: '',
    admin_note: '',
    created_at: createdAt,
    updated_at: createdAt
  };
  db.orders.push(order);
  writeDB(db);
  return { data: orderPayload(order) };
}

function listMiniappOrders(openid) {
  const db = readDB();
  return db.orders
    .filter((item) => item.openid === openid)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map(orderPayload);
}

function listMiniappOrdersByAccountId(accountIdValue) {
  const accountId = normalizeAccountId(accountIdValue);
  if (!accountId) return [];
  const db = readDB();
  return db.orders
    .filter((item) => normalizeAccountId(item.account_id) === accountId)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map(orderPayload);
}

function getMiniappOrder({ openid, orderId }) {
  const db = readDB();
  return orderPayload(db.orders.find((item) => item.openid === openid && item.id === orderId));
}

function getMiniappOrderByAccountId({ account_id: accountIdValue, orderId }) {
  const accountId = normalizeAccountId(accountIdValue);
  const targetOrderId = String(orderId || '').trim();
  if (!accountId || !targetOrderId) return null;
  const db = readDB();
  return orderPayload(db.orders.find((item) => normalizeAccountId(item.account_id) === accountId && item.id === targetOrderId));
}

function getOrderByOrderNo(orderNo) {
  const db = readDB();
  return orderPayload(db.orders.find((item) => item.order_no === orderNo));
}

function cancelMiniappOrder({ openid, orderId }) {
  const db = readDB();
  const index = db.orders.findIndex((item) => item.openid === openid && item.id === orderId);
  if (index === -1) return { error: 'ORDER_NOT_FOUND' };
  if (db.orders[index].status !== 'pending_payment') return { error: 'ORDER_NOT_CANCELABLE' };
  db.orders[index] = {
    ...db.orders[index],
    status: 'cancelled',
    updated_at: nowISO()
  };
  writeDB(db);
  return { data: orderPayload(db.orders[index]) };
}

function cancelMiniappOrderByAccountId({ account_id: accountIdValue, orderId }) {
  const accountId = normalizeAccountId(accountIdValue);
  const targetOrderId = String(orderId || '').trim();
  if (!accountId || !targetOrderId) return { error: 'ORDER_NOT_FOUND' };
  const db = readDB();
  const index = db.orders.findIndex((item) => normalizeAccountId(item.account_id) === accountId && item.id === targetOrderId);
  if (index === -1) return { error: 'ORDER_NOT_FOUND' };
  if (db.orders[index].status !== 'pending_payment') return { error: 'ORDER_NOT_CANCELABLE' };
  db.orders[index] = {
    ...db.orders[index],
    status: 'cancelled',
    updated_at: nowISO()
  };
  writeDB(db);
  return { data: orderPayload(db.orders[index]) };
}

function payMiniappOrderMock({ openid, orderId }) {
  const db = readDB();
  const index = db.orders.findIndex((item) => item.openid === openid && item.id === orderId);
  if (index === -1) return { error: 'ORDER_NOT_FOUND' };
  if (db.orders[index].status !== 'pending_payment') return { error: 'ORDER_NOT_PAYABLE' };
  const paidAt = nowISO();
  db.orders[index] = {
    ...db.orders[index],
    status: 'paid',
    payment_status: 'paid',
    payment_method: 'wechat_mock',
    payment_mock: true,
    wechat_transaction_id: `MOCK_${Date.now()}`,
    paid_at: paidAt,
    updated_at: paidAt
  };
  db.payment_logs.push({
    id: `PAY_${Date.now()}_${String(db.payment_logs.length + 1).padStart(4, '0')}`,
    order_id: db.orders[index].id,
    order_no: db.orders[index].order_no,
    method: 'wechat_mock',
    status: 'paid',
    amount_cents: db.orders[index].total_amount_cents,
    transaction_id: db.orders[index].wechat_transaction_id,
    raw: { mock: true },
    created_at: paidAt
  });
  writeDB(db);
  return { data: orderPayload(db.orders[index]) };
}

function payMiniappOrderMockByAccountId({ account_id: accountIdValue, orderId }) {
  const accountId = normalizeAccountId(accountIdValue);
  const targetOrderId = String(orderId || '').trim();
  if (!accountId || !targetOrderId) return { error: 'ORDER_NOT_FOUND' };
  const db = readDB();
  const index = db.orders.findIndex((item) => normalizeAccountId(item.account_id) === accountId && item.id === targetOrderId);
  if (index === -1) return { error: 'ORDER_NOT_FOUND' };
  if (db.orders[index].status !== 'pending_payment') return { error: 'ORDER_NOT_PAYABLE' };
  const paidAt = nowISO();
  db.orders[index] = {
    ...db.orders[index],
    status: 'paid',
    payment_status: 'paid',
    payment_method: 'wechat_mock',
    payment_mock: true,
    wechat_transaction_id: `MOCK_${Date.now()}`,
    paid_at: paidAt,
    updated_at: paidAt
  };
  db.payment_logs.push({
    id: `PAY_${Date.now()}_${String(db.payment_logs.length + 1).padStart(4, '0')}`,
    order_id: db.orders[index].id,
    order_no: db.orders[index].order_no,
    method: 'wechat_mock',
    status: 'paid',
    amount_cents: db.orders[index].total_amount_cents,
    transaction_id: db.orders[index].wechat_transaction_id,
    raw: { mock: true },
    created_at: paidAt
  });
  writeDB(db);
  return { data: orderPayload(db.orders[index]) };
}

function appendPaymentLog(input = {}) {
  const db = readDB();
  const createdAt = nowISO();
  db.payment_logs.push({
    id: `PAY_${Date.now()}_${String(db.payment_logs.length + 1).padStart(4, '0')}`,
    order_id: input.order_id || '',
    order_no: input.order_no || '',
    method: input.method || 'wechat',
    status: input.status || '',
    amount_cents: Number(input.amount_cents || 0),
    transaction_id: input.transaction_id || '',
    raw: input.raw || {},
    error: input.error || '',
    created_at: createdAt
  });
  writeDB(db);
}

function markOrderPaidByOrderNo({ orderNo, transactionId, paidAt, raw }) {
  const db = readDB();
  const index = db.orders.findIndex((item) => item.order_no === orderNo);
  if (index === -1) return { error: 'ORDER_NOT_FOUND' };
  const order = db.orders[index];
  const expectedAmount = Number(order.total_amount_cents || 0);
  const actualAmount = Number(raw && raw.amount && raw.amount.total);
  if (!Number.isFinite(actualAmount) || actualAmount !== expectedAmount) {
    return { error: 'AMOUNT_MISMATCH' };
  }
  if (order.payment_status === 'paid') {
    if (order.payment_method !== 'wechat') {
      return { error: 'PAYMENT_STATE_CONFLICT' };
    }
    if (order.wechat_transaction_id && transactionId && order.wechat_transaction_id !== transactionId) {
      return { error: 'TRANSACTION_MISMATCH' };
    }
    return { data: orderPayload(order), idempotent: true };
  }
  const confirmedAt = paidAt || nowISO();
  db.orders[index] = {
    ...order,
    status: ['shipped', 'completed'].includes(order.status) ? order.status : 'paid',
    payment_status: 'paid',
    payment_method: 'wechat',
    payment_mock: false,
    wechat_transaction_id: transactionId || order.wechat_transaction_id || '',
    paid_at: order.paid_at || confirmedAt,
    updated_at: confirmedAt
  };
  db.payment_logs.push({
    id: `PAY_${Date.now()}_${String(db.payment_logs.length + 1).padStart(4, '0')}`,
    order_id: order.id,
    order_no: order.order_no,
    method: 'wechat',
    status: 'paid',
    amount_cents: expectedAmount,
    transaction_id: transactionId || '',
    raw: raw || {},
    created_at: confirmedAt
  });
  writeDB(db);
  return { data: orderPayload(db.orders[index]) };
}

function maskOrderPhone(value) {
  const phone = String(value || '').trim();
  if (!phone) return '';
  if (/^1\d{10}$/.test(phone)) return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
  if (phone.length <= 4) return '*'.repeat(phone.length);
  return `${phone.slice(0, 2)}***${phone.slice(-2)}`;
}

function maskOrderName(value) {
  const name = String(value || '').trim();
  if (!name) return '';
  if (name.length === 1) return `${name}*`;
  return `${name.slice(0, 1)}${'*'.repeat(Math.min(2, name.length - 1))}`;
}

function summarizeOrderAddress(order) {
  const region = String(order.region || '').trim();
  const address = String(order.address || '').trim();
  if (!region && !address) return '';
  const summary = region || address;
  return `${summary.slice(0, 18)}${summary.length > 18 || (region && address) ? '…' : ''}`;
}

function adminOrderListPayload(order) {
  return {
    id: order.id,
    order_no: order.order_no,
    product_snapshot: order.product_snapshot || {},
    quantity: Number(order.quantity || 1),
    total_amount_cents: Number(order.total_amount_cents || 0),
    amount_text: `¥${(Number(order.total_amount_cents || 0) / 100).toFixed(2)}`,
    status: order.status,
    status_text: adminOrderStatusText(order.status),
    payment_status: order.payment_status || '',
    receiver_name_masked: maskOrderName(order.receiver_name),
    receiver_phone_masked: maskOrderPhone(order.receiver_phone),
    address_summary: summarizeOrderAddress(order),
    express_company: order.express_company || '',
    express_no: order.express_no || '',
    created_at: order.created_at,
    updated_at: order.updated_at
  };
}

function listOrders({ status, q, page = 1, pageSize = 50 } = {}) {
  const db = readDB();
  let orders = db.orders.slice();
  if (status === 'refund') {
    orders = orders.filter((item) => ['refunding', 'refunded'].includes(item.status));
  } else if (status && ORDER_STATUSES.includes(status)) {
    orders = orders.filter((item) => item.status === status);
  }
  const keyword = String(q || '').trim().toLowerCase();
  if (keyword) {
    orders = orders.filter((item) => [
      item.order_no,
      item.wechat_transaction_id,
      item.receiver_name,
      item.receiver_phone
    ].some((value) => String(value || '').toLowerCase().includes(keyword)));
  }
  orders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const normalizedPageSize = Math.min(50, Math.max(1, Math.floor(Number(pageSize) || 50)));
  const requestedPage = Math.max(1, Math.floor(Number(page) || 1));
  const total = orders.length;
  const totalPages = Math.max(1, Math.ceil(total / normalizedPageSize));
  const currentPage = Math.min(requestedPage, totalPages);
  const start = (currentPage - 1) * normalizedPageSize;
  return {
    total,
    page: currentPage,
    page_size: normalizedPageSize,
    total_pages: totalPages,
    orders: orders.slice(start, start + normalizedPageSize).map(adminOrderListPayload)
  };
}

function getAdminOrder(orderId) {
  const db = readDB();
  const order = db.orders.find((item) => item.id === orderId);
  if (!order) return null;
  return {
    id: order.id,
    order_no: order.order_no,
    product_id: order.product_id,
    product_snapshot: order.product_snapshot || {},
    quantity: Number(order.quantity || 1),
    unit_price_cents: Number(order.unit_price_cents || 0),
    total_amount_cents: Number(order.total_amount_cents || 0),
    amount_text: `¥${(Number(order.total_amount_cents || 0) / 100).toFixed(2)}`,
    status: order.status,
    status_text: adminOrderStatusText(order.status),
    payment_status: order.payment_status || '',
    payment_method: order.payment_method || '',
    payment_mock: order.payment_mock === true,
    wechat_transaction_id: order.wechat_transaction_id || '',
    paid_at: order.paid_at || null,
    receiver_name: order.receiver_name || '',
    receiver_phone: order.receiver_phone || '',
    region: order.region || '',
    address: order.address || '',
    remark: order.remark || '',
    express_company: order.express_company || '',
    express_no: order.express_no || '',
    admin_note: order.admin_note || '',
    shipped_at: order.shipped_at || null,
    refund_status: order.refund_status || '',
    created_at: order.created_at,
    updated_at: order.updated_at,
    timeline: [
      { key: 'created', label: '订单创建', at: order.created_at },
      order.paid_at ? { key: 'paid', label: '支付成功', at: order.paid_at } : null,
      order.shipped_at ? { key: 'shipped', label: '确认发货', at: order.shipped_at } : null,
      order.status === 'completed' ? { key: 'completed', label: '订单完成', at: order.updated_at } : null,
      order.status === 'cancelled' ? { key: 'cancelled', label: '订单取消', at: order.updated_at } : null,
      order.status === 'refunding' ? { key: 'refunding', label: '退款处理中', at: order.updated_at } : null,
      order.status === 'refunded' ? { key: 'refunded', label: '已退款', at: order.updated_at } : null
    ].filter(Boolean)
  };
}

function updateOrderShipment(orderId, input = {}) {
  const db = readDB();
  const index = db.orders.findIndex((item) => item.id === orderId);
  if (index === -1) return { error: 'ORDER_NOT_FOUND' };
  if (!['paid', 'shipped'].includes(db.orders[index].status)) {
    return { error: 'ORDER_NOT_SHIPPABLE' };
  }
  const expressCompany = String(input.express_company || '').trim();
  const expressNo = String(input.express_no || '').trim();
  if (!expressCompany || !expressNo) {
    return { error: 'VALIDATION_ERROR', message: '请填写快递公司和单号。' };
  }
  const now = nowISO();
  db.orders[index] = {
    ...db.orders[index],
    status: 'shipped',
    express_company: expressCompany,
    express_no: expressNo,
    admin_note: String(input.admin_note || db.orders[index].admin_note || '').trim(),
    shipped_at: db.orders[index].shipped_at || now,
    updated_at: now
  };
  writeDB(db);
  return { data: orderPayload(db.orders[index]) };
}

function normalizeImageUrl(value) {
  return String(value || '').trim();
}

function isValidImageUrl(value) {
  return !value || /^https?:\/\//i.test(value) || value.startsWith('/');
}

function normalizeHomeSlides(input, existing) {
  const source = Array.isArray(input)
    ? input
    : Array.isArray(existing)
      ? existing
      : DEFAULT_MINIAPP_CONTENT.home_slides;
  const normalized = source.slice(0, 5).map((item, index) => {
    const fallback = DEFAULT_MINIAPP_CONTENT.home_slides[index] || DEFAULT_MINIAPP_CONTENT.home_slides[0];
    const actionType = ['products', 'scene', 'scan'].includes(item && item.action_type)
      ? item.action_type
      : fallback.action_type;
    const sceneKey = PRODUCT_SCENE_KEYS.includes(item && item.scene_key) ? item.scene_key : fallback.scene_key;
    return {
      image: normalizeImageUrl(item && item.image),
      title: String((item && item.title) || fallback.title || '').trim() || fallback.title,
      subtitle: String((item && item.subtitle) || fallback.subtitle || '').trim() || fallback.subtitle,
      button_text: String((item && item.button_text) || fallback.button_text || '').trim() || fallback.button_text,
      action_type: actionType,
      scene_key: sceneKey
    };
  });
  return normalized.length ? normalized : DEFAULT_MINIAPP_CONTENT.home_slides;
}

function normalizeSceneCards(input, existing) {
  const source = Array.isArray(input)
    ? input
    : Array.isArray(existing)
      ? existing
      : DEFAULT_MINIAPP_CONTENT.scene_cards;
  const normalized = source.slice(0, 8).map((item, index) => {
    const fallback = DEFAULT_MINIAPP_CONTENT.scene_cards[index] || DEFAULT_MINIAPP_CONTENT.scene_cards[0];
    const key = PRODUCT_SCENE_KEYS.includes(item && item.key) ? item.key : fallback.key;
    return {
      key,
      label: String((item && item.label) || fallback.label || '').trim() || fallback.label,
      title: String((item && item.title) || fallback.title || '').trim() || fallback.title,
      description: String((item && item.description) || fallback.description || '').trim() || fallback.description,
      image: normalizeImageUrl(item && item.image),
      button_text: String((item && item.button_text) || fallback.button_text || '').trim() || fallback.button_text
    };
  });
  return normalized.length ? normalized : DEFAULT_MINIAPP_CONTENT.scene_cards;
}

function normalizeMiniappContent(input = {}, existing = {}) {
  return {
    home_title: String(input.home_title ?? existing.home_title ?? DEFAULT_MINIAPP_CONTENT.home_title).trim() || DEFAULT_MINIAPP_CONTENT.home_title,
    home_subtitle: String(input.home_subtitle ?? existing.home_subtitle ?? DEFAULT_MINIAPP_CONTENT.home_subtitle).trim() || DEFAULT_MINIAPP_CONTENT.home_subtitle,
    logo_image: normalizeImageUrl(input.logo_image ?? existing.logo_image ?? ''),
    home_banner_image: normalizeImageUrl(input.home_banner_image ?? existing.home_banner_image ?? ''),
    home_slides: normalizeHomeSlides(input.home_slides, existing.home_slides),
    scene_cards: normalizeSceneCards(input.scene_cards, existing.scene_cards),
    project_title: String(input.project_title ?? existing.project_title ?? DEFAULT_MINIAPP_CONTENT.project_title).trim() || DEFAULT_MINIAPP_CONTENT.project_title,
    project_body: String(input.project_body ?? existing.project_body ?? DEFAULT_MINIAPP_CONTENT.project_body).trim() || DEFAULT_MINIAPP_CONTENT.project_body,
    brand_story_title: String(input.brand_story_title ?? existing.brand_story_title ?? DEFAULT_MINIAPP_CONTENT.brand_story_title).trim() || DEFAULT_MINIAPP_CONTENT.brand_story_title,
    brand_story_body: String(input.brand_story_body ?? existing.brand_story_body ?? DEFAULT_MINIAPP_CONTENT.brand_story_body).trim() || DEFAULT_MINIAPP_CONTENT.brand_story_body,
    consult_label: String(input.consult_label ?? existing.consult_label ?? DEFAULT_MINIAPP_CONTENT.consult_label).trim() || DEFAULT_MINIAPP_CONTENT.consult_label,
    consult_url: String(input.consult_url ?? existing.consult_url ?? '').trim(),
    share_title: String(input.share_title ?? existing.share_title ?? DEFAULT_MINIAPP_CONTENT.share_title).trim() || DEFAULT_MINIAPP_CONTENT.share_title,
    share_description: String(input.share_description ?? existing.share_description ?? DEFAULT_MINIAPP_CONTENT.share_description).trim() || DEFAULT_MINIAPP_CONTENT.share_description,
    updated_at: input.updated_at ?? existing.updated_at ?? null,
    updated_by: input.updated_by ?? existing.updated_by ?? null
  };
}

function validateMiniappContent(data) {
  if (!isValidImageUrl(data.logo_image)) {
    return 'LOGO 图片需填写 http(s) 地址或站内路径。';
  }
  if (!isValidImageUrl(data.home_banner_image)) {
    return '首页 Banner 图片需填写 http(s) 地址或站内路径。';
  }
  const invalidSlide = (data.home_slides || []).find((item) => !isValidImageUrl(item.image));
  if (invalidSlide) {
    return '轮播图片需填写 http(s) 地址或站内路径。';
  }
  const invalidScene = (data.scene_cards || []).find((item) => !isValidImageUrl(item.image));
  if (invalidScene) {
    return '场景图片需填写 http(s) 地址或站内路径。';
  }
  if (data.consult_url && !/^https?:\/\//i.test(data.consult_url)) {
    return '咨询入口链接必须以 http:// 或 https:// 开头。';
  }
  return '';
}

function getMiniappContent({ publicOnly = false } = {}) {
  const db = readDB();
  const content = normalizeMiniappContent(db.miniapp_content);
  if (!publicOnly) {
    return content;
  }
  const { updated_at: _updatedAt, updated_by: _updatedBy, ...publicContent } = content;
  return publicContent;
}

function updateMiniappContent(input, updatedBy = 'admin') {
  const db = readDB();
  const data = normalizeMiniappContent(input, db.miniapp_content);
  const validationMessage = validateMiniappContent(data);
  if (validationMessage) {
    return { error: 'VALIDATION_ERROR', message: validationMessage };
  }
  const updated = {
    ...data,
    updated_at: nowISO(),
    updated_by: updatedBy
  };
  db.miniapp_content = updated;
  writeDB(db);
  return { data: updated };
}

async function generateQRCodes({ prefix, count, batchId }) {
  const { db, sourceHash } = readDBWithHash();
  const normalizedPrefix = String(prefix).toUpperCase();
  const regex = new RegExp(`^${normalizedPrefix}(\\d{5})$`);

  let maxSeq = 0;
  db.qr_codes.forEach((item) => {
    const matched = regex.exec(item.id);
    if (!matched) {
      return;
    }
    const seq = Number(matched[1]);
    if (seq > maxSeq) {
      maxSeq = seq;
    }
  });

  const records = [];
  const ids = [];

  for (let i = 1; i <= count; i += 1) {
    const seq = maxSeq + i;
    if (seq > 99999) {
      return { error: 'QR_SEQUENCE_EXCEEDED' };
    }

    const id = `${normalizedPrefix}${String(seq).padStart(5, '0')}`;
    const record = {
      id,
      issue_status: 'issued',
      activation_status: 'unactivated',
      hidden: false,
      batch_id: batchId || null,
      print_batch_id: null,
      quality_check: {
        checked: false,
        checked_at: null,
        checked_by: null,
        result: null
      },
      content: null,
      image_url: null,
      image_object_key: null,
      phone: null,
      activated_at: null,
      blockchain_hash: null,
      ...defaultChainFields(),
      co_creation_enabled: false,
      co_creation_owner_phone: null,
      co_creation_comments: [],
      co_creation_started_at: null,
      show_brand_disclosure: false,
      brand_disclosure_text_snapshot: '',
      qr_image_url: null,
      qr_access_token: null,
      created_at: nowISO()
    };

    records.push(record);
    ids.push(id);
  }

  // 生成唯一 qr_access_token
  const usedTokens = new Set(db.qr_codes.map((item) => item.qr_access_token).filter(Boolean));
  for (let i = 0; i < records.length; i += 1) {
    let token;
    do {
      token = crypto.randomBytes(16).toString('hex');
    } while (usedTokens.has(token));
    usedTokens.add(token);
    records[i].qr_access_token = token;
  }

  // 生成二维码 PNG 图片
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  const imageArtifacts = [];

  for (let i = 0; i < ids.length; i += 1) {
    const qrId = ids[i];
    const token = records[i].qr_access_token;
    try {
      const labeledPngBuffer = await renderQrImage({
        baseUrl,
        qrId,
        accessToken: token
      });
      imageArtifacts.push({
        recordIndex: i,
        finalPath: qrImagePath(qrId),
        content: labeledPngBuffer
      });
    } catch (_err) {
      // 图片生成失败不阻断流程，qr_image_url 保持 null
    }
  }

  assertDatabaseSourceHash(sourceHash);
  const stagedImages = [];
  try {
    imageArtifacts.forEach((artifact) => {
      assertDatabaseSourceHash(sourceHash);
      stagedImages.push(stageFileReplacement(artifact.finalPath, artifact.content));
      records[artifact.recordIndex].qr_image_url = `/api/qr/image/${records[artifact.recordIndex].qr_access_token}`;
    });

    db.qr_codes.push(...records);
    writeDBAtomicallyIfUnchanged(db, sourceHash);
    stagedImages.forEach((stagedImage) => stagedImage.commit());
  } catch (error) {
    stagedImages.reverse().forEach((stagedImage) => stagedImage.rollback());
    throw error;
  }

  return {
    data: {
      count: ids.length,
      ids,
      records
    }
  };
}

function setQRHiddenStatus(qrId, hidden) {
  const db = readDB();
  const index = db.qr_codes.findIndex((item) => item.id === qrId);
  if (index === -1) {
    return null;
  }

  db.qr_codes[index] = {
    ...db.qr_codes[index],
    hidden
  };
  writeDB(db);
  return db.qr_codes[index];
}


function setQRHiddenStatusBatch(ids, hidden) {
  const db = readDB();
  const idSet = new Set((ids || []).map((item) => String(item).trim()).filter(Boolean));
  if (idSet.size === 0) {
    return [];
  }

  const updated = [];
  db.qr_codes = db.qr_codes.map((item) => {
    if (!idSet.has(item.id)) {
      return item;
    }
    const next = { ...item, hidden };
    updated.push(next);
    return next;
  });

  writeDB(db);
  return updated;
}


function createBatch({ name, brandName, note, brandDisclosureText, brandDisclosureDefault, createdBy }) {
  const db = readDB();
  const ts = new Date();
  const id = `BATCH_${ts.toISOString().slice(0, 10).replace(/-/g, '')}_${String(db.batches.length + 1).padStart(3, '0')}`;

  const batch = {
    id,
    name,
    brand_name: brandName || '',
    note: note || '',
    brand_disclosure_text: brandDisclosureText || '',
    brand_disclosure_default: brandDisclosureDefault === true,
    created_at: nowISO(),
    created_by: createdBy || 'admin'
  };

  db.batches.push(batch);
  writeDB(db);
  return batch;
}

function listBatches() {
  const db = readDB();
  return db.batches
    .slice()
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map((batch) => {
      const records = db.qr_codes.filter((item) => item.batch_id === batch.id);
      const total = records.length;
      const activated = records.filter((item) => item.activation_status === 'activated').length;
      return {
        ...batch,
        total_codes: total,
        activated_codes: activated,
        activation_rate: total > 0 ? Number(((activated / total) * 100).toFixed(2)) : 0
      };
    });
}

function assignBatchToQRCodes({ batchId, ids }) {
  const db = readDB();
  const batch = db.batches.find((item) => item.id === batchId);
  if (!batch) {
    return { error: 'BATCH_NOT_FOUND' };
  }

  const idSet = new Set((ids || []).map((item) => String(item).trim()).filter(Boolean));
  let updatedCount = 0;
  db.qr_codes = db.qr_codes.map((item) => {
    if (!idSet.has(item.id)) return item;
    updatedCount += 1;
    return {
      ...item,
      batch_id: batchId
    };
  });

  writeDB(db);
  return { data: { updated_count: updatedCount } };
}

function getBatchDetail(batchId) {
  const db = readDB();
  const batch = db.batches.find((item) => item.id === batchId);
  if (!batch) {
    return null;
  }
  const records = db.qr_codes.filter((item) => item.batch_id === batchId);
  const activated = records.filter((item) => item.activation_status === 'activated').length;
  return {
    ...batch,
    total_codes: records.length,
    activated_codes: activated,
    pending_codes: records.length - activated,
    activation_rate: records.length > 0 ? Number(((activated / records.length) * 100).toFixed(2)) : 0,
    records
  };
}

function exportBatchCSV(batchId) {
  const detail = getBatchDetail(batchId);
  if (!detail) {
    return { error: 'BATCH_NOT_FOUND' };
  }

  const header = ['id', 'batch_id', 'issue_status', 'activation_status', 'hidden', 'phone', 'activated_at', 'created_at', 'qr_image_url'];
  const rows = detail.records.map((item) => [
    item.id,
    item.batch_id || '',
    item.issue_status,
    item.activation_status,
    item.hidden ? 'true' : 'false',
    item.phone || '',
    item.activated_at || '',
    item.created_at || '',
    item.qr_image_url ? `${process.env.BASE_URL || 'http://localhost:3000'}${item.qr_image_url}` : ''
  ]);

  const csv = [header.join(','), ...rows.map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\n');
  return { data: csv, filename: `batch-${batchId}-${Date.now()}.csv` };
}

function runQualityCheck({ qrId, checkedBy }) {
  const db = readDB();
  const index = db.qr_codes.findIndex((item) => item.id === qrId);
  if (index === -1) {
    return { error: 'QR_NOT_FOUND' };
  }

  const qr = db.qr_codes[index];
  let result = 'pass';
  let message = '首次质检通过，可以流通。';

  if (qr.activation_status === 'activated') {
    result = 'bound';
    message = '该星已被顾客绑定，请标记异常。';
  } else if (qr.quality_check && qr.quality_check.checked) {
    result = 'duplicate';
    message = '重复！该码已存在质检记录。';
  }

  const log = {
    id: db.quality_check_logs.length + 1,
    qr_id: qrId,
    checked_at: nowISO(),
    checked_by: checkedBy,
    result
  };

  db.quality_check_logs.push(log);

  if (result === 'pass') {
    db.qr_codes[index] = {
      ...qr,
      quality_check: {
        checked: true,
        checked_at: log.checked_at,
        checked_by: checkedBy,
        result
      }
    };
  }

  writeDB(db);

  return {
    data: {
      qr_id: qrId,
      result,
      message,
      checked_at: log.checked_at,
      checked_by: checkedBy
    }
  };
}

function getQualityCheckLogs({ page = 1, limit = 20 }) {
  const db = readDB();
  const logs = db.quality_check_logs.slice().sort((a, b) => new Date(b.checked_at) - new Date(a.checked_at));
  const total = logs.length;
  const start = (Number(page) - 1) * Number(limit);
  const end = start + Number(limit);
  return {
    total,
    page: Number(page),
    limit: Number(limit),
    logs: logs.slice(start, end)
  };
}

function getQualityCheckStats() {
  const db = readDB();
  const today = new Date().toISOString().slice(0, 10);
  const todayLogs = db.quality_check_logs.filter((item) => item.checked_at.slice(0, 10) === today);
  const abnormal = todayLogs.filter((item) => item.result !== 'pass').length;
  return {
    today_checked: todayLogs.length,
    today_abnormal: abnormal,
    total_checked: db.quality_check_logs.length
  };
}

module.exports = {
  initializeDB,
  migrateDatabaseSnapshot,
  getDatabaseSnapshot,
  getDatabaseSnapshotWithHash,
  writeDatabaseSnapshot,
  createOrGetUser,
  findUserById,
  getAuthenticatedUserReadContext,
  getAuthenticatedUserById,
  getAuthenticatedMiniappUserReadContext,
  getAuthenticatedMiniappUser,
  findUserByOpenid,
  createOrGetMiniappUser,
  bindMiniappUserPhone,
  getQRCode,
  findRecordByChainOperationId,
  updateRecordChainProof,
  findQRByToken,
  findQRByKey,
  findPublicQrReadContextByKey,
  findRecordImageUploadEligibilityByAccessToken,
  findPersonalRecordListContextByAccountId,
  findPersonalRecordDetailContext,
  getSampleUnactivated,
  activateQRCodeOnce,
  activateQRByKey,
  startCoCreationByKey,
  addCoCreationCommentByKey,
  deleteCoCreationCommentByKey,
  finalizeCoCreationByKey,
  findAdmin,
  listOperators,
  createOperator,
  setOperatorEnabled,
  changeOperatorPassword,
  getDashboardStats,
  listQRRecords,
  listActivatedRecordsByPhone,
  listActivatedRecordsByAccountId,
  listActivatedRecordsByMiniappOpenid,
  getActivatedRecordByPhoneAndId,
  getActivatedRecordByAccountIdAndId,
  getActivatedRecordByMiniappOpenidAndId,
  createProduct,
  updateProduct,
  listProducts,
  getProduct,
  createMiniappOrder,
  listMiniappOrders,
  listMiniappOrdersByAccountId,
  getMiniappOrder,
  getMiniappOrderByAccountId,
  getOrderByOrderNo,
  cancelMiniappOrder,
  cancelMiniappOrderByAccountId,
  payMiniappOrderMock,
  payMiniappOrderMockByAccountId,
  appendPaymentLog,
  markOrderPaidByOrderNo,
  listOrders,
  getAdminOrder,
  updateOrderShipment,
  getMiniappContent,
  updateMiniappContent,
  generateQRCodes,
  setQRHiddenStatus,
  setQRHiddenStatusBatch,
  createBatch,
  listBatches,
  assignBatchToQRCodes,
  getBatchDetail,
  exportBatchCSV,
  runQualityCheck,
  getQualityCheckLogs,
  getQualityCheckStats
};
