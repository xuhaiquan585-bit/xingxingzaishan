const express = require('express');
const multer = require('multer');

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

router.post('/', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      status: 'error',
      code: 'UPLOAD_FAILED',
      message: '上传失败，请重新选择图片。'
    });
  }

  const stored = saveImage(req.file);

  return res.json({
    status: 'success',
    code: 'OK',
    data: {
      url: stored.url,
      storage_mode: stored.mode,
      object_key: stored.object_key,
      buffered: true,
      active_storage_mode: getStorageMode()
    }
  });
});

module.exports = router;
