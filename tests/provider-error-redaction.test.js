'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

function mockHttps(handler) {
  const originalRequest = https.request;
  https.request = (url, options, callback) => {
    const request = new EventEmitter();
    let body = '';
    request.write = (chunk) => {
      body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    };
    request.setTimeout = () => request;
    request.destroy = (error) => process.nextTick(() => request.emit('error', error));
    request.end = () => {
      const result = handler({ url: String(url), options, body });
      const response = new EventEmitter();
      response.statusCode = result.statusCode || 200;
      response.headers = {};
      process.nextTick(() => {
        callback(response);
        response.emit('data', Buffer.from(JSON.stringify(result.body || {})));
        response.emit('end');
      });
    };
    return request;
  };
  return () => {
    https.request = originalRequest;
  };
}

function snapshotEnv(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test('WeChat miniapp provider details never become public error messages', async () => {
  const keys = ['NODE_ENV', 'MINIAPP_MOCK_ENABLED', 'WECHAT_MINIAPP_APPID', 'WECHAT_MINIAPP_SECRET'];
  const previous = snapshotEnv(keys);
  const restoreHttps = mockHttps(({ url }) => {
    if (url.includes('/sns/jscode2session')) {
      return { body: { errcode: 40029, errmsg: 'must-not-leak-login-provider-detail' } };
    }
    if (url.includes('/cgi-bin/token')) {
      return { body: { access_token: 'test-access-token', expires_in: 7200 } };
    }
    return { body: { errcode: 45009, errmsg: 'must-not-leak-content-provider-detail' } };
  });

  try {
    Object.assign(process.env, {
      NODE_ENV: 'production',
      WECHAT_MINIAPP_APPID: 'wx-test-appid',
      WECHAT_MINIAPP_SECRET: 'test-secret'
    });
    delete process.env.MINIAPP_MOCK_ENABLED;
    const { codeToSession } = require('../src/server/services/miniappAuthService');
    const { checkText } = require('../src/server/services/contentSafetyService');

    await assert.rejects(
      codeToSession('invalid-code'),
      (error) => error.code === 'WECHAT_LOGIN_FAILED'
        && error.message === '微信登录失败，请稍后重试。'
        && !error.message.includes('must-not-leak')
    );
    await assert.rejects(
      checkText('normal content', { openid: 'openid-test' }),
      (error) => error.code === 'CONTENT_SAFETY_UNAVAILABLE'
        && error.message === '内容安全检测暂时不可用，请稍后重试。'
        && !error.message.includes('must-not-leak')
    );
  } finally {
    restoreHttps();
    restoreEnv(previous);
  }
});

test('WeChat Pay provider details stay internal to the service error', async () => {
  const envKeys = [
    'WECHAT_PAY_MCH_ID',
    'WECHAT_PAY_APPID',
    'WECHAT_PAY_API_V3_KEY',
    'WECHAT_PAY_CERT_SERIAL_NO',
    'WECHAT_PAY_PRIVATE_KEY_PATH',
    'WECHAT_PAY_NOTIFY_URL'
  ];
  const previous = snapshotEnv(envKeys);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-pay-redaction-'));
  const privateKeyPath = path.join(tempDir, 'merchant-private.pem');
  const keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.writeFileSync(privateKeyPath, keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const restoreHttps = mockHttps(() => ({
    statusCode: 400,
    body: { code: 'PARAM_ERROR', message: 'must-not-leak-payment-provider-detail' }
  }));

  try {
    Object.assign(process.env, {
      WECHAT_PAY_MCH_ID: '1900000001',
      WECHAT_PAY_APPID: 'wx-test-appid',
      WECHAT_PAY_API_V3_KEY: '0123456789abcdef0123456789abcdef',
      WECHAT_PAY_CERT_SERIAL_NO: 'TEST_SERIAL',
      WECHAT_PAY_PRIVATE_KEY_PATH: privateKeyPath,
      WECHAT_PAY_NOTIFY_URL: 'https://example.invalid/api/payment/wechat/notify'
    });
    const { requestWechatPayApi } = require('../src/server/services/wechatPayService');
    await assert.rejects(
      requestWechatPayApi({ method: 'POST', path: '/v3/pay/transactions/jsapi', body: { test: true } }),
      (error) => error.code === 'WECHAT_PAY_API_ERROR'
        && error.message === '微信支付请求失败，请稍后重试。'
        && !error.message.includes('must-not-leak')
    );
  } finally {
    restoreHttps();
    restoreEnv(previous);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('miniapp route boundary redacts unexpected login and payment failures', () => {
  const {
    publicWechatLoginError,
    publicWechatPayError
  } = require('../src/server/routes/miniapp');
  const login = publicWechatLoginError(Object.assign(
    new Error('connect ECONNREFUSED 10.0.0.8:443 with secret path'),
    { code: 'ECONNREFUSED' }
  ));
  assert.deepEqual(login, {
    status: 502,
    code: 'WECHAT_LOGIN_FAILED',
    message: '微信登录失败，请稍后重试。'
  });
  const payment = publicWechatPayError(Object.assign(
    new Error('ENOENT /etc/private/merchant.pem'),
    { code: 'ENOENT' }
  ));
  assert.deepEqual(payment, {
    status: 502,
    code: 'WECHAT_PAY_FAILED',
    message: '微信支付下单失败，请稍后重试。'
  });
  assert.equal(publicWechatPayError({ code: 'WECHAT_PAY_API_ERROR' }).code, 'WECHAT_PAY_API_ERROR');
});
