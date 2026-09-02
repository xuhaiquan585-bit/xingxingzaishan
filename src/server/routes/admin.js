const express = require('express');
const crypto = require('node:crypto');
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
  setOperatorEnabled,
  changeOperatorPassword,
  createProduct,
  updateProduct,
  listProducts,
  getProduct,
  listOrders,
  getAdminOrder,
  updateOrderShipment,
  getMiniappContent,
  updateMiniappContent
} = require('../services/dbService');
const { generateToken, verifyToken } = require('../services/authService');
const {
  getStorageMode,
  getSignedUrl,
  saveBinaryObjectAtKey,
  saveImage
} = require('../services/storageService');
const {
  normalizeUploadedImage,
  receiveSingleImage,
  respondToImageValidationError
} = require('../services/imageUploadSecurityService');
const { hasMiniappConfig } = require('../services/miniappAuthService');
const {
  getChainSystemStatus,
  queryRecordChainProof,
  retryRecordChainProof
} = require('../services/chainProofService');
const {
  getArchiveSystemStatus,
  rebuildRecordArchive
} = require('../services/archiveService');
const {
  administerQrs,
  issueQrCodes,
  qrIssuanceAuthorityHttpError
} = require('../services/postgres/qrIssuanceAuthorityRuntime');
const {
  getRecordProofRuntimeStatus
} = require('../services/postgres/recordProofRuntime');
const {
  executePrintProduction
} = require('../services/postgres/printProductionRuntime');

const router = express.Router();

async function selectQrAdministration(operation, input, fallback) {
  const authority = await administerQrs(operation, input);
  return authority.selected ? authority.result : fallback();
}

function sendQrAuthorityError(res, error) {
  const response = qrIssuanceAuthorityHttpError(error);
  return res.status(response.status).json({
    status: 'error',
    code: response.code,
    message: response.message
  });
}

async function blockLegacyQrMutationWhenPostgresSelected(qrId, res) {
  const authority = await administerQrs('getRecord', { qrId });
  if (!authority.selected) return false;
  res.status(503).json({
    status: 'error',
    code: 'OPERATION_DISABLED_DURING_POSTGRES_AUTHORITY',
    message: '该操作在当前 PostgreSQL 迁移范围内暂未开放。'
  });
  return true;
}

function batchCsv(detail) {
  const header = [
    'id', 'batch_id', 'issue_status', 'activation_status', 'hidden',
    'phone', 'activated_at', 'created_at', 'qr_image_url'
  ];
  const rows = detail.records.map((item) => [
    item.id,
    item.batch_id || '',
    item.issue_status,
    item.activation_status,
    item.hidden ? 'true' : 'false',
    item.phone || '',
    item.activated_at || '',
    item.created_at || '',
    item.qr_image_url
      ? `${process.env.BASE_URL || 'http://localhost:3000'}${item.qr_image_url}`
      : ''
  ]);
  return [header, ...rows]
    .map((row) => row.map(
      (value) => `"${String(value).replace(/"/g, '""')}"`
    ).join(','))
    .join('\n');
}

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

router.get('/dashboard', requireAdmin, async (req, res) => {
  const { date_from: dateFrom, date_to: dateTo } = req.query;
  const legacyStats = () => getDashboardStats({ dateFrom, dateTo });
  let stats;
  try {
    stats = await selectQrAdministration(
      'getDashboardStats',
      { dateFrom, dateTo },
      legacyStats
    );
    if (stats.published_products === null) {
      stats = {
        ...stats,
        published_products: legacyStats().published_products
      };
    }
  } catch (error) {
    return sendQrAuthorityError(res, error);
  }
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

router.post('/operators/:id/change-password', requireAdmin, (req, res) => {
  const { password } = req.body;
  if (!password || !String(password).trim()) {
    return res.status(400).json({
      status: 'error',
      code: 'VALIDATION_ERROR',
      message: '新密码不能为空。'
    });
  }

  const result = changeOperatorPassword(req.params.id, String(password).trim());
  if (!result) {
    return res.status(404).json({
      status: 'error',
      code: 'OPERATOR_NOT_FOUND',
      message: '未找到该账号。'
    });
  }

  return res.json({
    status: 'success',
    code: 'OK',
    data: result
  });
});

router.post('/batches', requireAdmin, async (req, res) => {
  const { name, brand_name: brandName, note, brand_disclosure_text: brandDisclosureText, brand_disclosure_default: brandDisclosureDefault } = req.body;
  if (!name || !String(name).trim()) {
    return res.status(400).json({
      status: 'error',
      code: 'VALIDATION_ERROR',
      message: '批次名称不能为空。'
    });
  }

  const input = {
    name: String(name).trim(),
    brandName: String(brandName || '').trim(),
    note: String(note || '').trim(),
    brandDisclosureText: String(brandDisclosureText || '').trim(),
    brandDisclosureDefault: brandDisclosureDefault === true,
    createdBy: req.operator.username
  };
  let batch;
  try {
    batch = await selectQrAdministration(
      'createBatch',
      input,
      () => createBatch(input)
    );
  } catch (error) {
    return sendQrAuthorityError(res, error);
  }

  return res.json({
    status: 'success',
    code: 'OK',
    data: batch
  });
});

router.get('/batches', requireAdmin, async (_req, res) => {
  let batches;
  try {
    batches = await selectQrAdministration('listBatches', {}, listBatches);
  } catch (error) {
    return sendQrAuthorityError(res, error);
  }
  return res.json({
    status: 'success',
    code: 'OK',
    data: {
      total: batches.length,
      batches
    }
  });
});

router.get('/batches/:batchId', requireAdmin, async (req, res) => {
  let detail;
  try {
    detail = await selectQrAdministration(
      'getBatchDetail',
      { batchId: req.params.batchId },
      () => getBatchDetail(req.params.batchId)
    );
  } catch (error) {
    return sendQrAuthorityError(res, error);
  }
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

router.post('/batches/:batchId/assign', requireAdmin, async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  if (ids.length === 0) {
    return res.status(400).json({
      status: 'error',
      code: 'VALIDATION_ERROR',
      message: '请先勾选二维码再绑定批次。'
    });
  }

  let data;
  try {
    data = await selectQrAdministration(
      'assignBatch',
      { batchId: req.params.batchId, ids },
      () => {
        const result = assignBatchToQRCodes({
          batchId: req.params.batchId,
          ids
        });
        if (result.error) {
          const error = new Error(result.error);
          error.code = result.error;
          throw error;
        }
        return result.data;
      }
    );
  } catch (error) {
    return sendQrAuthorityError(res, error);
  }

  return res.json({
    status: 'success',
    code: 'OK',
    data
  });
});

router.get('/batches/:batchId/export', requireAdmin, async (req, res) => {
  let result;
  try {
    const authority = await administerQrs('getBatchDetail', {
      batchId: req.params.batchId
    });
    if (authority.selected) {
      if (!authority.result) {
        const error = new Error('BATCH_NOT_FOUND');
        error.code = 'BATCH_NOT_FOUND';
        throw error;
      }
      result = {
        data: batchCsv(authority.result),
        filename: `batch-${req.params.batchId}-${Date.now()}.csv`
      };
    } else {
      result = exportBatchCSV(req.params.batchId);
      if (result.error) {
        const error = new Error(result.error);
        error.code = result.error;
        throw error;
      }
    }
  } catch (error) {
    return sendQrAuthorityError(res, error);
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
  return res.send(`\uFEFF${result.data}`);
});

function envConfigured(names) {
  return names.every((name) => !!process.env[name]);
}

function printActor(req) {
  return {
    operatorId: req.operator && req.operator.id,
    username: req.operator && req.operator.username
  };
}

function sendPrintProductionError(res, error) {
  const code = String(error && error.code || 'PRINT_PRODUCTION_UNAVAILABLE');
  if (code === 'LABEL_TEMPLATE_INVALID') {
    return res.status(400).json({
      status: 'error',
      code,
      message: '模板存在越界、重叠或印刷约束错误。',
      data: { issues: Array.isArray(error.issues) ? error.issues : [] }
    });
  }
  if (['TEMPLATE_NAME_INVALID', 'TEMPLATE_ASSET_TYPE_INVALID', 'QR_ID_INVALID',
    'TEXT_OVERFLOW', 'QR_PHYSICAL_SIZE_TOO_SMALL', 'PRINT_QR_IDS_INVALID',
    'IDEMPOTENCY_KEY_INVALID', 'PRINT_TEMPLATE_VERSION_INVALID',
    'PRINT_BATCH_NAME_INVALID', 'PRINT_VENDOR_NAME_INVALID',
    'PRINT_BATCH_NOTE_INVALID', 'PRINT_VOID_REASON_INVALID',
    'PRINT_HISTORY_FILTER_INVALID', 'PRINT_HISTORY_TARGET_INVALID'].includes(code)) {
    return res.status(400).json({
      status: 'error', code, message: '模板参数不符合生产要求。'
    });
  }
  if (['TEMPLATE_NOT_FOUND', 'TEMPLATE_VERSION_NOT_FOUND',
    'TEMPLATE_ASSET_NOT_FOUND', 'PRINT_BATCH_NOT_FOUND',
    'PRINT_QR_NOT_FOUND'].includes(code)) {
    return res.status(404).json({
      status: 'error', code, message: '未找到对应的模板、版本或图片。'
    });
  }
  if (['TEMPLATE_ARCHIVED', 'TEMPLATE_DRAFT_NOT_FOUND',
    'TEMPLATE_DRAFT_ALREADY_EXISTS', 'TEMPLATE_NOT_PUBLISHED',
    'TEMPLATE_ALREADY_ARCHIVED', 'PRINT_TEMPLATE_NOT_AVAILABLE'].includes(code)) {
    return res.status(409).json({
      status: 'error', code, message: '当前模板状态不允许执行该操作。'
    });
  }
  if (code === 'PRINT_QR_NOT_UNACTIVATED') {
    return res.status(409).json({
      status: 'error', code, message: '所选二维码中包含已记录或共创中的二维码，不能用于新印刷任务。'
    });
  }
  if (code === 'PRINT_QR_ALREADY_RESERVED') {
    return res.status(409).json({
      status: 'error', code,
      message: '所选二维码中包含历史未分类、已预留、已打印或已报废的二维码。'
    });
  }
  if (code === 'PRINT_QR_RESERVATION_CONFLICT') {
    return res.status(409).json({
      status: 'error', code, message: '二维码印刷状态刚刚发生变化，请刷新后重新选择。'
    });
  }
  if (['IDEMPOTENCY_KEY_CONFLICT',
    'PRINT_BATCH_CANNOT_CANCEL', 'PRINT_ARTIFACT_GENERATION_IN_PROGRESS',
    'PRINT_ARTIFACT_GENERATION_NOT_ALLOWED', 'PRINT_ARTIFACT_NOT_READY',
    'PRINT_BATCH_TRANSITION_INVALID', 'PRINT_VOID_QR_SCOPE_INVALID',
    'PRINT_VOID_QR_CONFLICT', 'PRINT_HISTORY_QR_CONFLICT',
    'PRINT_HISTORY_QR_NOT_AVAILABLE'].includes(code)) {
    return res.status(409).json({
      status: 'error', code, message: '当前印刷任务状态不允许执行该操作。'
    });
  }
  return res.status(503).json({
    status: 'error',
    code: 'PRINT_PRODUCTION_UNAVAILABLE',
    message: '印刷生产服务暂时不可用，请稍后重试。'
  });
}

function printSuccess(res, data) {
  return res.json({ status: 'success', code: 'OK', data });
}

router.get('/label-templates', requireAdmin, async (_req, res) => {
  try {
    return printSuccess(res, {
      templates: await executePrintProduction('listTemplates')
    });
  } catch (error) {
    return sendPrintProductionError(res, error);
  }
});

router.post('/label-templates', requireAdmin, async (req, res) => {
  try {
    return printSuccess(res, await executePrintProduction('createTemplate', {
      name: req.body && req.body.name,
      actor: printActor(req)
    }));
  } catch (error) {
    return sendPrintProductionError(res, error);
  }
});

router.get('/label-templates/:templateId', requireAdmin, async (req, res) => {
  try {
    const data = await executePrintProduction('getTemplate', {
      templateId: req.params.templateId
    });
    if (!data) {
      return res.status(404).json({
        status: 'error', code: 'TEMPLATE_NOT_FOUND', message: '未找到对应模板。'
      });
    }
    return printSuccess(res, data);
  } catch (error) {
    return sendPrintProductionError(res, error);
  }
});

router.put('/label-templates/:templateId/draft', requireAdmin, async (req, res) => {
  try {
    return printSuccess(res, await executePrintProduction('saveDraft', {
      templateId: req.params.templateId,
      schema: req.body && req.body.schema,
      actor: printActor(req)
    }));
  } catch (error) {
    return sendPrintProductionError(res, error);
  }
});

router.post('/label-templates/:templateId/versions', requireAdmin, async (req, res) => {
  try {
    return printSuccess(res, await executePrintProduction('createVersion', {
      templateId: req.params.templateId,
      actor: printActor(req)
    }));
  } catch (error) {
    return sendPrintProductionError(res, error);
  }
});

router.post('/label-templates/:templateId/copy', requireAdmin, async (req, res) => {
  try {
    return printSuccess(res, await executePrintProduction('copyTemplate', {
      templateId: req.params.templateId,
      name: req.body && req.body.name,
      actor: printActor(req)
    }));
  } catch (error) {
    return sendPrintProductionError(res, error);
  }
});

router.post('/label-templates/:templateId/preview', requireAdmin, async (req, res) => {
  try {
    const buffer = await executePrintProduction('preview', {
      templateId: req.params.templateId,
      versionId: req.body && req.body.version_id,
      schema: req.body && req.body.schema,
      qrId: req.body && req.body.qr_id
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(buffer);
  } catch (error) {
    return sendPrintProductionError(res, error);
  }
});

router.post('/label-templates/:templateId/publish', requireAdmin, async (req, res) => {
  try {
    return printSuccess(res, await executePrintProduction('publish', {
      templateId: req.params.templateId,
      actor: printActor(req)
    }));
  } catch (error) {
    return sendPrintProductionError(res, error);
  }
});

router.post('/label-templates/:templateId/archive', requireAdmin, async (req, res) => {
  try {
    return printSuccess(res, await executePrintProduction('archive', {
      templateId: req.params.templateId,
      actor: printActor(req)
    }));
  } catch (error) {
    return sendPrintProductionError(res, error);
  }
});

router.post(
  '/label-templates/:templateId/assets',
  requireAdmin,
  receiveSingleImage('image'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          status: 'error', code: 'UPLOAD_FAILED', message: '请先选择图片。'
        });
      }
      const assetType = String(req.body.asset_type || '').trim();
      if (!['logo', 'background'].includes(assetType)) {
        return res.status(400).json({
          status: 'error', code: 'TEMPLATE_ASSET_TYPE_INVALID', message: '请选择图片用途。'
        });
      }
      const file = await normalizeUploadedImage(req.file, {
        maxOutputWidth: 4096,
        jpegQuality: 90
      });
      const assetId = crypto.randomUUID();
      const objectKey = `printing/template-assets/${req.params.templateId}/${assetId}.jpg`;
      await saveBinaryObjectAtKey({
        objectKey,
        buffer: file.buffer,
        contentType: 'image/jpeg',
        allowCloudFallback: false
      });
      return printSuccess(res, await executePrintProduction('registerAsset', {
        templateId: req.params.templateId,
        assetId,
        assetType,
        objectKey,
        mimeType: 'image/jpeg',
        pixelWidth: file.pixel_width,
        pixelHeight: file.pixel_height,
        sizeBytes: file.buffer.length,
        actor: printActor(req)
      }));
    } catch (error) {
      if (respondToImageValidationError(error, res)) return undefined;
      return sendPrintProductionError(res, error);
    }
  }
);

router.get('/label-templates/:templateId/assets/:assetId/preview', requireAdmin, async (req, res) => {
  try {
    const asset = await executePrintProduction('readAsset', {
      templateId: req.params.templateId,
      assetId: req.params.assetId
    });
    res.setHeader('Content-Type', asset.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.send(asset.buffer);
  } catch (error) {
    return sendPrintProductionError(res, error);
  }
});

router.get('/print-batches', requireAdmin, async (req, res) => {
  try {
    return printSuccess(res, {
      batches: await executePrintProduction('listPrintBatches', {
        status: req.query.status,
        search: req.query.search
      })
    });
  } catch (error) {
    return sendPrintProductionError(res, error);
  }
});

router.get('/print-production/legacy-qr-codes', requireAdmin, async (req, res) => {
  try {
    return printSuccess(res, {
      qr_codes: await executePrintProduction('listLegacyPrintQrCodes', {
        sourceBatchId: req.query.source_batch_id,
        idPrefix: req.query.id_prefix
      })
    });
  } catch (error) {
    return sendPrintProductionError(res, error);
  }
});

router.post('/print-production/legacy-qr-codes/classify', requireAdmin, async (req, res) => {
  try {
    return printSuccess(res, await executePrintProduction('classifyLegacyPrintQrCodes', {
      qrIds: req.body && req.body.qr_ids,
      targetStatus: req.body && req.body.target_status,
      reason: req.body && req.body.reason,
      actor: printActor(req)
    }));
  } catch (error) {
    return sendPrintProductionError(res, error);
  }
});

router.post('/print-batches', requireAdmin, async (req, res) => {
  try {
    return printSuccess(res, await executePrintProduction('createPrintBatch', {
      name: req.body && req.body.name,
      vendorName: req.body && req.body.vendor_name,
      note: req.body && req.body.note,
      templateVersionId: req.body && req.body.template_version_id,
      idempotencyKey: req.body && req.body.idempotency_key,
      qrIds: req.body && req.body.qr_ids,
      actor: printActor(req)
    }));
  } catch (error) {
    return sendPrintProductionError(res, error);
  }
});

router.get('/print-batches/:batchId', requireAdmin, async (req, res) => {
  try {
    const data = await executePrintProduction('getPrintBatch', {
      batchId: req.params.batchId
    });
    if (!data) {
      return res.status(404).json({
        status: 'error', code: 'PRINT_BATCH_NOT_FOUND', message: '未找到印刷任务。'
      });
    }
    return printSuccess(res, data);
  } catch (error) {
    return sendPrintProductionError(res, error);
  }
});

router.post('/print-batches/:batchId/cancel', requireAdmin, async (req, res) => {
  try {
    return printSuccess(res, await executePrintProduction('cancelPrintBatch', {
      batchId: req.params.batchId,
      actor: printActor(req)
    }));
  } catch (error) {
    return sendPrintProductionError(res, error);
  }
});

router.post('/print-batches/:batchId/generate', requireAdmin, async (req, res) => {
  try {
    return printSuccess(res, await executePrintProduction('generatePrintArtifact', {
      batchId: req.params.batchId,
      actor: printActor(req)
    }));
  } catch (error) {
    return sendPrintProductionError(res, error);
  }
});

router.get('/print-batches/:batchId/artifact', requireAdmin, async (req, res, next) => {
  try {
    const artifact = await executePrintProduction('downloadPrintArtifact', {
      batchId: req.params.batchId,
      actor: printActor(req)
    });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${artifact.filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Artifact-SHA256', artifact.sha256);
    if (artifact.expectedSize > 0) res.setHeader('Content-Length', artifact.expectedSize);
    artifact.stream.on('error', next);
    return artifact.stream.pipe(res);
  } catch (error) {
    return sendPrintProductionError(res, error);
  }
});

router.post('/print-batches/:batchId/start-printing', requireAdmin, async (req, res) => {
  try {
    return printSuccess(res, await executePrintProduction('startPrinting', {
      batchId: req.params.batchId,
      actor: printActor(req)
    }));
  } catch (error) {
    return sendPrintProductionError(res, error);
  }
});

router.post('/print-batches/:batchId/complete', requireAdmin, async (req, res) => {
  try {
    return printSuccess(res, await executePrintProduction('completePrintBatch', {
      batchId: req.params.batchId,
      voidQrIds: req.body && req.body.void_qr_ids,
      voidReason: req.body && req.body.void_reason,
      actor: printActor(req)
    }));
  } catch (error) {
    return sendPrintProductionError(res, error);
  }
});

router.post('/print-batches/:batchId/void', requireAdmin, async (req, res) => {
  try {
    return printSuccess(res, await executePrintProduction('voidPrintBatch', {
      batchId: req.params.batchId,
      reason: req.body && req.body.reason,
      actor: printActor(req)
    }));
  } catch (error) {
    return sendPrintProductionError(res, error);
  }
});

router.post('/print-batches/:batchId/qr-codes/void', requireAdmin, async (req, res) => {
  try {
    return printSuccess(res, await executePrintProduction('voidPrintedQrCodes', {
      batchId: req.params.batchId,
      qrIds: req.body && req.body.qr_ids,
      reason: req.body && req.body.reason,
      actor: printActor(req)
    }));
  } catch (error) {
    return sendPrintProductionError(res, error);
  }
});

router.get('/system-status', requireAdmin, async (_req, res) => {
  const storageMode = getStorageMode();
  const ossNames = ['OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET', 'OSS_BUCKET', 'OSS_REGION', 'OSS_ENDPOINT'];
  const ossConfigured = envConfigured(ossNames);
  const miniappConfigured = hasMiniappConfig();
  const contentSafetyMode = miniappConfigured ? 'wechat' : 'mock';
  let recordProof;
  try {
    recordProof = await getRecordProofRuntimeStatus();
  } catch (_error) {
    recordProof = Object.freeze({
      enabled: true,
      healthy: false,
      reason: 'RECORD_PROOF_STATUS_UNAVAILABLE',
      scope: null,
      started: false,
      running: false,
      last_run_at: null,
      last_run_summary: null,
      last_error_code: 'RECORD_PROOF_STATUS_UNAVAILABLE',
      outbox: null
    });
  }
  return res.json({
    status: 'success',
    code: 'OK',
    data: {
      storage: {
        mode: storageMode,
        configured: storageMode !== 'cloud' || ossConfigured,
        oss_configured: ossConfigured
      },
      miniapp: {
        appid_configured: !!process.env.WECHAT_MINIAPP_APPID,
        secret_configured: !!process.env.WECHAT_MINIAPP_SECRET,
        configured: miniappConfigured
      },
      content_safety: {
        mode: contentSafetyMode,
        configured: miniappConfigured || process.env.NODE_ENV !== 'production'
      },
      chain: getChainSystemStatus(),
      record_proof: recordProof,
      archive: getArchiveSystemStatus(),
      domain: {
        base_url: process.env.BASE_URL || '',
        expected_domain: 'https://xingxingzaishan.top',
        cors_configured: !!process.env.CORS_ORIGINS
      },
      agreements: {
        privacy_url_configured: !!process.env.PRIVACY_POLICY_URL,
        service_url_configured: !!process.env.SERVICE_AGREEMENT_URL
      },
      future_modules: {
        trade_management: 'reserved'
      }
    }
  });
});

router.get('/miniapp-content', requireAdmin, (_req, res) => {
  return res.json({
    status: 'success',
    code: 'OK',
    data: getMiniappContent()
  });
});

router.post('/miniapp-content', requireAdmin, (req, res) => {
  const result = updateMiniappContent(req.body, req.operator.username);
  if (result.error === 'VALIDATION_ERROR') {
    return res.status(400).json({
      status: 'error',
      code: 'VALIDATION_ERROR',
      message: result.message || '小程序内容配置不完整。'
    });
  }
  return res.json({
    status: 'success',
    code: 'OK',
    data: result.data
  });
});

router.post('/upload-image', requireAdmin, receiveSingleImage('image'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        status: 'error',
        code: 'UPLOAD_FAILED',
        message: '请先选择图片。'
      });
    }

    if (getStorageMode() === 'cloud' && !process.env.CLOUD_PUBLIC_BASE_URL) {
      return res.status(400).json({
        status: 'error',
        code: 'STORAGE_PUBLIC_URL_REQUIRED',
        message: '云存储内容图片需要先配置 CLOUD_PUBLIC_BASE_URL。'
      });
    }

    req.file = await normalizeUploadedImage(req.file, {
      maxOutputWidth: 1440,
      jpegQuality: 82
    });

    const stored = await saveImage({
      file: req.file,
      qrId: `admin-${String(req.body.scope || 'miniapp').trim() || 'miniapp'}`
    });
    const publicUrl = stored.url || (stored.object_key && process.env.CLOUD_PUBLIC_BASE_URL
      ? `${process.env.CLOUD_PUBLIC_BASE_URL.replace(/\/$/, '')}/${stored.object_key}`
      : '');
    return res.json({
      status: 'success',
      code: 'OK',
      data: {
        url: publicUrl,
        preview_url: stored.preview_url || null,
        object_key: stored.object_key,
        storage_mode: stored.mode,
        active_storage_mode: getStorageMode(),
        fallback: stored.fallback === true
      }
    });
  } catch (error) {
    if (respondToImageValidationError(error, res)) return undefined;
    return next(error);
  }
});

router.get('/products', requireAdmin, (_req, res) => {
  const products = listProducts({ publicOnly: false });
  return res.json({
    status: 'success',
    code: 'OK',
    data: {
      total: products.length,
      products
    }
  });
});

router.post('/products', requireAdmin, (req, res) => {
  const result = createProduct(req.body);
  if (result.error === 'VALIDATION_ERROR') {
    return res.status(400).json({
      status: 'error',
      code: 'VALIDATION_ERROR',
      message: result.message || '商品信息不完整。'
    });
  }
  return res.json({
    status: 'success',
    code: 'OK',
    data: result.data
  });
});

router.get('/products/:productId', requireAdmin, (req, res) => {
  const product = getProduct(req.params.productId, { publicOnly: false });
  if (!product) {
    return res.status(404).json({
      status: 'error',
      code: 'PRODUCT_NOT_FOUND',
      message: '未找到该商品。'
    });
  }
  return res.json({
    status: 'success',
    code: 'OK',
    data: product
  });
});

router.post('/products/:productId', requireAdmin, (req, res) => {
  const result = updateProduct(req.params.productId, req.body);
  if (result.error === 'PRODUCT_NOT_FOUND') {
    return res.status(404).json({
      status: 'error',
      code: 'PRODUCT_NOT_FOUND',
      message: '未找到该商品。'
    });
  }
  if (result.error === 'VALIDATION_ERROR') {
    return res.status(400).json({
      status: 'error',
      code: 'VALIDATION_ERROR',
      message: result.message || '商品信息不完整。'
    });
  }
  if (result.error === 'PRODUCT_UPDATE_CONFLICT') {
    return res.status(409).json({
      status: 'error',
      code: 'PRODUCT_UPDATE_CONFLICT',
      message: '商品已被其他操作更新，请刷新后重试。'
    });
  }
  return res.json({
    status: 'success',
    code: 'OK',
    data: result.data
  });
});

router.get('/orders', requireAdmin, (req, res) => {
  const result = listOrders({
    status: req.query.status,
    q: req.query.q,
    page: req.query.page,
    pageSize: req.query.page_size
  });
  return res.json({
    status: 'success',
    code: 'OK',
    data: result
  });
});

router.get('/orders/:orderId', requireAdmin, (req, res) => {
  const order = getAdminOrder(req.params.orderId);
  if (!order) {
    return res.status(404).json({
      status: 'error',
      code: 'ORDER_NOT_FOUND',
      message: '未找到该订单。'
    });
  }
  return res.json({
    status: 'success',
    code: 'OK',
    data: order
  });
});

router.post('/orders/:orderId/ship', requireAdmin, (req, res) => {
  const result = updateOrderShipment(req.params.orderId, req.body);
  if (result.error === 'ORDER_NOT_FOUND') {
    return res.status(404).json({
      status: 'error',
      code: 'ORDER_NOT_FOUND',
      message: '未找到该订单。'
    });
  }
  if (result.error === 'VALIDATION_ERROR') {
    return res.status(400).json({
      status: 'error',
      code: 'VALIDATION_ERROR',
      message: result.message || '发货信息不完整。'
    });
  }
  if (result.error === 'ORDER_NOT_SHIPPABLE') {
    return res.status(409).json({
      status: 'error',
      code: 'ORDER_NOT_SHIPPABLE',
      message: '当前订单状态不允许发货。'
    });
  }
  return res.json({
    status: 'success',
    code: 'OK',
    data: result.data
  });
});

router.post('/qr/generate', requireAdmin, async (req, res, next) => {
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

  let result;
  try {
    const authority = await issueQrCodes({
      prefix: normalizedPrefix,
      count: normalizedCount,
      batchId: batchId ? String(batchId).trim() : null,
      baseUrl: process.env.BASE_URL || 'http://localhost:3000'
    });
    result = authority.selected
      ? authority.result
      : await generateQRCodes({
        prefix: normalizedPrefix,
        count: normalizedCount,
        batchId: batchId ? String(batchId).trim() : null
      });
  } catch (error) {
    if (error && String(error.code || '').startsWith('QR_ISSUANCE')) {
      const response = qrIssuanceAuthorityHttpError(error);
      return res.status(response.status).json({
        status: 'error', code: response.code, message: response.message
      });
    }
    if (error && ['BATCH_NOT_FOUND', 'QR_SEQUENCE_EXCEEDED'].includes(error.code)) {
      const response = qrIssuanceAuthorityHttpError(error);
      return res.status(response.status).json({
        status: 'error', code: response.code, message: response.message
      });
    }
    return next(error);
  }

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
      ids: result.data.ids,
      records: result.data.records
    }
  });
});

router.get('/records', requireAdmin, async (req, res) => {
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

  const input = {
    issueStatus,
    activationStatus,
    hidden,
    idPrefix,
    batchId,
    dateFrom,
    dateTo,
    page,
    limit
  };
  let data;
  try {
    data = await selectQrAdministration(
      'listRecords',
      input,
      () => listQRRecords(input)
    );
  } catch (error) {
    return sendQrAuthorityError(res, error);
  }
  const records = data.records.map((record) => ({
    ...record,
    chain_certificate_object_url: record.chain_certificate_object_key
      ? getSignedUrl(record.chain_certificate_object_key)
      : record.chain_certificate_object_url || null
  }));

  return res.json({
    status: 'success',
    code: 'OK',
    data: {
      ...data,
      records
    }
  });
});

router.post('/records/:qrId/chain/query', requireAdmin, async (req, res) => {
  try {
    if (await blockLegacyQrMutationWhenPostgresSelected(req.params.qrId, res)) {
      return undefined;
    }
  } catch (error) {
    return sendQrAuthorityError(res, error);
  }
  const result = await queryRecordChainProof(req.params.qrId);
  if (result.error === 'CHAIN_OPERATION_NOT_FOUND') {
    return res.status(404).json({
      status: 'error',
      code: 'CHAIN_OPERATION_NOT_FOUND',
      message: '该记录还没有可查询的存证操作。'
    });
  }
  return res.json({
    status: 'success',
    code: 'OK',
    data: result.data
  });
});

router.post('/records/:qrId/chain/retry', requireAdmin, async (req, res) => {
  try {
    if (await blockLegacyQrMutationWhenPostgresSelected(req.params.qrId, res)) {
      return undefined;
    }
  } catch (error) {
    return sendQrAuthorityError(res, error);
  }
  const result = await retryRecordChainProof(req.params.qrId);
  if (result.error === 'QR_NOT_FOUND') {
    return res.status(404).json({
      status: 'error',
      code: 'QR_NOT_FOUND',
      message: '未找到该记录。'
    });
  }
  if (result.error === 'RECORD_NOT_SEALED') {
    return res.status(409).json({
      status: 'error',
      code: 'RECORD_NOT_SEALED',
      message: '该记录尚未封存，不能提交存证。'
    });
  }
  return res.json({
    status: 'success',
    code: 'OK',
    data: result.data
  });
});

router.post('/records/:qrId/archive/rebuild', requireAdmin, async (req, res) => {
  try {
    if (await blockLegacyQrMutationWhenPostgresSelected(req.params.qrId, res)) {
      return undefined;
    }
  } catch (error) {
    return sendQrAuthorityError(res, error);
  }
  const result = await rebuildRecordArchive(req.params.qrId);
  if (result.error === 'QR_NOT_FOUND') {
    return res.status(404).json({
      status: 'error',
      code: 'QR_NOT_FOUND',
      message: '未找到该记录。'
    });
  }
  if (result.error === 'RECORD_NOT_ARCHIVABLE') {
    return res.status(409).json({
      status: 'error',
      code: 'RECORD_NOT_ARCHIVABLE',
      message: '该记录尚未产生用户内容，不能重建档案索引。'
    });
  }
  return res.json({
    status: 'success',
    code: 'OK',
    data: result.data
  });
});

router.post('/records/batch-hide', requireAdmin, async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  let updated;
  try {
    updated = await selectQrAdministration(
      'setHidden',
      { ids, hidden: true },
      () => setQRHiddenStatusBatch(ids, true)
    );
  } catch (error) {
    return sendQrAuthorityError(res, error);
  }
  return res.json({
    status: 'success',
    code: 'OK',
    data: { updated_count: updated.length, records: updated }
  });
});

router.post('/records/batch-show', requireAdmin, async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  let updated;
  try {
    updated = await selectQrAdministration(
      'setHidden',
      { ids, hidden: false },
      () => setQRHiddenStatusBatch(ids, false)
    );
  } catch (error) {
    return sendQrAuthorityError(res, error);
  }
  return res.json({
    status: 'success',
    code: 'OK',
    data: { updated_count: updated.length, records: updated }
  });
});

router.post('/records/export', requireAdmin, async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  if (ids.length === 0) {
    return res.status(400).json({
      status: 'error',
      code: 'VALIDATION_ERROR',
      message: '请先勾选至少一条记录再导出。'
    });
  }

  let data;
  try {
    data = await selectQrAdministration(
      'listRecords',
      { ids, page: 1, limit: 100000 },
      () => ({
        records: listQRRecords({ page: 1, limit: 100000 }).records
          .filter((item) => ids.includes(item.id))
      })
    );
  } catch (error) {
    return sendQrAuthorityError(res, error);
  }
  const header = ['id', 'issue_status', 'activation_status', 'hidden', 'batch_id', 'phone', 'activated_at', 'created_at'];
  const rows = data.records.map((item) => [
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

router.post('/records/qr-images/export', requireAdmin, async (req, res) => {
  return res.status(410).json({
    status: 'error',
    code: 'LEGACY_QR_IMAGE_EXPORT_RETIRED',
    message: '正式二维码标签只能通过印刷任务生成；数据 CSV 导出不受影响。'
  });
});

router.post('/records/:qrId/hide', requireAdmin, async (req, res) => {
  let updated;
  try {
    const records = await selectQrAdministration(
      'setHidden',
      { ids: [req.params.qrId], hidden: true },
      () => {
        const record = setQRHiddenStatus(req.params.qrId, true);
        return record ? [record] : [];
      }
    );
    [updated] = records;
  } catch (error) {
    return sendQrAuthorityError(res, error);
  }
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

router.post('/records/:qrId/show', requireAdmin, async (req, res) => {
  let updated;
  try {
    const records = await selectQrAdministration(
      'setHidden',
      { ids: [req.params.qrId], hidden: false },
      () => {
        const record = setQRHiddenStatus(req.params.qrId, false);
        return record ? [record] : [];
      }
    );
    [updated] = records;
  } catch (error) {
    return sendQrAuthorityError(res, error);
  }
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
