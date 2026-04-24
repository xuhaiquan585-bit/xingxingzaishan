const {
  getSession,
  getCookieName,
  getCookieMaxAge
} = require('../services/userSessionService');

function parseCookies(rawCookie = '') {
  return rawCookie
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const index = part.indexOf('=');
      if (index <= 0) return acc;
      const key = part.slice(0, index).trim();
      let value = part.slice(index + 1).trim();
      try {
        value = decodeURIComponent(value);
      } catch (_error) {
        return acc;
      }
      acc[key] = value;
      return acc;
    }, {});
}

function buildCookieHeader(value, maxAgeSeconds) {
  const attrs = [
    `${getCookieName()}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${maxAgeSeconds}`,
    `SameSite=${process.env.USER_SESSION_SAMESITE || 'Lax'}`
  ];
  if (process.env.USER_SESSION_SECURE === 'true') {
    attrs.push('Secure');
  }
  return attrs.join('; ');
}

function clearCookieHeader() {
  const attrs = [
    `${getCookieName()}=`,
    'Path=/',
    'HttpOnly',
    'Max-Age=0',
    'SameSite=Lax'
  ];
  if (process.env.USER_SESSION_SECURE === 'true') {
    attrs.push('Secure');
  }
  return attrs.join('; ');
}

function attachUserSession() {
  return (req, _res, next) => {
    const cookies = parseCookies(req.headers.cookie || '');
    req.userSessionId = cookies[getCookieName()] || null;
    req.user = null;
    if (req.userSessionId) {
      const session = getSession(req.userSessionId);
      if (session) {
        req.user = {
          id: session.user_id,
          phone: session.phone
        };
      }
    }
    next();
  };
}

function requireUserSession(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      status: 'error',
      code: 'UNAUTHORIZED',
      message: '请先完成手机号登录。'
    });
  }
  return next();
}

module.exports = {
  attachUserSession,
  requireUserSession,
  buildCookieHeader,
  clearCookieHeader,
  parseCookies,
  getCookieMaxAge
};
