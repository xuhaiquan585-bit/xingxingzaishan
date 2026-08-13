const express = require('express');

const { saveImage, getStorageMode } = require('../services/storageService');
const {
  normalizeUploadedImage,
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

    req.file = await normalizeUploadedImage(req.file, {
      maxOutputWidth: 1080,
      jpegQuality: 80
    });

    const qrId = req.body.qr_id || req.query.qr_id || 'unbound';
    const stored = await saveImage({ file: req.file, qrId });

    return res.json({
      status: 'success',
      code: 'OK',
      data: {
        url: stored.url,
        preview_url: stored.preview_url || null,
        storage_mode: stored.mode,
        object_key: stored.object_key,
        buffered: true,
        active_storage_mode: getStorageMode(),
        fallback: stored.fallback === true
      }
    });
  } catch (error) {
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
