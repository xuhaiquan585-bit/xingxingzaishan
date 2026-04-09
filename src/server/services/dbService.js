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

function initializeDB() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  if (!fs.existsSync(dataFile)) {
    const initialData = {
      users: [],
      qr_codes: seedQRCodes()
    };
    fs.writeFileSync(dataFile, JSON.stringify(initialData, null, 2), 'utf-8');
  }
}

function readDB() {
  initializeDB();
  return JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
}

function writeDB(db) {
  fs.writeFileSync(dataFile, JSON.stringify(db, null, 2), 'utf-8');
}

function findUserByPhone(phone) {
  const db = readDB();
  return db.users.find((user) => user.phone === phone) || null;
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

module.exports = {
  initializeDB,
  createOrGetUser,
  findUserByPhone,
  getQRCode,
  activateQRCodeOnce
};
