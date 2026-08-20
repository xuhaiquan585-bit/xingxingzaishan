'use strict';

const crypto = require('node:crypto');

const UPLOAD_PROOF_VERSION = 1;
const UPLOAD_PROOF_PURPOSE = 'record-image';
const UPLOAD_PROOF_TTL_SECONDS = 15 * 60;
const PAYLOAD_KEYS = Object.freeze([
  'v',
  'purpose',
  'account_id',
  'qr_id',
  'object_key',
  'iat',
  'exp'
]);

class UploadProofError extends Error {
  constructor() {
    super('UPLOAD_PROOF_INVALID');
    this.name = 'UploadProofError';
    this.code = 'UPLOAD_PROOF_INVALID';
  }
}

function invalidProof() {
  throw new UploadProofError();
}

function getUploadProofSecret(env = process.env) {
  const secret = String(env.UPLOAD_PROOF_SECRET || '');
  const authSecret = String(env.AUTH_SECRET || '');
  if (Buffer.byteLength(secret, 'utf8') < 32 || secret === authSecret) {
    invalidProof();
  }
  return secret;
}

function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value || '')) invalidProof();
  try {
    return Buffer.from(value, 'base64url');
  } catch (_error) {
    return invalidProof();
  }
}

function signatureFor(encodedPayload, secret) {
  return crypto.createHmac('sha256', secret).update(encodedPayload, 'utf8').digest();
}

function issueRecordImageUploadProof({
  accountId,
  qrId,
  objectKey,
  now = Date.now(),
  env = process.env
} = {}) {
  const normalizedAccountId = String(accountId || '').trim();
  const normalizedQrId = String(qrId || '').trim();
  const normalizedObjectKey = String(objectKey || '').trim();
  if (!normalizedAccountId || !normalizedQrId || !normalizedObjectKey
      || !Number.isFinite(now)) invalidProof();
  const issuedAt = Math.floor(now / 1000);
  const payload = {
    v: UPLOAD_PROOF_VERSION,
    purpose: UPLOAD_PROOF_PURPOSE,
    account_id: normalizedAccountId,
    qr_id: normalizedQrId,
    object_key: normalizedObjectKey,
    iat: issuedAt,
    exp: issuedAt + UPLOAD_PROOF_TTL_SECONDS
  };
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const signature = signatureFor(encodedPayload, getUploadProofSecret(env));
  return `${encodedPayload}.${encodeBase64Url(signature)}`;
}

function verifyRecordImageUploadProof({
  proof,
  accountId,
  now = Date.now(),
  env = process.env
} = {}) {
  const parts = String(proof || '').split('.');
  if (parts.length !== 2 || !Number.isFinite(now)) invalidProof();
  const [encodedPayload, encodedSignature] = parts;
  const suppliedSignature = decodeBase64Url(encodedSignature);
  const expectedSignature = signatureFor(encodedPayload, getUploadProofSecret(env));
  if (suppliedSignature.length !== expectedSignature.length
      || !crypto.timingSafeEqual(suppliedSignature, expectedSignature)) {
    invalidProof();
  }

  let payload;
  try {
    payload = JSON.parse(decodeBase64Url(encodedPayload).toString('utf8'));
  } catch (_error) {
    return invalidProof();
  }
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') invalidProof();
  const keys = Object.keys(payload);
  if (keys.length !== PAYLOAD_KEYS.length
      || PAYLOAD_KEYS.some((key, index) => keys[index] !== key)) {
    invalidProof();
  }

  const nowSeconds = Math.floor(now / 1000);
  if (payload.v !== UPLOAD_PROOF_VERSION
      || payload.purpose !== UPLOAD_PROOF_PURPOSE
      || payload.account_id !== String(accountId || '').trim()
      || typeof payload.qr_id !== 'string'
      || !payload.qr_id.trim()
      || typeof payload.object_key !== 'string'
      || !payload.object_key
      || !Number.isInteger(payload.iat)
      || !Number.isInteger(payload.exp)
      || payload.exp - payload.iat !== UPLOAD_PROOF_TTL_SECONDS
      || payload.iat > nowSeconds + 30
      || payload.exp <= nowSeconds) {
    invalidProof();
  }
  return Object.freeze({ ...payload });
}

module.exports = {
  UPLOAD_PROOF_PURPOSE,
  UPLOAD_PROOF_TTL_SECONDS,
  UPLOAD_PROOF_VERSION,
  UploadProofError,
  getUploadProofSecret,
  issueRecordImageUploadProof,
  verifyRecordImageUploadProof
};
