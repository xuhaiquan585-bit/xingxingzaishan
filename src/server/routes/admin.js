const express = require('express');
const {
  findAdmin,
  getDashboardStats,
  listQRRecords,
  generateQRCodes,
  setQRHiddenStatus,
  setQRHiddenStatusBatch,
  createBatch,
  listBatches,
  assignBatchToQRCodes,
  getBatchDetail,
  exportBatchCSV,
  listOperators,
  createOperator,
  setOperatorEnabled
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


router.get('/operators', requireAdmin, (req, res) => {
  const { role } = req.query;
  const operators = listOperators(role);
  return res.json({
    status: 'success',
    code: 'OK',
    data: {
      total: operators.length,
      operators
    }
  });
});

router.post('/operators', requireAdmin, (req, res) => {
  const { username, password, role = 'qc', name = '' } = req.body;
  if (!username || !password) {
    return res.status(400).json({
      status: 'error',
      code: 'VALIDATION_ERROR',
      message: '账号和密码不能为空。'
    });
  }

  const result = createOperator({
    username: String(username).trim(),
    password: String(password).trim(),
    role: String(role).trim(),
    name: String(name || username).trim()
  });

  if (result.error === 'USERNAME_EXISTS') {
    return res.status(409).json({
      status: 'error',
      code: 'USERNAME_EXISTS',
      message: '该账号已存在，请更换账号名。'
    });
  }

  return res.json({
    status: 'success',
    code: 'OK',
    data: result.data
  });
});

router.post('/operators/:id/disable', requireAdmin, (req, res) => {
  const updated = setOperatorEnabled(req.params.id, false);
  if (!updated) {
    return res.status(404).json({
      status: 'error',
      code: 'OPERATOR_NOT_FOUND',
      message: '未找到该账号。'
    });
  }

  return res.json({
    status: 'success',
    code: 'OK',
    data: updated
  });
});

router.post('/operators/:id/enable', requireAdmin, (req, res) => {
  const updated = setOperatorEnabled(req.params.id, true);
  if (!updated) {
    return res.status(404).json({
      status: 'error',
      code: 'OPERATOR_NOT_FOUND',
      message: '未找到该账号。'
    });
  }

  return res.json({
    status: 'success',
    code: 'OK',
    data: updated
  });
});

router.post('/batches', requireAdmin, (req, res) => {
  const { name, brand_name: brandName, note } = req.body;
  if (!name || !String(name).trim()) {
    return res.status(400).json({
      status: 'error',
      code: 'VALIDATION_ERROR',
      message: '批次名称不能为空。'
    });
  }

  const batch = createBatch({
    name: String(name).trim(),
    brandName: String(brandName || '').trim(),
    note: String(note || '').trim(),
    createdBy: req.operator.username
  });

  return res.json({
    status: 'success',
    code: 'OK',
    data: batch
  });
});

router.get('/batches', requireAdmin, (_req, res) => {
  const batches = listBatches();
  return res.json({
    status: 'success',
    code: 'OK',
    data: {
      total: batches.length,
      batches
    }
  });
});

router.get('/batches/:batchId', requireAdmin, (req, res) => {
  const detail = getBatchDetail(req.params.batchId);
  if (!detail) {
    return res.status(404).json({
      status: 'error',
      code: 'BATCH_NOT_FOUND',
      message: '未找到该批次。'
    });
  }

  return res.json({
    status: 'success',
    code: 'OK',
    data: detail
  });
});

router.post('/batches/:batchId/assign', requireAdmin, (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  if (ids.length === 0) {
    return res.status(400).json({
      status: 'error',
      code: 'VALIDATION_ERROR',
      message: '请先勾选二维码再绑定批次。'
    });
  }

  const result = assignBatchToQRCodes({ batchId: req.params.batchId, ids });
  if (result.error === 'BATCH_NOT_FOUND') {
    return res.status(404).json({
      status: 'error',
      code: 'BATCH_NOT_FOUND',
      message: '未找到该批次。'
    });
  }

  return res.json({
    status: 'success',
    code: 'OK',
    data: result.data
  });
});

router.get('/batches/:batchId/export', requireAdmin, (req, res) => {
  const result = exportBatchCSV(req.params.batchId);
  if (result.error === 'BATCH_NOT_FOUND') {
    return res.status(404).json({
      status: 'error',
      code: 'BATCH_NOT_FOUND',
      message: '未找到该批次。'
    });
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
  return res.send(`\uFEFF${result.data}`);
});

router.post('/qr/generate', requireAdmin, (req, res) => {
  const { prefix, count = 1, batch_id: batchId } = req.body;
  const normalizedPrefix = String(prefix || '').trim().toUpperCase();

  if (!normalizedPrefix || !/^[A-Z0-9]+$/.test(normalizedPrefix)) {
    return res.status(400).json({
      status: 'error',
      code: 'VALIDATION_ERROR',
      message: 'prefix 仅支持字母和数字。'
    });
  }

  const normalizedCount = Number(count);
  if (!Number.isInteger(normalizedCount) || normalizedCount <= 0) {
    return res.status(400).json({
      status: 'error',
      code: 'VALIDATION_ERROR',
      message: 'count 必须是大于 0 的整数。'
    });
  }

  const result = generateQRCodes({
    prefix: normalizedPrefix,
    count: normalizedCount,
    batchId: batchId ? String(batchId).trim() : null
  });

  if (result.error === 'QR_SEQUENCE_EXCEEDED') {
    return res.status(400).json({
      status: 'error',
      code: 'QR_SEQUENCE_EXCEEDED',
      message: '该 prefix 可用序号已用尽（最多 99999）。'
    });
  }

  return res.json({
    status: 'success',
    code: 'OK',
    data: {
      count: result.data.count,
      ids: result.data.ids
    }
  });
});

router.get('/records', requireAdmin, (req, res) => {
  const {
    issue_status: issueStatus,
    activation_status: activationStatus,
    hidden,
    id_prefix: idPrefix,
    batch_id: batchId,
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
    batchId,
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
  const header = ['id', 'issue_status', 'activation_status', 'hidden', 'batch_id', 'phone', 'activated_at', 'created_at'];
  const rows = data.map((item) => [
    item.id,
    item.issue_status,
    item.activation_status,
    item.hidden ? 'true' : 'false',
    item.batch_id || '',
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
