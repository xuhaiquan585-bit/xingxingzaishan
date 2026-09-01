'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const QRCode = require('qrcode');
const { addLabelToQR } = require('../utils/qrWithLabel');

function unlinkFile(file) {
  try {
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
  } catch (_error) {
    // Cleanup is best effort; callers preserve the original failure.
  }
}

function qrImageDirectory(env = process.env) {
  if (String(env.NODE_ENV || '').toLowerCase() === 'test'
    && String(env.QR_ISSUANCE_TEST_IMAGE_DIR || '').trim()) {
    return path.resolve(String(env.QR_ISSUANCE_TEST_IMAGE_DIR).trim());
  }
  return path.join(__dirname, '..', '..', '..', 'public', 'qrcodes');
}

function qrImagePath(qrId, env = process.env) {
  const normalizedId = String(qrId || '').trim();
  if (!/^[A-Z0-9]+$/.test(normalizedId)) {
    const error = new Error('QR_IMAGE_ID_INVALID');
    error.code = 'QR_IMAGE_ID_INVALID';
    throw error;
  }
  return path.join(qrImageDirectory(env), `${normalizedId}.png`);
}

function siblingTempFile(targetFile) {
  const nonce = crypto.randomBytes(6).toString('hex');
  return path.join(
    path.dirname(targetFile),
    `.${path.basename(targetFile)}.${process.pid}.${Date.now()}.${nonce}.tmp`
  );
}

function stageFileReplacement(targetFile, content) {
  const tempFile = siblingTempFile(targetFile);
  const backupFile = siblingTempFile(targetFile);
  let descriptor = null;
  let hasBackup = false;
  try {
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    descriptor = fs.openSync(tempFile, 'wx', 0o600);
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    if (fs.existsSync(targetFile)) {
      fs.renameSync(targetFile, backupFile);
      hasBackup = true;
    }
    fs.renameSync(tempFile, targetFile);
    return Object.freeze({
      commit() {
        if (hasBackup) unlinkFile(backupFile);
      },
      rollback() {
        unlinkFile(targetFile);
        if (hasBackup && fs.existsSync(backupFile)) {
          fs.renameSync(backupFile, targetFile);
        }
      }
    });
  } catch (error) {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch (_closeError) {
        // Preserve the original staging error.
      }
    }
    unlinkFile(tempFile);
    if (hasBackup && fs.existsSync(backupFile) && !fs.existsSync(targetFile)) {
      fs.renameSync(backupFile, targetFile);
    }
    throw error;
  }
}

async function renderQrImage({ baseUrl, qrId, accessToken }) {
  const content = `${String(baseUrl || 'http://localhost:3000').replace(/\/$/, '')}`
    + `/record.html?t=${encodeURIComponent(accessToken)}`;
  const raw = await QRCode.toBuffer(content, {
    type: 'png',
    width: 300,
    margin: 2,
    errorCorrectionLevel: 'M'
  });
  return addLabelToQR(raw, qrId);
}

module.exports = {
  qrImageDirectory,
  qrImagePath,
  renderQrImage,
  stageFileReplacement
};
