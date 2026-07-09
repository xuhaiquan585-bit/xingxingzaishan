const express = require('express');
const path = require('path');
const fs = require('fs');
const {
  getQRCode,
  findQRByKey,
  findQRByToken,
  activateQRByKey,
  startCoCreationByKey,
  addCoCreationCommentByKey,
  deleteCoCreationCommentByKey,
  finalizeCoCreationByKey,
  getSampleUnactivated
} = require('../services/dbService');
const { listBatches } = require('../services/dbService');
const { getSignedUrl, getStorageMode } = require('../services/storageService');
const { chainPublicPayload } = require('../services/chainViewService');
const {
  prepareRecordManifest,
  submitPreparedRecord
} = require('../services/chainProofService');
const { requireUserSession } = require('../middlewares/userSession');

const router = express.Router();
const CO_CREATION_COMMENT_LIMIT = 12;

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

function visibleComments(qr) {
  return (Array.isArray(qr.co_creation_comments) ? qr.co_creation_comments : [])
    .filter((comment) => comment.status !== 'deleted')
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map((comment) => ({
      id: comment.id,
      author_name: comment.author_name || '',
      content: comment.content || '',
      created_at: comment.created_at || ''
    }));
}

function activeCoCreationComments(qr) {
  return (Array.isArray(qr.co_creation_comments) ? qr.co_creation_comments : [])
    .filter((comment) => comment.status !== 'deleted');
}

function coCreationMeta(qr, req) {
  const activeComments = activeCoCreationComments(qr);
  const phone = req.user && req.user.phone ? req.user.phone : '';
  return {
    has_my_co_creation_comment: !!phone && activeComments.some((comment) => comment.phone === phone),
    co_creation_comment_count: activeComments.length,
    co_creation_comment_limit: CO_CREATION_COMMENT_LIMIT
  };
}

function getBatchInfo(qr) {
  const batchInfo = {};
  if (!qr.batch_id) {
    return batchInfo;
  }

  const batches = listBatches();
  const batch = batches.find((b) => b.id === qr.batch_id);
  if (batch) {
    batchInfo.batch_brand_name = batch.brand_name || '';
    batchInfo.batch_brand_disclosure_text = batch.brand_disclosure_text || '';
    batchInfo.batch_brand_disclosure_default = batch.brand_disclosure_default === true;
  }
  return batchInfo;
}

function getBrandName(qr) {
  if (!qr.batch_id) return '';
  const batch = listBatches().find((item) => item.id === qr.batch_id);
  return batch ? batch.brand_name || '' : '';
}

function formatRecordPayload(qr, req) {
  return {
    qr_id: qr.id,
    id: qr.id,
    content: qr.content || '',
    image_url: resolveImageUrl(qr),
    image_object_key: qr.image_object_key || null,
    blockchain_hash: qr.blockchain_hash || null,
    ...chainPublicPayload(qr),
    activated_at: qr.activated_at,
    activation_status: qr.activation_status,
    co_creation_enabled: qr.co_creation_enabled === true,
    is_co_creation_owner: !!(req.user && qr.co_creation_owner_phone === req.user.phone),
    co_creation_comments: visibleComments(qr),
    ...coCreationMeta(qr, req),
    show_brand_disclosure: qr.show_brand_disclosure === true,
    brand_disclosure_text_snapshot: qr.brand_disclosure_text_snapshot || '',
    brand_name: getBrandName(qr)
  };
}

function formatQRStatusPayload(qr, req) {
  const batchInfo = getBatchInfo(qr);
  const base = {
    id: qr.id,
    qr_id: qr.id,
    activation_status: qr.activation_status,
    issue_status: qr.issue_status,
    active_storage_mode: getStorageMode(),
    batch_id: qr.batch_id || null,
    ...batchInfo
  };

  if (qr.activation_status === 'activated') {
    return {
      ...base,
      content: qr.content || '',
      image_url: resolveImageUrl(qr),
      image_object_key: qr.image_object_key || null,
      blockchain_hash: qr.blockchain_hash || null,
      ...chainPublicPayload(qr),
      activated_at: qr.activated_at,
      co_creation_enabled: qr.co_creation_enabled === true,
      is_co_creation_owner: !!(req.user && qr.co_creation_owner_phone === req.user.phone),
      co_creation_comments: visibleComments(qr),
      ...coCreationMeta(qr, req),
      show_brand_disclosure: qr.show_brand_disclosure === true,
      brand_disclosure_text_snapshot: qr.brand_disclosure_text_snapshot || ''
    };
  }

  if (qr.activation_status === 'co_creating') {
    const isLoggedIn = !!(req.user && req.user.phone);
    if (!isLoggedIn) {
      return base;
    }

    return {
      ...base,
      content: qr.content || '',
      image_url: resolveImageUrl(qr),
      image_object_key: qr.image_object_key || null,
      co_creation_enabled: true,
      is_co_creation_owner: qr.co_creation_owner_phone === req.user.phone,
      co_creation_comments: visibleComments(qr),
      ...coCreationMeta(qr, req),
      show_brand_disclosure: qr.show_brand_disclosure === true,
      brand_disclosure_text_snapshot: qr.brand_disclosure_text_snapshot || ''
    };
  }

  return {
    ...base,
    show_brand_disclosure: qr.show_brand_disclosure === true
  };
}

// 首页获取一个未激活的测试二维码（返回 token，不暴露序号到 URL）
router.get('/sample-unactivated', (_req, res) => {
  const qr = getSampleUnactivated();

  if (!qr) {
    return res.status(404).json({
      status: 'error',
      code: 'NO_AVAILABLE_QR',
      message: '暂未可用的星星。'
    });
  }

  return res.json({
    status: 'success',
    code: 'OK',
    data: {
      id: qr.id,
      token: qr.qr_access_token
    }
  });
});

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

  return res.json({
    status: 'success',
    code: 'OK',
    data: formatQRStatusPayload(qr, req)
  });
});

router.post('/:qrId/record', requireUserSession, async (req, res) => {
  const {
    content = '',
    image_url: imageUrl,
    image_object_key: imageObjectKey,
    show_brand_disclosure: showBrandDisclosure,
    mode = 'direct'
  } = req.body;
  const phone = req.user.phone;

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

  const payload = {
    content: String(content),
    image_url: imageUrl || null,
    image_object_key: imageObjectKey || null,
    phone,
    show_brand_disclosure: showBrandDisclosure === true
  };

  const result = mode === 'co_create'
    ? startCoCreationByKey(req.params.qrId, payload)
    : activateQRByKey(req.params.qrId, payload);

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

  let responseData = result.data;
  if (mode !== 'co_create' && result.data) {
    responseData = await prepareRecordManifest(result.data);
    submitPreparedRecord(responseData).catch(() => {});
  }

  return res.json({
    status: 'success',
    code: 'OK',
    data: formatRecordPayload(responseData, req)
  });
});

router.post('/:qrId/comments', requireUserSession, (req, res) => {
  const authorName = String(req.body.author_name || '').trim();
  const content = String(req.body.content || '').trim();

  if (!authorName || authorName.length > 20) {
    return res.status(400).json({
      status: 'error',
      code: 'VALIDATION_ERROR',
      message: '请填写 20 字以内的姓名或身份。'
    });
  }

  if (!content || content.length > 50) {
    return res.status(400).json({
      status: 'error',
      code: 'VALIDATION_ERROR',
      message: '请填写 50 字以内的留言。'
    });
  }

  const result = addCoCreationCommentByKey(req.params.qrId, {
    phone: req.user.phone,
    authorName,
    content
  });

  if (result.error === 'QR_NOT_FOUND') {
    return res.status(404).json({
      status: 'error',
      code: 'QR_NOT_FOUND',
      message: '未找到这颗星，请确认二维码是否正确。'
    });
  }
  if (result.error === 'CO_CREATION_CLOSED') {
    return res.status(409).json({
      status: 'error',
      code: 'CO_CREATION_CLOSED',
      message: '这瓶酒已经封存，不能继续留言。'
    });
  }
  if (result.error === 'CO_CREATION_COMMENT_EXISTS') {
    return res.status(409).json({
      status: 'error',
      code: 'CO_CREATION_COMMENT_EXISTS',
      message: '你已经留下过见证，每个人只能留言一次。'
    });
  }
  if (result.error === 'CO_CREATION_COMMENT_LIMIT_REACHED') {
    return res.status(409).json({
      status: 'error',
      code: 'CO_CREATION_COMMENT_LIMIT_REACHED',
      message: '共创留言已满，等待发起人确认封存。'
    });
  }

  return res.json({
    status: 'success',
    code: 'OK',
    data: result.data
  });
});

router.delete('/:qrId/comments/:commentId', requireUserSession, (req, res) => {
  const result = deleteCoCreationCommentByKey(req.params.qrId, {
    commentId: req.params.commentId,
    phone: req.user.phone
  });

  if (result.error === 'QR_NOT_FOUND' || result.error === 'COMMENT_NOT_FOUND') {
    return res.status(404).json({
      status: 'error',
      code: result.error,
      message: '未找到要删除的留言。'
    });
  }
  if (result.error === 'FORBIDDEN') {
    return res.status(403).json({
      status: 'error',
      code: 'FORBIDDEN',
      message: '只有发起人可以删除共创留言。'
    });
  }

  return res.json({
    status: 'success',
    code: 'OK',
    data: formatRecordPayload(result.data, req)
  });
});

router.post('/:qrId/finalize', requireUserSession, async (req, res) => {
  const result = finalizeCoCreationByKey(req.params.qrId, {
    phone: req.user.phone
  });

  if (result.error === 'QR_NOT_FOUND') {
    return res.status(404).json({
      status: 'error',
      code: 'QR_NOT_FOUND',
      message: '未找到这颗星，请确认二维码是否正确。'
    });
  }
  if (result.error === 'FORBIDDEN') {
    return res.status(403).json({
      status: 'error',
      code: 'FORBIDDEN',
      message: '只有发起人可以确认封存。'
    });
  }
  if (result.error === 'CO_CREATION_CLOSED') {
    return res.status(409).json({
      status: 'error',
      code: 'CO_CREATION_CLOSED',
      message: '这瓶酒不在共创中，不能确认封存。'
    });
  }

  let responseData = result.data;
  if (result.data) {
    responseData = await prepareRecordManifest(result.data);
    submitPreparedRecord(responseData).catch(() => {});
  }

  return res.json({
    status: 'success',
    code: 'OK',
    data: formatRecordPayload(responseData, req)
  });
});

// 通过 token 安全访问二维码图片（防枚举攻击）
router.get('/image/:token', (req, res) => {
  const qr = findQRByToken(req.params.token);

  if (!qr) {
    return res.status(404).json({
      status: 'error',
      code: 'QR_NOT_FOUND',
      message: '未找到该二维码。'
    });
  }

  const pngPath = path.join(__dirname, '..', '..', '..', 'public', 'qrcodes', `${qr.id}.png`);
  if (!fs.existsSync(pngPath)) {
    return res.status(404).json({
      status: 'error',
      code: 'IMAGE_NOT_FOUND',
      message: '二维码图片不存在。'
    });
  }

  res.setHeader('Content-Type', 'image/png');
  return res.sendFile(pngPath);
});

module.exports = router;
