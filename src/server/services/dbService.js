const fs = require('fs');
const path = require('path');
const { hashPassword, verifyPassword, isPasswordHashed } = require('./passwordService');

const dataDir = process.env.DB_DIR
  ? path.resolve(process.env.DB_DIR)
  : path.join(__dirname, '..', 'data');
const dataFile = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(dataDir, 'db.json');

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
      show_brand_disclosure: false,
      brand_disclosure_snapshot: '',
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

  db.qr_codes = db.qr_codes.map((item) => ({
    ...item,
    issue_status: item.issue_status || 'issued',
    activation_status: item.activation_status || 'unactivated',
    hidden: item.hidden === true,
    batch_id: Object.prototype.hasOwnProperty.call(item, 'batch_id') ? item.batch_id : null,
    print_batch_id: Object.prototype.hasOwnProperty.call(item, 'print_batch_id') ? item.print_batch_id : null,
    image_object_key: Object.prototype.hasOwnProperty.call(item, 'image_object_key') ? item.image_object_key : null,
    show_brand_disclosure: item.show_brand_disclosure === true,
    brand_disclosure_snapshot: typeof item.brand_disclosure_snapshot === 'string' ? item.brand_disclosure_snapshot : '',
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
      batches: []
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
      created_at: nowISO()
    };
    db.users.push(user);
    writeDB(db);
  }
  return user;
}

function getQRCode(qrId) {
  const db = readDB();
  return db.qr_codes.find((item) => item.id === qrId) || null;
}

function activateQRCodeOnce(qrId, payload) {
  const db = readDB();
  const index = db.qr_codes.findIndex((item) => item.id === qrId);
  if (index === -1) {
    return { error: 'QR_NOT_FOUND' };
  }

  const qrCode = db.qr_codes[index];
  if (qrCode.activation_status === 'activated') {
    return { error: 'QR_ALREADY_ACTIVATED', data: qrCode };
  }

  const showBrandDisclosure = payload.show_brand_disclosure === true;
  const batch = qrCode.batch_id ? db.batches.find((item) => item.id === qrCode.batch_id) : null;
  const batchDisclosure = batch ? String(batch.brand_disclosure || '') : '';

  const updated = {
    ...qrCode,
    activation_status: 'activated',
    content: payload.content,
    image_url: payload.image_url,
    image_object_key: payload.image_object_key || null,
    phone: payload.phone,
    activated_at: nowISO(),
    blockchain_hash: payload.blockchain_hash,
    show_brand_disclosure: showBrandDisclosure,
    brand_disclosure_snapshot: showBrandDisclosure ? batchDisclosure : ''
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

function getDashboardStats({ dateFrom, dateTo }) {
  const db = readDB();

  const totalIssued = db.qr_codes.filter((item) => item.issue_status === 'issued').length;
  const totalActivated = db.qr_codes.filter((item) => item.activation_status === 'activated').length;
  const circulatingPending = db.qr_codes.filter(
    (item) => item.issue_status === 'issued' && item.activation_status === 'unactivated'
  ).length;

  const from = dateFrom ? new Date(dateFrom).getTime() : null;
  const to = dateTo ? new Date(dateTo).getTime() : null;

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
    circulating_pending: circulatingPending,
    period_issued: filteredIssued,
    period_activated: filteredActivated,
    period_activation_rate: activationRate
  };
}

function listQRRecords({ issueStatus, activationStatus, hidden, idPrefix, batchId, dateFrom, dateTo, page = 1, limit = 20 }) {
  const db = readDB();
  const from = dateFrom ? new Date(dateFrom).getTime() : null;
  const to = dateTo ? new Date(dateTo).getTime() : null;

  let records = db.qr_codes.slice();

  if (issueStatus) {
    records = records.filter((item) => item.issue_status === issueStatus);
  }

  if (activationStatus) {
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
      const baseTime = item.activated_at || item.created_at;
      const ts = new Date(baseTime).getTime();
      if (Number.isNaN(ts)) return false;
      if (from && ts < from) return false;
      if (to && ts > to) return false;
      return true;
    });
  }

  records.sort((a, b) => new Date(b.activated_at || b.created_at) - new Date(a.activated_at || a.created_at));

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

function generateQRCodes({ prefix, count, batchId }) {
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
      show_brand_disclosure: false,
      brand_disclosure_snapshot: '',
      created_at: nowISO()
    };

    records.push(record);
    ids.push(id);
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


function createBatch({ name, brandName, note, brandDisclosure, createdBy }) {
  const db = readDB();
  const ts = new Date();
  const id = `BATCH_${ts.toISOString().slice(0, 10).replace(/-/g, '')}_${String(db.batches.length + 1).padStart(3, '0')}`;

  const batch = {
    id,
    name,
    brand_name: brandName || '',
    note: note || '',
    brand_disclosure: brandDisclosure || '',
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

  const header = ['id', 'batch_id', 'issue_status', 'activation_status', 'hidden', 'phone', 'activated_at', 'created_at'];
  const rows = detail.records.map((item) => [
    item.id,
    item.batch_id || '',
    item.issue_status,
    item.activation_status,
    item.hidden ? 'true' : 'false',
    item.phone || '',
    item.activated_at || '',
    item.created_at || ''
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
  getQRCode,
  activateQRCodeOnce,
  findAdmin,
  listOperators,
  createOperator,
  setOperatorEnabled,
  getDashboardStats,
  listQRRecords,
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
