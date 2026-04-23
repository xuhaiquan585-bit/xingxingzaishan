const express = require('express');
const { createOrGetUser, listActivatedRecordsByPhone } = require('../services/dbService');
const { createSession, destroySession } = require('../services/userSessionService');
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

function handleLogin(req, res) {
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

function handleRecords(req, res) {
  const records = listActivatedRecordsByPhone(req.user.phone).map((item) => ({
    id: item.id,
    content: item.content,
    activated_at: item.activated_at,
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

router.post('/login', handleLogin);
router.get('/me', requireUserSession, handleMe);
router.post('/logout', requireUserSession, handleLogout);
router.get('/records', requireUserSession, handleRecords);

module.exports = router;
