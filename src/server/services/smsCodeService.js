const crypto = require('crypto');
const { sendSmsCode } = require('./smsProviderService');

const smsCodeStore = new Map();

function codeTtlMs() {
  return Number(process.env.SMS_CODE_TTL_MS || 5 * 60 * 1000);
}

function cooldownMs() {
  return Number(process.env.SMS_SEND_COOLDOWN_MS || 60 * 1000);
}

function maxVerifyAttempts() {
  return Number(process.env.SMS_CODE_MAX_VERIFY_ATTEMPTS || 5);
}

function nowMs() {
  return Date.now();
}

function maskCodeForLogs(code) {
  return `***${String(code).slice(-2)}`;
}

function generateCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function getRecord(phone) {
  const record = smsCodeStore.get(phone);
  if (!record) return null;
  if (record.expiresAt <= nowMs()) {
    smsCodeStore.delete(phone);
    return null;
  }
  return record;
}

async function sendCode(phone) {
  const existing = getRecord(phone);
  if (existing && existing.lastSentAt + cooldownMs() > nowMs()) {
    const error = new Error('发送过于频繁，请稍后再试。');
    error.code = 'SMS_SEND_TOO_FREQUENT';
    throw error;
  }

  const code = generateCode();
  await sendSmsCode(phone, code);
  const issuedAt = nowMs();
  const record = {
    code,
    expiresAt: issuedAt + codeTtlMs(),
    lastSentAt: issuedAt,
    failedAttempts: 0
  };
  smsCodeStore.set(phone, record);

  return {
    expiresInSeconds: Math.floor(codeTtlMs() / 1000),
    cooldownInSeconds: Math.floor(cooldownMs() / 1000),
    debugCode: process.env.NODE_ENV === 'production' ? null : maskCodeForLogs(code),
    plainCode: process.env.NODE_ENV === 'production' ? null : code
  };
}

function verifyCode(phone, code) {
  const record = getRecord(phone);
  if (!record) {
    return { ok: false };
  }

  if (record.code !== String(code || '').trim()) {
    record.failedAttempts += 1;
    if (record.failedAttempts >= maxVerifyAttempts()) {
      smsCodeStore.delete(phone);
    } else {
      smsCodeStore.set(phone, record);
    }
    return { ok: false };
  }

  smsCodeStore.delete(phone);
  return { ok: true };
}

function resetSmsCodeStore() {
  smsCodeStore.clear();
}

module.exports = {
  sendCode,
  verifyCode,
  resetSmsCodeStore
};
