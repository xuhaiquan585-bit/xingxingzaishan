const crypto = require('crypto');
const https = require('https');

const DEFAULT_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const WECHAT_REQUEST_TIMEOUT_MS = 10_000;
let cachedAccessToken = null;

function getMiniappConfig() {
  return {
    appid: process.env.WECHAT_MINIAPP_APPID || '',
    secret: process.env.WECHAT_MINIAPP_SECRET || ''
  };
}

function hasMiniappConfig() {
  const config = getMiniappConfig();
  return !!(config.appid && config.secret);
}

function isProduction() {
  return process.env.NODE_ENV === 'production';
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
  return Buffer.from(pad ? normalized + '='.repeat(4 - pad) : normalized, 'base64').toString('utf8');
}

function getAuthSecret() {
  return process.env.AUTH_SECRET || 'dev-only-change-me';
}

function sign(content) {
  return base64url(
    crypto
      .createHmac('sha256', getAuthSecret())
      .update(content)
      .digest()
  );
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

function requestJson(url, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = https.request(url, {
      method,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': payload.length
      } : undefined
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(WECHAT_REQUEST_TIMEOUT_MS, () => {
      const error = new Error('微信接口请求超时，请稍后重试。');
      error.code = 'WECHAT_REQUEST_TIMEOUT';
      req.destroy(error);
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function mockOpenidFromCode(code) {
  const normalized = String(code || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'anonymous';
  return `mock-openid-${normalized}`;
}

async function codeToSession(code) {
  const value = String(code || '').trim();
  if (!value) {
    const error = new Error('缺少微信登录凭证。');
    error.code = 'INVALID_LOGIN_CODE';
    throw error;
  }

  if (!hasMiniappConfig()) {
    if (isProduction()) {
      const error = new Error('微信小程序配置不完整。');
      error.code = 'WECHAT_CONFIG_ERROR';
      throw error;
    }
    if (value.startsWith('bad')) {
      const error = new Error('微信登录失败。');
      error.code = 'WECHAT_LOGIN_FAILED';
      throw error;
    }
    return {
      openid: mockOpenidFromCode(value),
      session_key: 'mock-session-key',
      unionid: null
    };
  }

  const config = getMiniappConfig();
  const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${encodeURIComponent(config.appid)}&secret=${encodeURIComponent(config.secret)}&js_code=${encodeURIComponent(value)}&grant_type=authorization_code`;
  const response = await requestJson(url);
  if (!response.openid || response.errcode) {
    const error = new Error(response.errmsg || '微信登录失败。');
    error.code = 'WECHAT_LOGIN_FAILED';
    throw error;
  }
  return response;
}

async function getMiniappAccessToken() {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) {
    return cachedAccessToken.value;
  }

  if (!hasMiniappConfig()) {
    if (isProduction()) {
      const error = new Error('微信小程序配置不完整。');
      error.code = 'WECHAT_CONFIG_ERROR';
      throw error;
    }
    return null;
  }

  const config = getMiniappConfig();
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(config.appid)}&secret=${encodeURIComponent(config.secret)}`;
  const response = await requestJson(url);
  if (!response.access_token || response.errcode) {
    const error = new Error(response.errmsg || '获取微信 access_token 失败。');
    error.code = 'WECHAT_ACCESS_TOKEN_FAILED';
    throw error;
  }

  cachedAccessToken = {
    value: response.access_token,
    expiresAt: Date.now() + Number(response.expires_in || 7200) * 1000
  };
  return cachedAccessToken.value;
}

async function getPhoneNumberByCode(code) {
  const value = String(code || '').trim();
  if (!value) {
    const error = new Error('缺少手机号授权凭证。');
    error.code = 'INVALID_PHONE_CODE';
    throw error;
  }

  if (!hasMiniappConfig()) {
    if (isProduction()) {
      const error = new Error('微信小程序配置不完整。');
      error.code = 'WECHAT_CONFIG_ERROR';
      throw error;
    }
    if (value.startsWith('bad')) {
      const error = new Error('手机号授权失败。');
      error.code = 'PHONE_BIND_FAILED';
      throw error;
    }
    return /^1\d{10}$/.test(value) ? value : '13800000000';
  }

  const accessToken = await getMiniappAccessToken();
  const url = `https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${encodeURIComponent(accessToken)}`;
  const response = await requestJson(url, {
    method: 'POST',
    body: { code: value }
  });
  if (response.errcode || !response.phone_info || !response.phone_info.phoneNumber) {
    const error = new Error(response.errmsg || '手机号授权失败。');
    error.code = 'PHONE_BIND_FAILED';
    throw error;
  }
  return response.phone_info.phoneNumber;
}

function generateMiniappToken(user, options = {}) {
  const ttlSeconds = Number(options.ttl_seconds || process.env.MINIAPP_TOKEN_TTL_SECONDS || DEFAULT_TOKEN_TTL_SECONDS);
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    id: user.id,
    openid: user.openid,
    phone: user.phone || null,
    source: 'miniapp',
    iat: now,
    exp: now + ttlSeconds
  };
  const encodedHeader = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const encodedPayload = base64url(JSON.stringify(payload));
  const content = `${encodedHeader}.${encodedPayload}`;
  return `${content}.${sign(content)}`;
}

function verifyMiniappToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [encodedHeader, encodedPayload, tokenSignature] = token.split('.');
  if (!encodedHeader || !encodedPayload || !tokenSignature) return null;

  const content = `${encodedHeader}.${encodedPayload}`;
  if (!safeEqual(sign(content), tokenSignature)) return null;

  const header = safeJsonParse(decodeBase64url(encodedHeader));
  const payload = safeJsonParse(decodeBase64url(encodedPayload));
  if (!header || !payload || header.alg !== 'HS256' || payload.source !== 'miniapp') return null;
  if (!payload.exp || Math.floor(Date.now() / 1000) >= Number(payload.exp)) return null;

  return {
    id: payload.id,
    openid: payload.openid,
    phone: payload.phone || null
  };
}

module.exports = {
  codeToSession,
  getPhoneNumberByCode,
  getMiniappAccessToken,
  generateMiniappToken,
  verifyMiniappToken,
  hasMiniappConfig
};
