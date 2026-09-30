const express = require('express');
const { readSharedRecord } = require('../services/publicRecordAccessService');
const { publicQrPrimaryReadHttpError } = require('../services/postgres/publicQrPrimaryReadRuntime');

const router = express.Router();
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

function notFound(res) {
  return res.status(404).json({
    status: 'error', code: 'RECORD_NOT_FOUND', message: '未找到可访问的记录，请重新扫描星贴。'
  });
}

function sendReadError(res, error) {
  if (['QR_NOT_FOUND', 'QR_HIDDEN'].includes(error && error.code)) return notFound(res);
  const response = publicQrPrimaryReadHttpError(error);
  return res.status(response.status).json({
    status: 'error', code: response.code, message: response.message
  });
}

// The path parameter is a scan credential, not the printed QR ID (SEC-001/003).
router.get('/:key/download', async (req, res) => {
  try {
    const record = await readSharedRecord(req.params.key);
    if (!record) return notFound(res);
    if (!record.image_url) {
      return res.status(404).json({
        status: 'error', code: 'NFT_IMAGE_NOT_FOUND', message: '该记录暂无可下载图片。'
      });
    }
    return res.json({ status: 'success', code: 'OK', data: { download_url: record.image_url } });
  } catch (error) {
    return sendReadError(res, error);
  }
});

router.get('/:key/share-meta', async (req, res) => {
  try {
    const key = String(req.params.key || '').trim();
    const record = await readSharedRecord(key, {
      assetResolver: { resolveRecordImage: () => null, resolveCertificate: () => null }
    });
    if (!record) return notFound(res);
    const baseUrl = String(process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    return res.json({
      status: 'success', code: 'OK', data: {
        title: '星星在闪｜记在星上，闪到永远',
        text: record.content || '我在星星在闪记录了一个珍贵时刻。',
        url: `${baseUrl}/record.html?t=${encodeURIComponent(key)}`
      }
    });
  } catch (error) {
    return sendReadError(res, error);
  }
});

module.exports = router;
