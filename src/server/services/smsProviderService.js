const crypto = require('crypto');
const https = require('https');

function getSmsProvider() {
  return String(process.env.SMS_PROVIDER || 'mock').trim().toLowerCase();
}

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function getSmsConfig() {
  return {
    provider: getSmsProvider(),
    accessKeyId: process.env.SMS_ACCESS_KEY_ID || '',
    accessKeySecret: process.env.SMS_ACCESS_KEY_SECRET || '',
    signName: process.env.SMS_SIGN_NAME || '',
    templateCode: process.env.SMS_TEMPLATE_CODE || ''
  };
}

function assertAliyunConfig(config) {
  const missing = [];
  if (!config.accessKeyId) missing.push('SMS_ACCESS_KEY_ID');
  if (!config.accessKeySecret) missing.push('SMS_ACCESS_KEY_SECRET');
  if (!config.signName) missing.push('SMS_SIGN_NAME');
  if (!config.templateCode) missing.push('SMS_TEMPLATE_CODE');
  if (missing.length === 0) return;
  const error = new Error(`SMS config missing: ${missing.join(', ')}`);
  error.code = 'SMS_CONFIG_INVALID';
  throw error;
}

function percentEncode(value) {
  return encodeURIComponent(value)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

function aliyunRpcRequest(params, accessKeySecret) {
  const sortedKeys = Object.keys(params).sort();
  const canonicalized = sortedKeys.map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`).join('&');
  const stringToSign = `GET&%2F&${percentEncode(canonicalized)}`;
  const signature = crypto
    .createHmac('sha1', `${accessKeySecret}&`)
    .update(stringToSign, 'utf8')
    .digest('base64');
  const query = `Signature=${percentEncode(signature)}&${canonicalized}`;
  const url = `https://dysmsapi.aliyuncs.com/?${query}`;

  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch (_error) {
          body = null;
        }
        resolve({
          statusCode: res.statusCode || 500,
          body,
          raw
        });
      });
    }).on('error', reject);
  });
}

async function sendViaAliyun(phone, code, config) {
  assertAliyunConfig(config);
  const templateParam = JSON.stringify({ code });
  const params = {
    AccessKeyId: config.accessKeyId,
    Action: 'SendSms',
    Format: 'JSON',
    PhoneNumbers: phone,
    RegionId: process.env.SMS_REGION_ID || 'cn-hangzhou',
    SignName: config.signName,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: '1.0',
    TemplateCode: config.templateCode,
    TemplateParam: templateParam,
    Timestamp: new Date().toISOString(),
    Version: '2017-05-25'
  };

  const response = await aliyunRpcRequest(params, config.accessKeySecret);
  const success = response.statusCode === 200
    && response.body
    && String(response.body.Code || '').toUpperCase() === 'OK';

  if (!success) {
    const error = new Error('SMS provider returned failure');
    error.code = 'SMS_SEND_FAILED';
    error.details = response.body || response.raw;
    throw error;
  }
}

async function sendSmsCode(phone, code) {
  const config = getSmsConfig();

  if (config.provider === 'mock') {
    if (!isProduction()) {
      // non-production keeps compatibility for local/test env.
      return;
    }
    const error = new Error('SMS provider is not configured for production.');
    error.code = 'SMS_CONFIG_INVALID';
    throw error;
  }

  if (config.provider === 'aliyun') {
    await sendViaAliyun(phone, code, config);
    return;
  }

  const error = new Error(`Unsupported SMS_PROVIDER: ${config.provider}`);
  error.code = 'SMS_CONFIG_INVALID';
  throw error;
}

module.exports = {
  sendSmsCode,
  getSmsConfig
};
