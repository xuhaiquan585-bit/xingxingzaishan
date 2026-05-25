const { verifyMiniappToken } = require('../services/miniappAuthService');
const { findUserByOpenid } = require('../services/dbService');

function getBearerToken(req) {
  const value = req.headers.authorization || '';
  if (!value.startsWith('Bearer ')) {
    return null;
  }
  return value.replace('Bearer ', '').trim();
}

function attachMiniappUser(req) {
  const token = getBearerToken(req);
  const payload = verifyMiniappToken(token);
  if (!payload || !payload.openid) {
    req.miniappUser = null;
    return null;
  }

  const user = findUserByOpenid(payload.openid);
  req.miniappUser = user || null;
  return req.miniappUser;
}

function optionalMiniappAuth(req, _res, next) {
  attachMiniappUser(req);
  return next();
}

function requireMiniappAuth(req, res, next) {
  const user = attachMiniappUser(req);
  if (!user) {
    return res.status(401).json({
      status: 'error',
      code: 'UNAUTHORIZED',
      message: '请先登录小程序。'
    });
  }
  return next();
}

function requireMiniappPhone(req, res, next) {
  if (!req.miniappUser || !req.miniappUser.phone) {
    return res.status(403).json({
      status: 'error',
      code: 'PHONE_NOT_BOUND',
      message: '请先绑定手机号后继续。'
    });
  }
  return next();
}

module.exports = {
  optionalMiniappAuth,
  requireMiniappAuth,
  requireMiniappPhone
};
