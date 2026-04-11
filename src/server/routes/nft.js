const express = require('express');
const path = require('path');
const fs = require('fs');
const { getQRCode } = require('../services/dbService');
const { getStorageMode, getSignedUrl, getLocalObjectPath } = require('../services/storageService');

const router = express.Router();

router.get('/:qrId/download', (req, res) => {
  const qr = getQRCode(req.params.qrId);
  if (!qr || qr.activation_status !== 'activated') {
    return res.status(404).json({
      status: 'error',
      code: 'RECORD_NOT_FOUND',
      message: '未找到可下载的NFT记录。'
    });
  }

  const mode = getStorageMode();
  if (mode === 'cloud' && qr.image_object_key) {
    try {
      const downloadUrl = getSignedUrl(qr.image_object_key, Number(process.env.OSS_DOWNLOAD_SIGN_EXPIRES || 3600));
      return res.json({
        status: 'success',
        code: 'OK',
        data: {
          download_url: downloadUrl,
          image_object_key: qr.image_object_key
        }
      });
    } catch (_error) {
      return res.status(502).json({
        status: 'error',
        code: 'OSS_DOWNLOAD_SIGN_FAILED',
        message: '图片签名失败，请稍后重试。'
      });
    }
  }

  if (!qr.image_url) {
    return res.status(404).json({
      status: 'error',
      code: 'NFT_IMAGE_NOT_FOUND',
      message: '该记录暂无可下载图片。'
    });
  }

  const localPath = getLocalObjectPath(qr.image_object_key || qr.image_url);
  const filename = path.basename(localPath);
  if (!fs.existsSync(localPath)) {
    return res.status(404).json({
      status: 'error',
      code: 'NFT_IMAGE_NOT_FOUND',
      message: '图片文件不存在，请稍后重试。'
    });
  }

  return res.json({
    status: 'success',
    code: 'OK',
    data: {
      download_url: `/uploads/${filename}`,
      image_object_key: qr.image_object_key || null
    }
  });
});

router.get('/:qrId/share-meta', (req, res) => {
  const qr = getQRCode(req.params.qrId);
  if (!qr || qr.activation_status !== 'activated') {
    return res.status(404).json({
      status: 'error',
      code: 'RECORD_NOT_FOUND',
      message: '未找到可分享的NFT记录。'
    });
  }

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  return res.json({
    status: 'success',
    code: 'OK',
    data: {
      title: '星星在闪｜记在星上，闪到永远',
      text: qr.content || '我在星星在闪记录了一个珍贵时刻。',
      url: `${baseUrl}/record.html?qr=${encodeURIComponent(qr.id)}`
    }
  });
});

module.exports = router;
