const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { addLabelToQR } = require('../utils/qrWithLabel');
const { hashPassword, verifyPassword, isPasswordHashed } = require('./passwordService');

const dataDir = process.env.DB_DIR
  ? path.resolve(process.env.DB_DIR)
  : path.join(__dirname, '..', 'data');
const dataFile = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(dataDir, 'db.json');
const CO_CREATION_COMMENT_LIMIT = 12;

const DEFAULT_MINIAPP_CONTENT = {
  home_title: '把此刻，记在这瓶酒里',
  home_subtitle: '让故事与时间一同酝酿，区块链存证，一经封存，不可篡改。',
  home_banner_image: '',
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

function nowISO() {
  return new Date().toISOString();
}

function seedQRCodes() {
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
      co_creation_enabled: false,
      co_creation_owner_phone: null,
      co_creation_comments: [],
      co_creation_started_at: null,
      show_brand_disclosure: false,
      brand_disclosure_text_snapshot: '',
      qr_image_url: null,
      qr_access_token: null,
      created_at: nowISO()
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

function migrateSchema(db) {
  if (!Array.isArray(db.users)) {
    db.users = [];
  }

  db.users = db.users.map((item, idx) => ({
    id: item.id || idx + 1,
    phone: item.phone || null,
    openid: item.openid || null,
    unionid: item.unionid || null,
    source: item.source || (item.openid ? 'miniapp' : 'web'),
    created_at: item.created_at || nowISO()
  }));

  if (!Array.isArray(db.qr_codes)) {
    db.qr_codes = seedQRCodes();
  }

  ensureAdminsInitialized(db);

  db.admins = db.admins.map((item, idx) => ({
    id: item.id || idx + 1,
    username: item.username,
    password: isPasswordHashed(item.password) ? item.password : hashPassword(item.password),
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
    description: item.description || '',
    status: ['draft', 'published', 'hidden'].includes(item.status) ? item.status : 'draft',
    buy_type: item.buy_type || 'copy_link',
    buy_url: item.buy_url || '',
    sort_order: Number.isFinite(Number(item.sort_order)) ? Number(item.sort_order) : idx + 1,
    created_at: item.created_at || nowISO(),
    updated_at: item.updated_at || item.created_at || nowISO()
  }));

  db.qr_codes = db.qr_codes.map((item) => ({
    ...item,
    issue_status: item.issue_status || 'issued',
    activation_status: item.activation_status || 'unactivated',
    hidden: item.hidden === true,
    batch_id: Object.prototype.hasOwnProperty.call(item, 'batch_id') ? item.batch_id : null,
    print_batch_id: Object.prototype.hasOwnProperty.call(item, 'print_batch_id') ? item.print_batch_id : null,
    image_object_key: Object.prototype.hasOwnProperty.call(item, 'image_object_key') ? item.image_object_key : null,
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

  const hasUnissued = db.qr_codes.some((item) => item.issue_status === 'unissued');
  if (!hasUnissued) {
    db.qr_codes = db.qr_codes.map((item, index) => ({
      ...item,
      issue_status: index < 10 ? 'unissued' : 'issued'
    }));
  }

  return db;
}

function initializeDB() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  if (!fs.existsSync(dataFile)) {
    const initialData = migrateSchema({
      users: [],
      qr_codes: seedQRCodes(),
      admins: [],
      quality_check_logs: [],
      batches: [],
      products: [],
      content_pages: [],
      banners: [],
      orders: [],
      payment_logs: [],
      miniapp_content: DEFAULT_MINIAPP_CONTENT
    });
    fs.writeFileSync(dataFile, JSON.stringify(initialData, null, 2), 'utf-8');
    return;
  }

  const db = migrateSchema(JSON.parse(fs.readFileSync(dataFile, 'utf-8')));
  fs.writeFileSync(dataFile, JSON.stringify(db, null, 2), 'utf-8');
}

function readDB() {
  initializeDB();
  return migrateSchema(JSON.parse(fs.readFileSync(dataFile, 'utf-8')));
}

function writeDB(db) {
  fs.writeFileSync(dataFile, JSON.stringify(db, null, 2), 'utf-8');
}

function createOrGetUser(phone) {
  const db = readDB();
  let user = db.users.find((item) => item.phone === phone);
  if (!user) {
    user = {
      id: db.users.length + 1,
      phone,
      openid: null,
      unionid: null,
      source: 'web',
      created_at: nowISO()
    };
    db.users.push(user);
    writeDB(db);
  }
  return user;
}

function findUserByOpenid(openid) {
  const db = readDB();
  return db.users.find((item) => item.openid === openid) || null;
}

function createOrGetMiniappUser({ openid, unionid = null }) {
  const db = readDB();
  let user = db.users.find((item) => item.openid === openid);
  if (user) {
    if (unionid && user.unionid !== unionid) {
      user = { ...user, unionid };
      db.users = db.users.map((item) => (item.openid === openid ? user : item));
      writeDB(db);
    }
    return user;
  }

  user = {
    id: db.users.length + 1,
    phone: null,
    openid,
    unionid,
    source: 'miniapp',
    created_at: nowISO()
  };
  db.users.push(user);
  writeDB(db);
  return user;
}

function bindMiniappUserPhone({ openid, phone, unionid = null }) {
  const db = readDB();
  const miniUser = db.users.find((item) => item.openid === openid);
  if (!miniUser) {
    return { error: 'MINIAPP_USER_NOT_FOUND' };
  }

  const phoneUser = db.users.find((item) => item.phone === phone);
  const nextUnionid = unionid || miniUser.unionid || null;

  if (phoneUser && phoneUser.id !== miniUser.id) {
    const merged = {
      ...phoneUser,
      openid,
      unionid: nextUnionid,
      source: phoneUser.source === 'web' ? 'web+miniapp' : phoneUser.source || 'miniapp'
    };
    db.users = db.users
      .filter((item) => item.id !== miniUser.id)
      .map((item) => (item.id === phoneUser.id ? merged : item));
    writeDB(db);
    return { data: merged };
  }

  const updated = {
    ...miniUser,
    phone,
    unionid: nextUnionid,
    source: miniUser.source || 'miniapp'
  };
  db.users = db.users.map((item) => (item.openid === openid ? updated : item));
  writeDB(db);
  return { data: updated };
}

function getQRCode(qrId) {
  const db = readDB();
  return db.qr_codes.find((item) => item.id === qrId) || null;
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

function getSampleUnactivated() {
  const db = readDB();
  // 优先返回有 token 的（新数据），旧数据无 token 跳过
  return db.qr_codes.find((item) =>
    item.activation_status === 'unactivated' &&
    item.hidden !== true &&
    item.qr_access_token
  ) || null;
}

function activateQRCodeOnce(qrId, payload) {
  const db = readDB();
  const index = db.qr_codes.findIndex((item) => item.id === qrId);
  if (index === -1) {
    return { error: 'QR_NOT_FOUND' };
  }

  const qrCode = db.qr_codes[index];
  if (qrCode.activation_status !== 'unactivated') {
    return { error: 'QR_ALREADY_ACTIVATED', data: qrCode };
  }

  const showBrandDisclosure = payload.show_brand_disclosure === true;
  const batch = qrCode.batch_id ? db.batches.find((item) => item.id === qrCode.batch_id) : null;
  const batchDisclosure = batch ? String(batch.brand_disclosure_text || '') : '';

  const updated = {
    ...qrCode,
    activation_status: 'activated',
    content: payload.content,
    image_url: payload.image_url,
    image_object_key: payload.image_object_key || null,
    phone: payload.phone,
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
  return activateQRCodeOnce(key, payload);
}

function startCoCreationOnce(qrId, payload) {
  const db = readDB();
  const index = db.qr_codes.findIndex((item) => item.id === qrId);
  if (index === -1) {
    return { error: 'QR_NOT_FOUND' };
  }

  const qrCode = db.qr_codes[index];
  if (qrCode.activation_status !== 'unactivated') {
    return { error: 'QR_ALREADY_ACTIVATED', data: qrCode };
  }

  const showBrandDisclosure = payload.show_brand_disclosure === true;
  const batch = qrCode.batch_id ? db.batches.find((item) => item.id === qrCode.batch_id) : null;
  const batchDisclosure = batch ? String(batch.brand_disclosure_text || '') : '';

  const updated = {
    ...qrCode,
    activation_status: 'co_creating',
    co_creation_enabled: true,
    co_creation_owner_phone: payload.phone,
    co_creation_comments: [],
    co_creation_started_at: nowISO(),
    content: payload.content,
    image_url: payload.image_url,
    image_object_key: payload.image_object_key || null,
    phone: payload.phone,
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
  return startCoCreationOnce(key, payload);
}

function addCoCreationCommentByKey(key, { phone, authorName, content }) {
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
  if (activeComments.some((item) => item.phone === phone)) {
    return { error: 'CO_CREATION_COMMENT_EXISTS' };
  }
  if (activeComments.length >= CO_CREATION_COMMENT_LIMIT) {
    return { error: 'CO_CREATION_COMMENT_LIMIT_REACHED' };
  }

  const comment = {
    id: comments.length > 0 ? Math.max(...comments.map((item) => Number(item.id) || 0)) + 1 : 1,
    phone,
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

function deleteCoCreationCommentByKey(key, { commentId, phone }) {
  const db = readDB();
  const index = db.qr_codes.findIndex((item) => item.qr_access_token === key || item.id === key);
  if (index === -1) {
    return { error: 'QR_NOT_FOUND' };
  }

  const qrCode = db.qr_codes[index];
  if (qrCode.activation_status !== 'co_creating' || qrCode.co_creation_owner_phone !== phone) {
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

function finalizeCoCreationByKey(key, { phone, blockchain_hash: blockchainHash }) {
  const db = readDB();
  const index = db.qr_codes.findIndex((item) => item.qr_access_token === key || item.id === key);
  if (index === -1) {
    return { error: 'QR_NOT_FOUND' };
  }

  const qrCode = db.qr_codes[index];
  if (qrCode.activation_status !== 'co_creating' || qrCode.co_creation_enabled !== true) {
    return { error: 'CO_CREATION_CLOSED' };
  }
  if (qrCode.co_creation_owner_phone !== phone) {
    return { error: 'FORBIDDEN' };
  }

  const updated = {
    ...qrCode,
    activation_status: 'activated',
    activated_at: nowISO(),
    blockchain_hash: blockchainHash,
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
      co_creation_enabled: item.co_creation_enabled === true,
      co_creation_comments: Array.isArray(item.co_creation_comments) ? item.co_creation_comments : []
    }));
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
    co_creation_enabled: matched.co_creation_enabled === true,
    co_creation_comments: Array.isArray(matched.co_creation_comments) ? matched.co_creation_comments : [],
    show_brand_disclosure: matched.show_brand_disclosure === true,
    brand_disclosure_text_snapshot: matched.brand_disclosure_text_snapshot || '',
    batch_id: matched.batch_id || null
  };
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

  return {
    title: String(input.title ?? existing.title ?? '').trim(),
    subtitle: String(input.subtitle ?? existing.subtitle ?? '').trim(),
    cover_image: String(input.cover_image ?? existing.cover_image ?? '').trim(),
    images,
    price_text: String(input.price_text ?? existing.price_text ?? '').trim(),
    description: String(input.description ?? existing.description ?? '').trim(),
    status: ['draft', 'published', 'hidden'].includes(input.status) ? input.status : (existing.status || 'draft'),
    buy_type: 'copy_link',
    buy_url: String(input.buy_url ?? existing.buy_url ?? '').trim(),
    sort_order: Number.isFinite(Number(input.sort_order ?? existing.sort_order))
      ? Number(input.sort_order ?? existing.sort_order)
      : 0
  };
}

function validateProductData(data) {
  if (!data.title) {
    return '商品名称不能为空。';
  }
  if (data.buy_url && !/^https?:\/\//i.test(data.buy_url)) {
    return '购买链接必须以 http:// 或 https:// 开头。';
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

  const data = normalizeProductInput(input, db.products[index]);
  const validationMessage = validateProductData(data);
  if (validationMessage) {
    return { error: 'VALIDATION_ERROR', message: validationMessage };
  }

  const updated = {
    ...db.products[index],
    ...data,
    updated_at: nowISO()
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

function normalizeMiniappContent(input = {}, existing = {}) {
  return {
    home_title: String(input.home_title ?? existing.home_title ?? DEFAULT_MINIAPP_CONTENT.home_title).trim() || DEFAULT_MINIAPP_CONTENT.home_title,
    home_subtitle: String(input.home_subtitle ?? existing.home_subtitle ?? DEFAULT_MINIAPP_CONTENT.home_subtitle).trim() || DEFAULT_MINIAPP_CONTENT.home_subtitle,
    home_banner_image: String(input.home_banner_image ?? existing.home_banner_image ?? '').trim(),
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
  if (data.home_banner_image && !/^https?:\/\//i.test(data.home_banner_image) && !data.home_banner_image.startsWith('/')) {
    return '首页 Banner 图片需填写 http(s) 地址或站内路径。';
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
  const db = readDB();
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
  const qrImageDir = path.join(__dirname, '..', '..', '..', 'public', 'qrcodes');
  if (!fs.existsSync(qrImageDir)) {
    fs.mkdirSync(qrImageDir, { recursive: true });
  }

  for (let i = 0; i < ids.length; i += 1) {
    const qrId = ids[i];
    const token = records[i].qr_access_token;
    const qrContent = `${baseUrl}/record.html?t=${encodeURIComponent(token)}`;
    const pngPath = path.join(qrImageDir, `${qrId}.png`);

    try {
      const rawPngBuffer = await QRCode.toBuffer(qrContent, {
        type: 'png',
        width: 300,
        margin: 2,
        errorCorrectionLevel: 'M'
      });
      // 在二维码下方拼接序号标签（如 OSSC00001），一次成型
      const labeledPngBuffer = addLabelToQR(rawPngBuffer, qrId, { scale: 3 });
      fs.writeFileSync(pngPath, labeledPngBuffer);
      records[i].qr_image_url = `/api/qr/image/${token}`;
    } catch (_err) {
      // 图片生成失败不阻断流程，qr_image_url 保持 null
    }
  }

  db.qr_codes.push(...records);
  writeDB(db);

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
  createOrGetUser,
  findUserByOpenid,
  createOrGetMiniappUser,
  bindMiniappUserPhone,
  getQRCode,
  findQRByToken,
  findQRByKey,
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
  listActivatedRecordsByMiniappOpenid,
  getActivatedRecordByPhoneAndId,
  getActivatedRecordByMiniappOpenidAndId,
  createProduct,
  updateProduct,
  listProducts,
  getProduct,
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
