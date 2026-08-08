const {
  getSession,
  getCookieName,
  getCookieMaxAge
} = require('../services/userSessionService');
const {
  getAuthenticatedUserById,
  getAuthenticatedUserReadContext
} = require('../services/dbService');
const {
  identityAuthDto,
  registerIdentityShadowObservation
} = require('../services/postgres/identityShadowRuntime');

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
  const sameSite = process.env.USER_SESSION_SAMESITE || 'Lax';
  const attrs = [
    `${getCookieName()}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${maxAgeSeconds}`,
    `SameSite=${sameSite}`
  ];
  if (process.env.USER_SESSION_SECURE === 'true') {
    attrs.push('Secure');
  }
  return attrs.join('; ');
}

function clearCookieHeader() {
  const sameSite = process.env.USER_SESSION_SAMESITE || 'Lax';
  const attrs = [
    `${getCookieName()}=`,
    'Path=/',
    'HttpOnly',
    'Max-Age=0',
    `SameSite=${sameSite}`
  ];
  if (process.env.USER_SESSION_SECURE === 'true') {
    attrs.push('Secure');
  }
  return attrs.join('; ');
}

function isH5IdentityShadowRequest(req) {
  const pathname = String(req.originalUrl || req.url || '').split('?')[0];
  return req.method === 'GET' && pathname === '/api/user/me';
}

function attachUserSession() {
  return (req, res, next) => {
    const cookies = parseCookies(req.headers.cookie || '');
    req.userSessionId = cookies[getCookieName()] || null;
    req.user = null;
    if (req.userSessionId) {
      const session = getSession(req.userSessionId);
      if (session) {
        const input = {
          userId: session.user_id,
          accountId: session.account_id || null
        };
        const observeIdentity = isH5IdentityShadowRequest(req);
        const context = observeIdentity
          ? getAuthenticatedUserReadContext(input)
          : { result: getAuthenticatedUserById(input), sourceHash: null };
        const { result } = context;
        if (result.data) {
          req.user = {
            id: result.data.id,
            phone: result.data.phone,
            account_id: result.data.account_id
          };
          if (observeIdentity) {
            registerIdentityShadowObservation({
              res,
              event: {
                endpointTemplate: '/api/user/me',
                channel: 'h5',
                accountId: result.data.account_id,
                sourceHash: context.sourceHash,
                baselineDto: identityAuthDto(result),
                viewer: {
                  identityId: result.data.id
                }
              }
            });
          }
        }
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
  isH5IdentityShadowRequest,
  getCookieMaxAge
};
