const express = require('express');
const path = require('path');
const fs = require('fs');
const { getQRCode } = require('../services/dbService');

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

  if (!qr.image_url) {
    return res.status(404).json({
      status: 'error',
      code: 'NFT_IMAGE_NOT_FOUND',
      message: '该记录暂无可下载图片。'
    });
  }

  const filename = path.basename(qr.image_url);
  const localPath = path.join(__dirname, '..', 'public', 'uploads', filename);
  if (!fs.existsSync(localPath)) {
    return res.status(404).json({
      status: 'error',
      code: 'NFT_IMAGE_NOT_FOUND',
      message: '图片文件不存在，请稍后重试。'
    });
  }

  return res.download(localPath, `nft-${qr.id}-${filename}`);
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
