const crypto = require('crypto');

const DEFAULT_TOKEN_TTL_SECONDS = 12 * 60 * 60;

function getAuthSecret() {
  return process.env.AUTH_SECRET || 'dev-only-change-me';
}

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function decodeBase64url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4;
  const padded = pad ? normalized + '='.repeat(4 - pad) : normalized;
  return Buffer.from(padded, 'base64').toString('utf8');
}

function sign(content) {
  return base64url(
    crypto
      .createHmac('sha256', getAuthSecret())
      .update(content)
      .digest()
  );
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

function generateToken(admin, options = {}) {
  const ttlSeconds = Number(options.ttl_seconds || process.env.AUTH_TOKEN_TTL_SECONDS || DEFAULT_TOKEN_TTL_SECONDS);
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    id: admin.id,
    username: admin.username,
    role: admin.role,
    name: admin.name,
    iat: now,
    exp: now + ttlSeconds
  };

  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const content = `${encodedHeader}.${encodedPayload}`;

  return `${content}.${sign(content)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') {
    return null;
  }

  const [encodedHeader, encodedPayload, tokenSignature] = token.split('.');
  if (!encodedHeader || !encodedPayload || !tokenSignature) {
    return null;
  }

  const content = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = sign(content);
  if (tokenSignature !== expectedSignature) {
    return null;
  }

  const header = safeJsonParse(decodeBase64url(encodedHeader));
  const payload = safeJsonParse(decodeBase64url(encodedPayload));
  if (!header || !payload || header.alg !== 'HS256') {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || now >= Number(payload.exp)) {
    return null;
  }

  return {
    id: payload.id,
    username: payload.username,
    role: payload.role,
    name: payload.name,
    issued_at: new Date(payload.iat * 1000).toISOString(),
    expires_at: new Date(payload.exp * 1000).toISOString()
  };
}

module.exports = {
  generateToken,
  verifyToken
};
