const express = require('express');
const {
  findAdmin,
  getDashboardStats,
  listQRRecords,
  setQRHiddenStatus,
  setQRHiddenStatusBatch
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
    id_prefix: idPrefix,
    date_from: dateFrom,
    date_to: dateTo,
    page = 1,
    limit = 20
  } = req.query;

  const data = listQRRecords({
    issueStatus,
    activationStatus,
    hidden,
    idPrefix,
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

router.post('/records/batch-hide', requireAdmin, (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  const updated = setQRHiddenStatusBatch(ids, true);
  return res.json({
    status: 'success',
    code: 'OK',
    data: { updated_count: updated.length, records: updated }
  });
});

router.post('/records/batch-show', requireAdmin, (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  const updated = setQRHiddenStatusBatch(ids, false);
  return res.json({
    status: 'success',
    code: 'OK',
    data: { updated_count: updated.length, records: updated }
  });
});

router.post('/records/export', requireAdmin, (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  if (ids.length === 0) {
    return res.status(400).json({
      status: 'error',
      code: 'VALIDATION_ERROR',
      message: '请先勾选至少一条记录再导出。'
    });
  }

  const data = listQRRecords({ page: 1, limit: 100000 }).records.filter((item) => ids.includes(item.id));
  const header = ['id', 'issue_status', 'activation_status', 'hidden', 'phone', 'activated_at', 'created_at'];
  const rows = data.map((item) => [
    item.id,
    item.issue_status,
    item.activation_status,
    item.hidden ? 'true' : 'false',
    item.phone || '',
    item.activated_at || '',
    item.created_at || ''
  ]);
  const csv = [header.join(','), ...rows.map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="records-export-${Date.now()}.csv"`);
  return res.send(`\uFEFF${csv}`);
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
