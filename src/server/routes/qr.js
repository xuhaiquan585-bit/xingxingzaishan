const express = require('express');
const { getQRCode, activateQRCodeOnce } = require('../services/dbService');
const { generateMockBlockchainHash } = require('../services/hashService');

const router = express.Router();

function isValidPhone(phone) {
  return /^1\d{10}$/.test(phone);
}

router.get('/:qrId', (req, res) => {
  const qr = getQRCode(req.params.qrId);

  if (!qr) {
    return res.status(404).json({
      status: 'error',
      code: 'QR_NOT_FOUND',
      message: '未找到这颗星，请确认二维码是否正确。'
    });
  }

  if (qr.hidden === true) {
    return res.status(403).json({
      status: 'error',
      code: 'QR_HIDDEN',
      message: '这颗星暂不可见。'
    });
  }

  return res.json({
    status: 'success',
    code: 'OK',
    data: qr
  });
});

router.post('/:qrId/record', (req, res) => {
  const { content = '', image_url: imageUrl, phone } = req.body;

  if (!isValidPhone(phone)) {
    return res.status(400).json({
      status: 'error',
      code: 'INVALID_PHONE',
      message: '手机号格式不正确，请检查后重试。'
    });
  }

  if (!imageUrl) {
    return res.status(400).json({
      status: 'error',
      code: 'VALIDATION_ERROR',
      message: '请先上传一张照片再点亮。'
    });
  }

  if (String(content).length > 200) {
    return res.status(400).json({
      status: 'error',
      code: 'VALIDATION_ERROR',
      message: '文字超出 200 字，请精简后再提交。'
    });
  }

  const blockchainHash = generateMockBlockchainHash();
  const result = activateQRCodeOnce(req.params.qrId, {
    content: String(content),
    image_url: imageUrl,
    phone,
    blockchain_hash: blockchainHash
  });

  if (result.error === 'QR_NOT_FOUND') {
    return res.status(404).json({
      status: 'error',
      code: 'QR_NOT_FOUND',
      message: '未找到这颗星，请确认二维码是否正确。'
    });
  }

  if (result.error === 'QR_ALREADY_ACTIVATED') {
    return res.status(409).json({
      status: 'error',
      code: 'QR_ALREADY_ACTIVATED',
      message: '该星已被点亮，无法重复绑定。请确认二维码是否正确。'
    });
  }

  return res.json({
    status: 'success',
    code: 'OK',
    data: {
      qr_id: result.data.id,
      content: result.data.content,
      image_url: result.data.image_url,
      blockchain_hash: result.data.blockchain_hash,
      activated_at: result.data.activated_at,
      activation_status: result.data.activation_status
    }
  });
});

module.exports = router;
