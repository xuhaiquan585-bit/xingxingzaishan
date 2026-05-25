const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const {
  codeToSession,
  getPhoneNumberByCode,
  generateMiniappToken
} = require('../services/miniappAuthService');
const {
  createOrGetMiniappUser,
  bindMiniappUserPhone,
  findQRByKey,
  activateQRByKey,
  startCoCreationByKey,
  addCoCreationCommentByKey,
  deleteCoCreationCommentByKey,
  finalizeCoCreationByKey,
  listActivatedRecordsByMiniappOpenid,
  getActivatedRecordByMiniappOpenidAndId,
  listProducts,
  getProduct
} = require('../services/dbService');
const { saveImage, getStorageMode, getSignedUrl } = require('../services/storageService');
const { generateMockBlockchainHash } = require('../services/hashService');
const { checkText, checkImageBuffer } = require('../services/contentSafetyService');
const {
  optionalMiniappAuth,
  requireMiniappAuth,
  requireMiniappPhone
} = require('../middlewares/miniappAuth');

const router = express.Router();
const CO_CREATION_COMMENT_LIMIT = 12;

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

function isValidPhone(phone) {
  return /^1\d{10}$/.test(String(phone || ''));
}

function resolveImageUrl(record) {
  if (record.image_object_key) {
    try {
      return getSignedUrl(record.image_object_key);
    } catch (_error) {
      return record.image_url;
    }
  }
  return record.image_url;
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

function coCreationMeta(qr, user) {
  const activeComments = activeCoCreationComments(qr);
  const phone = user && user.phone ? user.phone : '';
  return {
    has_my_co_creation_comment: !!phone && activeComments.some((comment) => comment.phone === phone),
    co_creation_comment_count: activeComments.length,
    co_creation_comment_limit: CO_CREATION_COMMENT_LIMIT
  };
}

function formatQRPayload(qr, user) {
  const base = {
    id: qr.id,
    qr_id: qr.id,
    activation_status: qr.activation_status,
    issue_status: qr.issue_status,
    active_storage_mode: getStorageMode(),
    phone_bound: !!(user && user.phone)
  };

  if (qr.activation_status === 'activated') {
    return {
      ...base,
      content: qr.content || '',
      image_url: resolveImageUrl(qr),
      image_object_key: qr.image_object_key || null,
      blockchain_hash: qr.blockchain_hash || null,
      activated_at: qr.activated_at,
      co_creation_enabled: qr.co_creation_enabled === true,
      is_co_creation_owner: !!(user && user.phone && qr.co_creation_owner_phone === user.phone),
      co_creation_comments: visibleComments(qr),
      ...coCreationMeta(qr, user),
      show_brand_disclosure: qr.show_brand_disclosure === true,
      brand_disclosure_text_snapshot: qr.brand_disclosure_text_snapshot || ''
    };
  }

  if (qr.activation_status === 'co_creating') {
    if (!user || !user.phone) {
      return base;
    }

    return {
      ...base,
      content: qr.content || '',
      image_url: resolveImageUrl(qr),
      image_object_key: qr.image_object_key || null,
      co_creation_enabled: true,
      is_co_creation_owner: qr.co_creation_owner_phone === user.phone,
      co_creation_comments: visibleComments(qr),
      ...coCreationMeta(qr, user),
      show_brand_disclosure: qr.show_brand_disclosure === true,
      brand_disclosure_text_snapshot: qr.brand_disclosure_text_snapshot || ''
    };
  }

  return base;
}

function recordPayload(qr, user) {
  return {
    ...formatQRPayload(qr, user),
    content: qr.content || '',
    image_url: resolveImageUrl(qr),
    image_object_key: qr.image_object_key || null,
    blockchain_hash: qr.blockchain_hash || null,
    activated_at: qr.activated_at || null,
    co_creation_comments: visibleComments(qr),
    ...coCreationMeta(qr, user)
  };
}

function productPayload(product) {
  return {
    id: product.id,
    title: product.title,
    subtitle: product.subtitle,
    cover_image: product.cover_image,
    images: product.images,
    price_text: product.price_text,
    description: product.description,
    buy_type: product.buy_type,
    buy_url: product.buy_url
  };
}

function handleContentSafetyError(error, res) {
  if (['CONTENT_REJECTED', 'IMAGE_REJECTED', 'CONTENT_SAFETY_UNAVAILABLE'].includes(error.code)) {
    const status = error.code === 'CONTENT_SAFETY_UNAVAILABLE' ? 503 : 400;
    return res.status(status).json({
      status: 'error',
      code: error.code,
      message: error.message
    });
  }
  return null;
}

router.post('/auth/login', async (req, res) => {
  try {
    const session = await codeToSession(req.body.code);
    const user = createOrGetMiniappUser({
      openid: session.openid,
      unionid: session.unionid || null
    });
    const token = generateMiniappToken(user);
    return res.json({
      status: 'success',
      code: 'OK',
      data: {
        token,
        openid: user.openid,
        phone_bound: !!user.phone,
        phone: user.phone || null
      }
    });
  } catch (error) {
    return res.status(error.code === 'INVALID_LOGIN_CODE' ? 400 : 502).json({
      status: 'error',
      code: error.code || 'WECHAT_LOGIN_FAILED',
      message: error.message || '微信登录失败。'
    });
  }
});

router.post('/auth/bind-phone', requireMiniappAuth, async (req, res) => {
  try {
    const phone = await getPhoneNumberByCode(req.body.code);
    if (!isValidPhone(phone)) {
      return res.status(400).json({
        status: 'error',
        code: 'INVALID_PHONE',
        message: '手机号格式不正确，请检查后重试。'
      });
    }

    const result = bindMiniappUserPhone({
      openid: req.miniappUser.openid,
      phone,
      unionid: req.miniappUser.unionid || null
    });
    if (result.error) {
      return res.status(404).json({
        status: 'error',
        code: result.error,
        message: '未找到小程序登录用户。'
      });
    }

    const token = generateMiniappToken(result.data);
    return res.json({
      status: 'success',
      code: 'OK',
      data: {
        token,
        phone: result.data.phone,
        phone_bound: true
      }
    });
  } catch (error) {
    return res.status(error.code === 'INVALID_PHONE_CODE' ? 400 : 502).json({
      status: 'error',
      code: error.code || 'PHONE_BIND_FAILED',
      message: error.message || '手机号授权失败。'
    });
  }
});

router.get('/products', (_req, res) => {
  const products = listProducts({ publicOnly: true }).map(productPayload);
  return res.json({
    status: 'success',
    code: 'OK',
    data: {
      total: products.length,
      products
    }
  });
});

router.get('/products/:id', (req, res) => {
  const product = getProduct(req.params.id, { publicOnly: true });
  if (!product) {
    return res.status(404).json({
      status: 'error',
      code: 'PRODUCT_NOT_FOUND',
      message: '未找到该商品。'
    });
  }
  return res.json({
    status: 'success',
    code: 'OK',
    data: productPayload(product)
  });
});

router.post('/upload', requireMiniappAuth, upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        status: 'error',
        code: 'UPLOAD_FAILED',
        message: '上传失败，请重新选择图片。'
      });
    }

    try {
      await checkImageBuffer(req.file.buffer, {
        filename: req.file.originalname,
        mimetype: req.file.mimetype
      });
    } catch (error) {
      const handled = handleContentSafetyError(error, res);
      if (handled) return handled;
      throw error;
    }

    try {
      const compressedBuffer = await sharp(req.file.buffer)
        .rotate()
        .resize({ width: 1080, withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
      req.file.buffer = compressedBuffer;
      req.file.mimetype = 'image/jpeg';
    } catch (_compressErr) {
      // Keep original buffer if compression fails.
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
    return next(error);
  }
});

router.get('/qr/:key', optionalMiniappAuth, (req, res) => {
  const qr = findQRByKey(req.params.key);
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
    data: formatQRPayload(qr, req.miniappUser)
  });
});

router.post('/qr/:key/record', requireMiniappAuth, requireMiniappPhone, async (req, res) => {
  const content = String(req.body.content || '').trim();
  const mode = req.body.mode === 'co_create' ? 'co_create' : 'direct';
  const imageUrl = req.body.image_url || null;
  const imageObjectKey = req.body.image_object_key || null;

  if (!imageUrl && !imageObjectKey) {
    return res.status(400).json({
      status: 'error',
      code: 'VALIDATION_ERROR',
      message: '请先上传一张照片再点亮。'
    });
  }
  if (content.length > 200) {
    return res.status(400).json({
      status: 'error',
      code: 'VALIDATION_ERROR',
      message: '文字超出 200 字，请精简后再提交。'
    });
  }

  try {
    await checkText(content, { openid: req.miniappUser.openid });
  } catch (error) {
    const handled = handleContentSafetyError(error, res);
    if (handled) return handled;
    throw error;
  }

  const payload = {
    content,
    image_url: imageUrl,
    image_object_key: imageObjectKey,
    phone: req.miniappUser.phone,
    show_brand_disclosure: req.body.show_brand_disclosure === true
  };
  const result = mode === 'co_create'
    ? startCoCreationByKey(req.params.key, payload)
    : activateQRByKey(req.params.key, {
      ...payload,
      blockchain_hash: generateMockBlockchainHash()
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
      message: '该星已被记录，无法重复绑定。请确认二维码是否正确。'
    });
  }

  return res.json({
    status: 'success',
    code: 'OK',
    data: recordPayload(result.data, req.miniappUser)
  });
});

router.post('/qr/:key/comments', requireMiniappAuth, requireMiniappPhone, async (req, res) => {
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

  try {
    await checkText(`${authorName}\n${content}`, { openid: req.miniappUser.openid });
  } catch (error) {
    const handled = handleContentSafetyError(error, res);
    if (handled) return handled;
    throw error;
  }

  const result = addCoCreationCommentByKey(req.params.key, {
    phone: req.miniappUser.phone,
    authorName,
    content
  });
  if (result.error === 'QR_NOT_FOUND') {
    return res.status(404).json({ status: 'error', code: 'QR_NOT_FOUND', message: '未找到这颗星，请确认二维码是否正确。' });
  }
  if (result.error === 'CO_CREATION_CLOSED') {
    return res.status(409).json({ status: 'error', code: 'CO_CREATION_CLOSED', message: '这瓶酒已经封存，不能继续留言。' });
  }
  if (result.error === 'CO_CREATION_COMMENT_EXISTS') {
    return res.status(409).json({ status: 'error', code: 'CO_CREATION_COMMENT_EXISTS', message: '你已经留下过见证，每个人只能留言一次。' });
  }
  if (result.error === 'CO_CREATION_COMMENT_LIMIT_REACHED') {
    return res.status(409).json({ status: 'error', code: 'CO_CREATION_COMMENT_LIMIT_REACHED', message: '共创留言已满，等待发起人确认封存。' });
  }

  return res.json({ status: 'success', code: 'OK', data: result.data });
});

router.delete('/qr/:key/comments/:commentId', requireMiniappAuth, requireMiniappPhone, (req, res) => {
  const result = deleteCoCreationCommentByKey(req.params.key, {
    commentId: req.params.commentId,
    phone: req.miniappUser.phone
  });
  if (result.error === 'QR_NOT_FOUND' || result.error === 'COMMENT_NOT_FOUND') {
    return res.status(404).json({ status: 'error', code: result.error, message: '未找到要删除的留言。' });
  }
  if (result.error === 'FORBIDDEN') {
    return res.status(403).json({ status: 'error', code: 'FORBIDDEN', message: '只有发起人可以删除共创留言。' });
  }
  return res.json({
    status: 'success',
    code: 'OK',
    data: recordPayload(result.data, req.miniappUser)
  });
});

router.post('/qr/:key/finalize', requireMiniappAuth, requireMiniappPhone, (req, res) => {
  const result = finalizeCoCreationByKey(req.params.key, {
    phone: req.miniappUser.phone,
    blockchain_hash: generateMockBlockchainHash()
  });
  if (result.error === 'QR_NOT_FOUND') {
    return res.status(404).json({ status: 'error', code: 'QR_NOT_FOUND', message: '未找到这颗星，请确认二维码是否正确。' });
  }
  if (result.error === 'FORBIDDEN') {
    return res.status(403).json({ status: 'error', code: 'FORBIDDEN', message: '只有发起人可以确认封存。' });
  }
  if (result.error === 'CO_CREATION_CLOSED') {
    return res.status(409).json({ status: 'error', code: 'CO_CREATION_CLOSED', message: '这瓶酒不在共创中，不能确认封存。' });
  }
  return res.json({
    status: 'success',
    code: 'OK',
    data: recordPayload(result.data, req.miniappUser)
  });
});

router.get('/user/records', requireMiniappAuth, requireMiniappPhone, (req, res) => {
  const records = listActivatedRecordsByMiniappOpenid(req.miniappUser.openid).map((item) => ({
    id: item.id,
    content: item.content,
    activated_at: item.activated_at,
    display_at: item.display_at,
    activation_status: item.activation_status,
    image_url: resolveImageUrl(item)
  }));
  return res.json({
    status: 'success',
    code: 'OK',
    data: {
      total: records.length,
      records
    }
  });
});

router.get('/user/records/:id', requireMiniappAuth, requireMiniappPhone, (req, res) => {
  const record = getActivatedRecordByMiniappOpenidAndId({
    openid: req.miniappUser.openid,
    id: req.params.id
  });
  if (!record) {
    return res.status(404).json({
      status: 'error',
      code: 'RECORD_NOT_FOUND',
      message: '未找到该记录，或你无权查看。'
    });
  }
  return res.json({
    status: 'success',
    code: 'OK',
    data: {
      ...record,
      image_url: resolveImageUrl(record),
      co_creation_comments: visibleComments(record)
    }
  });
});

router.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      status: 'error',
      code: 'UPLOAD_SIZE_EXCEEDED',
      message: '图片过大，请选择 5MB 以内的图片'
    });
  }

  if (err.message === '仅支持图片文件上传') {
    return res.status(400).json({
      status: 'error',
      code: 'UPLOAD_FAILED',
      message: '仅支持图片文件上传'
    });
  }

  if (err.message === 'OSS_UPLOAD_FAILED') {
    return res.status(502).json({
      status: 'error',
      code: 'OSS_UPLOAD_FAILED',
      message: '云存储暂时不可用，请稍后重试。'
    });
  }

  return res.status(500).json({
    status: 'error',
    code: 'SERVER_ERROR',
    message: '服务器暂时繁忙，请稍后再试'
  });
});

module.exports = router;
