const express = require('express');
const multer = require('multer');
const sharp = require('sharp');

const { saveImage, getStorageMode } = require('../services/storageService');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('仅支持图片文件上传'));
    }
    cb(null, true);
  }
});

router.post('/', upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        status: 'error',
        code: 'UPLOAD_FAILED',
        message: '上传失败，请重新选择图片。'
      });
    }

    // 图片压缩：最大宽1080，统一JPEG，质量80，自动EXIF旋转
    // 压缩失败时回退原始buffer，不阻断上传
    try {
      const compressedBuffer = await sharp(req.file.buffer)
        .rotate()
        .resize({ width: 1080, withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();

      req.file.buffer = compressedBuffer;
      req.file.mimetype = 'image/jpeg';
    } catch (_compressErr) {
      // 压缩失败，保持原始文件不变
    }

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
        message: error.message
      });
    }

    if (error.message.includes('ali-oss')) {
      return res.status(500).json({
        status: 'error',
        code: 'OSS_DEP_MISSING',
        message: '云存储依赖未安装，请联系管理员。'
      });
    }

    return next(error);
  }
});

module.exports = router;
