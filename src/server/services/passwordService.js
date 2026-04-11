const crypto = require('crypto');

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;

function hashPassword(plainText) {
  const value = String(plainText || '');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(value, salt, KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P
  }).toString('hex');

  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${hash}`;
}

function isPasswordHashed(value) {
  return typeof value === 'string' && value.startsWith('scrypt$');
}

function verifyPassword(plainText, hashedValue) {
  if (!isPasswordHashed(hashedValue)) {
    return String(plainText || '') === String(hashedValue || '');
  }

  const [, nStr, rStr, pStr, salt, expectedHash] = hashedValue.split('$');
  const hash = crypto.scryptSync(String(plainText || ''), salt, KEYLEN, {
    N: Number(nStr),
    r: Number(rStr),
    p: Number(pStr)
  }).toString('hex');

  const expectedBuffer = Buffer.from(expectedHash, 'hex');
  const actualBuffer = Buffer.from(hash, 'hex');
  return expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

module.exports = {
  hashPassword,
  verifyPassword,
  isPasswordHashed
};
