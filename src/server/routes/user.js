const express = require('express');
const {
  createOrGetUser,
  findPersonalRecordListContextByAccountId,
  findPersonalRecordDetailContext
} = require('../services/dbService');
const { createSession, destroySession } = require('../services/userSessionService');
const { sendCode, verifyCode } = require('../services/smsCodeService');
const {
  requireUserSession,
  buildCookieHeader,
  clearCookieHeader,
  getCookieMaxAge
} = require('../middlewares/userSession');
const { getSignedUrl } = require('../services/storageService');
const { chainPublicPayload } = require('../services/chainViewService');
const { createPublicQrAssetResolver } = require('../services/publicQrAssetResolver');
const {
  registerPersonalRecordShadowObservation
} = require('../services/postgres/personalRecordShadowRuntime');
const {
  personalRecordPrimaryReadHttpError,
  readPersonalRecordPrimary
} = require('../services/postgres/personalRecordPrimaryReadRuntime');

const router = express.Router();

function isValidPhone(phone) {
  return /^1\d{10}$/.test(phone);
}

function isLegacyLoginEnabled() {
  const raw = process.env.USER_LEGACY_LOGIN_ENABLED;
  if (raw === undefined) {
    return process.env.NODE_ENV !== 'production';
  }
  return raw === '1' || raw === 'true';
}

function shouldExposeVerificationCode() {
  return process.env.NODE_ENV !== 'production';
}

function accountMappingFailure(res, code = 'ACCOUNT_MAPPING_REQUIRED') {
  return res.status(409).json({
    status: 'error',
    code,
    message: '账号状态异常，暂时无法登录，请稍后处理。'
  });
}

function isAccountLoginError(errorCode) {
  return [
    'ACCOUNT_MAPPING_REQUIRED',
    'ACCOUNT_MAPPING_MISMATCH',
    'ACCOUNT_IDENTITY_MISMATCH',
    'DUPLICATE_PHONE_IDENTITY'
  ].includes(errorCode);
}

function handleLogin(req, res, next) {
  if (!isLegacyLoginEnabled()) {
    return res.status(403).json({
      status: 'error',
      code: 'LEGACY_LOGIN_DISABLED',
      message: '当前登录方式已下线，请使用短信验证码登录。'
    });
  }

  const { phone } = req.body;
  if (!phone || !isValidPhone(phone)) {
    return res.status(400).json({
      status: 'error',
      code: 'INVALID_PHONE',
      message: '手机号格式不正确，请检查后重试。'
    });
  }

  let user;
  try {
    user = createOrGetUser(phone);
  } catch (error) {
    if (isAccountLoginError(error.code)) {
      return accountMappingFailure(res, error.code);
    }
    return next(error);
  }
  const session = createSession({
    userId: user.id,
    phone: user.phone,
    accountId: user.account_id
  });
  res.setHeader('Set-Cookie', buildCookieHeader(session.sid, getCookieMaxAge()));

  return res.json({
    status: 'success',
    code: 'OK',
    data: {
      id: user.id,
      phone: user.phone,
      created_at: user.created_at,
      session_expires_at: session.expires_at
    }
  });
}

async function handleSendCode(req, res) {
  const { phone } = req.body;
  if (!phone || !isValidPhone(phone)) {
    return res.status(400).json({
      status: 'error',
      code: 'INVALID_PHONE',
      message: '手机号格式不正确，请检查后重试。'
    });
  }

  try {
    const sendResult = await sendCode(phone);
    const data = {
      sent: true,
      expires_in_seconds: sendResult.expiresInSeconds,
      cooldown_in_seconds: sendResult.cooldownInSeconds
    };
    if (shouldExposeVerificationCode() && sendResult.plainCode) {
      data.verification_code = sendResult.plainCode;
    }
    return res.json({
      status: 'success',
      code: 'OK',
      data
    });
  } catch (error) {
    if (error.code === 'SMS_SEND_TOO_FREQUENT') {
      return res.status(429).json({
        status: 'error',
        code: 'SMS_SEND_TOO_FREQUENT',
        message: '发送过于频繁，请稍后再试。'
      });
    }
    return res.status(503).json({
      status: 'error',
      code: 'SMS_SERVICE_UNAVAILABLE',
      message: '短信服务暂时不可用，请稍后再试。'
    });
  }
}

function handleVerifyCode(req, res, next) {
  const { phone, code } = req.body;
  if (!phone || !isValidPhone(phone)) {
    return res.status(400).json({
      status: 'error',
      code: 'INVALID_PHONE',
      message: '手机号格式不正确，请检查后重试。'
    });
  }
  if (!/^\d{6}$/.test(String(code || '').trim())) {
    return res.status(400).json({
      status: 'error',
      code: 'INVALID_VERIFY_CODE',
      message: '验证码错误或已过期，请重新获取'
    });
  }

  const verified = verifyCode(phone, code);
  if (!verified.ok) {
    return res.status(400).json({
      status: 'error',
      code: 'INVALID_VERIFY_CODE',
      message: '验证码错误或已过期，请重新获取'
    });
  }

  let user;
  try {
    user = createOrGetUser(phone);
  } catch (error) {
    if (isAccountLoginError(error.code)) {
      return accountMappingFailure(res, error.code);
    }
    return next(error);
  }
  const session = createSession({
    userId: user.id,
    phone: user.phone,
    accountId: user.account_id
  });
  res.setHeader('Set-Cookie', buildCookieHeader(session.sid, getCookieMaxAge()));
  return res.json({
    status: 'success',
    code: 'OK',
    data: {
      id: user.id,
      phone: user.phone,
      created_at: user.created_at,
      session_expires_at: session.expires_at
    }
  });
}

function handleMe(req, res) {
  return res.json({
    status: 'success',
    code: 'OK',
    data: {
      id: req.user.id,
      phone: req.user.phone
    }
  });
}

function handleLogout(req, res) {
  destroySession(req.userSessionId);
  res.setHeader('Set-Cookie', clearCookieHeader());
  return res.json({
    status: 'success',
    code: 'OK',
    data: {
      logged_out: true
    }
  });
}

function resolveImageUrl(record, assetResolver = null) {
  if (assetResolver && typeof assetResolver.resolveRecordImage === 'function') {
    return assetResolver.resolveRecordImage({ record, channel: 'h5' });
  }
  if (record.image_object_key) {
    try {
      return getSignedUrl(record.image_object_key);
    } catch (_error) {
      return record.image_url;
    }
  }
  return record.image_url;
}

function visibleComments(record) {
  return (Array.isArray(record.co_creation_comments) ? record.co_creation_comments : [])
    .filter((comment) => comment.status !== 'deleted')
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map((comment) => ({
      id: comment.id,
      author_name: comment.author_name || '',
      content: comment.content || '',
      created_at: comment.created_at || ''
    }));
}

function respondPersonalRecordReadUnavailable(res, error) {
  const response = personalRecordPrimaryReadHttpError(error);
  return res.status(response.status).json({
    status: 'error',
    code: response.code,
    message: response.message
  });
}

async function handleRecords(req, res) {
  const accountId = String(req.user.account_id || '');
  const {
    records: sourceRecords,
    sourceHash,
    publicQrDomainHash
  } = findPersonalRecordListContextByAccountId(accountId);
  const assetResolver = createPublicQrAssetResolver();

  try {
    const primaryRead = await readPersonalRecordPrimary({
      readKind: 'list',
      accountId,
      domainHash: publicQrDomainHash,
      channel: 'h5',
      assetResolver
    });
    if (primaryRead.selected) {
      return res.json({ status: 'success', code: 'OK', data: primaryRead.dto });
    }
  } catch (error) {
    return respondPersonalRecordReadUnavailable(res, error);
  }

  const records = sourceRecords.map((item) => ({
    id: item.id,
    content: item.content,
    activated_at: item.activated_at,
    display_at: item.display_at,
    activation_status: item.activation_status,
    image_url: resolveImageUrl(item, assetResolver)
  }));
  const data = {
    total: records.length,
    records
  };
  registerPersonalRecordShadowObservation({
    res,
    event: {
      channel: 'h5',
      endpointTemplate: '/api/user/records',
      readKind: 'list',
      accountId,
      baselineDto: data,
      sourceHash,
      assetResolver
    }
  });
  return res.json({
    status: 'success',
    code: 'OK',
    data
  });
}

async function handleRecordDetail(req, res) {
  const accountId = String(req.user.account_id || '');
  const {
    record,
    batch,
    sourceHash,
    publicQrDomainHash
  } = findPersonalRecordDetailContext({
    account_id: req.user.account_id,
    id: req.params.id
  });

  const assetResolver = createPublicQrAssetResolver();
  try {
    const primaryRead = await readPersonalRecordPrimary({
      readKind: 'detail',
      accountId,
      recordId: req.params.id,
      domainHash: publicQrDomainHash,
      channel: 'h5',
      assetResolver
    });
    if (primaryRead.selected) {
      return res.json({ status: 'success', code: 'OK', data: primaryRead.dto });
    }
  } catch (error) {
    return respondPersonalRecordReadUnavailable(res, error);
  }

  if (!record) {
    return res.status(404).json({
      status: 'error',
      code: 'RECORD_NOT_FOUND',
      message: '未找到该点亮记录。'
    });
  }

  const data = {
    id: record.id,
    content: record.content,
    activated_at: record.activated_at,
    blockchain_hash: record.blockchain_hash,
    ...chainPublicPayload(record, { channel: 'h5', assetResolver }),
    co_creation_enabled: record.co_creation_enabled === true,
    co_creation_comments: visibleComments(record),
    image_url: resolveImageUrl(record, assetResolver),
    show_brand_disclosure: record.show_brand_disclosure,
    brand_disclosure_text_snapshot: record.brand_disclosure_text_snapshot,
    brand_name: batch ? batch.brand_name || '' : ''
  };
  registerPersonalRecordShadowObservation({
    res,
    event: {
      channel: 'h5',
      endpointTemplate: '/api/user/records/:id',
      readKind: 'detail',
      accountId,
      recordId: record.id,
      baselineDto: data,
      sourceHash,
      assetResolver
    }
  });
  return res.json({ status: 'success', code: 'OK', data });
}

router.post('/login', handleLogin);
router.post('/sms/send-code', handleSendCode);
router.post('/sms/verify-code', handleVerifyCode);
router.get('/me', requireUserSession, handleMe);
router.post('/logout', requireUserSession, handleLogout);
router.get('/records', requireUserSession, (req, res, next) => (
  handleRecords(req, res).catch(next)
));
router.get('/records/:id', requireUserSession, (req, res, next) => (
  handleRecordDetail(req, res).catch(next)
));

module.exports = router;
