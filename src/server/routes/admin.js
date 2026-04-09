const express = require('express');
const {
  findAdmin,
  getDashboardStats,
  listQRRecords,
  setQRHiddenStatus
} = require('../services/dbService');
const { generateToken, verifyToken } = require('../services/authService');

const router = express.Router();

function getBearerToken(req) {
  const value = req.headers.authorization || '';
  if (!value.startsWith('Bearer ')) {
    return null;
  }
  return value.replace('Bearer ', '').trim();
}

function requireAdmin(req, res, next) {
  const token = getBearerToken(req);
  const operator = verifyToken(token);
  if (!operator) {
    return res.status(401).json({
      status: 'error',
      code: 'UNAUTHORIZED',
      message: '请先登录后台账号。'
    });
  }

  if (operator.role !== 'admin') {
    return res.status(403).json({
      status: 'error',
      code: 'FORBIDDEN',
      message: '你没有该操作权限。'
    });
  }

  req.operator = operator;
  return next();
}

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({
      status: 'error',
      code: 'VALIDATION_ERROR',
      message: '请输入后台账号和密码。'
    });
  }

  const admin = findAdmin(username, password);
  if (!admin) {
    return res.status(401).json({
      status: 'error',
      code: 'INVALID_CREDENTIALS',
      message: '账号或密码不正确。'
    });
  }

  const token = generateToken(admin);
  return res.json({
    status: 'success',
    code: 'OK',
    data: {
      token,
      profile: {
        id: admin.id,
        name: admin.name,
        username: admin.username,
        role: admin.role
      }
    }
  });
});

router.get('/dashboard', requireAdmin, (req, res) => {
  const { date_from: dateFrom, date_to: dateTo } = req.query;
  const stats = getDashboardStats({ dateFrom, dateTo });
  return res.json({
    status: 'success',
    code: 'OK',
    data: stats
  });
});

router.get('/records', requireAdmin, (req, res) => {
  const {
    issue_status: issueStatus,
    activation_status: activationStatus,
    hidden,
    date_from: dateFrom,
    date_to: dateTo,
    page = 1,
    limit = 20
  } = req.query;

  const data = listQRRecords({
    issueStatus,
    activationStatus,
    hidden,
    dateFrom,
    dateTo,
    page,
    limit
  });

  return res.json({
    status: 'success',
    code: 'OK',
    data
  });
});

router.post('/records/:qrId/hide', requireAdmin, (req, res) => {
  const updated = setQRHiddenStatus(req.params.qrId, true);
  if (!updated) {
    return res.status(404).json({
      status: 'error',
      code: 'QR_NOT_FOUND',
      message: '未找到该二维码。'
    });
  }

  return res.json({
    status: 'success',
    code: 'OK',
    data: updated
  });
});

router.post('/records/:qrId/show', requireAdmin, (req, res) => {
  const updated = setQRHiddenStatus(req.params.qrId, false);
  if (!updated) {
    return res.status(404).json({
      status: 'error',
      code: 'QR_NOT_FOUND',
      message: '未找到该二维码。'
    });
  }

  return res.json({
    status: 'success',
    code: 'OK',
    data: updated
  });
});

module.exports = router;
