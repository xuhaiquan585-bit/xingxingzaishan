const express = require('express');
const {
  createOrGetUser,
  listActivatedRecordsByPhone,
  getActivatedRecordByPhoneAndId,
  listBatches
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

function handleLogin(req, res) {
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

  const user = createOrGetUser(phone);
  const session = createSession({
    userId: user.id,
    phone: user.phone
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

function handleVerifyCode(req, res) {
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

  const user = createOrGetUser(phone);
  const session = createSession({
    userId: user.id,
    phone: user.phone
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

function resolveImageUrl(record) {
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

function handleRecords(req, res) {
  const records = listActivatedRecordsByPhone(req.user.phone).map((item) => ({
    id: item.id,
    content: item.content,
    activated_at: item.activated_at,
    display_at: item.display_at,
    activation_status: item.activation_status,
    image_url: resolveImageUrl(item)
  }));

  return res.json({
    status: 'success',
    code: 'OK',
    data: {
      total: records.length,
      records
    }
  });
}

function handleRecordDetail(req, res) {
  const record = getActivatedRecordByPhoneAndId({
    phone: req.user.phone,
    id: req.params.id
  });

  if (!record) {
    return res.status(404).json({
      status: 'error',
      code: 'RECORD_NOT_FOUND',
      message: '未找到该点亮记录。'
    });
  }

  let brandName = '';
  if (record.batch_id) {
    const batch = listBatches().find((item) => item.id === record.batch_id);
    if (batch) {
      brandName = batch.brand_name || '';
    }
  }

  return res.json({
    status: 'success',
    code: 'OK',
    data: {
      id: record.id,
      content: record.content,
      activated_at: record.activated_at,
      blockchain_hash: record.blockchain_hash,
      co_creation_enabled: record.co_creation_enabled === true,
      co_creation_comments: visibleComments(record),
      image_url: resolveImageUrl(record),
      show_brand_disclosure: record.show_brand_disclosure,
      brand_disclosure_text_snapshot: record.brand_disclosure_text_snapshot,
      brand_name: brandName
    }
  });
}

router.post('/login', handleLogin);
router.post('/sms/send-code', handleSendCode);
router.post('/sms/verify-code', handleVerifyCode);
router.get('/me', requireUserSession, handleMe);
router.post('/logout', requireUserSession, handleLogout);
router.get('/records', requireUserSession, handleRecords);
router.get('/records/:id', requireUserSession, handleRecordDetail);

module.exports = router;
