const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const dataFile = path.join(dataDir, 'db.json');

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
      quality_check: {
        checked: false,
        checked_at: null,
        checked_by: null,
        result: null
      },
      content: null,
      image_url: null,
      phone: null,
      activated_at: null,
      blockchain_hash: null,
      created_at: nowISO()
    });
  }
  return qrCodes;
}

function defaultAdmins() {
  return [
    {
      id: 1,
      username: 'admin',
      password: 'admin123',
      role: 'admin',
      name: '系统管理员'
    },
    {
      id: 2,
      username: 'qc',
      password: 'qc123456',
      role: 'qc',
      name: '质检员'
    }
  ];
}

function migrateSchema(db) {
  if (!Array.isArray(db.users)) {
    db.users = [];
  }

  if (!Array.isArray(db.qr_codes)) {
    db.qr_codes = seedQRCodes();
  }

  if (!Array.isArray(db.admins)) {
    db.admins = defaultAdmins();
  }

  if (!Array.isArray(db.quality_check_logs)) {
    db.quality_check_logs = [];
  }

  db.qr_codes = db.qr_codes.map((item) => ({
    ...item,
    issue_status: item.issue_status || 'issued',
    activation_status: item.activation_status || 'unactivated',
    hidden: item.hidden === true,
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
    const initialData = {
      users: [],
      qr_codes: seedQRCodes(),
      admins: defaultAdmins(),
      quality_check_logs: []
    };
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

  const updated = {
    ...qrCode,
    activation_status: 'activated',
    content: payload.content,
    image_url: payload.image_url,
    phone: payload.phone,
    activated_at: nowISO(),
    blockchain_hash: payload.blockchain_hash
  };

  db.qr_codes[index] = updated;
  writeDB(db);

  return { data: updated };
}

function findAdmin(username, password) {
  const db = readDB();
  return db.admins.find((item) => item.username === username && item.password === password) || null;
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

function listQRRecords({ issueStatus, activationStatus, hidden, idPrefix, dateFrom, dateTo, page = 1, limit = 20 }) {
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
  getDashboardStats,
  listQRRecords,
  setQRHiddenStatus,
  setQRHiddenStatusBatch,
  runQualityCheck,
  getQualityCheckLogs,
  getQualityCheckStats
};
