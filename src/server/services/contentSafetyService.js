const https = require('https');
const { getMiniappAccessToken, hasMiniappConfig } = require('./miniappAuthService');
const { readBoundedNodeResponse } = require('../utils/boundedResponse');

const WECHAT_REQUEST_TIMEOUT_MS = 10_000;
const WECHAT_RESPONSE_MAX_BYTES = 1024 * 1024;

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function shouldMockPass() {
  return !isProduction() && !hasMiniappConfig();
}

function assertMockSafeText(text) {
  if (String(text || '').includes('mock-reject')) {
    const error = new Error('内容未通过安全检测，请修改后再提交。');
    error.code = 'CONTENT_REJECTED';
    throw error;
  }
}

function requestJson(url, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length
      }
    }, (res) => {
      readBoundedNodeResponse(res, {
        maxBytes: WECHAT_RESPONSE_MAX_BYTES,
        errorCode: 'CONTENT_SAFETY_UNAVAILABLE',
        errorMessage: '内容安全检测暂时不可用，请稍后重试。'
      }).then((buffer) => {
        const raw = buffer.toString('utf8');
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch (error) {
          reject(error);
        }
      }).catch(reject);
    });
    req.setTimeout(WECHAT_REQUEST_TIMEOUT_MS, () => {
      const error = new Error('内容安全检测暂时不可用，请稍后重试。');
      error.code = 'CONTENT_SAFETY_UNAVAILABLE';
      req.destroy(error);
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function requestMultipart(url, { fieldName, filename, contentType, buffer }) {
  return new Promise((resolve, reject) => {
    const boundary = `----MiniappSafety${Date.now().toString(16)}`;
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
      'utf8'
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const payload = Buffer.concat([head, buffer, tail]);

    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': payload.length
      }
    }, (res) => {
      readBoundedNodeResponse(res, {
        maxBytes: WECHAT_RESPONSE_MAX_BYTES,
        errorCode: 'CONTENT_SAFETY_UNAVAILABLE',
        errorMessage: '内容安全检测暂时不可用，请稍后重试。'
      }).then((buffer) => {
        const raw = buffer.toString('utf8');
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch (error) {
          reject(error);
        }
      }).catch(reject);
    });
    req.setTimeout(WECHAT_REQUEST_TIMEOUT_MS, () => {
      const error = new Error('内容安全检测暂时不可用，请稍后重试。');
      error.code = 'CONTENT_SAFETY_UNAVAILABLE';
      req.destroy(error);
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function rejectFromWechatResponse(response, fallbackCode) {
  if (!response || response.errcode === 0) {
    if (response && response.result && response.result.suggest && response.result.suggest !== 'pass') {
      const error = new Error('内容未通过安全检测，请修改后再提交。');
      error.code = fallbackCode;
      throw error;
    }
    return;
  }

  if (Number(response.errcode) === 40003 || /invalid\s+openid/i.test(String(response.errmsg || ''))) {
    const error = new Error('登录状态已失效，请重新进入小程序后继续。');
    error.code = 'MINIAPP_LOGIN_STALE';
    throw error;
  }

  if (Number(response.errcode) === 87014) {
    const error = new Error('内容未通过安全检测，请修改后再提交。');
    error.code = fallbackCode;
    throw error;
  }

  const error = new Error('内容安全检测暂时不可用，请稍后重试。');
  error.code = 'CONTENT_SAFETY_UNAVAILABLE';
  error.providerCode = response.errcode || null;
  throw error;
}

async function checkText(text, { openid = '' } = {}) {
  const content = String(text || '').trim();
  if (!content) return { ok: true };

  if (shouldMockPass()) {
    assertMockSafeText(content);
    return { ok: true, mocked: true };
  }

  const accessToken = await getMiniappAccessToken();
  const response = await requestJson(`https://api.weixin.qq.com/wxa/msg_sec_check?access_token=${encodeURIComponent(accessToken)}`, {
    content,
    version: 2,
    scene: 2,
    openid
  });
  rejectFromWechatResponse(response, 'CONTENT_REJECTED');
  return { ok: true };
}

async function checkImageBuffer(buffer, { filename = 'image.jpg', mimetype = 'image/jpeg' } = {}) {
  if (!buffer || buffer.length === 0) return { ok: true };

  if (shouldMockPass()) {
    if (String(filename || '').includes('mock-reject')) {
      const error = new Error('图片未通过安全检测，请重新选择。');
      error.code = 'IMAGE_REJECTED';
      throw error;
    }
    return { ok: true, mocked: true };
  }

  const accessToken = await getMiniappAccessToken();
  const response = await requestMultipart(`https://api.weixin.qq.com/wxa/img_sec_check?access_token=${encodeURIComponent(accessToken)}`, {
    fieldName: 'media',
    filename,
    contentType: mimetype,
    buffer
  });
  rejectFromWechatResponse(response, 'IMAGE_REJECTED');
  return { ok: true };
}

module.exports = {
  checkText,
  checkImageBuffer
};
