const { verifyMiniappToken } = require('../services/miniappAuthService');
const {
  getAuthenticatedMiniappUser,
  getAuthenticatedMiniappUserReadContext
} = require('../services/dbService');
const {
  identityAuthDto,
  registerIdentityShadowObservation
} = require('../services/postgres/identityShadowRuntime');

function getBearerToken(req) {
  const value = req.headers.authorization || '';
  if (!value.startsWith('Bearer ')) {
    return null;
  }
  return value.replace('Bearer ', '').trim();
}

function isMiniappIdentityShadowRequest(req) {
  const pathname = String(req.originalUrl || req.url || '').split('?')[0];
  return req.method === 'GET' && pathname === '/api/miniapp/user/records';
}

function attachMiniappUser(req, res) {
  const token = getBearerToken(req);
  const payload = verifyMiniappToken(token);
  if (!payload || !payload.id || !payload.openid) {
    req.miniappUser = null;
    return null;
  }

  const input = {
    userId: payload.id,
    openid: payload.openid,
    accountId: payload.account_id || null
  };
  const observeIdentity = isMiniappIdentityShadowRequest(req);
  const context = observeIdentity
    ? getAuthenticatedMiniappUserReadContext(input)
    : { result: getAuthenticatedMiniappUser(input), sourceHash: null };
  const { result } = context;
  req.miniappUser = result.data || null;
  if (req.miniappUser && observeIdentity) {
    registerIdentityShadowObservation({
      res,
      event: {
        endpointTemplate: '/api/miniapp/user/records',
        channel: 'miniapp',
        accountId: result.data.account_id,
        sourceHash: context.sourceHash,
        baselineDto: identityAuthDto(result),
        viewer: {
          identityId: result.data.id,
          openid: result.data.openid
        }
      }
    });
  }
  return req.miniappUser;
}

function optionalMiniappAuth(req, res, next) {
  attachMiniappUser(req, res);
  return next();
}

function requireMiniappAuth(req, res, next) {
  const user = attachMiniappUser(req, res);
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
  requireMiniappPhone,
  isMiniappIdentityShadowRequest
};
