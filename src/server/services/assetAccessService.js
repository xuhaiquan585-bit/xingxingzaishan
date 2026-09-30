'use strict';

const crypto = require('node:crypto');

const MAX_ASSET_TTL_SECONDS = 3600;
const PURPOSES = new Set(['record-media', 'local-asset']);

function signingSecret(env) {
  const secret = String(env.AUTH_SECRET || '');
  if (!secret) throw new Error('ASSET_SIGNING_UNAVAILABLE');
  return secret;
}

function signatureFor(purpose, resource, expires, env) {
  return crypto.createHmac('sha256', signingSecret(env))
    .update(JSON.stringify(['asset-access-v1', purpose, resource, expires]), 'utf8')
    .digest();
}

function signAssetAccess({
  purpose, resource, ttlSeconds = MAX_ASSET_TTL_SECONDS, now = Date.now(), env = process.env
}) {
  if (!PURPOSES.has(purpose) || typeof resource !== 'string' || !resource
      || !Number.isFinite(now)) throw new Error('ASSET_ACCESS_INVALID');
  const ttl = Math.min(MAX_ASSET_TTL_SECONDS, Math.max(1, Math.floor(Number(ttlSeconds)) || 1));
  const expires = String(Math.floor(now / 1000) + ttl);
  return { expires, signature: signatureFor(purpose, resource, expires, env).toString('hex') };
}

function verifyAssetAccess({ purpose, resource, expires, signature, now = Date.now(), env = process.env }) {
  if (!PURPOSES.has(purpose) || typeof resource !== 'string' || !resource
      || typeof expires !== 'string' || !/^\d{1,12}$/.test(expires)
      || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)
      || !Number.isFinite(now)) return false;
  const remaining = Number(expires) - Math.floor(now / 1000);
  if (remaining <= 0 || remaining > MAX_ASSET_TTL_SECONDS) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'), signatureFor(purpose, resource, expires, env)
    );
  } catch (_error) {
    return false;
  }
}

function localAssetPath(value) {
  if (typeof value !== 'string') return null;
  const pathname = value.split('?')[0];
  if (!/^\/(uploads|cloud)\/[a-zA-Z0-9_./-]+$/.test(pathname)
      || pathname.split('/').some((part, index) => index > 0 && (!part || part === '.' || part === '..'))) {
    return null;
  }
  return pathname;
}

function signLocalAssetUrl(value, options = {}) {
  let candidate = value;
  let origin = '';
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const base = new URL((options.env || process.env).BASE_URL);
      if (url.origin !== base.origin || url.username || url.password) return value;
      candidate = url.pathname;
      origin = url.origin;
    } catch (_error) {
      return value;
    }
  }
  const pathname = localAssetPath(candidate);
  if (!pathname) return value;
  const grant = signAssetAccess({ ...options, purpose: 'local-asset', resource: pathname });
  return `${origin}${pathname}?${new URLSearchParams(grant)}`;
}

// Refresh presentation URLs without persisting expiring signatures in content records.
function refreshLocalAssetUrls(value) {
  if (typeof value === 'string') return signLocalAssetUrl(value);
  if (Array.isArray(value)) return value.map(refreshLocalAssetUrls);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, refreshLocalAssetUrls(item)]));
  }
  return value;
}

function requireLocalAssetSignature(prefix) {
  return (req, res, next) => {
    const resource = `${prefix}${req.path}`;
    if (!localAssetPath(resource) || !verifyAssetAccess({
      purpose: 'local-asset', resource,
      expires: req.query.expires, signature: req.query.signature
    })) return res.status(404).end();
    res.setHeader('Cache-Control', 'private, no-store');
    return next();
  };
}

module.exports = {
  MAX_ASSET_TTL_SECONDS,
  refreshLocalAssetUrls,
  requireLocalAssetSignature,
  signAssetAccess,
  signLocalAssetUrl,
  verifyAssetAccess
};
