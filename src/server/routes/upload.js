const express = require('express');

const { getStorageMode } = require('../services/storageService');
const {
  RecordImageUploadEligibilityError
} = require('../services/recordImageUploadEligibilityService');
const { processRecordImageUpload } = require('../services/recordImageUploadService');
const {
  QrLifecyclePostgresWriteError,
  qrLifecycleWriteHttpError
} = require('../services/postgres/qrLifecycleWriteRuntime');
const {
  receiveSingleImage,
  respondToImageValidationError
} = require('../services/imageUploadSecurityService');
const { requireUserSession } = require('../middlewares/userSession');

const router = express.Router();

router.post('/', requireUserSession, receiveSingleImage('image'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        status: 'error',
        code: 'UPLOAD_FAILED',
        message: '上传失败，请重新选择图片。'
      });
    }

    const qrKey = String(req.body.qr_id || req.query.qr_id || '').trim();
    const accountId = String(req.user.account_id || '').trim();
    if (!qrKey || !accountId) {
      return res.status(400).json({
        status: 'error',
        code: 'UPLOAD_FAILED',
        message: '上传上下文无效，请重新扫码后再试。'
      });
    }
    const prepared = await processRecordImageUpload({
      file: req.file,
      accessToken: qrKey,
      accountId,
      maxOutputWidth: 1080,
      jpegQuality: 80
    });
    const { stored, uploadProof } = prepared;

    return res.json({
      status: 'success',
      code: 'OK',
      data: {
        url: stored.url,
        preview_url: stored.preview_url || null,
        storage_mode: stored.mode,
        object_key: stored.object_key,
        upload_proof: uploadProof,
        buffered: true,
        active_storage_mode: getStorageMode(),
        fallback: stored.fallback === true
      }
    });
  } catch (error) {
    if (error instanceof RecordImageUploadEligibilityError) {
      return res.status(400).json({
        status: 'error',
        code: 'UPLOAD_QR_NOT_ELIGIBLE',
        message: 'The QR code is not eligible for a record image upload.'
      });
    }
    if (error instanceof QrLifecyclePostgresWriteError) {
      const response = qrLifecycleWriteHttpError(error);
      return res.status(response.status).json({
        status: 'error',
        code: response.code,
        message: response.message
      });
    }
    if (respondToImageValidationError(
      error,
      res,
      '图片文件无法识别，请重新选择。'
    )) return undefined;
    if (error.message === 'OSS_UPLOAD_FAILED') {
      return res.status(502).json({
        status: 'error',
        code: 'OSS_UPLOAD_FAILED',
        message: '云存储暂时不可用，请稍后重试。'
      });
    }

    if (error.message.startsWith('OSS配置不完整')) {
      return res.status(500).json({
        status: 'error',
        code: 'OSS_CONFIG_ERROR',
        message: '上传服务暂时不可用，请联系客服'
      });
    }

    if (error.message.includes('ali-oss')) {
      return res.status(500).json({
        status: 'error',
        code: 'OSS_DEP_MISSING',
        message: '上传服务暂时不可用，请联系客服'
      });
    }

    return next(error);
  }
});

module.exports = router;
