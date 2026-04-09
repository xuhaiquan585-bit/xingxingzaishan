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
      issue_status: 'issued',
      activation_status: 'unactivated',
      hidden: false,
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

  db.qr_codes = db.qr_codes.map((item) => ({
    ...item,
    issue_status: item.issue_status || 'issued',
    activation_status: item.activation_status || 'unactivated',
    hidden: item.hidden === true
  }));

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
      admins: defaultAdmins()
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

function listQRRecords({ issueStatus, activationStatus, hidden, dateFrom, dateTo, page = 1, limit = 20 }) {
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

module.exports = {
  initializeDB,
  createOrGetUser,
  getQRCode,
  activateQRCodeOnce,
  findAdmin,
  getDashboardStats,
  listQRRecords,
  setQRHiddenStatus
};
