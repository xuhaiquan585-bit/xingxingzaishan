'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { EventEmitter } = require('node:events');

const { sendSmsCode } = require('../src/server/services/smsProviderService');
const { fetchCertificate } = require('../src/server/services/chainProofService');

const SMS_ENV_KEYS = [
  'NODE_ENV',
  'SMS_PROVIDER',
  'SMS_ACCESS_KEY_ID',
  'SMS_ACCESS_KEY_SECRET',
  'SMS_SIGN_NAME',
  'SMS_TEMPLATE_CODE'
];

test('Aliyun SMS requests fail with a bounded timeout', async () => {
  const previous = Object.fromEntries(SMS_ENV_KEYS.map((key) => [key, process.env[key]]));
  const originalGet = https.get;
  try {
    Object.assign(process.env, {
      NODE_ENV: 'production',
      SMS_PROVIDER: 'aliyun',
      SMS_ACCESS_KEY_ID: 'test-access-key',
      SMS_ACCESS_KEY_SECRET: 'test-access-secret',
      SMS_SIGN_NAME: 'test-sign',
      SMS_TEMPLATE_CODE: 'SMS_TEST'
    });

    https.get = () => {
      const request = new EventEmitter();
      let timeoutHandler = null;
      request.setTimeout = (timeoutMs, handler) => {
        assert.equal(timeoutMs, 10_000);
        timeoutHandler = handler;
        return request;
      };
      request.destroy = (error) => process.nextTick(() => request.emit('error', error));
      process.nextTick(() => timeoutHandler());
      return request;
    };

    await assert.rejects(
      sendSmsCode('13800138000', '123456'),
      (error) => error && error.code === 'SMS_REQUEST_TIMEOUT'
    );
  } finally {
    https.get = originalGet;
    for (const key of SMS_ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test('legacy certificate downloads fail with a bounded timeout', async () => {
  let timerCleared = false;
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

  await assert.rejects(
    fetchCertificate('https://example.invalid/certificate.pdf', {
      fetchImpl,
      setTimer(handler, timeoutMs) {
        assert.equal(timeoutMs, 10_000);
        process.nextTick(handler);
        return 1;
      },
      clearTimer(timer) {
        assert.equal(timer, 1);
        timerCleared = true;
      }
    }),
    (error) => error && error.code === 'CERTIFICATE_DOWNLOAD_TIMEOUT'
  );
  assert.equal(timerCleared, true);
});
