const express = require('express');
const { getQRCode, findQRByKey, activateQRByKey } = require('../services/dbService');
const { listBatches } = require('../services/dbService');
const { generateMockBlockchainHash } = require('../services/hashService');
const { getSignedUrl, getStorageMode } = require('../services/storageService');

const router = express.Router();

function isValidPhone(phone) {
  return /^1\d{10}$/.test(phone);
}

function resolveImageUrl(qr) {
  if (qr.image_object_key) {
    try {
      return getSignedUrl(qr.image_object_key);
    } catch (_error) {
      return qr.image_url;
    }
  }
  return qr.image_url;
}

router.get('/:qrId', (req, res) => {
  const qr = findQRByKey(req.params.qrId);

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

  // 附带批次品牌露出信息供前端判断
  const batchInfo = {};
  if (qr.batch_id) {
    const batches = listBatches();
    const batch = batches.find((b) => b.id === qr.batch_id);
    if (batch) {
      batchInfo.batch_brand_name = batch.brand_name || '';
      batchInfo.batch_brand_disclosure_text = batch.brand_disclosure_text || '';
      batchInfo.batch_brand_disclosure_default = batch.brand_disclosure_default === true;
    }
  }

  return res.json({
    status: 'success',
    code: 'OK',
    data: {
      ...qr,
      image_url: resolveImageUrl(qr),
      active_storage_mode: getStorageMode(),
      ...batchInfo
    }
  });
});

router.post('/:qrId/record', (req, res) => {
  const {
    content = '',
    image_url: imageUrl,
    image_object_key: imageObjectKey,
    phone,
    show_brand_disclosure: showBrandDisclosure
  } = req.body;

  if (!isValidPhone(phone)) {
    return res.status(400).json({
      status: 'error',
      code: 'INVALID_PHONE',
      message: '手机号格式不正确，请检查后重试。'
    });
  }

  if (!imageUrl && !imageObjectKey) {
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
  const result = activateQRByKey(req.params.qrId, {
    content: String(content),
    image_url: imageUrl,
    image_object_key: imageObjectKey,
    phone,
    blockchain_hash: blockchainHash,
    show_brand_disclosure: showBrandDisclosure === true
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

  // 查找批次品牌名称
  const batchInfo = {};
  if (result.data.batch_id) {
    const batches = listBatches();
    const batch = batches.find((b) => b.id === result.data.batch_id);
    if (batch) {
      batchInfo.brand_name = batch.brand_name || '';
    }
  }

  return res.json({
    status: 'success',
    code: 'OK',
    data: {
      qr_id: result.data.id,
      content: result.data.content,
      image_url: resolveImageUrl(result.data),
      image_object_key: result.data.image_object_key || null,
      blockchain_hash: result.data.blockchain_hash,
      activated_at: result.data.activated_at,
      activation_status: result.data.activation_status,
      show_brand_disclosure: result.data.show_brand_disclosure === true,
      brand_disclosure_text_snapshot: result.data.brand_disclosure_text_snapshot || '',
      ...batchInfo
    }
  });
});

module.exports = router;
