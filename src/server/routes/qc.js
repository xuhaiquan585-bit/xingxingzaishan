const express = require('express');
const { verifyToken } = require('../services/authService');
const { runQualityCheck, getQualityCheckLogs, getQualityCheckStats } = require('../services/dbService');

const router = express.Router();

function getBearerToken(req) {
  const value = req.headers.authorization || '';
  if (!value.startsWith('Bearer ')) {
    return null;
  }
  return value.replace('Bearer ', '').trim();
}

function requireQC(req, res, next) {
  const token = getBearerToken(req);
  const operator = verifyToken(token);
  if (!operator) {
    return res.status(401).json({
      status: 'error',
      code: 'UNAUTHORIZED',
      message: '请先登录质检账号。'
    });
  }

  if (!['qc', 'admin'].includes(operator.role)) {
    return res.status(403).json({
      status: 'error',
      code: 'FORBIDDEN',
      message: '你没有质检权限。'
    });
  }

  req.operator = operator;
  return next();
}

router.post('/check', requireQC, (req, res) => {
  const qrId = (req.body.qr_id || '').trim();
  if (!qrId) {
    return res.status(400).json({
      status: 'error',
      code: 'VALIDATION_ERROR',
      message: '请输入二维码ID。'
    });
  }

  const result = runQualityCheck({
    qrId,
    checkedBy: req.operator.name || req.operator.username
  });

  if (result.error === 'QR_NOT_FOUND') {
    return res.status(404).json({
      status: 'error',
      code: 'QR_NOT_FOUND',
      message: '未找到该二维码，请确认后重试。'
    });
  }

  return res.json({
    status: 'success',
    code: 'OK',
    data: result.data
  });
});

router.get('/logs', requireQC, (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const data = getQualityCheckLogs({ page, limit });
  return res.json({
    status: 'success',
    code: 'OK',
    data
  });
});

router.get('/stats', requireQC, (_req, res) => {
  const data = getQualityCheckStats();
  return res.json({
    status: 'success',
    code: 'OK',
    data
  });
});

module.exports = router;
