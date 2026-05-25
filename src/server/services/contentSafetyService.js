const https = require('https');
const { getMiniappAccessToken, hasMiniappConfig } = require('./miniappAuthService');

const WECHAT_REQUEST_TIMEOUT_MS = 10_000;

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
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch (error) {
          reject(error);
        }
      });
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
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch (error) {
          reject(error);
        }
      });
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

  if (Number(response.errcode) === 87014) {
    const error = new Error('内容未通过安全检测，请修改后再提交。');
    error.code = fallbackCode;
    throw error;
  }

  const error = new Error(response.errmsg || '内容安全检测暂时不可用，请稍后重试。');
  error.code = 'CONTENT_SAFETY_UNAVAILABLE';
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
