const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

let server;
let baseUrl;
let basePort;
let tmpDir;

test('record manifest should hash stably without identity secrets', () => {
  const { buildRecordManifest, hashManifest, stableStringify } = require('../src/server/services/manifestService');
  const manifest = buildRecordManifest({
    id: 'STAR_PRIVACY_001',
    activation_status: 'activated',
    activated_at: '2026-07-09T00:00:00.000Z',
    content: '只把记忆内容纳入存证清单',
    image_object_key: 'stars/STAR_PRIVACY_001/photo.jpg',
    phone: '13800000000',
    openid: 'openid-should-not-leak',
    co_creation_enabled: true,
    co_creation_comments: [
      { id: 1, phone: '13900000000', author_name: '朋友', content: '祝福', status: 'kept', created_at: '2026-07-09T00:00:01.000Z' }
    ],
    show_brand_disclosure: true,
    brand_disclosure_text_snapshot: '品牌快照'
  });
  const serialized = stableStringify(manifest);
  assert.equal(hashManifest(manifest), hashManifest(manifest));
  assert.equal(serialized.includes('13800000000'), false);
  assert.equal(serialized.includes('13900000000'), false);
  assert.equal(serialized.includes('openid-should-not-leak'), false);
  assert.equal(serialized.includes('AVATA_API_SECRET'), false);
});

test('AVATA V3 signature should use sorted path/body parameters', () => {
  const { buildSignParams, signRequest, stableJson } = require('../src/server/services/avataService');
  const params = buildSignParams({
    path: '/v3/native/record/records',
    body: {
      hash: 'abc',
      operation_id: 'op-1',
      identities: [{ identity_num: 'u1', identity_type: 1, identity_name: '企业' }]
    }
  });
  assert.deepEqual(Object.keys(params), ['body_hash', 'body_identities', 'body_operation_id', 'path_url']);
  assert.equal(stableJson(params), stableJson(buildSignParams({
    path: '/v3/native/record/records',
    body: {
      operation_id: 'op-1',
      identities: [{ identity_name: '企业', identity_type: 1, identity_num: 'u1' }],
      hash: 'abc'
    }
  })));
  assert.equal(
    signRequest({
      path: '/v3/native/record/records',
      body: {
        hash: 'abc',
        operation_id: 'op-1',
        identities: [{ identity_num: 'u1', identity_type: 1, identity_name: '企业' }]
      },
      timestamp: '1700000000000',
      apiSecret: 'secret'
    }),
    signRequest({
      path: '/v3/native/record/records',
      body: {
        operation_id: 'op-1',
        identities: [{ identity_name: '企业', identity_type: 1, identity_num: 'u1' }],
        hash: 'abc'
      },
      timestamp: '1700000000000',
      apiSecret: 'secret'
    })
  );
});

test('AVATA record proof body should include official fields without secrets', () => {
  const { buildRecordProofBody } = require('../src/server/services/avataService');
  const body = buildRecordProofBody({
    operationId: 'record_STAR001_hash',
    manifestHash: 'a'.repeat(64),
    starId: 'STAR001',
    sealedAt: '2026-07-09T00:00:00.000Z',
    config: {
      identityType: 1,
      identityName: '测试企业主体',
      identityNum: 'TEST-CREDIT-CODE',
      recordType: 1,
      hashType: 1
    }
  });
  assert.equal(body.identity_type, 1);
  assert.equal(body.identity_name, '测试企业主体');
  assert.equal(body.identity_num, 'TEST-CREDIT-CODE');
  assert.equal(body.type, 1);
  assert.equal(body.hash_type, 1);
  assert.equal(body.operation_id, 'record_STAR001_hash');
  assert.equal(body.hash, 'a'.repeat(64));
  assert.equal(Array.isArray(body.identities), true);
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes('AVATA_API_SECRET'), false);
  assert.equal(serialized.includes('openid'), false);
  assert.equal(serialized.includes('13800000000'), false);
});

test('AVATA result normalization should parse V3 record payload', () => {
  const { normalizeAvataResult } = require('../src/server/services/avataService');
  const result = normalizeAvataResult({
    data: {
      operation_id: 'op-v3',
      status: 1,
      tx_hash: 'tx-v3',
      block_height: 88,
      record: {
        create_record: {
          record_id: 'record-v3',
          certificate_url: 'https://cert.example.com/v3.pdf'
        }
      }
    }
  });
  assert.equal(result.operation_id, 'op-v3');
  assert.equal(result.status, 1);
  assert.equal(result.tx_hash, 'tx-v3');
  assert.equal(result.block_height, 88);
  assert.equal(result.record_id, 'record-v3');
  assert.equal(result.certificate_url, 'https://cert.example.com/v3.pdf');
});

function requestRaw(method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: basePort,
      path: urlPath,
      method,
      headers
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch (_error) {
          parsed = null;
        }

        resolve({
          status: res.statusCode,
          headers: res.headers,
          raw,
          body: parsed
        });
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(body);
    }

    req.end();
  });
}

function postJson(urlPath, body, token) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': payload.length
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return requestRaw('POST', urlPath, {
    headers,
    body: payload
  });
}

function postJsonWithCookie(urlPath, body, cookie = '') {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  return requestRaw('POST', urlPath, {
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': payload.length,
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: payload
  });
}

function getJson(urlPath, token) {
  const headers = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return requestRaw('GET', urlPath, { headers });
}

function getJsonWithCookie(urlPath, cookie = '') {
  return requestRaw('GET', urlPath, {
    headers: cookie ? { Cookie: cookie } : {}
  });
}

function localDateKey(value = new Date()) {
  const parsed = value instanceof Date ? value : new Date(value);
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function deleteJsonWithCookie(urlPath, cookie = '') {
  return requestRaw('DELETE', urlPath, {
    headers: cookie ? { Cookie: cookie } : {}
  });
}

function createMultipartBody(fields = {}, files = []) {
  const boundary = `----NodeFormBoundary${crypto.randomBytes(12).toString('hex')}`;
  const chunks = [];

  Object.entries(fields).forEach(([name, value]) => {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n`));
    chunks.push(Buffer.from(String(value)));
    chunks.push(Buffer.from('\r\n'));
  });

  files.forEach((file) => {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename}"\r\n`));
    chunks.push(Buffer.from(`Content-Type: ${file.contentType || 'application/octet-stream'}\r\n\r\n`));
    chunks.push(Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content || '', 'utf8'));
    chunks.push(Buffer.from('\r\n'));
  });

  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

function postMultipart(urlPath, { fields = {}, files = [] }, token) {
  const multipart = createMultipartBody(fields, files);
  const headers = {
    'Content-Type': multipart.contentType,
    'Content-Length': multipart.body.length
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return requestRaw('POST', urlPath, {
    headers,
    body: multipart.body
  });
}

function postMultipartWithCookie(urlPath, { fields = {}, files = [] }, cookie = '') {
  const multipart = createMultipartBody(fields, files);
  return requestRaw('POST', urlPath, {
    headers: {
      'Content-Type': multipart.contentType,
      'Content-Length': multipart.body.length,
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: multipart.body
  });
}

function getSessionCookie(response) {
  const setCookie = response.headers['set-cookie'];
  if (!Array.isArray(setCookie) || setCookie.length === 0) {
    return '';
  }
  return setCookie[0].split(';')[0];
}

async function loginUserAndGetCookie(phone = '13800138000') {
  const sendRes = await postJson('/api/user/sms/send-code', { phone });
  assert.equal(sendRes.status, 200);
  assert.ok(sendRes.body.data.verification_code);

  const verifyRes = await postJson('/api/user/sms/verify-code', {
    phone,
    code: sendRes.body.data.verification_code
  });
  assert.equal(verifyRes.status, 200);
  const cookie = getSessionCookie(verifyRes);
  assert.ok(cookie);
  return cookie;
}

async function loginMiniappAndGetToken(code = 'mini-code') {
  const loginRes = await postJson('/api/miniapp/auth/login', { code });
  assert.equal(loginRes.status, 200);
  assert.ok(loginRes.body.data.token);
  return loginRes.body.data.token;
}

async function loginMiniappBindPhoneAndGetToken({ code = 'mini-code', phone = '13800138000' } = {}) {
  const token = await loginMiniappAndGetToken(code);
  const bindRes = await postJson('/api/miniapp/auth/bind-phone', { code: phone }, token);
  assert.equal(bindRes.status, 200);
  assert.ok(bindRes.body.data.token);
  assert.equal(bindRes.body.data.phone, phone);
  return bindRes.body.data.token;
}

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xingxingzaishan-'));
  process.env.DB_FILE = path.join(tmpDir, 'db.json');
  process.env.STORAGE_ROOT = path.join(tmpDir, 'storage');
  process.env.AUTH_SECRET = 'test-secret-123';
  process.env.RATE_LIMIT_LOGIN_MAX = '1000';
  process.env.SMS_PROVIDER = 'mock';
  process.env.ADMIN_INIT_ACCOUNTS_JSON = JSON.stringify([
    { username: 'admin', password: 'test-admin-pass', role: 'admin', name: '系统管理员' },
    { username: 'qc', password: 'test-qc-pass', role: 'qc', name: '质检员' }
  ]);

  // eslint-disable-next-line global-require
  const { createApp } = require('../src/server/app');
  const app = createApp();

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const address = server.address();
      basePort = address.port;
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DB_FILE;
  delete process.env.STORAGE_ROOT;
  delete process.env.AUTH_SECRET;
  delete process.env.RATE_LIMIT_LOGIN_MAX;
  delete process.env.SMS_PROVIDER;
  delete process.env.ADMIN_INIT_ACCOUNTS_JSON;
});

test('POST /api/user/login should reject invalid phone', async () => {
  const res = await postJson('/api/user/login', { phone: '123' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_PHONE');
});

test('POST /api/user/login should login with valid phone', async () => {
  const res = await postJson('/api/user/login', { phone: '13800138000' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'success');
  assert.equal(res.body.data.phone, '13800138000');
  assert.ok(getSessionCookie(res).startsWith('user_session_id='));
});

test('POST /api/user/sms/send-code and /verify-code should create session', async () => {
  const sendRes = await postJson('/api/user/sms/send-code', { phone: '13800138002' });
  assert.equal(sendRes.status, 200);
  assert.equal(sendRes.body.status, 'success');
  assert.ok(sendRes.body.data.verification_code);
  assert.ok(sendRes.body.data.expires_in_seconds > 0);

  const verifyRes = await postJson('/api/user/sms/verify-code', {
    phone: '13800138002',
    code: sendRes.body.data.verification_code
  });
  assert.equal(verifyRes.status, 200);
  assert.equal(verifyRes.body.data.phone, '13800138002');
  assert.ok(getSessionCookie(verifyRes).startsWith('user_session_id='));
});

test('POST /api/user/sms/verify-code should return generic message on mismatch', async () => {
  const sendRes = await postJson('/api/user/sms/send-code', { phone: '13800138003' });
  assert.equal(sendRes.status, 200);
  const verifyRes = await postJson('/api/user/sms/verify-code', {
    phone: '13800138003',
    code: '000000'
  });
  assert.equal(verifyRes.status, 400);
  assert.equal(verifyRes.body.code, 'INVALID_VERIFY_CODE');
  assert.equal(verifyRes.body.message, '验证码错误或已过期，请重新获取');
});

test('POST /api/user/login should be disabled by default in production', async () => {
  const oldNodeEnv = process.env.NODE_ENV;
  const oldLegacy = process.env.USER_LEGACY_LOGIN_ENABLED;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.USER_LEGACY_LOGIN_ENABLED;
    const res = await postJson('/api/user/login', { phone: '13800138004' });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'LEGACY_LOGIN_DISABLED');
  } finally {
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldNodeEnv;
    if (oldLegacy === undefined) delete process.env.USER_LEGACY_LOGIN_ENABLED;
    else process.env.USER_LEGACY_LOGIN_ENABLED = oldLegacy;
  }
});

test('POST /api/user/sms/send-code should not expose verification code in production error response', async () => {
  const oldNodeEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    const res = await postJson('/api/user/sms/send-code', { phone: '13800138005' });
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'SMS_SERVICE_UNAVAILABLE');
    assert.equal(Object.hasOwn(res.body, 'verification_code'), false);
    assert.equal(Object.hasOwn(res.body.data || {}, 'verification_code'), false);
  } finally {
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldNodeEnv;
  }
});

test('GET /api/user/me should require session and return current user', async () => {
  const unauthorized = await getJson('/api/user/me');
  assert.equal(unauthorized.status, 401);

  const cookie = await loginUserAndGetCookie('13900139000');
  const meRes = await getJsonWithCookie('/api/user/me', cookie);
  assert.equal(meRes.status, 200);
  assert.equal(meRes.body.data.phone, '13900139000');
});

test('POST /api/user/logout should clear session and cookie', async () => {
  const cookie = await loginUserAndGetCookie('13700137000');
  const logoutRes = await postJsonWithCookie('/api/user/logout', {}, cookie);
  assert.equal(logoutRes.status, 200);
  assert.equal(logoutRes.body.data.logged_out, true);
  assert.ok(Array.isArray(logoutRes.headers['set-cookie']));
  assert.ok(logoutRes.headers['set-cookie'][0].includes('Max-Age=0'));
});

test('malformed Cookie header should not trigger 500', async () => {
  const res = await requestRaw('GET', '/api/user/me', {
    headers: {
      Cookie: 'user_session_id=%E0%A4%A'
    }
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'UNAUTHORIZED');
});

test('GET /api/user/records should return only current user activated records', async () => {
  const imageData = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZQ1EAAAAASUVORK5CYII=',
    'base64'
  );

  const uploaderCookie = await loginUserAndGetCookie('13600136000');
  const uploadRes = await postMultipartWithCookie('/api/upload', {
    fields: { qr_id: 'STAR0003' },
    files: [
      {
        fieldName: 'image',
        filename: 'mine.png',
        contentType: 'image/png',
        content: imageData
      }
    ]
  }, uploaderCookie);
  assert.equal(uploadRes.status, 200);

  const userACookie = uploaderCookie;
  const activateRes = await postJsonWithCookie('/api/qr/STAR0003/record', {
    content: 'my record',
    image_url: uploadRes.body.data.url,
    image_object_key: uploadRes.body.data.object_key
  }, userACookie);
  assert.equal(activateRes.status, 200);

  const userARecords = await getJsonWithCookie('/api/user/records', userACookie);
  assert.equal(userARecords.status, 200);
  assert.equal(userARecords.body.data.total, 1);
  assert.equal(userARecords.body.data.records[0].id, 'STAR0003');
  assert.ok(userARecords.body.data.records[0].image_url);

  const userADetail = await getJsonWithCookie('/api/user/records/STAR0003', userACookie);
  assert.equal(userADetail.status, 200);
  assert.equal(userADetail.body.data.id, 'STAR0003');
  assert.ok(userADetail.body.data.blockchain_hash);
  assert.ok(userADetail.body.data.manifest_hash);
  assert.equal(userADetail.body.data.blockchain_hash, userADetail.body.data.manifest_hash);
  assert.equal(typeof userADetail.body.data.chain_status_text, 'string');
  assert.ok(userADetail.body.data.image_url);
  assert.equal(typeof userADetail.body.data.brand_name, 'string');

  const userBCookie = await loginUserAndGetCookie('13500135000');
  const userBRecords = await getJsonWithCookie('/api/user/records', userBCookie);
  assert.equal(userBRecords.status, 200);
  assert.equal(userBRecords.body.data.total, 0);

  const userBDetail = await getJsonWithCookie('/api/user/records/STAR0003', userBCookie);
  assert.equal(userBDetail.status, 404);
  assert.equal(userBDetail.body.code, 'RECORD_NOT_FOUND');
});

test('frontend me.js should avoid innerHTML rendering for user content (basic XSS guard)', () => {
  const meJsPath = path.join(__dirname, '..', 'src', 'frontend', 'js', 'me.js');
  const content = fs.readFileSync(meJsPath, 'utf8');

  assert.equal(content.includes('recordsSection.innerHTML = records.map'), false);
  assert.equal(content.includes('content.textContent = summarizeContent(item.content)'), true);
});

test('frontend me-detail.js should read brand_name from record detail payload', () => {
  const detailJsPath = path.join(__dirname, '..', 'src', 'frontend', 'js', 'me-detail.js');
  const content = fs.readFileSync(detailJsPath, 'utf8');

  assert.equal(content.includes('record.brand_name ||'), true);
  assert.equal(content.includes('record.batch_brand_name ||'), false);
});

test('storage archive object keys should not escape local upload root', async () => {
  const {
    saveJsonObjectAtKey,
    readTextObjectAtKey
  } = require('../src/server/services/storageService');
  const saved = await saveJsonObjectAtKey({
    objectKey: 'indexes/../escape.json',
    data: { ok: true }
  });
  assert.equal(saved.object_key, 'indexes/item/escape.json');
  assert.equal(fs.existsSync(path.join(tmpDir, 'storage', 'public', 'uploads', 'indexes', 'item', 'escape.json')), true);
  assert.equal(await readTextObjectAtKey('indexes/missing.json'), '');
});

test('frontend api.js should abort stalled requests with a timeout message', () => {
  const apiJsPath = path.join(__dirname, '..', 'src', 'frontend', 'js', 'api.js');
  const content = fs.readFileSync(apiJsPath, 'utf8');

  assert.equal(content.includes('new AbortController()'), true);
  assert.equal(content.includes('REQUEST_TIMEOUT'), true);
  assert.equal(content.includes('signal: controller.signal'), true);
});

test('admin and qc pages should use timeout-protected fetch wrappers', () => {
  const adminJsPath = path.join(__dirname, '..', 'src', 'admin', 'js', 'admin.js');
  const qcJsPath = path.join(__dirname, '..', 'src', 'qc', 'js', 'qc.js');
  const adminContent = fs.readFileSync(adminJsPath, 'utf8');
  const qcContent = fs.readFileSync(qcJsPath, 'utf8');

  assert.equal(adminContent.includes('async function fetchWithTimeout'), true);
  assert.equal(adminContent.includes('请求超时，请检查网络后重试'), true);
  assert.equal(adminContent.includes('timeoutMs: EXPORT_TIMEOUT_MS'), true);
  assert.equal(qcContent.includes('async function fetchWithTimeout'), true);
  assert.equal(qcContent.includes('请求超时，请检查网络后重试'), true);
});

test('admin page should expose section navigation and miniapp content tools', () => {
  const adminHtmlPath = path.join(__dirname, '..', 'src', 'admin', 'index.html');
  const adminJsPath = path.join(__dirname, '..', 'src', 'admin', 'js', 'admin.js');
  const appJsPath = path.join(__dirname, '..', 'src', 'miniprogram', 'app.js');
  const appJsonPath = path.join(__dirname, '..', 'src', 'miniprogram', 'app.json');
  const homeJsPath = path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'home', 'home.js');
  const html = fs.readFileSync(adminHtmlPath, 'utf8');
  const js = fs.readFileSync(adminJsPath, 'utf8');
  const appJs = fs.readFileSync(appJsPath, 'utf8');
  const appJson = fs.readFileSync(appJsonPath, 'utf8');
  const homeJs = fs.readFileSync(homeJsPath, 'utf8');

  ['dashboard', 'bottles', 'records', 'miniappContent', 'products', 'operators', 'settings'].forEach((section) => {
    assert.equal(html.includes(`data-admin-section="${section}"`), true);
  });
  assert.equal(html.includes('id="miniappContentPanel"'), true);
  assert.equal(html.includes('id="systemPanel"'), true);
  assert.equal(html.includes('id="productSceneTags"'), true);
  assert.equal(js.includes('adminActiveSection'), true);
  assert.equal(js.includes('function activateAdminSection'), true);
  assert.equal(js.includes('async function loadContentRecords'), true);
  assert.equal(js.includes('async function loadMiniappContent'), true);
  assert.equal(js.includes('async function loadSystemStatus'), true);
  assert.equal(js.includes('scene_tags: getProductSceneTags()'), true);
  assert.equal(js.includes('Promise.all([loadDashboard(), loadBatches(), loadRecords(), loadOperators(), loadProducts()])'), false);
  assert.equal(appJs.includes("appName: '记在星上'"), true);
  assert.equal(appJson.includes('pages/project/project'), true);
  assert.equal(appJson.includes('"navigationBarTitleText": "记在星上"'), true);
  assert.equal(appJson.includes('"tabBar"'), true);
  assert.equal(appJson.includes('"text": "封存时光"'), true);
  assert.equal(appJson.includes('"text": "我的星星"'), true);
  assert.equal(homeJs.includes('/api/miniapp/content'), true);
});

test('user login pages should keep copy and expose miniapp-first login cues', () => {
  const registerHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'frontend', 'register.html'), 'utf8');
  const recordHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'frontend', 'record.html'), 'utf8');
  const h5MeJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'frontend', 'js', 'me.js'), 'utf8');
  const registerJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'frontend', 'js', 'register.js'), 'utf8');
  const frontendCss = fs.readFileSync(path.join(__dirname, '..', 'src', 'frontend', 'css', 'style.css'), 'utf8');
  const appWxss = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'app.wxss'), 'utf8');
  const bindPhoneWxml = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'bind-phone', 'bind-phone.wxml'), 'utf8');
  const bindPhoneCss = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'bind-phone', 'bind-phone.wxss'), 'utf8');
  const bindPhoneJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'bind-phone', 'bind-phone.js'), 'utf8');
  const recordWxml = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'record', 'record.wxml'), 'utf8');
  const recordWxss = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'record', 'record.wxss'), 'utf8');
  const recordJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'record', 'record.js'), 'utf8');
  const resultWxml = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'result', 'result.wxml'), 'utf8');
  const resultWxss = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'result', 'result.wxss'), 'utf8');
  const coCreateWxml = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'co-create', 'co-create.wxml'), 'utf8');
  const coCreateWxss = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'co-create', 'co-create.wxss'), 'utf8');
  const homeJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'home', 'home.js'), 'utf8');
  const homeWxml = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'home', 'home.wxml'), 'utf8');
  const homeWxss = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'home', 'home.wxss'), 'utf8');
  const productsJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'products', 'products.js'), 'utf8');
  const productsWxml = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'products', 'products.wxml'), 'utf8');
  const productsWxss = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'products', 'products.wxss'), 'utf8');
  const productDetailWxml = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'product-detail', 'product-detail.wxml'), 'utf8');
  const productDetailWxss = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'product-detail', 'product-detail.wxss'), 'utf8');
  const projectWxml = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'project', 'project.wxml'), 'utf8');
  const projectWxss = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'project', 'project.wxss'), 'utf8');
  const meWxml = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'me', 'me.wxml'), 'utf8');
  const meWxss = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'me', 'me.wxss'), 'utf8');
  const recordDetailWxml = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'record-detail', 'record-detail.wxml'), 'utf8');
  const recordDetailWxss = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'record-detail', 'record-detail.wxss'), 'utf8');

  assert.equal(registerHtml.includes('把此刻，记在这瓶酒里'), true);
  assert.equal(registerHtml.includes('让故事与时间一同酝酿，区块链存证，一经封存，不可篡改。'), true);
  assert.equal(registerHtml.includes('微信扫码会优先进入小程序'), true);
  assert.equal(registerHtml.includes('class="login-input sms-row auth-sms-row"'), true);
  assert.equal(registerHtml.includes('inputmode="numeric"'), true);
  assert.equal(registerJs.includes('MicroMessenger'), true);
  assert.equal(frontendCss.includes('.auth-sms-row'), true);
  assert.equal(frontendCss.includes('grid-template-columns: minmax(0, 1fr) 128px'), true);
  assert.equal(recordHtml.includes('confirm-preview-text'), true);
  assert.equal(recordHtml.includes('confirm-notice-card'), true);
  assert.equal(recordHtml.includes('将要保存的话'), true);
  assert.equal(recordHtml.includes('id="content" class="memory-input"'), true);
  assert.equal(recordHtml.includes('wrap="soft"'), true);
  assert.equal(frontendCss.includes('.memory-input'), true);
  assert.equal(frontendCss.includes('word-break: normal'), true);
  assert.equal(frontendCss.includes('overflow-wrap: break-word'), true);
  assert.equal(frontendCss.includes('word-wrap: break-word'), true);
  assert.equal(frontendCss.includes('font-family: var(--font-sans)'), true);
  const memoryInputCss = frontendCss.match(/\.memory-input\s*\{[\s\S]*?\}/)?.[0] || '';
  assert.equal(memoryInputCss.includes('overflow-wrap: anywhere'), false);
  assert.equal(frontendCss.includes('overflow-wrap: anywhere'), true);
  assert.equal(frontendCss.includes('.record-summary'), true);
  assert.equal(frontendCss.includes('max-height: min(68vh, 620px)'), true);
  assert.equal(h5MeJs.includes('function summarizeContent'), true);
  assert.equal(h5MeJs.includes('record-content record-summary'), true);
  assert.equal(bindPhoneWxml.includes('<view class="hero-title">星星在闪</view>'), true);
  assert.equal(bindPhoneWxml.includes('用微信快速确认身份，继续记录这瓶酒的故事。'), true);
  assert.equal(bindPhoneWxml.includes('<text class="wechat-mark">微信</text>'), true);
  assert.equal(bindPhoneWxml.includes('<text class="wechat-login-text">手机号一键登录</text>'), true);
  assert.equal(bindPhoneWxml.includes('open-type="getPhoneNumber"'), true);
  assert.equal(bindPhoneCss.includes('white-space: nowrap'), true);
  assert.equal(bindPhoneCss.includes('width: 460rpx'), true);
  assert.equal(bindPhoneJs.includes('event.detail && event.detail.code'), true);
  assert.equal(bindPhoneJs.includes('encryptedData'), false);
  assert.equal(recordWxml.includes('星星在闪 · 记在星上'), false);
  assert.equal(recordWxml.includes('把这一刻，记在这瓶酒里'), true);
  assert.equal(recordWxml.includes('✦ 区块链存证'), true);
  assert.equal(recordWxml.includes('NFT凭证'), false);
  assert.equal(recordWxml.includes('选一张照片，写一句话，以后随时能看到。'), true);
  const recordTitleIndex = recordWxml.indexOf('把这一刻，记在这瓶酒里');
  const recordSubtitleIndex = recordWxml.indexOf('选一张照片，写一句话，以后随时能看到。');
  const recordTrustIndex = recordWxml.indexOf('✦ 区块链存证');
  assert.equal(recordTitleIndex < recordSubtitleIndex, true);
  assert.equal(recordSubtitleIndex < recordTrustIndex, true);
  assert.equal(recordWxml.includes('永久记在这瓶酒里'), false);
  assert.equal(recordWxml.includes('星星ID:'), true);
  assert.equal(recordWxml.includes('写下想记住的话'), true);
  assert.equal(recordWxml.includes('这一刻，会成为这瓶酒的记忆'), false);
  assert.equal(recordWxml.includes('保存后，扫码即可查看这条记录。'), true);
  assert.equal(recordWxml.includes('扫码可查看'), false);
  assert.equal(recordWxml.includes('class="trust-tag"'), false);
  assert.equal(recordWxml.includes('bindtap="chooseImage"'), true);
  assert.equal(recordWxml.includes('bindinput="onContentInput"'), true);
  assert.equal(recordWxml.includes('class="textarea-shell"'), true);
  assert.equal(recordWxml.includes('cursor-spacing="80"'), true);
  assert.equal(recordWxml.includes('auto-height'), false);
  assert.equal(recordWxml.includes('radio-group class="mode-cards" bindchange="onModeChange"'), true);
  assert.equal(recordWxml.includes('class="mode-indicator"'), true);
  assert.equal(recordWxml.includes('直接保存'), true);
  assert.equal(recordWxml.includes('直接封存'), false);
  assert.equal(recordWxml.includes('value="direct"'), true);
  assert.equal(recordWxml.includes('value="co_create"'), true);
  assert.equal(recordWxml.includes('wx:if="{{showBrandSection}}"'), true);
  assert.equal(recordWxml.includes('checkbox-group bindchange="onBrandDisclosureChange"'), true);
  assert.equal(recordWxml.includes('显示酒的品牌信息'), true);
  assert.equal(recordWxml.includes('{{brandPreviewText}}'), true);
  assert.equal(recordWxml.includes('bindtap="submitRecord"'), true);
  assert.equal(recordWxml.includes('mode="aspectFit"'), true);
  assert.equal(recordWxml.includes('style="height: {{previewHeight}}rpx;"'), true);
  assert.equal(recordWxml.includes('mode="aspectFill"'), false);
  assert.equal(recordWxml.includes('class="mode-row"'), false);
  assert.equal(recordWxss.includes('env(safe-area-inset-bottom)'), true);
  assert.equal(recordWxss.includes('padding-bottom: calc(160rpx + env(safe-area-inset-bottom))'), true);
  assert.equal(recordWxss.includes('grid-template-columns: 1fr'), true);
  assert.equal(recordWxss.includes('"Songti SC", STSong, serif'), true);
  assert.equal(recordWxss.includes('-webkit-backdrop-filter: blur(16px)'), true);
  assert.equal(recordWxss.includes('backdrop-filter: blur(16px)'), true);
  assert.equal(recordWxss.includes('background: rgba(255, 255, 255, .04)'), true);
  assert.equal(recordWxss.includes('min-height: 280rpx'), true);
  assert.equal(recordWxss.includes('2rpx dashed rgba(212, 175, 55, .5)'), true);
  assert.equal(recordWxss.includes('min-height: 116rpx'), false);
  assert.equal(recordWxss.includes('color: rgba(255, 255, 255, .74)'), true);
  assert.equal(recordWxss.includes('.textarea-shell'), true);
  assert.equal(recordWxss.includes('position: absolute'), true);
  assert.equal(recordWxss.includes('right: 24rpx'), true);
  assert.equal(recordWxss.includes('bottom: 20rpx'), true);
  assert.equal(recordWxss.includes('min-height: 180rpx'), true);
  assert.equal(recordWxss.includes('padding: 28rpx 22rpx'), true);
  assert.equal(recordWxss.includes('box-shadow: 0 12rpx 24rpx rgba(212, 175, 55, .25)'), true);
  assert.equal(recordWxss.includes('.count-row'), true);
  assert.equal(recordWxss.includes('font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace'), true);
  assert.equal(recordJs.includes('wx.getImageInfo'), true);
  assert.equal(recordJs.includes('calculatePreviewHeight'), true);
  assert.equal(recordJs.includes('showBrandSection'), true);
  assert.equal(recordJs.includes('onBrandDisclosureChange'), true);
  assert.equal(recordJs.includes('show_brand_disclosure'), true);
  assert.equal(resultWxml.includes('brand-disclosure-line'), true);
  assert.equal(recordDetailWxml.includes('brand-disclosure-line'), true);
  assert.equal(appWxss.includes('radial-gradient(circle at 12% 0%'), true);
  assert.equal(appWxss.includes('padding-bottom: calc(112rpx + env(safe-area-inset-bottom))'), true);
  assert.equal(appWxss.includes('background: rgba(255, 255, 255, .04)'), true);
  assert.equal(appWxss.includes('-webkit-backdrop-filter: blur(16px)'), true);
  assert.equal(appWxss.includes('backdrop-filter: blur(16px)'), true);
  assert.equal(appWxss.includes('.btn::after'), true);
  assert.equal(appWxss.includes('background: #d4af37'), true);
  assert.equal(resultWxml.includes('保存成功'), true);
  assert.equal(resultWxml.includes('记在星上，闪到永远'), true);
  assert.equal(resultWxml.includes('open-type="share"'), true);
  assert.equal(resultWxml.includes('bindtap="goMe"'), true);
  assert.equal(resultWxml.includes('bindtap="toggleHash"'), true);
  assert.equal(resultWxss.includes('"Songti SC", STSong, serif'), true);
  assert.equal(resultWxss.includes('-webkit-backdrop-filter: blur(16px)'), true);
  assert.equal(resultWxss.includes('font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace'), true);
  assert.equal(recordDetailWxml.includes('记录详情'), true);
  assert.equal(recordDetailWxss.includes('"Songti SC", STSong, serif'), true);
  assert.equal(recordDetailWxss.includes('-webkit-backdrop-filter: blur(16px)'), true);
  assert.equal(coCreateWxml.includes('这瓶酒正在共创中'), true);
  assert.equal(coCreateWxml.includes('bindtap="submitComment"'), true);
  assert.equal(coCreateWxml.includes('bindtap="finalize"'), true);
  assert.equal(coCreateWxml.includes('bindtap="deleteComment"'), true);
  assert.equal(coCreateWxss.includes('"Songti SC", STSong, serif'), true);
  assert.equal(coCreateWxss.includes('-webkit-backdrop-filter: blur(16px)'), true);
  assert.equal(homeWxml.includes('bindtap="scanCode"'), true);
  assert.equal(homeWxml.includes('bindtap="goProject"'), true);
  assert.equal(homeWxml.includes('bindtap="goProducts"'), true);
  assert.equal(homeWxml.includes('bindtap="copyConsultLink"'), true);
  assert.equal(homeWxml.includes('bindtap="goMe"'), true);
  assert.equal(homeWxml.includes('bindtap="focusScenes"'), true);
  assert.equal(homeWxml.includes('bindtap="goSceneProducts"'), true);
  assert.equal(homeWxml.includes('class="home-brand-mark"'), true);
  assert.equal(homeWxml.includes('一瓶酒'), true);
  assert.equal(homeWxml.includes('一张照片'), true);
  assert.equal(homeWxml.includes('一句话'), true);
  assert.equal(homeWxml.includes('封存这一刻'), true);
  assert.equal(homeWxml.includes('已有酒瓶，扫码记录'), true);
  assert.equal(homeWxml.includes('class="home-section home-scene-section"'), true);
  assert.equal(homeJs.includes("key: 'lover'"), true);
  assert.equal(homeJs.includes("key: 'elder'"), true);
  assert.equal(homeJs.includes("key: 'coming_of_age'"), true);
  assert.equal(homeJs.includes("key: 'wedding'"), true);
  assert.equal(homeJs.includes("key: 'free'"), true);
  assert.equal(homeWxml.includes('class="home-section home-commerce-section"'), true);
  assert.equal(homeWxml.includes('class="home-section home-trust-section"'), true);
  assert.equal(homeWxml.includes('区块链存证'), true);
  assert.equal(homeWxml.includes('NFT凭证'), false);
  assert.equal(homeWxml.includes('链上存证'), true);
  assert.equal(homeWxml.includes('封存后可查看'), true);
  assert.equal(homeWxml.includes('订单'), false);
  assert.equal(homeWxml.includes('支付'), false);
  assert.equal(homeWxml.includes('购物车'), false);
  assert.equal(homeWxml.includes('class="btn home-primary-cta"'), true);
  assert.equal(homeWxss.includes('.home-brand-star'), true);
  assert.equal(homeWxss.includes('.home-scene-grid'), true);
  assert.equal(homeWxss.includes('.home-commerce-actions'), true);
  assert.equal(homeWxss.includes('box-shadow: 0 18rpx 42rpx'), true);
  assert.equal(productsWxml.includes('封存时光'), true);
  assert.equal(productsJs.includes("label: '恋人'"), true);
  assert.equal(productsJs.includes("label: '长辈'"), true);
  assert.equal(productsJs.includes("label: '成人礼'"), true);
  assert.equal(productsJs.includes("label: '婚礼'"), true);
  assert.equal(productsJs.includes("label: '随心'"), true);
  assert.equal(productsWxml.includes('bindtap="changeScene"'), true);
  assert.equal(productsWxml.includes('bindtap="openProduct"'), true);
  assert.equal(productsWxml.includes('class="product-list"'), true);
  assert.equal(productsWxml.includes('class="meta state-card"'), true);
  assert.equal(productsWxml.includes('订单'), false);
  assert.equal(productsWxml.includes('支付'), false);
  assert.equal(productsWxml.includes('购物车'), false);
  assert.equal(productsWxss.includes('.products-hero'), true);
  assert.equal(productsWxss.includes('box-shadow: 0 16rpx 36rpx'), true);
  assert.equal(productDetailWxml.includes('去快团团购买'), true);
  assert.equal(productDetailWxml.includes('点击后复制购买链接，请在微信中打开。'), true);
  assert.equal(productDetailWxml.includes('bindtap="copyBuyLink"'), true);
  assert.equal(productDetailWxml.includes('class="card product-detail-panel"'), true);
  assert.equal(productDetailWxml.includes('订单'), false);
  assert.equal(productDetailWxml.includes('微信支付'), false);
  assert.equal(productDetailWxml.includes('购物车'), false);
  assert.equal(productDetailWxss.includes('height: 480rpx'), true);
  assert.equal(projectWxml.includes('{{content.project_title}}'), true);
  assert.equal(projectWxml.includes('class="card project-card project-card-primary"'), true);
  assert.equal(projectWxml.includes('class="card project-card project-card-secondary"'), true);
  assert.equal(projectWxml.includes('class="meta state-card"'), true);
  assert.equal(projectWxss.includes('line-height: 1.82'), true);
  assert.equal(meWxml.includes('我的记录'), true);
  assert.equal(meWxml.includes('bindtap="openRecord"'), true);
  assert.equal(meWxml.includes('class="record-meta-group"'), true);
  assert.equal(meWxml.includes('class="meta state-card"'), true);
  assert.equal(meWxss.includes('.record-meta-group'), true);
  assert.equal(meWxss.includes('-webkit-line-clamp: 2'), true);
});

test('POST /api/user/logout should clear cookie with same SameSite policy as session cookie', async () => {
  const oldSameSite = process.env.USER_SESSION_SAMESITE;
  process.env.USER_SESSION_SAMESITE = 'None';
  try {
    const cookie = await loginUserAndGetCookie('13800138009');
    const logoutRes = await postJsonWithCookie('/api/user/logout', {}, cookie);
    assert.equal(logoutRes.status, 200);
    assert.ok(Array.isArray(logoutRes.headers['set-cookie']));
    assert.ok(logoutRes.headers['set-cookie'][0].includes('SameSite=None'));
  } finally {
    if (oldSameSite === undefined) delete process.env.USER_SESSION_SAMESITE;
    else process.env.USER_SESSION_SAMESITE = oldSameSite;
  }
});

test('POST /api/upload should reject unauthenticated request', async () => {
  const response = await postMultipart('/api/upload', {
    files: [
      {
        fieldName: 'image',
        filename: 'unauth.png',
        contentType: 'image/png',
        content: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZQ1EAAAAASUVORK5CYII=', 'base64')
      }
    ]
  });

  assert.equal(response.status, 401);
  assert.equal(response.body.code, 'UNAUTHORIZED');
});

test('POST /api/upload should reject non-image file', async () => {
  const cookie = await loginUserAndGetCookie('13800138000');
  const response = await postMultipartWithCookie('/api/upload', {
    files: [
      {
        fieldName: 'image',
        filename: 'not-image.txt',
        contentType: 'text/plain',
        content: 'not-image'
      }
    ]
  }, cookie);

  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'UPLOAD_FAILED');
});

test('POST /api/qr/:id/record should validate image_url required', async () => {
  const cookie = await loginUserAndGetCookie('13800138000');
  const res = await postJsonWithCookie('/api/qr/STAR0001/record', { content: 'hello' }, cookie);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
});

test('POST /api/admin/login should reject wrong credentials', async () => {
  const res = await postJson('/api/admin/login', { username: 'admin', password: 'wrong-pass' });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'INVALID_CREDENTIALS');
});

test('POST /api/admin/login should return token for valid credentials', async () => {
  const res = await postJson('/api/admin/login', { username: 'admin', password: 'test-admin-pass' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'success');
  assert.ok(res.body.data.token);
});

test('GET /api/admin/dashboard should work with valid token', async () => {
  const login = await postJson('/api/admin/login', { username: 'admin', password: 'test-admin-pass' });
  const token = login.body.data.token;

  const res = await getJson('/api/admin/dashboard', token);
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'success');
  assert.equal(typeof res.body.data.total_co_creating, 'number');
  assert.equal(typeof res.body.data.today_new_records, 'number');
  assert.equal(typeof res.body.data.published_products, 'number');
  assert.equal(typeof res.body.data.hidden_records, 'number');
  assert.equal(typeof res.body.data.today_quality_abnormal, 'number');

  const generateRes = await postJson('/api/admin/qr/generate', {
    prefix: 'DAY',
    count: 1
  }, token);
  assert.equal(generateRes.status, 200);

  const today = localDateKey();
  const datedRes = await getJson(`/api/admin/dashboard?date_from=${today}&date_to=${today}`, token);
  assert.equal(datedRes.status, 200);
  assert.ok(datedRes.body.data.period_issued >= 1);
});

test('admin miniapp content should update public miniapp content', async () => {
  const login = await postJson('/api/admin/login', { username: 'admin', password: 'test-admin-pass' });
  const token = login.body.data.token;

  const defaultRes = await getJson('/api/admin/miniapp-content', token);
  assert.equal(defaultRes.status, 200);
  assert.equal(defaultRes.body.data.home_title, '把此刻，记在这瓶酒里');

  const updateRes = await postJson('/api/admin/miniapp-content', {
    home_title: '记在星上测试',
    home_subtitle: '测试副标题',
    home_banner_image: '/uploads/banner.jpg',
    project_title: '项目说明测试',
    project_body: '项目正文',
    brand_story_title: '品牌故事测试',
    brand_story_body: '品牌正文',
    consult_label: '复制咨询链接',
    consult_url: 'https://ktt.example.com/shop',
    share_title: '分享标题',
    share_description: '分享描述'
  }, token);
  assert.equal(updateRes.status, 200);
  assert.equal(updateRes.body.data.updated_by, 'admin');

  const publicRes = await getJson('/api/miniapp/content');
  assert.equal(publicRes.status, 200);
  assert.equal(publicRes.body.data.home_title, '记在星上测试');
  assert.equal(publicRes.body.data.consult_url, 'https://ktt.example.com/shop');
  assert.equal(Object.hasOwn(publicRes.body.data, 'updated_by'), false);

  const invalidRes = await postJson('/api/admin/miniapp-content', {
    consult_url: 'javascript:alert(1)'
  }, token);
  assert.equal(invalidRes.status, 400);
  assert.equal(invalidRes.body.code, 'VALIDATION_ERROR');
});

test('admin system status should not leak secrets', async () => {
  const oldAppId = process.env.WECHAT_MINIAPP_APPID;
  const oldSecret = process.env.WECHAT_MINIAPP_SECRET;
  const oldAvataKey = process.env.AVATA_API_KEY;
  const oldAvataSecret = process.env.AVATA_API_SECRET;
  process.env.WECHAT_MINIAPP_APPID = 'wx-test-appid';
  process.env.WECHAT_MINIAPP_SECRET = 'super-secret-value';
  process.env.AVATA_API_KEY = 'avata-test-key';
  process.env.AVATA_API_SECRET = 'avata-super-secret-value';

  try {
    const login = await postJson('/api/admin/login', { username: 'admin', password: 'test-admin-pass' });
    const token = login.body.data.token;
    const res = await getJson('/api/admin/system-status', token);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.miniapp.configured, true);
    assert.equal(res.raw.includes('super-secret-value'), false);
    assert.equal(res.raw.includes('avata-super-secret-value'), false);
    assert.equal(Object.hasOwn(res.body.data.miniapp, 'secret'), false);
  assert.equal(res.body.data.chain.configured, true);
  assert.equal(res.body.data.archive.configured, true);
  assert.equal(res.body.data.archive.records_index_path, 'indexes/records.jsonl');
  assert.equal(res.raw.includes('AVATA_API_SECRET'), false);
  assert.equal(Object.hasOwn(res.body.data.chain, 'api_secret'), false);
  } finally {
    if (oldAppId === undefined) delete process.env.WECHAT_MINIAPP_APPID;
    else process.env.WECHAT_MINIAPP_APPID = oldAppId;
    if (oldSecret === undefined) delete process.env.WECHAT_MINIAPP_SECRET;
    else process.env.WECHAT_MINIAPP_SECRET = oldSecret;
    if (oldAvataKey === undefined) delete process.env.AVATA_API_KEY;
    else process.env.AVATA_API_KEY = oldAvataKey;
    if (oldAvataSecret === undefined) delete process.env.AVATA_API_SECRET;
    else process.env.AVATA_API_SECRET = oldAvataSecret;
  }
});

test('POST /api/admin/qr/generate should create issued and unactivated QR ids', async () => {
  const login = await postJson('/api/admin/login', { username: 'admin', password: 'test-admin-pass' });
  const token = login.body.data.token;

  const generateRes = await postJson('/api/admin/qr/generate', {
    prefix: 'ab9',
    count: 3,
    batch_id: 'BATCH_TEST'
  }, token);

  assert.equal(generateRes.status, 200);
  assert.deepEqual(generateRes.body.data.ids, ['AB900001', 'AB900002', 'AB900003']);

  const generateMoreRes = await postJson('/api/admin/qr/generate', {
    prefix: 'AB9',
    count: 2,
    batch_id: 'BATCH_TEST'
  }, token);

  assert.equal(generateMoreRes.status, 200);
  assert.deepEqual(generateMoreRes.body.data.ids, ['AB900004', 'AB900005']);

  const recordsRes = await getJson('/api/admin/records?id_prefix=AB9&limit=10', token);
  assert.equal(recordsRes.status, 200);
  const generated = recordsRes.body.data.records.filter((item) => item.id.startsWith('AB9'));
  assert.equal(generated.length, 5);
  generated.forEach((item) => {
    assert.equal(item.issue_status, 'issued');
    assert.equal(item.activation_status, 'unactivated');
    assert.equal(item.batch_id, 'BATCH_TEST');
  });
});

test('POST /api/qr/:id/record should persist batch disclosure snapshot when enabled', async () => {
  const adminLogin = await postJson('/api/admin/login', { username: 'admin', password: 'test-admin-pass' });
  const adminToken = adminLogin.body.data.token;

  const batchRes = await postJson('/api/admin/batches', {
    name: 'D3 Batch',
    brand_name: 'BrandX',
    brand_disclosure_text: '品牌披露文案-D3',
    brand_disclosure_default: true
  }, adminToken);
  assert.equal(batchRes.status, 200);
  const batchId = batchRes.body.data.id;

  const genRes = await postJson('/api/admin/qr/generate', {
    prefix: 'D3X',
    count: 1,
    batch_id: batchId
  }, adminToken);
  assert.equal(genRes.status, 200);
  const qrId = genRes.body.data.ids[0];

  const userCookie = await loginUserAndGetCookie('13800138000');
  const uploadRes = await postMultipartWithCookie('/api/upload', {
    fields: { qr_id: qrId },
    files: [
      {
        fieldName: 'image',
        filename: 'd3.png',
        contentType: 'image/png',
        content: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZQ1EAAAAASUVORK5CYII=', 'base64')
      }
    ]
  }, userCookie);
  assert.equal(uploadRes.status, 200);

  const recordRes = await postJsonWithCookie(`/api/qr/${encodeURIComponent(qrId)}/record`, {
    content: 'd3 test',
    image_url: uploadRes.body.data.url,
    image_object_key: uploadRes.body.data.object_key,
    show_brand_disclosure: true
  }, userCookie);

  assert.equal(recordRes.status, 200);
  assert.equal(recordRes.body.data.show_brand_disclosure, true);
  assert.equal(recordRes.body.data.brand_disclosure_text_snapshot, '品牌披露文案-D3');
});

test('POST /api/qr/:id/record should NOT fallback to note when brand_disclosure_text is empty', async () => {
  const adminLogin = await postJson('/api/admin/login', { username: 'admin', password: 'test-admin-pass' });
  const adminToken = adminLogin.body.data.token;

  // 批次只有 note，没有 brand_disclosure_text
  const batchRes = await postJson('/api/admin/batches', {
    name: 'D3 Batch No Disclosure',
    brand_name: 'BrandY',
    note: '这是备注，不是品牌披露'
  }, adminToken);
  assert.equal(batchRes.status, 200);
  const batchId = batchRes.body.data.id;

  const genRes = await postJson('/api/admin/qr/generate', {
    prefix: 'D3Y',
    count: 1,
    batch_id: batchId
  }, adminToken);
  assert.equal(genRes.status, 200);
  const qrId = genRes.body.data.ids[0];

  const userCookie = await loginUserAndGetCookie('13800138001');
  const uploadRes = await postMultipartWithCookie('/api/upload', {
    fields: { qr_id: qrId },
    files: [
      {
        fieldName: 'image',
        filename: 'd3y.png',
        contentType: 'image/png',
        content: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZQ1EAAAAASUVORK5CYII=', 'base64')
      }
    ]
  }, userCookie);
  assert.equal(uploadRes.status, 200);
  const recordRes = await postJsonWithCookie(`/api/qr/${encodeURIComponent(qrId)}/record`, {
    content: 'd3y test',
    image_url: uploadRes.body.data.url,
    image_object_key: uploadRes.body.data.object_key,
    show_brand_disclosure: true
  }, userCookie);

  // brand_disclosure_text 为空时，即使开关打开，快照也必须是空字符串，不能 fallback 到 note
  assert.equal(recordRes.status, 200);
  assert.equal(recordRes.body.data.show_brand_disclosure, true);
  assert.equal(recordRes.body.data.brand_disclosure_text_snapshot, '');
});

test('POST /api/admin/qr/generate should validate prefix format', async () => {
  const login = await postJson('/api/admin/login', { username: 'admin', password: 'test-admin-pass' });
  const token = login.body.data.token;

  const res = await postJson('/api/admin/qr/generate', {
    prefix: 'ab-9',
    count: 1
  }, token);

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
});

test('GET /api/admin/dashboard should reject invalid token', async () => {
  const res = await getJson('/api/admin/dashboard', 'bad.token.value');
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'UNAUTHORIZED');
});

test('POST /api/qc/check should reject unauthorized request', async () => {
  const res = await postJson('/api/qc/check', { qr_id: 'STAR0001' });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'UNAUTHORIZED');
});

test('GET /api/admin/dashboard should reject qc role token', async () => {
  const qcLogin = await postJson('/api/admin/login', { username: 'qc', password: 'test-qc-pass' });
  assert.equal(qcLogin.status, 200);
  const qcToken = qcLogin.body.data.token;

  const res = await getJson('/api/admin/dashboard', qcToken);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'FORBIDDEN');
});

test('GET /api/qc/logs should reject missing token', async () => {
  const res = await getJson('/api/qc/logs');
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'UNAUTHORIZED');
});

test('miniapp auth should login, reject bad token, and bind phone', async () => {
  const loginRes = await postJson('/api/miniapp/auth/login', { code: 'mini-auth' });
  assert.equal(loginRes.status, 200);
  assert.equal(loginRes.body.data.phone_bound, false);
  assert.ok(loginRes.body.data.token);

  const badTokenRes = await getJson('/api/miniapp/user/records', 'bad.token.value');
  assert.equal(badTokenRes.status, 401);
  assert.equal(badTokenRes.body.code, 'UNAUTHORIZED');

  const bindRes = await postJson('/api/miniapp/auth/bind-phone', {
    code: '13888889999'
  }, loginRes.body.data.token);
  assert.equal(bindRes.status, 200);
  assert.equal(bindRes.body.data.phone_bound, true);
  assert.equal(bindRes.body.data.phone, '13888889999');

  const unauthedBind = await postJson('/api/miniapp/auth/bind-phone', { code: '13888889999' });
  assert.equal(unauthedBind.status, 401);
});

test('admin product management should expose only published products to miniapp', async () => {
  const login = await postJson('/api/admin/login', { username: 'admin', password: 'test-admin-pass' });
  const token = login.body.data.token;

  const publishedRes = await postJson('/api/admin/products', {
    title: '成年礼星酒',
    subtitle: '把祝福记在酒里',
    cover_image: '/uploads/product.jpg',
    images: ['/uploads/detail-1.jpg'],
    price_text: '¥399 / 礼盒装',
    description: '适合成年礼和纪念日。',
    buy_url: 'https://ktt.example.com/buy/1',
    status: 'published',
    scene_tags: ['coming_of_age', 'wedding'],
    sort_order: 1
  }, token);
  assert.equal(publishedRes.status, 200);
  assert.deepEqual(publishedRes.body.data.scene_tags, ['coming_of_age', 'wedding']);
  const productId = publishedRes.body.data.id;

  const invalidUrlRes = await postJson('/api/admin/products', {
    title: '错误链接商品',
    buy_url: 'javascript:alert(1)'
  }, token);
  assert.equal(invalidUrlRes.status, 400);
  assert.equal(invalidUrlRes.body.code, 'VALIDATION_ERROR');

  const draftRes = await postJson('/api/admin/products', {
    title: '隐藏商品',
    status: 'draft',
    sort_order: 2
  }, token);
  assert.equal(draftRes.status, 200);

  const adminList = await getJson('/api/admin/products', token);
  assert.equal(adminList.status, 200);
  assert.ok(adminList.body.data.products.some((item) => item.id === productId));
  assert.deepEqual(adminList.body.data.products.find((item) => item.id === productId).scene_tags, ['coming_of_age', 'wedding']);

  const miniList = await getJson('/api/miniapp/products');
  assert.equal(miniList.status, 200);
  assert.equal(miniList.body.data.products.some((item) => item.id === productId), true);
  assert.equal(miniList.body.data.products.some((item) => item.title === '隐藏商品'), false);
  assert.deepEqual(miniList.body.data.products.find((item) => item.id === productId).scene_tags, ['coming_of_age', 'wedding']);

  const detail = await getJson(`/api/miniapp/products/${productId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.buy_type, 'copy_link');
  assert.equal(detail.body.data.buy_url, 'https://ktt.example.com/buy/1');
  assert.deepEqual(detail.body.data.scene_tags, ['coming_of_age', 'wedding']);
});

test('miniapp upload and record flow should require bound phone and reject duplicate activation', async () => {
  const adminLogin = await postJson('/api/admin/login', { username: 'admin', password: 'test-admin-pass' });
  const adminToken = adminLogin.body.data.token;
  const batchRes = await postJson('/api/admin/batches', {
    name: 'Miniapp Brand Batch',
    brand_name: '星酒品牌',
    brand_disclosure_text: '品牌露出文案-MINI',
    brand_disclosure_default: true
  }, adminToken);
  assert.equal(batchRes.status, 200);
  const genRes = await postJson('/api/admin/qr/generate', {
    prefix: 'MQR',
    count: 1,
    batch_id: batchRes.body.data.id
  }, adminToken);
  assert.equal(genRes.status, 200);
  const accessToken = genRes.body.data.records[0].qr_access_token;

  const loginToken = await loginMiniappAndGetToken('mini-record-unbound');
  const unboundRecord = await postJson(`/api/miniapp/qr/${accessToken}/record`, {
    content: 'unbound',
    image_object_key: 'demo.jpg'
  }, loginToken);
  assert.equal(unboundRecord.status, 403);
  assert.equal(unboundRecord.body.code, 'PHONE_NOT_BOUND');

  const token = await loginMiniappBindPhoneAndGetToken({
    code: 'mini-record-bound',
    phone: '13877770001'
  });
  const imageData = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZQ1EAAAAASUVORK5CYII=',
    'base64'
  );
  const uploadRes = await postMultipart('/api/miniapp/upload', {
    fields: { qr_id: 'MQR00001' },
    files: [
      {
        fieldName: 'image',
        filename: 'mini.png',
        contentType: 'image/png',
        content: imageData
      }
    ]
  }, token);
  assert.equal(uploadRes.status, 200);
  assert.ok(uploadRes.body.data.object_key);

  const statusRes = await getJson(`/api/miniapp/qr/${accessToken}`, token);
  assert.equal(statusRes.status, 200);
  assert.equal(statusRes.body.data.batch_brand_name, '星酒品牌');
  assert.equal(statusRes.body.data.batch_brand_disclosure_text, '品牌露出文案-MINI');
  assert.equal(statusRes.body.data.batch_brand_disclosure_default, true);

  const recordRes = await postJson(`/api/miniapp/qr/${accessToken}/record`, {
    content: '小程序记录',
    image_url: uploadRes.body.data.url,
    image_object_key: uploadRes.body.data.object_key,
    show_brand_disclosure: true
  }, token);
  assert.equal(recordRes.status, 200);
  assert.equal(recordRes.body.data.activation_status, 'activated');
  assert.equal(recordRes.body.data.show_brand_disclosure, true);
  assert.equal(recordRes.body.data.brand_disclosure_text_snapshot, '品牌露出文案-MINI');
  assert.equal(recordRes.body.data.brand_name, '星酒品牌');
  assert.ok(recordRes.body.data.blockchain_hash);
  assert.ok(recordRes.body.data.manifest_hash);
  assert.equal(recordRes.body.data.blockchain_hash, recordRes.body.data.manifest_hash);
  assert.ok(['manifest_ready', 'submitting', 'submitted', 'confirmed', 'failed'].includes(recordRes.body.data.chain_status));
  assert.equal(typeof recordRes.body.data.chain_status_text, 'string');

  const detailRes = await getJson('/api/miniapp/user/records/MQR00001', token);
  assert.equal(detailRes.status, 200);
  assert.equal(detailRes.body.data.show_brand_disclosure, true);
  assert.equal(detailRes.body.data.brand_disclosure_text_snapshot, '品牌露出文案-MINI');
  assert.equal(detailRes.body.data.brand_name, '星酒品牌');
  assert.ok(detailRes.body.data.manifest_hash);
  assert.equal(Object.prototype.hasOwnProperty.call(detailRes.body.data, 'chain_operation_id'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(detailRes.body.data, 'manifest_object_key'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(detailRes.body.data, 'chain_last_error'), false);

  const adminRecordList = await getJson('/api/admin/records?id_prefix=MQR&limit=5', adminToken);
  assert.equal(adminRecordList.status, 200);
  const adminRecord = adminRecordList.body.data.records.find((item) => item.id === 'MQR00001');
  assert.ok(adminRecord.chain_operation_id);
  assert.equal(adminRecord.manifest_object_key, 'stars/MQR00001/record_manifest.json');
  assert.equal(adminRecord.archive_index_object_key, 'indexes/by-star/MQR00001.json');
  assert.equal(adminRecord.archive_status, 'ready');
  assert.ok(adminRecord.image_sha256);
  const archiveManifestPath = path.join(tmpDir, 'storage', 'public', 'uploads', 'stars', 'MQR00001', 'record_manifest.json');
  const archiveIndexPath = path.join(tmpDir, 'storage', 'public', 'uploads', 'indexes', 'by-star', 'MQR00001.json');
  const recordsIndexPath = path.join(tmpDir, 'storage', 'public', 'uploads', 'indexes', 'records.jsonl');
  assert.equal(fs.existsSync(archiveManifestPath), true);
  assert.equal(fs.existsSync(archiveIndexPath), true);
  assert.equal(fs.existsSync(recordsIndexPath), true);
  const archiveManifest = JSON.parse(fs.readFileSync(archiveManifestPath, 'utf8'));
  const archiveSerialized = JSON.stringify(archiveManifest);
  assert.equal(archiveManifest.manifest_hash, adminRecord.manifest_hash);
  assert.equal(archiveManifest.sealed_manifest.record.image.sha256, adminRecord.image_sha256);
  assert.equal(archiveSerialized.includes('13877770001'), false);
  assert.equal(archiveSerialized.includes('mini-record-bound'), false);
  const queryRes = await postJson('/api/admin/records/MQR00001/chain/query', {}, adminToken);
  assert.equal(queryRes.status, 200);
  assert.ok(['submitted', 'confirmed', 'failed'].includes(queryRes.body.data.chain_status));
  const rebuildArchiveRes = await postJson('/api/admin/records/MQR00001/archive/rebuild', {}, adminToken);
  assert.equal(rebuildArchiveRes.status, 200);
  assert.equal(rebuildArchiveRes.body.data.archive_status, 'ready');
  const callbackRes = await postJson('/api/chain/avata/callback', {
    operation_id: adminRecord.chain_operation_id,
    status: 1,
    tx_hash: 'tx_test_mqr',
    block_height: 123,
    record: {
      record_id: 'record_test_mqr',
      certificate_url: 'https://cert.example.com/mqr'
    }
  });
  assert.equal(callbackRes.status, 200);
  assert.equal(callbackRes.raw, 'SUCCESS');
  const archiveAfterCallback = JSON.parse(fs.readFileSync(archiveManifestPath, 'utf8'));
  const { hashManifest } = require('../src/server/services/manifestService');
  assert.equal(hashManifest(archiveAfterCallback.sealed_manifest), archiveAfterCallback.manifest_hash);
  assert.equal(archiveAfterCallback.archive.chain.tx_hash, 'tx_test_mqr');
  const retryRes = await postJson('/api/admin/records/MQR00001/chain/retry', {}, adminToken);
  assert.equal(retryRes.status, 200);

  const duplicateRes = await postJson(`/api/miniapp/qr/${accessToken}/record`, {
    content: '重复记录',
    image_object_key: uploadRes.body.data.object_key
  }, token);
  assert.equal(duplicateRes.status, 409);
  assert.equal(duplicateRes.body.code, 'QR_ALREADY_ACTIVATED');

  const recordsRes = await getJson('/api/miniapp/user/records', token);
  assert.equal(recordsRes.status, 200);
  assert.equal(recordsRes.body.data.records.some((item) => item.id === 'MQR00001'), true);
});

test('miniapp content safety mock should reject unsafe text and image', async () => {
  const adminLogin = await postJson('/api/admin/login', { username: 'admin', password: 'test-admin-pass' });
  const adminToken = adminLogin.body.data.token;
  const genRes = await postJson('/api/admin/qr/generate', {
    prefix: 'MSF',
    count: 1
  }, adminToken);
  assert.equal(genRes.status, 200);
  const accessToken = genRes.body.data.records[0].qr_access_token;
  const token = await loginMiniappBindPhoneAndGetToken({
    code: 'mini-safety',
    phone: '13877770002'
  });

  const rejectText = await postJson(`/api/miniapp/qr/${accessToken}/record`, {
    content: 'mock-reject',
    image_object_key: 'demo.jpg'
  }, token);
  assert.equal(rejectText.status, 400);
  assert.equal(rejectText.body.code, 'CONTENT_REJECTED');

  const rejectImage = await postMultipart('/api/miniapp/upload', {
    fields: { qr_id: 'MSF00001' },
    files: [
      {
        fieldName: 'image',
        filename: 'mock-reject.png',
        contentType: 'image/png',
        content: Buffer.from('not-real-but-image-mimetype')
      }
    ]
  }, token);
  assert.equal(rejectImage.status, 400);
  assert.equal(rejectImage.body.code, 'IMAGE_REJECTED');
});

test('miniapp co-creation flow should collect comments and finalize', async () => {
  const adminLogin = await postJson('/api/admin/login', { username: 'admin', password: 'test-admin-pass' });
  const adminToken = adminLogin.body.data.token;
  const genRes = await postJson('/api/admin/qr/generate', {
    prefix: 'MCO',
    count: 1
  }, adminToken);
  assert.equal(genRes.status, 200);
  const accessToken = genRes.body.data.records[0].qr_access_token;

  const ownerToken = await loginMiniappBindPhoneAndGetToken({
    code: 'mini-owner',
    phone: '13877770003'
  });
  const startRes = await postJson(`/api/miniapp/qr/${accessToken}/record`, {
    mode: 'co_create',
    content: '主留言',
    image_object_key: 'owner.jpg'
  }, ownerToken);
  assert.equal(startRes.status, 200);
  assert.equal(startRes.body.data.activation_status, 'co_creating');
  assert.equal(startRes.body.data.is_co_creation_owner, true);
  assert.equal(startRes.body.data.blockchain_hash, null);
  assert.equal(startRes.body.data.manifest_hash, null);
  assert.equal(startRes.body.data.chain_status, 'not_started');

  const participantToken = await loginMiniappBindPhoneAndGetToken({
    code: 'mini-participant',
    phone: '13877770004'
  });
  const commentRes = await postJson(`/api/miniapp/qr/${accessToken}/comments`, {
    author_name: '朋友',
    content: '一起见证'
  }, participantToken);
  assert.equal(commentRes.status, 200);

  const duplicateCommentRes = await postJson(`/api/miniapp/qr/${accessToken}/comments`, {
    author_name: '朋友',
    content: '第二次'
  }, participantToken);
  assert.equal(duplicateCommentRes.status, 409);

  const forbiddenFinalize = await postJson(`/api/miniapp/qr/${accessToken}/finalize`, {}, participantToken);
  assert.equal(forbiddenFinalize.status, 403);

  const finalizeRes = await postJson(`/api/miniapp/qr/${accessToken}/finalize`, {}, ownerToken);
  assert.equal(finalizeRes.status, 200);
  assert.equal(finalizeRes.body.data.activation_status, 'activated');
  assert.ok(finalizeRes.body.data.blockchain_hash);
  assert.ok(finalizeRes.body.data.manifest_hash);
  assert.equal(finalizeRes.body.data.blockchain_hash, finalizeRes.body.data.manifest_hash);
  assert.ok(['manifest_ready', 'submitting', 'submitted', 'confirmed', 'failed'].includes(finalizeRes.body.data.chain_status));
});


test('createApp should fail fast in production when no admin bootstrap config and no existing admins', async () => {
  const oldNodeEnv = process.env.NODE_ENV;
  const oldDbFile = process.env.DB_FILE;
  const oldBootstrap = process.env.ADMIN_INIT_ACCOUNTS_JSON;

  const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xingxingzaishan-prod-'));
  process.env.NODE_ENV = 'production';
  process.env.DB_FILE = path.join(isolatedDir, 'db.json');
  delete process.env.ADMIN_INIT_ACCOUNTS_JSON;

  delete require.cache[require.resolve('../src/server/app')];
  delete require.cache[require.resolve('../src/server/services/dbService')];
  const { createApp } = require('../src/server/app');
  assert.throws(
    () => createApp(),
    (error) => error && error.code === 'CONFIG_VALIDATION_FAILED'
  );

  if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = oldNodeEnv;
  if (oldDbFile === undefined) delete process.env.DB_FILE;
  else process.env.DB_FILE = oldDbFile;
  if (oldBootstrap === undefined) delete process.env.ADMIN_INIT_ACCOUNTS_JSON;
  else process.env.ADMIN_INIT_ACCOUNTS_JSON = oldBootstrap;

  fs.rmSync(isolatedDir, { recursive: true, force: true });
  delete require.cache[require.resolve('../src/server/app')];
  delete require.cache[require.resolve('../src/server/services/dbService')];
});

test('createApp should fail fast in cloud mode without OSS config', async () => {
  const oldStorageMode = process.env.STORAGE_MODE;
  const oldAccessKeyId = process.env.OSS_ACCESS_KEY_ID;
  const oldAccessKeySecret = process.env.OSS_ACCESS_KEY_SECRET;
  const oldBucket = process.env.OSS_BUCKET;
  const oldRegion = process.env.OSS_REGION;
  const oldEndpoint = process.env.OSS_ENDPOINT;
  process.env.STORAGE_MODE = 'cloud';
  delete process.env.OSS_ENDPOINT;
  delete process.env.OSS_ACCESS_KEY_ID;
  delete process.env.OSS_ACCESS_KEY_SECRET;
  delete process.env.OSS_BUCKET;
  delete process.env.OSS_REGION;

  delete require.cache[require.resolve('../src/server/app')];
  delete require.cache[require.resolve('../src/server/services/dbService')];
  const { createApp } = require('../src/server/app');
  assert.throws(
    () => createApp(),
    (error) => error && error.code === 'CONFIG_VALIDATION_FAILED'
  );

  if (oldStorageMode === undefined) delete process.env.STORAGE_MODE;
  else process.env.STORAGE_MODE = oldStorageMode;
  if (oldAccessKeyId === undefined) delete process.env.OSS_ACCESS_KEY_ID;
  else process.env.OSS_ACCESS_KEY_ID = oldAccessKeyId;
  if (oldAccessKeySecret === undefined) delete process.env.OSS_ACCESS_KEY_SECRET;
  else process.env.OSS_ACCESS_KEY_SECRET = oldAccessKeySecret;
  if (oldBucket === undefined) delete process.env.OSS_BUCKET;
  else process.env.OSS_BUCKET = oldBucket;
  if (oldRegion === undefined) delete process.env.OSS_REGION;
  else process.env.OSS_REGION = oldRegion;
  if (oldEndpoint === undefined) delete process.env.OSS_ENDPOINT;
  else process.env.OSS_ENDPOINT = oldEndpoint;
});

test('GET /api/nft/:id/download should return download_url after activation', async () => {
  const imageData = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZQ1EAAAAASUVORK5CYII=',
    'base64'
  );

  const userCookie = await loginUserAndGetCookie('13800138000');
  const uploadRes = await postMultipartWithCookie('/api/upload', {
    fields: { qr_id: 'STAR0002' },
    files: [
      {
        fieldName: 'image',
        filename: 'pixel.png',
        contentType: 'image/png',
        content: imageData
      }
    ]
  }, userCookie);

  assert.equal(uploadRes.status, 200);
  const uploadBody = uploadRes.body;
  assert.ok(uploadBody.data.object_key);

  const recordRes = await postJsonWithCookie('/api/qr/STAR0002/record', {
    content: 'demo',
    image_url: uploadBody.data.url,
    image_object_key: uploadBody.data.object_key
  }, userCookie);
  assert.equal(recordRes.status, 200);

  const downloadRes = await getJson('/api/nft/STAR0002/download');
  assert.equal(downloadRes.status, 200);
  assert.ok(downloadRes.body.data.download_url);
});

test('POST /api/admin/qr/generate should assign qr_access_token to new QR codes', async () => {
  const login = await postJson('/api/admin/login', { username: 'admin', password: 'test-admin-pass' });
  const token = login.body.data.token;

  const genRes = await postJson('/api/admin/qr/generate', {
    prefix: 'TKN',
    count: 3
  }, token);
  assert.equal(genRes.status, 200);

  const records = genRes.body.data.records;
  assert.equal(records.length, 3);

  records.forEach((item) => {
    assert.ok(item.qr_access_token, 'qr_access_token should exist');
    assert.equal(item.qr_access_token.length, 32, 'qr_access_token should be 32 chars');
  });

  const tokens = records.map((item) => item.qr_access_token);
  const uniqueTokens = new Set(tokens);
  assert.equal(uniqueTokens.size, 3, 'tokens should be unique');
});

test('GET /api/qr/:key should return QR by token and reject invalid token', async () => {
  const login = await postJson('/api/admin/login', { username: 'admin', password: 'test-admin-pass' });
  const token = login.body.data.token;

  const genRes = await postJson('/api/admin/qr/generate', {
    prefix: 'TQA',
    count: 1
  }, token);
  assert.equal(genRes.status, 200);

  const qrId = genRes.body.data.ids[0];
  const accessToken = genRes.body.data.records[0].qr_access_token;

  const resByToken = await getJson(`/api/qr/${accessToken}`);
  assert.equal(resByToken.status, 200);
  assert.equal(resByToken.body.data.id, qrId);

  const resById = await getJson(`/api/qr/${qrId}`);
  assert.equal(resById.status, 200);
  assert.equal(resById.body.data.id, qrId);

  const resByBadToken = await getJson('/api/qr/nonexistenttoken1234567890123456');
  assert.equal(resByBadToken.status, 404);
});

test('POST /api/qr/:token/record should activate QR by access token', async () => {
  const login = await postJson('/api/admin/login', { username: 'admin', password: 'test-admin-pass' });
  const adminToken = login.body.data.token;

  const genRes = await postJson('/api/admin/qr/generate', {
    prefix: 'TQR',
    count: 1
  }, adminToken);
  assert.equal(genRes.status, 200);

  const accessToken = genRes.body.data.records[0].qr_access_token;

  const userCookie = await loginUserAndGetCookie('13900139000');
  const uploadRes = await postMultipartWithCookie('/api/upload', {
    fields: { qr_id: genRes.body.data.ids[0] },
    files: [
      {
        fieldName: 'image',
        filename: 'tqr.png',
        contentType: 'image/png',
        content: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZQ1EAAAAASUVORK5CYII=', 'base64')
      }
    ]
  }, userCookie);
  assert.equal(uploadRes.status, 200);

  const recordRes = await postJsonWithCookie(`/api/qr/${accessToken}/record`, {
    content: 'activated by token',
    image_url: uploadRes.body.data.url,
    image_object_key: uploadRes.body.data.object_key
  }, userCookie);
  assert.equal(recordRes.status, 200);
  assert.equal(recordRes.body.data.activation_status, 'activated');
  assert.equal(recordRes.body.data.content, 'activated by token');
});

test('co-creation flow should collect comments and owner finalize record', async () => {
  const adminLogin = await postJson('/api/admin/login', { username: 'admin', password: 'test-admin-pass' });
  const adminToken = adminLogin.body.data.token;

  const genRes = await postJson('/api/admin/qr/generate', {
    prefix: 'COC',
    count: 1
  }, adminToken);
  assert.equal(genRes.status, 200);

  const qrId = genRes.body.data.ids[0];
  const accessToken = genRes.body.data.records[0].qr_access_token;

  const ownerCookie = await loginUserAndGetCookie('13811112222');
  const uploadRes = await postMultipartWithCookie('/api/upload', {
    fields: { qr_id: qrId },
    files: [
      {
        fieldName: 'image',
        filename: 'co-create.png',
        contentType: 'image/png',
        content: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZQ1EAAAAASUVORK5CYII=', 'base64')
      }
    ]
  }, ownerCookie);
  assert.equal(uploadRes.status, 200);

  const startRes = await postJsonWithCookie(`/api/qr/${accessToken}/record`, {
    mode: 'co_create',
    content: '主留言',
    image_url: uploadRes.body.data.url,
    image_object_key: uploadRes.body.data.object_key
  }, ownerCookie);
  assert.equal(startRes.status, 200);
  assert.equal(startRes.body.data.activation_status, 'co_creating');
  assert.equal(startRes.body.data.is_co_creation_owner, true);
  assert.equal(startRes.body.data.blockchain_hash, null);
  assert.equal(startRes.body.data.manifest_hash, null);
  assert.equal(startRes.body.data.chain_status, 'not_started');
  assert.equal(startRes.body.data.co_creation_comment_count, 0);
  assert.equal(startRes.body.data.co_creation_comment_limit, 12);

  const anonymousStatus = await getJson(`/api/qr/${accessToken}`);
  assert.equal(anonymousStatus.status, 200);
  assert.equal(anonymousStatus.body.data.activation_status, 'co_creating');
  assert.equal(Object.prototype.hasOwnProperty.call(anonymousStatus.body.data, 'phone'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(anonymousStatus.body.data, 'content'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(anonymousStatus.body.data, 'image_url'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(anonymousStatus.body.data, 'co_creation_comments'), false);

  const ownerRecordsBeforeFinalize = await getJsonWithCookie('/api/user/records', ownerCookie);
  assert.equal(ownerRecordsBeforeFinalize.status, 200);
  const coCreatingRecord = ownerRecordsBeforeFinalize.body.data.records.find((item) => item.id === qrId);
  assert.ok(coCreatingRecord);
  assert.equal(coCreatingRecord.activation_status, 'co_creating');

  const participantCookie = await loginUserAndGetCookie('13811113333');
  const commentRes = await postJsonWithCookie(`/api/qr/${accessToken}/comments`, {
    author_name: '朋友',
    content: '一起见证'
  }, participantCookie);
  assert.equal(commentRes.status, 200);
  assert.equal(commentRes.body.data.content, '一起见证');

  const duplicateCommentRes = await postJsonWithCookie(`/api/qr/${accessToken}/comments`, {
    author_name: '朋友',
    content: '第二次留言'
  }, participantCookie);
  assert.equal(duplicateCommentRes.status, 409);
  assert.equal(duplicateCommentRes.body.code, 'CO_CREATION_COMMENT_EXISTS');

  const participantStatus = await getJsonWithCookie(`/api/qr/${accessToken}`, participantCookie);
  assert.equal(participantStatus.status, 200);
  assert.equal(participantStatus.body.data.is_co_creation_owner, false);
  assert.equal(participantStatus.body.data.has_my_co_creation_comment, true);
  assert.equal(participantStatus.body.data.co_creation_comment_count, 1);
  assert.equal(participantStatus.body.data.co_creation_comment_limit, 12);
  assert.equal(participantStatus.body.data.content, startRes.body.data.content);
  assert.ok(participantStatus.body.data.image_url);
  assert.equal(Object.prototype.hasOwnProperty.call(participantStatus.body.data, 'phone'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(participantStatus.body.data, 'co_creation_owner_phone'), false);
  assert.equal(participantStatus.body.data.co_creation_comments.length, 1);

  const forbiddenDelete = await deleteJsonWithCookie(`/api/qr/${accessToken}/comments/${commentRes.body.data.id}`, participantCookie);
  assert.equal(forbiddenDelete.status, 403);

  const deleteRes = await deleteJsonWithCookie(`/api/qr/${accessToken}/comments/${commentRes.body.data.id}`, ownerCookie);
  assert.equal(deleteRes.status, 200);
  assert.equal(deleteRes.body.data.co_creation_comments.length, 0);
  assert.equal(deleteRes.body.data.co_creation_comment_count, 0);

  const keptCommentRes = await postJsonWithCookie(`/api/qr/${accessToken}/comments`, {
    author_name: '家人',
    content: '留在酒里'
  }, participantCookie);
  assert.equal(keptCommentRes.status, 200);

  const forbiddenFinalize = await postJsonWithCookie(`/api/qr/${accessToken}/finalize`, {}, participantCookie);
  assert.equal(forbiddenFinalize.status, 403);

  const finalizeRes = await postJsonWithCookie(`/api/qr/${accessToken}/finalize`, {}, ownerCookie);
  assert.equal(finalizeRes.status, 200);
  assert.equal(finalizeRes.body.data.activation_status, 'activated');
  assert.ok(finalizeRes.body.data.blockchain_hash);
  assert.ok(finalizeRes.body.data.manifest_hash);
  assert.equal(finalizeRes.body.data.blockchain_hash, finalizeRes.body.data.manifest_hash);
  assert.ok(['manifest_ready', 'submitting', 'submitted', 'confirmed', 'failed'].includes(finalizeRes.body.data.chain_status));
  const ownerRecordsAfterFinalize = await getJsonWithCookie('/api/user/records', ownerCookie);
  assert.equal(ownerRecordsAfterFinalize.status, 200);
  const finalizedRecord = ownerRecordsAfterFinalize.body.data.records.find((item) => item.id === qrId);
  assert.ok(finalizedRecord);
  assert.equal(finalizedRecord.activation_status, 'activated');
  assert.equal(finalizeRes.body.data.co_creation_comments.length, 1);
  assert.equal(finalizeRes.body.data.co_creation_comments[0].content, '留在酒里');
});

test('co-creation comments should be limited to 12 active comments', async () => {
  const adminLogin = await postJson('/api/admin/login', { username: 'admin', password: 'test-admin-pass' });
  const adminToken = adminLogin.body.data.token;

  const genRes = await postJson('/api/admin/qr/generate', {
    prefix: 'LIM',
    count: 1
  }, adminToken);
  assert.equal(genRes.status, 200);

  const qrId = genRes.body.data.ids[0];
  const accessToken = genRes.body.data.records[0].qr_access_token;
  const ownerCookie = await loginUserAndGetCookie('13700000000');
  const uploadRes = await postMultipartWithCookie('/api/upload', {
    fields: { qr_id: qrId },
    files: [
      {
        fieldName: 'image',
        filename: 'limit.png',
        contentType: 'image/png',
        content: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZQ1EAAAAASUVORK5CYII=', 'base64')
      }
    ]
  }, ownerCookie);
  assert.equal(uploadRes.status, 200);

  const startRes = await postJsonWithCookie(`/api/qr/${accessToken}/record`, {
    mode: 'co_create',
    content: '主留言',
    image_url: uploadRes.body.data.url,
    image_object_key: uploadRes.body.data.object_key
  }, ownerCookie);
  assert.equal(startRes.status, 200);

  const commentIds = [];
  for (let i = 0; i < 12; i += 1) {
    const participantCookie = await loginUserAndGetCookie(`137000000${String(i + 1).padStart(2, '0')}`);
    const commentRes = await postJsonWithCookie(`/api/qr/${accessToken}/comments`, {
      author_name: `见证人${i + 1}`,
      content: `留言${i + 1}`
    }, participantCookie);
    assert.equal(commentRes.status, 200);
    commentIds.push(commentRes.body.data.id);
  }

  const fullStatus = await getJsonWithCookie(`/api/qr/${accessToken}`, ownerCookie);
  assert.equal(fullStatus.status, 200);
  assert.equal(fullStatus.body.data.co_creation_comment_count, 12);
  assert.equal(fullStatus.body.data.co_creation_comment_limit, 12);

  const extraCookie = await loginUserAndGetCookie('13700000013');
  const limitRes = await postJsonWithCookie(`/api/qr/${accessToken}/comments`, {
    author_name: '第十三人',
    content: '第十三条'
  }, extraCookie);
  assert.equal(limitRes.status, 409);
  assert.equal(limitRes.body.code, 'CO_CREATION_COMMENT_LIMIT_REACHED');

  const deleteRes = await deleteJsonWithCookie(`/api/qr/${accessToken}/comments/${commentIds[0]}`, ownerCookie);
  assert.equal(deleteRes.status, 200);
  assert.equal(deleteRes.body.data.co_creation_comment_count, 11);

  const retryRes = await postJsonWithCookie(`/api/qr/${accessToken}/comments`, {
    author_name: '第十三人',
    content: '补位留言'
  }, extraCookie);
  assert.equal(retryRes.status, 200);
});

test('POST /api/upload should compress image and return .jpg object_key', async () => {
  // 用 sharp 生成 200x200 红色 PNG 作为测试图片
  const sharp = require('sharp');
  const rawPixels = Buffer.alloc(200 * 200 * 3, 0);
  for (let i = 0; i < 200 * 200; i++) {
    rawPixels[i * 3] = 255;     // R
    rawPixels[i * 3 + 1] = 0;   // G
    rawPixels[i * 3 + 2] = 0;   // B
  }
  const pngBuffer = await sharp(rawPixels, { raw: { width: 200, height: 200, channels: 3 } })
    .png()
    .toBuffer();

  const userCookie = await loginUserAndGetCookie('13800138000');
  const uploadRes = await postMultipartWithCookie('/api/upload', {
    fields: { qr_id: 'COMPRESS_TEST' },
    files: [
      {
        fieldName: 'image',
        filename: 'test-image.png',
        contentType: 'image/png',
        content: pngBuffer
      }
    ]
  }, userCookie);

  assert.equal(uploadRes.status, 200);
  assert.equal(uploadRes.body.status, 'success');

  // 压缩后 object_key 后缀应为 .jpg
  const objectKey = uploadRes.body.data.object_key;
  assert.ok(objectKey, 'object_key should exist');
  assert.ok(objectKey.endsWith('.jpg'), `object_key should end with .jpg, got: ${objectKey}`);
});
