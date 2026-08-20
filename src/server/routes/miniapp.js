const express = require('express');
const {
  codeToSession,
  getPhoneNumberByCode,
  generateMiniappToken
} = require('../services/miniappAuthService');
const {
  createOrGetMiniappUser,
  bindMiniappUserPhone,
  findPublicQrReadContextByKey,
  activateQRByKey,
  startCoCreationByKey,
  addCoCreationCommentByKey,
  deleteCoCreationCommentByKey,
  finalizeCoCreationByKey,
  findPersonalRecordListContextByAccountId,
  findPersonalRecordDetailContext,
  listBatches,
  listProducts,
  getProduct,
  getMiniappContent,
  createMiniappOrder,
  listMiniappOrdersByAccountId,
  getMiniappOrderByAccountId,
  cancelMiniappOrderByAccountId,
  payMiniappOrderMockByAccountId
} = require('../services/dbService');
const {
  saveImage,
  getStorageMode,
  isCurrentRecordImageObjectKey,
  isRecordImageObjectKeyForQrId
} = require('../services/storageService');
const {
  UploadProofError,
  verifyRecordImageUploadProof
} = require('../services/uploadProofService');
const {
  RecordImageUploadEligibilityError
} = require('../services/recordImageUploadEligibilityService');
const { processRecordImageUpload } = require('../services/recordImageUploadService');
const { checkText, checkImageBuffer } = require('../services/contentSafetyService');
const {
  receiveSingleImage,
  respondToImageValidationError
} = require('../services/imageUploadSecurityService');
const { chainPublicPayload } = require('../services/chainViewService');
const { createPublicQrAssetResolver } = require('../services/publicQrAssetResolver');
const {
  registerPublicQrShadowObservation
} = require('../services/postgres/publicQrShadowRuntime');
const {
  publicQrPrimaryReadHttpError,
  readPublicQrPrimary
} = require('../services/postgres/publicQrPrimaryReadRuntime');
const {
  QrLifecyclePostgresWriteError,
  qrLifecycleWriteHttpError,
  writeQrLifecycle
} = require('../services/postgres/qrLifecycleWriteRuntime');
const {
  registerPersonalRecordShadowObservation
} = require('../services/postgres/personalRecordShadowRuntime');
const {
  personalRecordPrimaryReadHttpError,
  readPersonalRecordPrimary
} = require('../services/postgres/personalRecordPrimaryReadRuntime');
const {
  IdentityAuthorityError,
  identityAuthorityHttpError,
  invokeIdentityAuthority
} = require('../services/postgres/identityAuthorityRuntime');
const {
  prepareRecordManifest,
  submitPreparedRecord
} = require('../services/chainProofService');
const { sendCode, verifyCode } = require('../services/smsCodeService');
const {
  optionalMiniappAuth,
  requireMiniappAuth,
  requireMiniappPhone
} = require('../middlewares/miniappAuth');
const {
  createMiniappPayment,
  isWechatPayConfigured
} = require('../services/wechatPayService');

const router = express.Router();
const CO_CREATION_COMMENT_LIMIT = 12;

function isValidPhone(phone) {
  return /^1\d{10}$/.test(String(phone || ''));
}

function normalizePhone(phone) {
  return String(phone || '').trim();
}

function getMiniappAccountId(user) {
  return user && user.account_id ? String(user.account_id) : '';
}

function respondContentPrivacyRejected(res) {
  return res.status(400).json({
    status: 'error',
    code: 'CONTENT_PRIVACY_REJECTED',
    message: '\u8bf7\u52ff\u5728\u516c\u5f00\u8bb0\u5f55\u6216\u7559\u8a00\u4e2d\u586b\u5199\u4ed6\u4eba\u7684\u5b8c\u6574\u624b\u673a\u53f7\u3002'
  });
}

async function selectPostgresLifecycleWrite({ key, operation, payload, req }) {
  const { qr, publicQrDomainHash } = findPublicQrReadContextByKey(key);
  return writeQrLifecycle({
    key,
    operation,
    payload,
    publicQrId: qr && qr.id,
    domainHash: publicQrDomainHash,
    channel: 'miniapp',
    viewer: {
      accountId: getMiniappAccountId(req.miniappUser),
      phoneBound: Boolean(req.miniappUser && req.miniappUser.phone)
    },
    assetResolver: createPublicQrAssetResolver()
  });
}

function respondLifecycleWriteUnavailable(res, error) {
  const response = qrLifecycleWriteHttpError(error);
  return res.status(response.status).json({
    status: 'error',
    code: response.code,
    message: response.message
  });
}

function respondPersonalRecordReadUnavailable(res, error) {
  const response = personalRecordPrimaryReadHttpError(error);
  return res.status(response.status).json({
    status: 'error',
    code: response.code,
    message: response.message
  });
}

function formatPostgresCreatedComment(result) {
  const comment = result && result.data && result.data.comment;
  if (!comment) return null;
  const createdAt = comment.created_at instanceof Date
    ? comment.created_at.toISOString()
    : comment.created_at;
  return {
    id: comment.legacy_comment_id ?? comment.id,
    phone: comment.phone_snapshot || '',
    account_id: comment.account_id,
    author_name: comment.author_name,
    content: comment.content,
    status: comment.status,
    created_at: createdAt
  };
}

function isCoCreationOwnerByAccount(qr, user) {
  const accountId = getMiniappAccountId(user);
  const ownerAccountId = qr && qr.co_creation_owner_account_id ? String(qr.co_creation_owner_account_id) : '';
  return !!accountId && !!ownerAccountId && accountId === ownerAccountId;
}

function hasMyCoCreationCommentByAccount(qr, user) {
  const accountId = getMiniappAccountId(user);
  if (!accountId) {
    return false;
  }
  return activeCoCreationComments(qr).some((comment) => (
    !!comment.account_id && String(comment.account_id) === accountId
  ));
}

function respondMiniappAccountContextRequired(res) {
  return res.status(401).json({
    status: 'error',
    code: 'UNAUTHORIZED',
    message: '璇峰厛鐧诲綍灏忕▼搴忋€?'
  });
}

function shouldExposeVerificationCode() {
  return ['development', 'test'].includes(String(process.env.NODE_ENV || '').toLowerCase());
}

function respondIdentityAuthorityUnavailable(res) {
  const response = identityAuthorityHttpError();
  return res.status(response.status).json({
    status: 'error',
    code: response.code,
    message: response.message
  });
}

async function createOrGetAuthoritativeMiniappUser(input) {
  const authority = await invokeIdentityAuthority('createOrGetMiniappIdentity', input);
  return authority.selected ? authority.result.data : createOrGetMiniappUser(input);
}

async function bindAuthoritativeMiniappPhone(input) {
  const authority = await invokeIdentityAuthority('bindMiniappPhone', input);
  return authority.selected ? authority.result : bindMiniappUserPhone(input);
}

function resolveImageUrl(record, assetResolver = null) {
  if (assetResolver && typeof assetResolver.resolveRecordImage === 'function') {
    const authority = record.record_media_authority || {
      qrId: record.id || record.qr_id,
      accessToken: record.qr_access_token || record.authority_access_token
    };
    return assetResolver.resolveRecordImage({ record, authority, channel: 'miniapp' });
  }
  return record.image_object_key ? null : record.image_url;
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
  return {
    has_my_co_creation_comment: hasMyCoCreationCommentByAccount(qr, user),
    co_creation_comment_count: activeComments.length,
    co_creation_comment_limit: CO_CREATION_COMMENT_LIMIT
  };
}

function findBatchForQr(qr) {
  if (!qr.batch_id) return null;
  return listBatches().find((item) => item.id === qr.batch_id) || null;
}

function getBatchInfo(qr, batch = null) {
  if (!qr.batch_id) {
    return {};
  }
  if (!batch) {
    return {};
  }
  return {
    batch_brand_name: batch.brand_name || '',
    batch_brand_disclosure_text: batch.brand_disclosure_text || '',
    batch_brand_disclosure_default: batch.brand_disclosure_default === true
  };
}

function getBrandName(qr, batch = undefined) {
  if (!qr.batch_id) {
    return '';
  }
  const resolvedBatch = batch === undefined ? findBatchForQr(qr) : batch;
  return resolvedBatch ? resolvedBatch.brand_name || '' : '';
}

function formatQRPayload(qr, user, { batch = null, assetResolver = null } = {}) {
  const base = {
    id: qr.id,
    qr_id: qr.id,
    activation_status: qr.activation_status,
    issue_status: qr.issue_status,
    active_storage_mode: getStorageMode(),
    phone_bound: !!(user && user.phone),
    batch_id: qr.batch_id || null,
    ...getBatchInfo(qr, batch)
  };

  if (qr.activation_status === 'activated') {
    return {
      ...base,
      content: qr.content || '',
      image_url: resolveImageUrl(qr, assetResolver),
      blockchain_hash: qr.blockchain_hash || null,
      ...chainPublicPayload(qr, { channel: 'miniapp', assetResolver }),
      activated_at: qr.activated_at,
      co_creation_enabled: qr.co_creation_enabled === true,
      is_co_creation_owner: isCoCreationOwnerByAccount(qr, user),
      co_creation_comments: visibleComments(qr),
      ...coCreationMeta(qr, user),
      show_brand_disclosure: qr.show_brand_disclosure === true,
      brand_disclosure_text_snapshot: qr.brand_disclosure_text_snapshot || '',
      brand_name: getBrandName(qr, batch)
    };
  }

  if (qr.activation_status === 'co_creating') {
    if (!user || !user.phone) {
      return base;
    }

    return {
      ...base,
      content: qr.content || '',
      image_url: resolveImageUrl(qr, assetResolver),
      co_creation_enabled: true,
      is_co_creation_owner: isCoCreationOwnerByAccount(qr, user),
      co_creation_comments: visibleComments(qr),
      ...coCreationMeta(qr, user),
      show_brand_disclosure: qr.show_brand_disclosure === true,
      brand_disclosure_text_snapshot: qr.brand_disclosure_text_snapshot || '',
      brand_name: getBrandName(qr, batch)
    };
  }

  return base;
}

function recordPayload(qr, user, assetResolver = createPublicQrAssetResolver()) {
  const batch = findBatchForQr(qr);
  return {
    ...formatQRPayload(qr, user, { batch, assetResolver }),
    content: qr.content || '',
    image_url: resolveImageUrl(qr, assetResolver),
    blockchain_hash: qr.blockchain_hash || null,
    ...chainPublicPayload(qr),
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
    price_cents: Number(product.price_cents || 0),
    description: product.description,
    buy_type: product.buy_type,
    buy_url: product.buy_url,
    product_type: product.product_type || 'wine_sticker',
    sticker_count: Number(product.sticker_count || 1),
    stock: Number(product.stock || 0),
    is_customizable: product.is_customizable === true,
    shipping_note: product.shipping_note || '',
    after_sale_note: product.after_sale_note || '',
    scene_tags: Array.isArray(product.scene_tags) ? product.scene_tags : []
  };
}

function shouldUseMockPay() {
  return process.env.WECHAT_PAY_MOCK === 'true' && process.env.NODE_ENV !== 'production';
}

function handleContentSafetyError(error, res) {
  if (error.code === 'MINIAPP_LOGIN_STALE') {
    return res.status(401).json({
      status: 'error',
      code: 'MINIAPP_LOGIN_STALE',
      message: '登录状态已失效，请重新进入小程序后继续。'
    });
  }
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

function miniappBindPhoneError(errorCode) {
  const errors = {
    MINIAPP_USER_NOT_FOUND: {
      status: 404,
      message: '未找到小程序登录用户，请重新进入小程序。'
    },
    PHONE_ALREADY_BOUND_TO_OTHER_WECHAT: {
      status: 409,
      message: '这个手机号已关联其他微信账号，暂时无法绑定。'
    },
    MINIAPP_PHONE_REPLACE_REQUIRED: {
      status: 409,
      message: '当前微信账号已绑定手机号，更换手机号功能暂未开放。'
    },
    MINIAPP_ACCOUNT_CONFLICT: {
      status: 409,
      message: '账号状态异常，暂时无法绑定手机号，请联系客服处理。'
    },
    ACCOUNT_MAPPING_REQUIRED: {
      status: 409,
      message: '账号状态异常，暂时无法绑定手机号，请联系客服处理。'
    }
  };
  return errors[errorCode] || {
    status: 409,
    message: '暂时无法绑定手机号，请稍后重试。'
  };
}

function isAccountMappingError(errorCode) {
  return [
    'ACCOUNT_MAPPING_REQUIRED',
    'ACCOUNT_MAPPING_MISMATCH',
    'ACCOUNT_IDENTITY_MISMATCH',
    'DUPLICATE_PHONE_IDENTITY',
    'DUPLICATE_OPENID_IDENTITY'
  ].includes(errorCode);
}

function phoneAuthError(errorCode) {
  if (errorCode === 'INVALID_PHONE_CODE') {
    return {
      status: 400,
      code: 'INVALID_PHONE_CODE',
      message: '未获取到微信手机号，请再次尝试。'
    };
  }
  if (errorCode === 'WECHAT_CONFIG_ERROR') {
    return {
      status: 503,
      code: 'MINIAPP_WECHAT_NOT_CONFIGURED',
      message: '暂时无法获取微信手机号，请稍后重试。'
    };
  }
  return {
    status: 502,
    code: 'PHONE_BIND_FAILED',
    message: '暂时无法获取微信手机号，请稍后重试。'
  };
}

function miniappSmsSendError(errorCode) {
  if (errorCode === 'SMS_SEND_TOO_FREQUENT') {
    return {
      status: 429,
      code: 'SMS_SEND_TOO_FREQUENT',
      message: '操作太频繁，请稍后再试。'
    };
  }
  return {
    status: 503,
    code: 'SMS_SERVICE_UNAVAILABLE',
    message: '暂时无法完成手机号验证，请稍后重试。'
  };
}

function miniappSmsBindError(errorCode) {
  if (errorCode === 'MINIAPP_PHONE_REPLACE_REQUIRED') {
    return {
      status: 409,
      message: '当前微信账号已绑定手机号，更换手机号功能暂未开放。'
    };
  }
  return miniappBindPhoneError(errorCode);
}

router.post('/auth/login', async (req, res) => {
  try {
    const session = await codeToSession(req.body.code);
    const user = await createOrGetAuthoritativeMiniappUser({
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
    if (error instanceof IdentityAuthorityError) {
      return respondIdentityAuthorityUnavailable(res);
    }
    const isConfigError = error.code === 'WECHAT_CONFIG_ERROR';
    if (isAccountMappingError(error.code)) {
      return res.status(409).json({
        status: 'error',
        code: error.code || 'ACCOUNT_MAPPING_REQUIRED',
        message: '账号状态异常，暂时无法登录，请稍后处理。'
      });
    }
    return res.status(error.code === 'INVALID_LOGIN_CODE' ? 400 : 502).json({
      status: 'error',
      code: isConfigError ? 'MINIAPP_WECHAT_NOT_CONFIGURED' : error.code || 'WECHAT_LOGIN_FAILED',
      message: isConfigError ? '微信登录暂时不可用，请稍后重试。' : error.message || '微信登录失败。'
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

    const result = await bindAuthoritativeMiniappPhone({
      openid: req.miniappUser.openid,
      phone,
      unionid: req.miniappUser.unionid || null
    });
    if (result.error) {
      const bindError = miniappBindPhoneError(result.error);
      return res.status(bindError.status).json({
        status: 'error',
        code: result.error,
        message: bindError.message
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
    if (error instanceof IdentityAuthorityError) {
      return respondIdentityAuthorityUnavailable(res);
    }
    if (isAccountMappingError(error.code)) {
      const bindError = miniappBindPhoneError('ACCOUNT_MAPPING_REQUIRED');
      return res.status(bindError.status).json({
        status: 'error',
        code: 'ACCOUNT_MAPPING_REQUIRED',
        message: bindError.message
      });
    }
    const phoneError = phoneAuthError(error.code);
    return res.status(phoneError.status).json({
      status: 'error',
      code: phoneError.code,
      message: phoneError.message
    });
  }
});

router.post('/auth/sms/send-code', requireMiniappAuth, async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!isValidPhone(phone)) {
    return res.status(400).json({
      status: 'error',
      code: 'INVALID_PHONE',
      message: '请输入正确的手机号。'
    });
  }

  try {
    const sendResult = await sendCode(phone);
    const data = {
      sent: true,
      expires_in_seconds: sendResult.expiresInSeconds,
      cooldown_in_seconds: sendResult.cooldownInSeconds
    };
    if (shouldExposeVerificationCode() && sendResult.plainCode) {
      data.verification_code = sendResult.plainCode;
    }
    return res.json({
      status: 'success',
      code: 'OK',
      data
    });
  } catch (error) {
    const smsError = miniappSmsSendError(error.code);
    return res.status(smsError.status).json({
      status: 'error',
      code: smsError.code,
      message: smsError.message
    });
  }
});

router.post('/auth/sms/bind-phone', requireMiniappAuth, async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const code = String(req.body.code || '').trim();
  if (!isValidPhone(phone)) {
    return res.status(400).json({
      status: 'error',
      code: 'INVALID_PHONE',
      message: '请输入正确的手机号。'
    });
  }
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({
      status: 'error',
      code: 'INVALID_VERIFY_CODE',
      message: '验证码不正确或已过期，请重新获取。'
    });
  }

  try {
    const verified = verifyCode(phone, code);
    if (!verified.ok) {
      return res.status(400).json({
        status: 'error',
        code: 'INVALID_VERIFY_CODE',
        message: '验证码不正确或已过期，请重新获取。'
      });
    }

    const result = await bindAuthoritativeMiniappPhone({
      openid: req.miniappUser.openid,
      phone,
      unionid: req.miniappUser.unionid || null
    });
    if (result.error) {
      const bindError = miniappSmsBindError(result.error);
      return res.status(bindError.status).json({
        status: 'error',
        code: result.error,
        message: bindError.message
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
    if (error instanceof IdentityAuthorityError) {
      return respondIdentityAuthorityUnavailable(res);
    }
    if (isAccountMappingError(error.code)) {
      const bindError = miniappSmsBindError('ACCOUNT_MAPPING_REQUIRED');
      return res.status(bindError.status).json({
        status: 'error',
        code: 'ACCOUNT_MAPPING_REQUIRED',
        message: bindError.message
      });
    }
    console.warn('[miniapp-sms-bind]', {
      reason: error.code || 'MINIAPP_SMS_BIND_FAILED'
    });
    return res.status(500).json({
      status: 'error',
      code: 'MINIAPP_SMS_BIND_FAILED',
      message: '暂时无法完成手机号验证，请稍后重试。'
    });
  }
});

router.get('/content', (_req, res) => {
  return res.json({
    status: 'success',
    code: 'OK',
    data: getMiniappContent({ publicOnly: true })
  });
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

router.post('/orders', requireMiniappAuth, requireMiniappPhone, (req, res) => {
  const accountId = getMiniappAccountId(req.miniappUser);
  if (!accountId) {
    return respondMiniappAccountContextRequired(res);
  }

  const result = createMiniappOrder({
    openid: req.miniappUser.openid,
    phone: req.miniappUser.phone,
    account_id: accountId,
    productId: String(req.body.product_id || '').trim(),
    quantity: req.body.quantity,
    receiverName: req.body.receiver_name,
    receiverPhone: req.body.receiver_phone,
    region: req.body.region,
    address: req.body.address,
    remark: req.body.remark
  });
  if (result.error === 'PRODUCT_NOT_FOUND') {
    return res.status(404).json({ status: 'error', code: 'PRODUCT_NOT_FOUND', message: '未找到该商品或商品未上架。' });
  }
  if (result.error === 'ACCOUNT_CONTEXT_REQUIRED') {
    return respondMiniappAccountContextRequired(res);
  }
  if (result.error === 'OUT_OF_STOCK') {
    return res.status(409).json({ status: 'error', code: 'OUT_OF_STOCK', message: '库存不足，请减少数量或联系客服。' });
  }
  if (result.error === 'VALIDATION_ERROR') {
    return res.status(400).json({ status: 'error', code: 'VALIDATION_ERROR', message: result.message || '订单信息不完整。' });
  }
  return res.json({ status: 'success', code: 'OK', data: result.data });
});

router.get('/orders', requireMiniappAuth, requireMiniappPhone, (req, res) => {
  const orders = listMiniappOrdersByAccountId(req.miniappUser.account_id);
  return res.json({
    status: 'success',
    code: 'OK',
    data: {
      total: orders.length,
      orders
    }
  });
});

router.get('/orders/:orderId', requireMiniappAuth, requireMiniappPhone, (req, res) => {
  const order = getMiniappOrderByAccountId({ account_id: req.miniappUser.account_id, orderId: req.params.orderId });
  if (!order) {
    return res.status(404).json({ status: 'error', code: 'ORDER_NOT_FOUND', message: '未找到该订单。' });
  }
  return res.json({ status: 'success', code: 'OK', data: order });
});

router.post('/orders/:orderId/cancel', requireMiniappAuth, requireMiniappPhone, (req, res) => {
  const result = cancelMiniappOrderByAccountId({ account_id: req.miniappUser.account_id, orderId: req.params.orderId });
  if (result.error === 'ORDER_NOT_FOUND') {
    return res.status(404).json({ status: 'error', code: 'ORDER_NOT_FOUND', message: '未找到该订单。' });
  }
  if (result.error === 'ORDER_NOT_CANCELABLE') {
    return res.status(409).json({ status: 'error', code: 'ORDER_NOT_CANCELABLE', message: '当前订单不能取消。' });
  }
  return res.json({ status: 'success', code: 'OK', data: result.data });
});

router.post('/orders/:orderId/pay', requireMiniappAuth, requireMiniappPhone, async (req, res) => {
  const order = getMiniappOrderByAccountId({ account_id: req.miniappUser.account_id, orderId: req.params.orderId });
  if (!order) {
    return res.status(404).json({ status: 'error', code: 'ORDER_NOT_FOUND', message: '未找到该订单。' });
  }
  if (order.status !== 'pending_payment') {
    return res.status(409).json({ status: 'error', code: 'ORDER_NOT_PAYABLE', message: '当前订单不能支付。' });
  }
  if (isWechatPayConfigured()) {
    try {
      const payment = await createMiniappPayment({
        openid: req.miniappUser.openid,
        order
      });
      return res.json({
        status: 'success',
        code: 'OK',
        data: {
          order,
          payment
        }
      });
    } catch (error) {
      return res.status(502).json({
        status: 'error',
        code: error.code || 'WECHAT_PAY_FAILED',
        message: error.message || '微信支付下单失败，请稍后重试。'
      });
    }
  }
  if (!shouldUseMockPay()) {
    return res.status(503).json({
      status: 'error',
      code: 'WECHAT_PAY_NOT_CONFIGURED',
      message: '微信支付尚未配置完成，请稍后再试。'
    });
  }
  const result = payMiniappOrderMockByAccountId({ account_id: req.miniappUser.account_id, orderId: req.params.orderId });
  if (result.error === 'ORDER_NOT_FOUND') {
    return res.status(404).json({ status: 'error', code: 'ORDER_NOT_FOUND', message: '未找到该订单。' });
  }
  if (result.error === 'ORDER_NOT_PAYABLE') {
    return res.status(409).json({ status: 'error', code: 'ORDER_NOT_PAYABLE', message: '当前订单不能支付。' });
  }
  return res.json({
    status: 'success',
    code: 'OK',
    data: {
      order: result.data,
      payment_mock: true
    }
  });
});

router.post('/upload', requireMiniappAuth, requireMiniappPhone, receiveSingleImage('image'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        status: 'error',
        code: 'UPLOAD_FAILED',
        message: '上传失败，请重新选择图片。'
      });
    }

    const qrKey = String(req.body.qr_id || req.query.qr_id || '').trim();
    const accountId = getMiniappAccountId(req.miniappUser);
    if (!qrKey || !accountId) {
      return res.status(400).json({
        status: 'error',
        code: 'UPLOAD_FAILED',
        message: '上传上下文无效，请重新扫码后再试。'
      });
    }
    const prepared = await processRecordImageUpload({
      file: req.file,
      accessToken: qrKey,
      accountId,
      maxOutputWidth: 1080,
      jpegQuality: 80,
      async validateNormalizedImage(normalizedFile) {
        await checkImageBuffer(normalizedFile.buffer, {
          filename: normalizedFile.originalname,
          mimetype: 'image/jpeg'
        });
      }
    });
    const { stored, uploadProof } = prepared;
    return res.json({
      status: 'success',
      code: 'OK',
      data: {
        url: stored.url,
        preview_url: stored.preview_url || null,
        storage_mode: stored.mode,
        object_key: stored.object_key,
        upload_proof: uploadProof,
        buffered: true,
        active_storage_mode: getStorageMode(),
        fallback: stored.fallback === true
      }
    });
  } catch (error) {
    if (error instanceof RecordImageUploadEligibilityError) {
      return res.status(400).json({
        status: 'error',
        code: 'UPLOAD_QR_NOT_ELIGIBLE',
        message: 'The QR code is not eligible for a record image upload.'
      });
    }
    if (error instanceof QrLifecyclePostgresWriteError) {
      return respondLifecycleWriteUnavailable(res, error);
    }
    const contentSafetyResponse = handleContentSafetyError(error, res);
    if (contentSafetyResponse) return contentSafetyResponse;
    if (respondToImageValidationError(error, res)) return undefined;
    return next(error);
  }
});

router.get('/qr/:key', optionalMiniappAuth, async (req, res) => {
  const key = String(req.params.key || '').trim();
  const {
    qr,
    batch,
    sourceHash,
    publicQrDomainHash
  } = findPublicQrReadContextByKey(key);
  const assetResolver = createPublicQrAssetResolver();
  const viewer = {
    accountId: getMiniappAccountId(req.miniappUser),
    phoneBound: Boolean(req.miniappUser && req.miniappUser.phone)
  };

  try {
    const primaryRead = await readPublicQrPrimary({
      key,
      publicQrId: qr && qr.id,
      domainHash: publicQrDomainHash,
      channel: 'miniapp',
      viewer,
      assetResolver
    });
    if (primaryRead.selected) {
      return res.json({
        status: 'success',
        code: 'OK',
        data: primaryRead.dto
      });
    }
  } catch (error) {
    const response = publicQrPrimaryReadHttpError(error);
    return res.status(response.status).json({
      status: 'error',
      code: response.code,
      message: response.message
    });
  }

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
  const data = formatQRPayload(qr, req.miniappUser, { batch, assetResolver });
  registerPublicQrShadowObservation({
    res,
    event: {
      channel: 'miniapp',
      endpointTemplate: '/api/miniapp/qr/:key',
      key,
      publicQrId: qr.id,
      viewer,
      baselineDto: data,
      sourceHash,
      assetResolver
    }
  });
  return res.json({
    status: 'success',
    code: 'OK',
    data
  });
});

router.post('/qr/:key/record', requireMiniappAuth, requireMiniappPhone, async (req, res) => {
  const content = String(req.body.content || '').trim();
  const mode = req.body.mode === 'co_create' ? 'co_create' : 'direct';
  const accountId = getMiniappAccountId(req.miniappUser);

  if (!accountId) {
    return respondMiniappAccountContextRequired(res);
  }

  let verifiedUpload;
  try {
    verifiedUpload = verifyRecordImageUploadProof({
      proof: req.body.upload_proof,
      accountId
    });
    if (!isCurrentRecordImageObjectKey(verifiedUpload.object_key)
        || !isRecordImageObjectKeyForQrId(
          verifiedUpload.object_key,
          verifiedUpload.qr_id
        )) {
      throw new UploadProofError();
    }
  } catch (error) {
    if (!(error instanceof UploadProofError)) throw error;
    return res.status(400).json({
      status: 'error',
      code: 'UPLOAD_PROOF_INVALID',
      message: '图片上传凭证无效或已过期，请重新上传。'
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
    image_url: null,
    image_object_key: null,
    upload_claim: verifiedUpload,
    phone: req.miniappUser.phone,
    account_id: accountId,
    show_brand_disclosure: req.body.show_brand_disclosure === true
  };
  let selectedWrite;
  try {
    selectedWrite = await selectPostgresLifecycleWrite({
      key: req.params.key,
      operation: mode === 'co_create' ? 'start_co_creation' : 'activate',
      payload,
      req
    });
  } catch (error) {
    return respondLifecycleWriteUnavailable(res, error);
  }
  const result = selectedWrite.selected
    ? selectedWrite.result
    : mode === 'co_create'
      ? startCoCreationByKey(req.params.key, payload)
      : activateQRByKey(req.params.key, payload);

  if (result.error === 'ACCOUNT_CONTEXT_REQUIRED') {
    return respondMiniappAccountContextRequired(res);
  }
  if (result.error === 'CONTENT_PRIVACY_REJECTED') {
    return respondContentPrivacyRejected(res);
  }
  if (result.error === 'UPLOAD_PROOF_INVALID') {
    return res.status(400).json({
      status: 'error',
      code: 'UPLOAD_PROOF_INVALID',
      message: 'The image upload proof does not match this QR code.'
    });
  }

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
  if (result.error === 'QR_NOT_ISSUED') {
    return res.status(409).json({
      status: 'error',
      code: 'QR_NOT_ISSUED',
      message: '\u8be5\u4e8c\u7ef4\u7801\u5c1a\u672a\u53d1\u884c\uff0c\u65e0\u6cd5\u6fc0\u6d3b\u6216\u5f00\u59cb\u5171\u521b\u3002'
    });
  }

  if (selectedWrite.selected) {
    return res.json({
      status: 'success',
      code: 'OK',
      data: selectedWrite.dto
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
    data: recordPayload(responseData, req.miniappUser)
  });
});

router.post('/qr/:key/comments', requireMiniappAuth, requireMiniappPhone, async (req, res) => {
  const authorName = String(req.body.author_name || '').trim();
  const content = String(req.body.content || '').trim();
  const accountId = getMiniappAccountId(req.miniappUser);

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

  if (!accountId) {
    return respondMiniappAccountContextRequired(res);
  }

  try {
    await checkText(`${authorName}\n${content}`, { openid: req.miniappUser.openid });
  } catch (error) {
    const handled = handleContentSafetyError(error, res);
    if (handled) return handled;
    throw error;
  }

  const payload = {
    phone: req.miniappUser.phone,
    account_id: accountId,
    authorName,
    content
  };
  let selectedWrite;
  try {
    selectedWrite = await selectPostgresLifecycleWrite({
      key: req.params.key,
      operation: 'add_comment',
      payload,
      req
    });
  } catch (error) {
    return respondLifecycleWriteUnavailable(res, error);
  }
  const result = selectedWrite.selected
    ? selectedWrite.result
    : addCoCreationCommentByKey(req.params.key, payload);
  if (result.error === 'ACCOUNT_CONTEXT_REQUIRED') {
    return respondMiniappAccountContextRequired(res);
  }
  if (result.error === 'CONTENT_PRIVACY_REJECTED') {
    return respondContentPrivacyRejected(res);
  }
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

  return res.json({
    status: 'success',
    code: 'OK',
    data: selectedWrite.selected
      ? formatPostgresCreatedComment(result)
      : result.data
  });
});

router.delete('/qr/:key/comments/:commentId', requireMiniappAuth, requireMiniappPhone, async (req, res) => {
  const accountId = getMiniappAccountId(req.miniappUser);
  if (!accountId) {
    return respondMiniappAccountContextRequired(res);
  }

  const payload = {
    commentId: req.params.commentId,
    account_id: accountId
  };
  let selectedWrite;
  try {
    selectedWrite = await selectPostgresLifecycleWrite({
      key: req.params.key,
      operation: 'delete_comment',
      payload,
      req
    });
  } catch (error) {
    return respondLifecycleWriteUnavailable(res, error);
  }
  const result = selectedWrite.selected
    ? selectedWrite.result
    : deleteCoCreationCommentByKey(req.params.key, payload);
  if (result.error === 'ACCOUNT_CONTEXT_REQUIRED') {
    return respondMiniappAccountContextRequired(res);
  }
  if (result.error === 'QR_NOT_FOUND' || result.error === 'COMMENT_NOT_FOUND') {
    return res.status(404).json({ status: 'error', code: result.error, message: '未找到要删除的留言。' });
  }
  if (result.error === 'FORBIDDEN') {
    return res.status(403).json({ status: 'error', code: 'FORBIDDEN', message: '只有发起人可以删除共创留言。' });
  }
  return res.json({
    status: 'success',
    code: 'OK',
    data: selectedWrite.selected
      ? selectedWrite.dto
      : recordPayload(result.data, req.miniappUser)
  });
});

router.post('/qr/:key/finalize', requireMiniappAuth, requireMiniappPhone, async (req, res) => {
  const accountId = getMiniappAccountId(req.miniappUser);
  if (!accountId) {
    return respondMiniappAccountContextRequired(res);
  }

  const payload = {
    account_id: accountId
  };
  let selectedWrite;
  try {
    selectedWrite = await selectPostgresLifecycleWrite({
      key: req.params.key,
      operation: 'finalize',
      payload,
      req
    });
  } catch (error) {
    return respondLifecycleWriteUnavailable(res, error);
  }
  const result = selectedWrite.selected
    ? selectedWrite.result
    : finalizeCoCreationByKey(req.params.key, payload);
  if (result.error === 'ACCOUNT_CONTEXT_REQUIRED') {
    return respondMiniappAccountContextRequired(res);
  }
  if (result.error === 'QR_NOT_FOUND') {
    return res.status(404).json({ status: 'error', code: 'QR_NOT_FOUND', message: '未找到这颗星，请确认二维码是否正确。' });
  }
  if (result.error === 'FORBIDDEN') {
    return res.status(403).json({ status: 'error', code: 'FORBIDDEN', message: '只有发起人可以确认封存。' });
  }
  if (result.error === 'CO_CREATION_CLOSED') {
    return res.status(409).json({ status: 'error', code: 'CO_CREATION_CLOSED', message: '这瓶酒不在共创中，不能确认封存。' });
  }
  if (selectedWrite.selected) {
    return res.json({
      status: 'success',
      code: 'OK',
      data: selectedWrite.dto
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
    data: recordPayload(responseData, req.miniappUser)
  });
});

async function handleMiniappPersonalRecords(req, res) {
  const accountId = getMiniappAccountId(req.miniappUser);
  const {
    records: sourceRecords,
    sourceHash,
    publicQrDomainHash
  } = findPersonalRecordListContextByAccountId(accountId);
  const assetResolver = createPublicQrAssetResolver();

  try {
    const primaryRead = await readPersonalRecordPrimary({
      readKind: 'list',
      accountId,
      domainHash: publicQrDomainHash,
      channel: 'miniapp',
      assetResolver
    });
    if (primaryRead.selected) {
      return res.json({ status: 'success', code: 'OK', data: primaryRead.dto });
    }
  } catch (error) {
    return respondPersonalRecordReadUnavailable(res, error);
  }

  const records = sourceRecords.map((item) => ({
    id: item.id,
    content: item.content,
    activated_at: item.activated_at,
    display_at: item.display_at,
    activation_status: item.activation_status,
    image_url: resolveImageUrl(item, assetResolver)
  }));
  const data = { total: records.length, records };
  registerPersonalRecordShadowObservation({
    res,
    event: {
      channel: 'miniapp',
      endpointTemplate: '/api/miniapp/user/records',
      readKind: 'list',
      accountId,
      baselineDto: data,
      sourceHash,
      assetResolver
    }
  });
  return res.json({
    status: 'success',
    code: 'OK',
    data
  });
}

async function handleMiniappPersonalRecordDetail(req, res) {
  const accountId = getMiniappAccountId(req.miniappUser);
  const {
    record,
    batch,
    sourceHash,
    publicQrDomainHash
  } = findPersonalRecordDetailContext({
    account_id: req.miniappUser.account_id,
    id: req.params.id
  });

  const assetResolver = createPublicQrAssetResolver();
  try {
    const primaryRead = await readPersonalRecordPrimary({
      readKind: 'detail',
      accountId,
      recordId: req.params.id,
      domainHash: publicQrDomainHash,
      channel: 'miniapp',
      assetResolver
    });
    if (primaryRead.selected) {
      return res.json({ status: 'success', code: 'OK', data: primaryRead.dto });
    }
  } catch (error) {
    return respondPersonalRecordReadUnavailable(res, error);
  }

  if (!record) {
    return res.status(404).json({
      status: 'error',
      code: 'RECORD_NOT_FOUND',
      message: '未找到该记录，或你无权查看。'
    });
  }
  const data = {
    id: record.id,
    content: record.content || '',
    activated_at: record.activated_at,
    blockchain_hash: record.blockchain_hash || null,
    image_url: resolveImageUrl(record, assetResolver),
    co_creation_comments: visibleComments(record),
    show_brand_disclosure: record.show_brand_disclosure === true,
    brand_disclosure_text_snapshot: record.brand_disclosure_text_snapshot || '',
    brand_name: getBrandName(record, batch),
    ...chainPublicPayload(record, { channel: 'miniapp', assetResolver })
  };
  registerPersonalRecordShadowObservation({
    res,
    event: {
      channel: 'miniapp',
      endpointTemplate: '/api/miniapp/user/records/:id',
      readKind: 'detail',
      accountId,
      recordId: record.id,
      baselineDto: data,
      sourceHash,
      assetResolver
    }
  });
  return res.json({ status: 'success', code: 'OK', data });
}

router.get('/user/records', requireMiniappAuth, requireMiniappPhone, (req, res, next) => (
  handleMiniappPersonalRecords(req, res).catch(next)
));

router.get('/user/records/:id', requireMiniappAuth, requireMiniappPhone, (req, res, next) => (
  handleMiniappPersonalRecordDetail(req, res).catch(next)
));

router.use((err, _req, res, _next) => {
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
