const crypto = require('crypto');
const { sendSmsCode } = require('./smsProviderService');

const smsCodeStore = new Map();
const MAX_CLEANUP_INTERVAL_MS = 60_000;
let nextCleanupAt = 0;

function codeTtlMs() {
  return Number(process.env.SMS_CODE_TTL_MS || 5 * 60 * 1000);
}

function cooldownMs() {
  const raw = process.env.SMS_SEND_COOLDOWN_MS;
  return raw === undefined || String(raw).trim() === '' ? 60 * 1000 : Number(raw);
}

function maxVerifyAttempts() {
  return Number(process.env.SMS_CODE_MAX_VERIFY_ATTEMPTS || 5);
}

function nowMs() {
  return Date.now();
}

function cleanupIntervalMs() {
  return Math.max(1_000, Math.min(codeTtlMs(), MAX_CLEANUP_INTERVAL_MS));
}

function pruneExpiredSmsCodes(currentTime = nowMs(), { force = false } = {}) {
  if (!force && currentTime < nextCleanupAt) return 0;
  let removed = 0;
  for (const [phone, record] of smsCodeStore.entries()) {
    if (!record || !Number.isFinite(record.expiresAt) || record.expiresAt <= currentTime) {
      smsCodeStore.delete(phone);
      removed += 1;
    }
  }
  nextCleanupAt = currentTime + cleanupIntervalMs();
  return removed;
}

function maskCodeForLogs(code) {
  return `***${String(code).slice(-2)}`;
}

function generateCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function getRecord(phone) {
  pruneExpiredSmsCodes();
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
    debugCode: ['development', 'test'].includes(String(process.env.NODE_ENV || '').toLowerCase())
      ? maskCodeForLogs(code)
      : null,
    plainCode: ['development', 'test'].includes(String(process.env.NODE_ENV || '').toLowerCase())
      ? code
      : null
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
  nextCleanupAt = 0;
}

module.exports = {
  sendCode,
  verifyCode,
  pruneExpiredSmsCodes,
  resetSmsCodeStore
};
