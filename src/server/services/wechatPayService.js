const crypto = require('crypto');
const fs = require('fs');
const https = require('https');

const WECHAT_PAY_API_BASE = 'https://api.mch.weixin.qq.com';

function getConfig() {
  return {
    appid: process.env.WECHAT_PAY_APPID || process.env.WECHAT_MINIAPP_APPID || '',
    mchid: process.env.WECHAT_PAY_MCH_ID || '',
    apiV3Key: process.env.WECHAT_PAY_API_V3_KEY || '',
    certSerialNo: process.env.WECHAT_PAY_CERT_SERIAL_NO || '',
    privateKeyPath: process.env.WECHAT_PAY_PRIVATE_KEY_PATH || '',
    platformCertPath: process.env.WECHAT_PAY_PLATFORM_CERT_PATH || '',
    notifyUrl: process.env.WECHAT_PAY_NOTIFY_URL || ''
  };
}

function isWechatPayConfigured() {
  const config = getConfig();
  return Boolean(
    config.appid
    && config.mchid
    && config.apiV3Key
    && config.certSerialNo
    && config.privateKeyPath
    && config.platformCertPath
    && config.notifyUrl
  );
}

function readRequiredFile(filePath, label) {
  if (!filePath) {
    const error = new Error(`${label} 未配置。`);
    error.code = 'WECHAT_PAY_CONFIG_MISSING';
    throw error;
  }
  return fs.readFileSync(filePath, 'utf8');
}

function randomNonce(size = 16) {
  return crypto.randomBytes(size).toString('hex');
}

function signWithPrivateKey(message, privateKey) {
  return crypto
    .createSign('RSA-SHA256')
    .update(message)
    .end()
    .sign(privateKey, 'base64');
}

function buildAuthorization({ method, urlPath, body = '' }) {
  const config = getConfig();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = randomNonce();
  const privateKey = readRequiredFile(config.privateKeyPath, '微信支付商户私钥');
  const message = `${method}\n${urlPath}\n${timestamp}\n${nonceStr}\n${body}\n`;
  const signature = signWithPrivateKey(message, privateKey);
  return `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchid}",nonce_str="${nonceStr}",signature="${signature}",timestamp="${timestamp}",serial_no="${config.certSerialNo}"`;
}

function requestWechatPayApi({ method, path, body }) {
  const payload = body ? JSON.stringify(body) : '';
  const authorization = buildAuthorization({ method, urlPath: path, body: payload });

  return new Promise((resolve, reject) => {
    const req = https.request(`${WECHAT_PAY_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: authorization,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = {};
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch (_error) {
          parsed = { raw };
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
          return;
        }
        const error = new Error(parsed.message || parsed.code || '微信支付请求失败。');
        error.code = parsed.code || 'WECHAT_PAY_API_ERROR';
        error.statusCode = res.statusCode;
        error.response = parsed;
        reject(error);
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function createJsapiPrepay({ openid, order }) {
  const config = getConfig();
  const description = String((order.product_snapshot && order.product_snapshot.title) || '酒瓶星贴').slice(0, 127);
  const body = {
    appid: config.appid,
    mchid: config.mchid,
    description,
    out_trade_no: order.order_no,
    notify_url: config.notifyUrl,
    amount: {
      total: Number(order.total_amount_cents || 0),
      currency: 'CNY'
    },
    payer: {
      openid
    }
  };
  const result = await requestWechatPayApi({
    method: 'POST',
    path: '/v3/pay/transactions/jsapi',
    body
  });
  if (!result.prepay_id) {
    const error = new Error('微信支付未返回 prepay_id。');
    error.code = 'WECHAT_PAY_PREPAY_FAILED';
    throw error;
  }
  return result.prepay_id;
}

function buildMiniappPaymentParams(prepayId) {
  const config = getConfig();
  const timeStamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = randomNonce();
  const packageValue = `prepay_id=${prepayId}`;
  const privateKey = readRequiredFile(config.privateKeyPath, '微信支付商户私钥');
  const message = `${config.appid}\n${timeStamp}\n${nonceStr}\n${packageValue}\n`;
  return {
    timeStamp,
    nonceStr,
    package: packageValue,
    signType: 'RSA',
    paySign: signWithPrivateKey(message, privateKey)
  };
}

async function createMiniappPayment({ openid, order }) {
  const prepayId = await createJsapiPrepay({ openid, order });
  return buildMiniappPaymentParams(prepayId);
}

function verifyWechatPaySignature({ rawBody, headers }) {
  const config = getConfig();
  const timestamp = headers['wechatpay-timestamp'];
  const nonce = headers['wechatpay-nonce'];
  const signature = headers['wechatpay-signature'];
  if (!timestamp || !nonce || !signature) {
    return false;
  }
  const platformCert = readRequiredFile(config.platformCertPath, '微信支付平台证书');
  const message = `${timestamp}\n${nonce}\n${rawBody}\n`;
  return crypto
    .createVerify('RSA-SHA256')
    .update(message)
    .end()
    .verify(platformCert, signature, 'base64');
}

function decryptResource(resource) {
  const config = getConfig();
  const ciphertext = Buffer.from(resource.ciphertext || '', 'base64');
  const authTag = ciphertext.subarray(ciphertext.length - 16);
  const encrypted = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    Buffer.from(config.apiV3Key, 'utf8'),
    Buffer.from(resource.nonce || '', 'utf8')
  );
  decipher.setAuthTag(authTag);
  if (resource.associated_data) {
    decipher.setAAD(Buffer.from(resource.associated_data, 'utf8'));
  }
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  return JSON.parse(decrypted);
}

function parsePaymentNotify({ rawBody, headers }) {
  if (!verifyWechatPaySignature({ rawBody, headers })) {
    const error = new Error('微信支付回调验签失败。');
    error.code = 'WECHAT_PAY_SIGNATURE_INVALID';
    throw error;
  }
  const body = JSON.parse(rawBody || '{}');
  if (!body.resource) {
    const error = new Error('微信支付回调缺少 resource。');
    error.code = 'WECHAT_PAY_NOTIFY_INVALID';
    throw error;
  }
  return decryptResource(body.resource);
}

async function queryOrderByOutTradeNo(outTradeNo) {
  const config = getConfig();
  return requestWechatPayApi({
    method: 'GET',
    path: `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(config.mchid)}`
  });
}

module.exports = {
  buildMiniappPaymentParams,
  createMiniappPayment,
  createJsapiPrepay,
  decryptResource,
  getConfig,
  isWechatPayConfigured,
  parsePaymentNotify,
  queryOrderByOutTradeNo,
  requestWechatPayApi,
  verifyWechatPaySignature
};
