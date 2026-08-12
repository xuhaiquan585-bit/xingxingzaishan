const express = require('express');
const { verifyToken } = require('../services/authService');
const { runQualityCheck, getQualityCheckLogs, getQualityCheckStats } = require('../services/dbService');
const {
  administerQrs,
  qrIssuanceAuthorityHttpError
} = require('../services/postgres/qrIssuanceAuthorityRuntime');

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

async function selectQualityOperation(operation, input, fallback) {
  const authority = await administerQrs(operation, input);
  return authority.selected ? authority.result : fallback();
}

function sendAuthorityError(res, error) {
  const response = qrIssuanceAuthorityHttpError(error);
  return res.status(response.status).json({
    status: 'error', code: response.code, message: response.message
  });
}

router.post('/check', requireQC, async (req, res) => {
  const qrId = (req.body.qr_id || '').trim();
  if (!qrId) {
    return res.status(400).json({
      status: 'error',
      code: 'VALIDATION_ERROR',
      message: '请输入二维码ID。'
    });
  }

  const checkedBy = req.operator.name || req.operator.username;
  let data;
  try {
    data = await selectQualityOperation(
      'runQualityCheck',
      { qrId, checkedBy },
      () => {
        const result = runQualityCheck({ qrId, checkedBy });
        if (result.error) {
          const error = new Error(result.error);
          error.code = result.error;
          throw error;
        }
        return result.data;
      }
    );
  } catch (error) {
    return sendAuthorityError(res, error);
  }

  return res.json({
    status: 'success',
    code: 'OK',
    data
  });
});

router.get('/logs', requireQC, async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  let data;
  try {
    data = await selectQualityOperation(
      'listQualityCheckLogs',
      { page, limit },
      () => getQualityCheckLogs({ page, limit })
    );
  } catch (error) {
    return sendAuthorityError(res, error);
  }
  return res.json({
    status: 'success',
    code: 'OK',
    data
  });
});

router.get('/stats', requireQC, async (_req, res) => {
  let data;
  try {
    data = await selectQualityOperation(
      'getQualityCheckStats',
      {},
      getQualityCheckStats
    );
  } catch (error) {
    return sendAuthorityError(res, error);
  }
  return res.json({
    status: 'success',
    code: 'OK',
    data
  });
});

module.exports = router;
