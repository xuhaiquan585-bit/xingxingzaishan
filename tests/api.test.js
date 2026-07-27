const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
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

function decodeJwtPayload(token) {
  const encodedPayload = String(token || '').split('.')[1];
  assert.ok(encodedPayload);
  const normalized = encodedPayload.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4;
  return JSON.parse(Buffer.from(pad ? normalized + '='.repeat(4 - pad) : normalized, 'base64').toString('utf8'));
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value))
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function signTestMiniappToken(payload) {
  const header = base64urlJson({ alg: 'HS256', typ: 'JWT' });
  const body = base64urlJson(payload);
  const content = `${header}.${body}`;
  const signature = Buffer.from(
    crypto
      .createHmac('sha256', process.env.AUTH_SECRET || 'test-secret-123')
      .update(content)
      .digest()
  )
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${content}.${signature}`;
}

function makeMiniappTokenForUser(user, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return signTestMiniappToken({
    id: user.id,
    openid: user.openid,
    account_id: user.account_id,
    phone: user.phone || null,
    source: 'miniapp',
    iat: now,
    exp: now + 7 * 24 * 60 * 60,
    ...overrides
  });
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

function nextTestAccountId(db) {
  const maxAccount = Math.max(0, ...(Array.isArray(db.accounts) ? db.accounts : [])
    .map((item) => {
      const match = String(item && item.id || '').match(/^ACC(\d+)$/);
      return match ? Number(match[1]) : 0;
    }));
  const nextFromMeta = Number(db.meta && db.meta.next_account_id) || 1;
  return Math.max(maxAccount + 1, nextFromMeta);
}

function attachTestAccount(db, user, createdFrom = 'migration') {
  if (!Array.isArray(db.accounts)) db.accounts = [];
  if (!db.meta || typeof db.meta !== 'object' || Array.isArray(db.meta)) db.meta = {};
  const nextIndex = nextTestAccountId(db);
  const accountId = `ACC${String(nextIndex).padStart(6, '0')}`;
  const createdAt = user.created_at || '2026-07-26T00:00:00.000Z';
  db.accounts.push({
    id: accountId,
    status: 'active',
    display_name: '',
    avatar_url: '',
    created_from: createdFrom,
    created_at: createdAt,
    updated_at: createdAt
  });
  db.meta.next_account_id = nextIndex + 1;
  user.account_id = accountId;
  return accountId;
}

const WECHAT_PAY_ENV_KEYS = [
  'WECHAT_PAY_MCH_ID',
  'WECHAT_PAY_APPID',
  'WECHAT_PAY_API_V3_KEY',
  'WECHAT_PAY_CERT_SERIAL_NO',
  'WECHAT_PAY_PRIVATE_KEY_PATH',
  'WECHAT_PAY_PLATFORM_CERT_PATH',
  'WECHAT_PAY_PUBLIC_KEY_PATH',
  'WECHAT_PAY_PUBLIC_KEY_ID',
  'WECHAT_PAY_NOTIFY_URL',
  'WECHAT_PAY_MOCK'
];

function snapshotEnv(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  Object.entries(snapshot).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
}

function clearWechatPayEnv() {
  WECHAT_PAY_ENV_KEYS.forEach((key) => delete process.env[key]);
}

function createWechatPayKeyFiles(prefix) {
  const merchant = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const platform = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const merchantPrivateKey = merchant.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const platformPrivateKey = platform.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const platformPublicKey = platform.publicKey.export({ type: 'spki', format: 'pem' });
  const privateKeyPath = path.join(tmpDir, `${prefix}-apiclient_key.pem`);
  const platformCertPath = path.join(tmpDir, `${prefix}-wechatpay_public.pem`);
  fs.writeFileSync(privateKeyPath, merchantPrivateKey);
  fs.writeFileSync(platformCertPath, platformPublicKey);
  return {
    privateKeyPath,
    platformCertPath,
    platformPrivateKey
  };
}

function applyWechatPayEnv(keys) {
  process.env.WECHAT_PAY_MCH_ID = '1748255259';
  process.env.WECHAT_PAY_APPID = 'wx8b85b181e784722f';
  process.env.WECHAT_PAY_API_V3_KEY = '0123456789abcdef0123456789abcdef';
  process.env.WECHAT_PAY_CERT_SERIAL_NO = 'TEST_SERIAL_NO';
  process.env.WECHAT_PAY_PRIVATE_KEY_PATH = keys.privateKeyPath;
  process.env.WECHAT_PAY_PLATFORM_CERT_PATH = keys.platformCertPath;
  process.env.WECHAT_PAY_NOTIFY_URL = 'https://xingxingzaishan.top/api/payment/wechat/notify';
}

function applyWechatPayPublicKeyEnv(keys) {
  applyWechatPayEnv(keys);
  delete process.env.WECHAT_PAY_PLATFORM_CERT_PATH;
  process.env.WECHAT_PAY_PUBLIC_KEY_PATH = keys.platformCertPath;
  process.env.WECHAT_PAY_PUBLIC_KEY_ID = 'PUB_KEY_ID_TEST';
}

function mockWechatPayHttps(responseBody, statusCode = 200) {
  const originalRequest = https.request;
  const calls = [];
  https.request = (url, options, callback) => {
    const req = new EventEmitter();
    let requestBody = '';
    req.write = (chunk) => {
      requestBody += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    };
    req.end = () => {
      calls.push({ url: String(url), options, body: requestBody });
      const res = new EventEmitter();
      res.statusCode = statusCode;
      process.nextTick(() => {
        callback(res);
        res.emit('data', Buffer.from(JSON.stringify(responseBody)));
        res.emit('end');
      });
    };
    return req;
  };
  return {
    calls,
    restore: () => {
      https.request = originalRequest;
    }
  };
}

function encryptWechatPayResource(payload, apiKey) {
  const nonce = 'notify-nonce';
  const associatedData = 'transaction';
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(apiKey, 'utf8'), Buffer.from(nonce, 'utf8'));
  cipher.setAAD(Buffer.from(associatedData, 'utf8'));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();
  return {
    algorithm: 'AEAD_AES_256_GCM',
    associated_data: associatedData,
    nonce,
    ciphertext: Buffer.concat([encrypted, authTag]).toString('base64')
  };
}

function signWechatPayNotify({ rawBody, timestamp, nonce, privateKey }) {
  return crypto
    .createSign('RSA-SHA256')
    .update(`${timestamp}\n${nonce}\n${rawBody}\n`)
    .end()
    .sign(privateKey, 'base64');
}

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xingxingzaishan-'));
  clearWechatPayEnv();
  process.env.DB_FILE = path.join(tmpDir, 'db.json');
  process.env.STORAGE_ROOT = path.join(tmpDir, 'storage');
  process.env.AUTH_SECRET = 'test-secret-123';
  process.env.RATE_LIMIT_LOGIN_MAX = '1000';
  process.env.SMS_PROVIDER = 'mock';
  process.env.MINIAPP_MOCK_ENABLED = 'true';
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
  delete process.env.MINIAPP_MOCK_ENABLED;
  delete process.env.ADMIN_INIT_ACCOUNTS_JSON;
  clearWechatPayEnv();
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

  const { getDatabaseSnapshot } = require('../src/server/services/dbService');
  let db = getDatabaseSnapshot();
  const user = db.users.find((item) => item.phone === '13800138000');
  assert.ok(user.account_id);
  const accountsBeforeRepeat = db.accounts.length;
  const repeat = await postJson('/api/user/login', { phone: '13800138000' });
  assert.equal(repeat.status, 200);
  db = getDatabaseSnapshot();
  assert.equal(db.users.filter((item) => item.phone === '13800138000').length, 1);
  assert.equal(db.accounts.length, accountsBeforeRepeat);
});

test('H5 login should fail closed on duplicate phone identity', async () => {
  const {
    getDatabaseSnapshot,
    writeDatabaseSnapshot
  } = require('../src/server/services/dbService');

  const duplicatePhone = '13900139998';
  let db = getDatabaseSnapshot();
  const nextUserId = Math.max(...db.users.map((item) => Number(item.id) || 0), 0) + 1;
  const userA = {
    id: nextUserId,
    phone: duplicatePhone,
    openid: null,
    unionid: null,
    source: 'web',
    created_at: '2026-07-27T00:00:00.000Z'
  };
  const userB = {
    id: nextUserId + 1,
    phone: duplicatePhone,
    openid: 'mock-openid-h5-duplicate-phone',
    unionid: null,
    source: 'web+miniapp',
    created_at: '2026-07-27T00:00:01.000Z'
  };
  attachTestAccount(db, userA, 'web_phone');
  attachTestAccount(db, userB, 'web_phone');
  db.users.push(userA, userB);
  writeDatabaseSnapshot(db);

  const beforeLogin = JSON.stringify(getDatabaseSnapshot());
  const loginRes = await postJson('/api/user/login', { phone: duplicatePhone });
  assert.equal(loginRes.status, 409);
  assert.equal(loginRes.body.code, 'DUPLICATE_PHONE_IDENTITY');
  assert.equal(loginRes.headers['set-cookie'], undefined);
  assert.equal(JSON.stringify(getDatabaseSnapshot()), beforeLogin);

  const sendRes = await postJson('/api/user/sms/send-code', { phone: duplicatePhone });
  assert.equal(sendRes.status, 200);
  const beforeVerify = JSON.stringify(getDatabaseSnapshot());
  const verifyRes = await postJson('/api/user/sms/verify-code', {
    phone: duplicatePhone,
    code: sendRes.body.data.verification_code
  });
  assert.equal(verifyRes.status, 409);
  assert.equal(verifyRes.body.code, 'DUPLICATE_PHONE_IDENTITY');
  assert.equal(verifyRes.headers['set-cookie'], undefined);
  assert.equal(JSON.stringify(getDatabaseSnapshot()), beforeVerify);
});

test('H5 login should pass unknown account creation errors to internal error handler', async () => {
  const sendRes = await postJson('/api/user/sms/send-code', { phone: '13900139997' });
  assert.equal(sendRes.status, 200);

  const originalWriteFileSync = fs.writeFileSync;
  try {
    fs.writeFileSync = function patchedWriteFileSync(filePath, ...args) {
      if (String(filePath).endsWith(`${path.sep}db.json`)) {
        throw new Error('SIMULATED_DB_WRITE_FAILURE');
      }
      return originalWriteFileSync.call(this, filePath, ...args);
    };

    const loginRes = await postJson('/api/user/login', { phone: '13900139996' });
    assert.equal(loginRes.status, 500);
    assert.equal(loginRes.body.code, 'INTERNAL_ERROR');
    assert.notEqual(loginRes.status, 409);
    assert.equal(loginRes.headers['set-cookie'], undefined);

    const verifyRes = await postJson('/api/user/sms/verify-code', {
      phone: '13900139997',
      code: sendRes.body.data.verification_code
    });
    assert.equal(verifyRes.status, 500);
    assert.equal(verifyRes.body.code, 'INTERNAL_ERROR');
    assert.notEqual(verifyRes.status, 409);
    assert.equal(verifyRes.headers['set-cookie'], undefined);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }
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

test('H5 sessions should verify account mapping from database context', async () => {
  const {
    createSession,
    getSession,
    getCookieName
  } = require('../src/server/services/userSessionService');
  const {
    getDatabaseSnapshot,
    writeDatabaseSnapshot
  } = require('../src/server/services/dbService');

  const cookie = await loginUserAndGetCookie('13900139010');
  let db = getDatabaseSnapshot();
  const user = db.users.find((item) => item.phone === '13900139010');
  assert.ok(user.account_id);

  const sessionId = decodeURIComponent(cookie.split('=')[1]);
  const session = getSession(sessionId);
  assert.equal(session.user_id, user.id);
  assert.equal(session.account_id, user.account_id);

  const oldSession = createSession({
    userId: user.id,
    phone: user.phone
  });
  const oldSessionRes = await getJsonWithCookie('/api/user/me', `${getCookieName()}=${oldSession.sid}`);
  assert.equal(oldSessionRes.status, 200);
  assert.equal(oldSessionRes.body.data.phone, user.phone);

  const mismatchSession = createSession({
    userId: user.id,
    phone: user.phone,
    accountId: 'ACC999999'
  });
  const mismatchRes = await getJsonWithCookie('/api/user/me', `${getCookieName()}=${mismatchSession.sid}`);
  assert.equal(mismatchRes.status, 401);

  const noPhoneFallbackSession = createSession({
    userId: 'missing-user-id',
    phone: user.phone
  });
  const noPhoneFallbackRes = await getJsonWithCookie('/api/user/me', `${getCookieName()}=${noPhoneFallbackSession.sid}`);
  assert.equal(noPhoneFallbackRes.status, 401);

  db = getDatabaseSnapshot();
  db.users = db.users.map((item) =>
    item.id === user.id ? { ...item, account_id: null } : item
  );
  writeDatabaseSnapshot(db);
  const missingAccountSession = createSession({
    userId: user.id,
    phone: user.phone
  });
  const missingAccountRes = await getJsonWithCookie('/api/user/me', `${getCookieName()}=${missingAccountSession.sid}`);
  assert.equal(missingAccountRes.status, 401);

  const reloginRes = await postJson('/api/user/sms/send-code', { phone: user.phone });
  assert.equal(reloginRes.status, 200);
  const verifyRes = await postJson('/api/user/sms/verify-code', {
    phone: user.phone,
    code: reloginRes.body.data.verification_code
  });
  assert.equal(verifyRes.status, 409);
  assert.equal(verifyRes.body.code, 'ACCOUNT_MAPPING_REQUIRED');
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

test('H5 my records and detail pages should use Dawn-safe record data presentation', () => {
  const meHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'frontend', 'me.html'), 'utf8');
  const meJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'frontend', 'js', 'me.js'), 'utf8');
  const detailHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'frontend', 'me-detail.html'), 'utf8');
  const detailJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'frontend', 'js', 'me-detail.js'), 'utf8');
  const themeDawnCss = fs.readFileSync(path.join(__dirname, '..', 'src', 'frontend', 'css', 'theme-dawn.css'), 'utf8');

  assert.equal(meHtml.includes('class="container my-records-page"'), true);
  assert.equal(meHtml.includes('当前手机号：'), false);
  assert.equal(meHtml.includes('（<a id="switchPhoneBtn"'), false);
  assert.equal(meHtml.includes('id="currentPhoneText"'), true);
  assert.equal(meHtml.includes('id="switchPhoneBtn"'), true);
  assert.equal(meJs.includes("apiRequest('/api/user/records')"), true);
  assert.equal(meJs.includes("detailLink.href = `/me-detail.html?id=${encodeURIComponent(item.id || '')}`"), true);
  assert.equal(meJs.includes("detailLink.href = `/record.html?t=${encodeURIComponent(item.id || '')}`"), true);
  assert.equal(meJs.includes("idHint.textContent = '星贴 '"), true);
  assert.equal(meJs.includes('二维码编号：'), false);
  assert.equal(meJs.includes('保存时间：'), false);

  assert.equal(detailHtml.includes('class="container record-detail-page"'), true);
  assert.equal(detailHtml.includes('查看这张星贴里的完整记录'), true);
  assert.equal(detailHtml.includes('id="detailHashGroup"'), true);
  assert.equal(detailHtml.includes('id="copyHashBtn"'), true);
  assert.equal(detailHtml.includes('id="toggleHashBtn"'), true);
  assert.equal(detailHtml.includes('id="detailCertificateLink"'), true);
  assert.equal(detailHtml.includes('id="detailBrandGroup"'), true);
  assert.equal(detailHtml.includes('当前手机号：'), false);
  assert.equal(detailJs.includes('record.manifest_hash || record.blockchain_hash'), true);
  assert.equal(detailJs.includes('formatHashSummary'), true);
  assert.equal(detailJs.includes('navigator.clipboard.writeText'), true);
  assert.equal(detailJs.includes("document.execCommand('copy')"), true);
  assert.equal(detailJs.includes('已复制存证哈希'), true);
  assert.equal(detailJs.includes('复制失败，请长按选择复制'), true);
  assert.equal(detailJs.includes('chain_certificate_url'), true);
  assert.equal(detailJs.includes("url.protocol === 'http:' || url.protocol === 'https:'"), true);
  assert.equal(detailJs.includes('alert('), false);
  assert.equal(detailJs.includes('record.show_brand_disclosure && brandDisclosureText'), true);

  assert.equal(themeDawnCss.includes('html.theme-dawn .my-records-page'), true);
  assert.equal(themeDawnCss.includes('html.theme-dawn .record-detail-page'), true);
  assert.equal(themeDawnCss.includes('html.theme-dawn .my-records-page .record-detail-link'), true);
  assert.equal(themeDawnCss.includes('html.theme-dawn .record-detail-page .detail-hash-value.is-expanded'), true);
  assert.equal(themeDawnCss.includes('overflow-wrap: anywhere'), true);
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
  assert.equal(html.includes('id="contentLogoImage"'), true);
  assert.equal(html.includes('id="contentHomeSlides"'), true);
  assert.equal(html.includes('id="contentSceneCards"'), true);
  assert.equal(html.includes('id="uploadMiniappImageBtn"'), true);
  assert.equal(html.includes('id="contentImageUploadedUrl"'), true);
  assert.equal(html.includes('id="systemPanel"'), true);
  assert.equal(html.includes('id="productSceneTags"'), true);
  assert.equal(html.includes('id="productPriceCents"'), true);
  assert.equal(html.includes('id="productStickerCount"'), true);
  assert.equal(html.includes('id="productStock"'), true);
  assert.equal(html.includes('id="orderTable"'), true);
  assert.equal(html.includes('id="refreshOrderBtn"'), true);
  assert.equal(js.includes('adminActiveSection'), true);
  assert.equal(js.includes('function activateAdminSection'), true);
  assert.equal(js.includes('async function loadContentRecords'), true);
  assert.equal(js.includes('async function loadMiniappContent'), true);
  assert.equal(js.includes('async function uploadMiniappContentImage'), true);
  assert.equal(js.includes('/api/admin/upload-image'), true);
  assert.equal(js.includes('contentImageUploadedUrl'), true);
  assert.equal(js.includes("readJsonArrayField('contentHomeSlides'"), true);
  assert.equal(js.includes('async function loadSystemStatus'), true);
  assert.equal(js.includes('scene_tags: getProductSceneTags()'), true);
  assert.equal(js.includes('async function loadOrders'), true);
  assert.equal(js.includes('/api/admin/orders'), true);
  assert.equal(js.includes('/ship'), true);
  assert.equal(js.includes('Promise.all([loadDashboard(), loadBatches(), loadRecords(), loadOperators(), loadProducts()])'), false);
  assert.equal(appJs.includes("appName: '记在星上'"), true);
  assert.equal(appJson.includes('pages/project/project'), true);
  assert.equal(appJson.includes('"navigationBarTitleText": "记在星上"'), true);
  assert.equal(appJson.includes('"tabBar"'), true);
  assert.equal(appJson.includes('"text": "封存"'), true);
  assert.equal(appJson.includes('pages/order-confirm/order-confirm'), true);
  assert.equal(appJson.includes('pages/orders/orders'), true);
  assert.equal(appJson.includes('pages/order-detail/order-detail'), true);
  assert.equal(appJson.includes('"text": "我的星星"'), true);
  assert.equal(appJson.includes('"__usePrivacyCheck__": true'), true);
  assert.equal(homeJs.includes('/api/miniapp/content'), true);
});

test('miniapp QR parser should normalize only confirmed scan key formats', () => {
  const { extractQrKey, parseTokenFromUrl } = require('../src/miniprogram/utils/qr');
  const token = '0123456789abcdef0123456789abcdef';

  assert.equal(extractQrKey({ key: 'SSS00010', t: token }), 'SSS00010');
  assert.equal(extractQrKey({ t: token }), token);
  assert.equal(extractQrKey({ scene: 'key%3DSTAR0011' }), 'STAR0011');
  assert.equal(extractQrKey({ scene: `t%3D${token}` }), token);
  assert.equal(
    extractQrKey({ q: `https%3A%2F%2Fxingxingzaishan.top%2Frecord.html%3Ft%3D${token}%26ui%3Ddawn` }),
    token
  );
  assert.equal(
    extractQrKey({ key: 'https://xingxingzaishan.top/record.html?key=MQR00001&ui=dawn' }),
    'MQR00001'
  );
  assert.equal(parseTokenFromUrl(`https://xingxingzaishan.top/not-record.html?t=${token}`), '');
  assert.equal(extractQrKey({ scene: 'preview' }), '');
  assert.equal(extractQrKey({ scene: 'foo=bar' }), '');
  assert.equal(extractQrKey({ scene: `foo=bar&t=${token}` }), '');
  assert.equal(extractQrKey({ scene: 'https://example.com/other.html?t=SSS00010' }), '');
  assert.equal(extractQrKey({}), '');
});

test('user login pages should keep copy and expose miniapp-first login cues', () => {
  const registerHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'frontend', 'register.html'), 'utf8');
  const recordHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'frontend', 'record.html'), 'utf8');
  const h5MeJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'frontend', 'js', 'me.js'), 'utf8');
  const h5RecordJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'frontend', 'js', 'record.js'), 'utf8');
  const registerJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'frontend', 'js', 'register.js'), 'utf8');
  const frontendCss = fs.readFileSync(path.join(__dirname, '..', 'src', 'frontend', 'css', 'style.css'), 'utf8');
  const themeDawnCss = fs.readFileSync(path.join(__dirname, '..', 'src', 'frontend', 'css', 'theme-dawn.css'), 'utf8');
  const chainViewService = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'services', 'chainViewService.js'), 'utf8');
  const normalizedH5RecordJs = h5RecordJs.replace(/\r\n/g, '\n');
  const appWxss = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'app.wxss'), 'utf8');
  const miniappAppJson = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'app.json'), 'utf8');
  const miniappAuthJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'utils', 'auth.js'), 'utf8');
  const bindPhoneWxml = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'bind-phone', 'bind-phone.wxml'), 'utf8');
  const bindPhoneCss = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'bind-phone', 'bind-phone.wxss'), 'utf8');
  const bindPhoneJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'bind-phone', 'bind-phone.js'), 'utf8');
  const bindPhoneSmsWxml = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'bind-phone-sms', 'bind-phone-sms.wxml'), 'utf8');
  const bindPhoneSmsCss = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'bind-phone-sms', 'bind-phone-sms.wxss'), 'utf8');
  const bindPhoneSmsJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'bind-phone-sms', 'bind-phone-sms.js'), 'utf8');
  const recordWxml = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'record', 'record.wxml'), 'utf8');
  const recordWxss = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'record', 'record.wxss'), 'utf8');
  const recordJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'record', 'record.js'), 'utf8');
  const resultWxml = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'result', 'result.wxml'), 'utf8');
  const resultJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'result', 'result.js'), 'utf8');
  const resultWxss = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'result', 'result.wxss'), 'utf8');
  const coCreateWxml = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'co-create', 'co-create.wxml'), 'utf8');
  const coCreateWxss = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'co-create', 'co-create.wxss'), 'utf8');
  const miniappQrUtil = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'utils', 'qr.js'), 'utf8');
  const homeJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'home', 'home.js'), 'utf8');
  const homeWxml = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'home', 'home.wxml'), 'utf8');
  const homeWxss = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'home', 'home.wxss'), 'utf8');
  const productsJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'products', 'products.js'), 'utf8');
  const productsWxml = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'products', 'products.wxml'), 'utf8');
  const productsWxss = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'products', 'products.wxss'), 'utf8');
  const productDetailWxml = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'product-detail', 'product-detail.wxml'), 'utf8');
  const productDetailJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'product-detail', 'product-detail.js'), 'utf8');
  const productDetailWxss = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'product-detail', 'product-detail.wxss'), 'utf8');
  const orderConfirmWxml = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'order-confirm', 'order-confirm.wxml'), 'utf8');
  const orderConfirmJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'order-confirm', 'order-confirm.js'), 'utf8');
  const ordersWxml = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'orders', 'orders.wxml'), 'utf8');
  const orderDetailWxml = fs.readFileSync(path.join(__dirname, '..', 'src', 'miniprogram', 'pages', 'order-detail', 'order-detail.wxml'), 'utf8');
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
  assert.equal(recordHtml.includes('id="resultTitle"'), true);
  assert.equal(recordHtml.includes('id="resultSubtitle"'), true);
  assert.equal(recordHtml.includes('id="resultQrId"'), true);
  assert.equal(recordHtml.includes('id="resultVisibilityHint"'), true);
  assert.equal(recordHtml.includes('✨ 保存成功'), false);
  assert.equal(recordHtml.includes('别人扫码就能看到您的记录了'), false);
  assert.equal(recordHtml.includes('查看存证信息'), true);
  assert.equal(recordHtml.includes('查看存证哈希'), false);
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
  assert.equal(bindPhoneWxml.includes('<view class="hero-title">{{title}}</view>'), true);
  assert.equal(bindPhoneWxml.includes('<view class="subtitle bind-subtitle">{{subtitle}}</view>'), true);
  assert.equal(bindPhoneWxml.includes('微信手机号验证'), true);
  assert.equal(bindPhoneWxml.includes('<text class="wechat-mark">微信</text>'), true);
  assert.equal(bindPhoneWxml.includes('<text class="wechat-login-text">使用微信手机号继续</text>'), true);
  assert.equal(bindPhoneWxml.includes('使用其他手机号'), true);
  assert.equal(bindPhoneWxml.includes('bindtap="onUseOtherPhone"'), true);
  assert.equal(bindPhoneWxml.includes('open-type="getPhoneNumber"'), true);
  assert.equal(bindPhoneWxml.includes('<view wx:if="{{message}}" class="meta">{{message}}</view>'), true);
  assert.equal(bindPhoneCss.includes('white-space: nowrap'), true);
  assert.equal(bindPhoneCss.includes('width: 100%'), true);
  assert.equal(bindPhoneCss.includes('width: 460rpx'), false);
  assert.equal(bindPhoneCss.includes('white-space: pre-line'), true);
  assert.equal(bindPhoneCss.includes('.sms-fallback-btn'), true);
  assert.equal(bindPhoneCss.includes('.wechat-login-btn::after'), true);
  assert.equal(bindPhoneCss.includes('.sms-fallback-btn::after'), true);
  assert.equal(bindPhoneCss.includes('background: #C79E55'), true);
  assert.equal(bindPhoneCss.includes('background: rgba(255, 255, 255, .28)'), true);
  assert.equal(bindPhoneJs.includes('event.detail && event.detail.code'), true);
  assert.equal(bindPhoneJs.includes('normalizeBindPhoneSource'), true);
  assert.equal(bindPhoneJs.includes('/pages/bind-phone-sms/bind-phone-sms'), true);
  assert.equal(bindPhoneJs.includes('未获取到微信手机号，请再次尝试。'), true);
  assert.equal(bindPhoneJs.includes('暂时无法获取微信手机号，请稍后重试。'), true);
  assert.equal(bindPhoneJs.includes('这个手机号已关联其他微信账号，暂时无法绑定。'), true);
  assert.equal(bindPhoneJs.includes('当前微信账号已绑定其他手机号，如需修改，请使用更换手机号功能。'), true);
  assert.equal(bindPhoneJs.includes('errMsg'), false);
  assert.equal(bindPhoneJs.includes('验证手机号，继续添加照片'), true);
  assert.equal(bindPhoneJs.includes('验证手机号，继续保存记录'), true);
  assert.equal(bindPhoneJs.includes('验证手机号，继续完成这条记录'), true);
  assert.equal(bindPhoneJs.includes('encryptedData'), false);
  assert.equal(bindPhoneJs.includes("'/pages/order-confirm/order-confirm'"), false);
  assert.equal(miniappAppJson.includes('pages/bind-phone-sms/bind-phone-sms'), true);
  assert.equal(miniappAuthJs.includes('/api/miniapp/auth/sms/send-code'), true);
  assert.equal(miniappAuthJs.includes('/api/miniapp/auth/sms/bind-phone'), true);
  assert.equal(miniappAuthJs.includes('function bindPhoneBySms'), true);
  assert.equal(bindPhoneSmsWxml.includes('使用其他手机号'), true);
  assert.equal(bindPhoneSmsWxml.includes('输入并验证你希望用于后续查看和管理记录的手机号。'), true);
  assert.equal(bindPhoneSmsWxml.includes('手机号'), true);
  assert.equal(bindPhoneSmsWxml.includes('验证码'), true);
  assert.equal(bindPhoneSmsWxml.includes('{{sendCodeText}}'), true);
  assert.equal(bindPhoneSmsWxml.includes('验证并继续'), true);
  assert.equal(bindPhoneSmsWxml.includes('<view wx:if="{{message}}" class="meta">{{message}}</view>'), true);
  assert.equal(bindPhoneSmsJs.includes('sendSmsCode'), true);
  assert.equal(bindPhoneSmsJs.includes('bindPhoneBySms'), true);
  assert.equal(bindPhoneSmsJs.includes('normalizeBindPhoneSource'), true);
  assert.equal(bindPhoneSmsJs.includes("sendCodeText: '获取验证码'"), true);
  assert.equal(bindPhoneSmsJs.includes('当前微信账号已绑定手机号，更换手机号功能暂未开放。'), true);
  assert.equal(bindPhoneSmsJs.includes('验证码不正确或已过期，请重新获取。'), true);
  assert.equal(bindPhoneSmsJs.includes('wx.chooseMedia'), false);
  assert.equal(bindPhoneSmsJs.includes('wx.chooseImage'), false);
  assert.equal(bindPhoneSmsJs.includes('wx.uploadFile'), false);
  assert.equal(bindPhoneSmsCss.includes('#C79E55'), true);
  assert.equal(bindPhoneSmsCss.includes('rgba(248, 250, 251, .76)'), true);
  assert.equal(bindPhoneSmsCss.includes('width: 460rpx'), false);
  assert.equal(bindPhoneSmsCss.includes('.sms-code-btn::after'), true);
  assert.equal(bindPhoneSmsCss.includes('.sms-submit-btn::after'), true);
  assert.equal(bindPhoneSmsCss.includes('grid-template-columns: minmax(0, 1fr) 184rpx'), true);
  assert.equal(recordWxml.includes('星星在闪 · 记在星上'), false);
  assert.equal(recordWxml.includes('留下这瓶酒的专属记录'), true);
  assert.equal(recordWxml.includes('✦ 区块链存证'), true);
  assert.equal(recordWxml.includes('NFT凭证'), false);
  assert.equal(recordWxml.includes('选一张照片，写一句话，下次扫码还能看到。'), true);
  const recordTitleIndex = recordWxml.indexOf('留下这瓶酒的专属记录');
  const recordSubtitleIndex = recordWxml.indexOf('选一张照片，写一句话，下次扫码还能看到。');
  const recordTrustIndex = recordWxml.indexOf('✦ 区块链存证');
  assert.equal(recordTitleIndex < recordSubtitleIndex, true);
  assert.equal(recordSubtitleIndex < recordTrustIndex, true);
  assert.equal(recordWxml.includes('永久记在这瓶酒里'), false);
  assert.equal(recordWxml.includes('星星ID:'), false);
  assert.equal(recordWxml.includes('星星ID：'), false);
  assert.equal(recordWxml.includes('当前手机号:'), false);
  assert.equal(recordWxml.includes('当前手机号：'), false);
  assert.equal(recordWxml.includes('更换手机号'), false);
  assert.equal(recordWxml.includes("{{phoneBound ? '更换手机号' : '验证手机号'}}"), false);
  assert.equal(recordWxml.includes('<text wx:else class="record-phone-change" bindtap="changePhone">验证手机号</text>'), true);
  assert.equal(recordWxml.includes('星贴'), true);
  assert.equal(recordWxml.includes('验证手机号'), true);
  assert.equal(recordWxml.includes('写下想记住的话'), true);
  assert.equal(recordWxml.includes('最多 200 字'), false);
  assert.equal(recordWxml.includes('这一刻，会成为这瓶酒的记忆'), false);
  assert.equal(recordWxml.includes('保存后，扫码即可查看这条记录。'), true);
  assert.equal(recordWxml.includes('扫码可查看'), false);
  assert.equal(recordWxml.includes('class="trust-tag"'), false);
  assert.equal(recordWxml.includes('bindtap="chooseImage"'), true);
  assert.equal(recordWxml.includes('disabled="{{!recordAvailable}}" bindtap="chooseImage"'), false);
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
  assert.equal(recordWxml.includes('class="brand-disclosure-grid"'), true);
  assert.equal(recordWxml.includes('checkbox-group class="brand-toggle-group" bindchange="onBrandDisclosureChange"'), true);
  assert.equal(recordWxml.includes('显示酒的品牌信息'), true);
  assert.equal(recordWxml.includes('{{brandPreviewText}}'), true);
  assert.equal(recordWxml.includes('bindtap="submitRecord"'), true);
  assert.equal(recordWxml.includes('mode="aspectFit"'), true);
  assert.equal(recordWxml.includes('style="height: {{previewHeight}}rpx;"'), true);
  assert.equal(recordWxml.includes('mode="aspectFill"'), false);
  assert.equal(recordWxml.includes('class="mode-row"'), false);
  assert.equal(recordWxml.includes('class="record-state-card"'), true);
  assert.equal(recordWxml.includes('class="preview-mask"'), true);
  assert.equal(recordWxml.includes('wx:if="{{previewMessage}}" class="preview-message"'), true);
  assert.equal(recordWxml.includes('bindtap="confirmPreview"'), true);
  assert.equal(recordWxml.includes('bindtap="closePreview"'), true);
  assert.equal(recordWxss.includes('env(safe-area-inset-bottom)'), true);
  assert.equal(recordWxss.includes('padding-bottom: calc(160rpx + env(safe-area-inset-bottom))'), true);
  assert.equal(recordWxss.includes('grid-template-columns: 1fr'), true);
  assert.equal(recordWxss.includes('"Songti SC", STSong, serif'), true);
  assert.equal(recordWxss.includes('-webkit-backdrop-filter: none'), true);
  assert.equal(recordWxss.includes('backdrop-filter: none'), true);
  assert.equal(recordWxss.includes('-webkit-backdrop-filter: blur(16px)'), false);
  assert.equal(recordWxss.includes('backdrop-filter: blur(16px)'), false);
  assert.equal(recordWxss.includes('background: rgba(248, 250, 251, .66)'), true);
  assert.equal(recordWxss.includes('min-height: 258rpx'), true);
  assert.equal(recordWxss.includes('1px dashed rgba(181, 139, 74, .40)'), true);
  assert.equal(recordWxss.includes('width: 100%'), true);
  assert.equal(recordWxss.includes('width: 56rpx'), true);
  assert.equal(recordWxss.includes('margin-bottom: 16rpx'), true);
  assert.equal(recordWxss.includes('min-height: 116rpx'), false);
  assert.equal(recordWxss.includes('color: #647487'), true);
  assert.equal(recordWxss.includes('.textarea-shell'), true);
  assert.equal(recordWxss.includes('position: absolute'), true);
  assert.equal(recordWxss.includes('right: 24rpx'), true);
  assert.equal(recordWxss.includes('bottom: 20rpx'), true);
  assert.equal(recordWxss.includes('min-height: 180rpx'), true);
  assert.equal(recordWxss.includes('padding: 22rpx'), true);
  assert.equal(recordWxss.includes('box-shadow: none'), true);
  assert.equal(recordWxss.includes('.count-row'), true);
  assert.equal(recordWxss.includes('.preview-message'), true);
  assert.equal(recordWxss.includes('grid-template-columns: 44rpx minmax(0, 1fr)'), true);
  assert.equal(recordWxss.includes('min-height: 80rpx'), true);
  assert.equal(recordWxss.includes('font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif'), true);
  assert.equal(h5RecordJs.includes("const SUPPORTED_UI_THEMES = new Set(['dark', 'dawn'])"), true);
  assert.equal(h5RecordJs.includes("next.set('ui', uiTheme)"), true);
  assert.equal(h5RecordJs.includes("const SUPPORTED_BG_THEMES = new Set(['mist', 'paper', 'blue'])"), true);
  assert.equal(h5RecordJs.includes("next.set('bg', bgTheme)"), true);
  assert.equal(h5RecordJs.includes("const SUPPORTED_DRAFT_SOURCES = new Set(['upload', 'replace-photo', 'submit'])"), true);
  assert.equal(h5RecordJs.includes('const RECORD_DRAFT_VERSION = 1'), true);
  assert.equal(h5RecordJs.includes('const RECORD_DRAFT_TTL_MS = 24 * 60 * 60 * 1000'), true);
  assert.equal(h5RecordJs.includes('function saveRecordDraft(source = draftReturnSource)'), true);
  assert.equal(h5RecordJs.includes('function restoreRecordDraft()'), true);
  assert.equal(h5RecordJs.includes('function requirePhoneBeforeProtectedAction(source = \'\')'), true);
  assert.equal(h5RecordJs.includes('storage.setItem(recordDraftKey'), true);
  assert.equal(h5RecordJs.includes("const safeSource = getValidDraftSource(typeof source === 'string' ? source : draftReturnSource)"), true);
  assert.equal(h5RecordJs.includes('version: RECORD_DRAFT_VERSION'), true);
  assert.equal(h5RecordJs.includes('source: safeSource'), true);
  assert.equal(h5RecordJs.includes('savedAt,'), true);
  assert.equal(h5RecordJs.includes('expiresAt: savedAt + RECORD_DRAFT_TTL_MS'), true);
  assert.equal(h5RecordJs.includes('function readVerificationPending()'), true);
  assert.equal(h5RecordJs.includes('function markVerificationPending(source = \'\')'), true);
  assert.equal(h5RecordJs.includes('function showDraftRestoreNotice(restoredDraft, verificationPending)'), true);
  assert.equal(h5RecordJs.includes('已恢复刚才填写的内容，请继续选择照片。'), true);
  assert.equal(h5RecordJs.includes('已恢复刚才填写的内容，请继续预览确认。'), true);
  assert.equal(h5RecordJs.includes('验证成功，请继续完成这条记录。'), true);
  assert.equal(h5RecordJs.includes("switchPhoneBtn.textContent = boundPhone ? '更换手机号' : '验证手机号'"), true);
  assert.equal(h5RecordJs.includes('clearRecordDraft();'), true);
  assert.equal(h5RecordJs.includes("resultTitle.textContent = justSaved ? '保存成功' : '这瓶酒里的记录'"), true);
  assert.equal(h5RecordJs.includes("'以后再扫码，还能回到这一刻'"), true);
  assert.equal(h5RecordJs.includes('formatRecordDate(data.activated_at)'), true);
  assert.equal(h5RecordJs.includes("document.querySelector('.result-success-title')"), false);
  assert.equal(h5RecordJs.includes('resultHashToggle.dataset.certificateUrl'), true);
  assert.equal(h5RecordJs.includes("window.open(targetUrl.href, '_blank', 'noopener,noreferrer')"), true);
  assert.equal(h5RecordJs.includes('查看存证信息'), true);
  assert.equal(normalizedH5RecordJs.includes("if (!userPhone) {\n      window.location.href = registerUrl();\n      return;\n    }\n\n    const batchBrandDisclosureText"), false);
  assert.equal(normalizedH5RecordJs.includes("const restoredDraft = restoreRecordDraft();\n    const verificationPending = hasBoundPhone() ? readVerificationPending() : null;\n    setPageMode('form');\n    showDraftRestoreNotice(restoredDraft, verificationPending);"), true);
  assert.equal(normalizedH5RecordJs.includes("if (!requirePhoneBeforeProtectedAction('upload')) return;\n    imageInput.click();"), true);
  assert.equal(normalizedH5RecordJs.includes("if (!requirePhoneBeforeProtectedAction('replace-photo')) return;\n    imageInput.click();"), true);
  assert.equal(normalizedH5RecordJs.includes("if (!requirePhoneBeforeProtectedAction('submit')) return;\n  openConfirmOverlay();"), true);
  assert.equal(h5RecordJs.includes("document.querySelector('label[for=\"imageInput\"]')"), true);
  assert.equal(h5RecordJs.includes("uploadLabel.addEventListener('click'"), true);
  assert.equal(normalizedH5RecordJs.includes("if (!hasBoundPhone()) {\n      redirectToRegisterWithDraft();\n      return;\n    }\n\n    const confirmed"), true);
  assert.equal(h5RecordJs.includes("showBrandDisclosureInput.addEventListener('change', saveRecordDraft)"), true);
  assert.equal(registerJs.includes("const SUPPORTED_UI_THEMES = new Set(['dark', 'dawn'])"), true);
  assert.equal(registerJs.includes("next.set('ui', uiTheme)"), true);
  assert.equal(registerJs.includes("const SUPPORTED_BG_THEMES = new Set(['mist', 'paper', 'blue'])"), true);
  assert.equal(registerJs.includes("next.set('bg', bgTheme)"), true);
  assert.equal(registerJs.includes("const SUPPORTED_DRAFT_SOURCES = new Set(['upload', 'replace-photo', 'submit'])"), true);
  assert.equal(registerJs.includes("next.set('source', draftSource)"), true);
  assert.equal(registerJs.includes('验证手机号，继续添加照片'), true);
  assert.equal(registerJs.includes('验证手机号，继续保存记录'), true);
  assert.equal(registerJs.includes('验证手机号，继续完成这条记录'), true);
  assert.equal(registerJs.includes('验证后，这条记录会与你的手机号关联，方便以后查看和管理。'), true);
  assert.equal(recordHtml.includes('id="recordPhoneSeparator"'), true);
  assert.equal(recordHtml.includes('id="draftNotice"'), true);
  assert.equal(registerHtml.includes('id="authMethodTitle"'), true);
  assert.equal(registerHtml.includes('id="authMethodSubtitle"'), true);
  assert.equal(themeDawnCss.includes('html.theme-dawn .auth-card.login-card'), true);
  assert.equal(themeDawnCss.includes('html.theme-dawn .auth-container .login-input'), true);
  assert.equal(themeDawnCss.includes('html.theme-dawn .auth-sms-row .btn.sms-btn'), true);
  assert.equal(themeDawnCss.includes('html.theme-dawn .login-card #registerBtn'), true);
  assert.equal(themeDawnCss.includes('background: #C79E55'), true);
  assert.equal(themeDawnCss.includes('color: #A88955'), true);
  assert.equal(recordHtml.includes("const supportedBackgrounds = new Set(['mist', 'paper', 'blue'])"), true);
  assert.equal(recordHtml.includes("document.documentElement.classList.add(`bg-${backgroundParam}`)"), true);
  assert.equal(themeDawnCss.includes('html.theme-dawn.bg-mist body'), true);
  assert.equal(themeDawnCss.includes('html.theme-dawn.bg-paper body'), true);
  assert.equal(themeDawnCss.includes('html.theme-dawn.bg-blue body'), true);
  const dawnOverlayMaskCss = themeDawnCss.match(/html\.theme-dawn \.record-page \.overlay-mask\s*\{[\s\S]*?\}/)?.[0] || '';
  assert.equal(dawnOverlayMaskCss.includes('backdrop-filter: none'), true);
  assert.equal(dawnOverlayMaskCss.includes('-webkit-backdrop-filter: none'), true);
  assert.equal(dawnOverlayMaskCss.includes('blur(10px)'), false);
  assert.equal(themeDawnCss.includes('html.theme-dawn .record-page #resultSection.card'), true);
  assert.equal(themeDawnCss.includes('html.theme-dawn .record-page #resultSection .memory-content'), true);
  assert.equal(themeDawnCss.includes('starBlink'), false);
  assert.equal(chainViewService.includes('存证生成中'), true);
  assert.equal(chainViewService.includes('已完成区块链存证'), true);
  assert.equal(chainViewService.includes('存证暂未完成，系统会继续处理'), true);
  assert.equal(chainViewService.includes('存证生成失败'), false);
  assert.equal(recordJs.includes('wx.getImageInfo'), true);
  assert.equal(recordJs.includes('calculatePreviewHeight'), true);
  assert.equal(recordJs.includes('previewMessage'), true);
  assert.equal(recordJs.includes('wx.showToast({'), true);
  assert.equal(recordJs.includes('showBrandSection'), true);
  assert.equal(recordJs.includes('onBrandDisclosureChange'), true);
  assert.equal(recordJs.includes('show_brand_disclosure'), true);
  assert.equal(recordJs.includes('RECORD_DRAFT_TTL_MS = 24 * 60 * 60 * 1000'), true);
  assert.equal(recordJs.includes("new Set(['upload', 'replace-photo', 'submit'])"), true);
  assert.equal(recordJs.includes('record_draft:${key}'), true);
  assert.equal(recordJs.includes('record_draft:${key}:verify_pending'), true);
  assert.equal(recordJs.includes('wx.chooseMedia'), true);
  assert.equal(recordJs.includes('requirePhoneBeforeProtectedAction(source)'), true);
  assert.equal(recordJs.indexOf('if (!this.requirePhoneBeforeProtectedAction(source)) return;') < recordJs.indexOf('wx.chooseMedia'), true);
  assert.equal(recordJs.includes('function getUnavailableActionMessage(pageState)'), true);
  assert.equal(recordJs.includes('请通过星贴二维码进入。'), true);
  assert.equal(recordJs.includes('没有找到这张星贴，请重新扫码。'), true);
  assert.equal(recordJs.includes('页面尚未加载完成，请稍后重试。'), true);
  assert.equal(recordJs.includes('请通过星贴二维码进入'), true);
  assert.equal(recordJs.includes('没有找到这张星贴'), true);
  assert.equal(miniappQrUtil.includes('function safeDecode(value)'), true);
  assert.equal(miniappQrUtil.includes('function normalizeDirectKey(value)'), true);
  assert.equal(miniappQrUtil.includes('const QR_ACCESS_TOKEN_PATTERN = /^[a-f0-9]{32}$/i'), true);
  assert.equal(miniappQrUtil.includes('const QR_ID_PATTERN = /^[A-Za-z0-9]{2,12}\\d{4,6}$/'), true);
  assert.equal(miniappQrUtil.includes('record\\.html'), true);
  assert.equal(miniappQrUtil.includes('[?&](?:t|key)=([^&#]+)'), true);
  assert.equal(miniappQrUtil.includes("decoded.includes('/')"), true);
  assert.equal(miniappQrUtil.includes('decoded.match(/^\\??(?:t|key)=([^&#]+)(?:[&#].*)?$/)'), true);
  assert.equal(miniappQrUtil.includes('if (options.key) return parseQrKeyValue(options.key);'), true);
  assert.equal(miniappQrUtil.includes('if (options.t) return parseQrKeyValue(options.t);'), true);
  assert.equal(miniappQrUtil.includes('return parseQrKeyValue(options.scene);'), true);
  assert.equal(resultWxml.includes('brand-disclosure-line'), true);
  assert.equal(recordDetailWxml.includes('brand-disclosure-line'), true);
  assert.equal(appWxss.includes('radial-gradient(circle at 12% 0%'), true);
  assert.equal(appWxss.includes('padding-bottom: calc(112rpx + env(safe-area-inset-bottom))'), true);
  assert.equal(appWxss.includes('background: rgba(255, 255, 255, .04)'), true);
  assert.equal(appWxss.includes('-webkit-backdrop-filter: blur(16px)'), true);
  assert.equal(appWxss.includes('backdrop-filter: blur(16px)'), true);
  assert.equal(appWxss.includes('.btn::after'), true);
  assert.equal(appWxss.includes('background: #d4af37'), true);
  assert.equal(resultJs.includes("pageTitle: this.data.justSaved ? '保存成功' : '这瓶酒里的记录'"), true);
  assert.equal(resultJs.includes("'以后再扫码，还能回到这一刻'"), true);
  assert.equal(resultJs.includes('保存于 ${displayDate}'), true);
  assert.equal(resultWxml.includes('{{pageTitle}}'), true);
  assert.equal(resultWxml.includes('{{pageSubtitle}}'), true);
  assert.equal(resultWxml.includes('记在星上，闪到永远'), false);
  assert.equal(resultWxml.includes('open-type="share"'), true);
  assert.equal(resultWxml.includes('bindtap="goMe"'), true);
  assert.equal(resultWxml.includes('bindtap="toggleHash"'), true);
  assert.equal(resultWxml.includes('mode="aspectFit"'), true);
  assert.equal(resultWxss.includes('"Songti SC", STSong, serif'), true);
  assert.equal(resultWxss.includes('-webkit-backdrop-filter: blur(16px)'), false);
  assert.equal(resultWxss.includes('color: #263445'), true);
  assert.equal(resultWxss.includes('font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace'), true);
  assert.equal(recordDetailWxml.includes('记录详情'), true);
  assert.equal(recordDetailWxml.includes('查看这张星贴里的完整记录'), true);
  assert.equal(recordDetailWxml.includes('bindtap="copyHash"'), true);
  assert.equal(recordDetailWxml.includes('bindtap="toggleHash"'), true);
  assert.equal(recordDetailWxml.includes('bindtap="openCertificate"'), true);
  assert.equal(recordDetailWxml.includes('mode="aspectFit"'), true);
  assert.equal(recordDetailWxss.includes('"Songti SC", STSong, serif'), true);
  assert.equal(recordDetailWxss.includes('-webkit-backdrop-filter: blur(16px)'), false);
  assert.equal(recordDetailWxss.includes('overflow-wrap: anywhere'), true);
  assert.equal(meWxml.includes('当前手机号：'), false);
  assert.equal(meWxml.includes('查看你留在酒里的照片和留言'), true);
  assert.equal(meWxml.includes('{{currentPhoneText}}'), true);
  assert.equal(meWxml.includes('星贴 {{item.display_qr_id}}'), true);
  assert.equal(coCreateWxml.includes('这瓶酒正在共创中'), true);
  assert.equal(coCreateWxml.includes('bindtap="submitComment"'), true);
  assert.equal(coCreateWxml.includes('bindtap="finalize"'), true);
  assert.equal(coCreateWxml.includes('bindtap="deleteComment"'), true);
  assert.equal(coCreateWxss.includes('"Songti SC", STSong, serif'), true);
  assert.equal(coCreateWxss.includes('-webkit-backdrop-filter: blur(16px)'), true);
  assert.equal(homeWxml.includes('bindtap="scanCode"'), true);
  assert.equal(homeWxml.includes('bindtap="goProject"'), false);
  assert.equal(homeWxml.includes('bindtap="goProducts"'), true);
  assert.equal(homeWxml.includes('bindtap="copyConsultLink"'), false);
  assert.equal(homeWxml.includes('bindtap="goMe"'), false);
  assert.equal(homeWxml.includes('<button class="btn home-primary-cta" bindtap="goProducts">封存这一刻</button>'), true);
  assert.equal(homeWxml.includes('<button class="btn home-primary-cta" bindtap="scanCode">封存这一刻</button>'), false);
  assert.equal(homeWxml.includes('bindtap="goSceneProducts"'), true);
  assert.equal(homeWxml.includes('bindtap="handleSlideAction"'), true);
  assert.equal(homeWxml.includes('<swiper class="home-carousel"'), true);
  assert.equal(homeWxml.includes('class="home-logo"'), true);
  assert.equal(homeWxml.includes('class="home-slide-image"'), true);
  assert.equal(homeWxml.includes('class="home-scene-image"'), true);
  assert.equal(homeWxml.includes('class="home-brand-mark"'), true);
  assert.equal(homeWxml.includes('{{content.home_title}}'), true);
  assert.equal(homeWxml.includes('酒瓶星贴'), true);
  assert.equal(homeWxml.includes('一张照片'), true);
  assert.equal(homeWxml.includes('一句话'), true);
  assert.equal(homeWxml.includes('封存这一刻'), true);
  assert.equal(homeWxml.includes('购买酒瓶星贴'), false);
  assert.equal(homeWxml.includes('已有星贴，扫码记录'), true);
  assert.equal(homeWxml.includes('class="home-section home-scene-section"'), true);
  assert.equal(homeJs.includes("key: 'lover'"), true);
  assert.equal(homeJs.includes("key: 'elder'"), true);
  assert.equal(homeJs.includes("key: 'birthday'"), true);
  assert.equal(homeJs.includes("key: 'wedding'"), true);
  assert.equal(homeJs.includes("key: 'party'"), true);
  assert.equal(homeWxml.includes('class="home-section home-commerce-section"'), true);
  assert.equal(homeWxml.includes('class="home-section home-trust-section"'), true);
  assert.equal(homeWxml.includes('区块链存证'), true);
  assert.equal(homeWxml.includes('NFT凭证'), false);
  assert.equal(homeWxml.includes('链上存证'), false);
  assert.equal(homeWxml.includes('不可篡改'), true);
  assert.equal(homeWxml.includes('封存后可查看'), true);
  assert.equal(homeWxml.includes('不含酒水'), true);
  assert.equal(homeWxml.includes('购物车'), false);
  assert.equal(homeWxml.includes('home-secondary-actions'), false);
  assert.equal(homeWxml.includes('lazy-load'), true);
  assert.equal(homeJs.includes('onShareTimeline'), true);
  assert.equal(homeJs.includes('handleSlideAction'), true);
  assert.equal(homeJs.includes('this.goProducts();'), true);
  assert.equal(homeJs.includes('normalizeSceneCards'), true);
  assert.equal(homeJs.includes('goProject()'), false);
  assert.equal(homeJs.includes('copyConsultLink()'), false);
  assert.equal(homeJs.includes('goMe()'), false);
  assert.equal(homeJs.includes('hasConsultUrl'), false);
  assert.equal(homeWxml.includes('class="btn home-primary-cta"'), true);
  assert.equal(homeWxss.includes('.home-brand-star'), true);
  assert.equal(homeWxss.includes('.home-carousel'), true);
  assert.equal(homeWxss.includes('.home-scene-list'), true);
  assert.equal(homeWxss.includes('.home-slide-image'), true);
  assert.equal(productsWxml.includes('封存'), true);
  assert.equal(productsWxml.includes('酒瓶星贴'), true);
  assert.equal(productsWxml.includes('不含酒水'), true);
  assert.equal(productsJs.includes("label: '恋人'"), true);
  assert.equal(productsJs.includes("label: '长辈'"), true);
  assert.equal(productsJs.includes("label: '生日'"), true);
  assert.equal(productsJs.includes("label: '婚礼'"), true);
  assert.equal(productsJs.includes("label: '聚会'"), true);
  assert.equal(productsJs.includes("label: '随心'"), true);
  assert.equal(productsWxml.includes('bindtap="changeScene"'), true);
  assert.equal(productsWxml.includes('bindtap="openProduct"'), true);
  assert.equal(productsWxml.includes('class="product-list"'), true);
  assert.equal(productsWxml.includes('class="meta state-card"'), true);
  assert.equal(productsWxml.includes('lazy-load'), true);
  assert.equal(productsJs.includes('onShareAppMessage'), true);
  assert.equal(productsWxml.includes('购物车'), false);
  assert.equal(productsWxss.includes('.products-hero'), true);
  assert.equal(productsWxss.includes('box-shadow: 0 16rpx 36rpx'), true);
  assert.equal(productDetailWxml.includes('立即购买'), true);
  assert.equal(productDetailWxml.includes('不含酒水'), true);
  assert.equal(productDetailWxml.includes('bindtap="buyNow"'), true);
  assert.equal(productDetailJs.includes('/pages/order-confirm/order-confirm'), true);
  assert.equal(productDetailJs.includes('onShareAppMessage'), true);
  assert.equal(productDetailJs.includes('onShareTimeline'), true);
  assert.equal(productDetailWxml.includes('lazy-load'), true);
  assert.equal(productDetailWxml.includes('class="card product-detail-panel"'), true);
  assert.equal(productDetailWxml.includes('购物车'), false);
  assert.equal(orderConfirmWxml.includes('确认订单'), true);
  assert.equal(orderConfirmWxml.includes('立即支付'), true);
  assert.equal(orderConfirmWxml.includes('提交订单并支付'), false);
  assert.equal(orderConfirmWxml.includes('测试环境'), false);
  assert.equal(orderConfirmWxml.includes('模拟支付'), false);
  assert.equal(orderConfirmWxml.includes('正式上线前'), false);
  assert.equal(orderConfirmJs.includes('/api/miniapp/orders'), true);
  assert.equal(orderConfirmJs.includes('wx.requestPayment'), true);
  assert.equal(orderConfirmJs.includes('请填写收货人'), true);
  assert.equal(orderConfirmJs.includes('请填写正确的手机号'), true);
  assert.equal(orderConfirmJs.includes('请选择省市区'), true);
  assert.equal(orderConfirmJs.includes('请填写详细地址'), true);
  assert.equal(orderConfirmJs.includes('已取消支付'), true);
  assert.equal(orderConfirmJs.includes('redirectToBindPhone'), true);
  assert.equal(ordersWxml.includes('我的订单'), true);
  assert.equal(ordersWxml.includes('lazy-load'), true);
  assert.equal(orderDetailWxml.includes('订单详情'), true);
  assert.equal(orderDetailWxml.includes('lazy-load'), true);
  assert.equal(resultJs.includes('onShareTimeline'), true);
  assert.equal(resultWxml.includes('lazy-load'), true);
  assert.equal(recordDetailWxml.includes('lazy-load'), true);
  assert.equal(coCreateWxml.includes('lazy-load'), true);
  assert.equal(meWxml.includes('lazy-load'), true);
  assert.equal(productDetailWxss.includes('height: 480rpx'), true);
  assert.equal(projectWxml.includes('{{content.project_title}}'), true);
  assert.equal(projectWxml.includes('class="card project-card project-card-primary"'), true);
  assert.equal(projectWxml.includes('class="card project-card project-card-secondary"'), true);
  assert.equal(projectWxml.includes('class="meta state-card"'), true);
  assert.equal(projectWxss.includes('line-height: 1.82'), true);
  assert.equal(meWxml.includes('我的记录'), true);
  assert.equal(meWxml.includes('我的订单'), true);
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
  assert.equal(defaultRes.body.data.home_title, '给这瓶酒，贴上一颗星');
  assert.equal(Array.isArray(defaultRes.body.data.home_slides), true);
  assert.equal(Array.isArray(defaultRes.body.data.scene_cards), true);

  const imageData = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZQ1EAAAAASUVORK5CYII=',
    'base64'
  );
  const uploadRes = await postMultipart('/api/admin/upload-image', {
    fields: { scope: 'miniapp-content' },
    files: [
      {
        fieldName: 'image',
        filename: 'miniapp-logo.png',
        contentType: 'image/png',
        content: imageData
      }
    ]
  }, token);
  assert.equal(uploadRes.status, 200);
  assert.ok(uploadRes.body.data.url);

  const updateRes = await postJson('/api/admin/miniapp-content', {
    home_title: '记在星上测试',
    home_subtitle: '测试副标题',
    logo_image: uploadRes.body.data.url,
    home_banner_image: '/uploads/banner.jpg',
    home_slides: [
      {
        image: '/uploads/slide.jpg',
        title: '轮播标题',
        subtitle: '轮播副标题',
        button_text: '去封存',
        action_type: 'scene',
        scene_key: 'lover'
      }
    ],
    scene_cards: [
      {
        key: 'elder',
        label: '长辈',
        title: '长辈场景',
        description: '给长辈的一句话',
        image: '/uploads/elder.jpg',
        button_text: '查看长辈星贴'
      }
    ],
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
  assert.equal(publicRes.body.data.logo_image, uploadRes.body.data.url);
  assert.equal(publicRes.body.data.home_slides[0].scene_key, 'lover');
  assert.equal(publicRes.body.data.scene_cards[0].key, 'elder');
  assert.equal(publicRes.body.data.consult_url, 'https://ktt.example.com/shop');
  assert.equal(Object.hasOwn(publicRes.body.data, 'updated_by'), false);

  const invalidRes = await postJson('/api/admin/miniapp-content', {
    logo_image: 'javascript:alert(1)'
  }, token);
  assert.equal(invalidRes.status, 400);
  assert.equal(invalidRes.body.code, 'VALIDATION_ERROR');
});

test('admin miniapp image upload should reject invalid files and missing cloud public url', async () => {
  const login = await postJson('/api/admin/login', { username: 'admin', password: 'test-admin-pass' });
  const token = login.body.data.token;

  const fakeImageRes = await postMultipart('/api/admin/upload-image', {
    files: [
      {
        fieldName: 'image',
        filename: 'fake.png',
        contentType: 'image/png',
        content: Buffer.from('not a real image')
      }
    ]
  }, token);
  assert.equal(fakeImageRes.status, 400);
  assert.equal(fakeImageRes.body.code, 'UPLOAD_FAILED');

  const largeImageRes = await postMultipart('/api/admin/upload-image', {
    files: [
      {
        fieldName: 'image',
        filename: 'large.png',
        contentType: 'image/png',
        content: Buffer.alloc(5 * 1024 * 1024 + 1)
      }
    ]
  }, token);
  assert.equal(largeImageRes.status, 413);
  assert.equal(largeImageRes.body.code, 'UPLOAD_TOO_LARGE');

  const oldStorageMode = process.env.STORAGE_MODE;
  const oldCloudPublicBaseUrl = process.env.CLOUD_PUBLIC_BASE_URL;
  try {
    process.env.STORAGE_MODE = 'cloud';
    delete process.env.CLOUD_PUBLIC_BASE_URL;
    const imageData = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZQ1EAAAAASUVORK5CYII=',
      'base64'
    );
    const cloudConfigRes = await postMultipart('/api/admin/upload-image', {
      files: [
        {
          fieldName: 'image',
          filename: 'cloud.png',
          contentType: 'image/png',
          content: imageData
        }
      ]
    }, token);
    assert.equal(cloudConfigRes.status, 400);
    assert.equal(cloudConfigRes.body.code, 'STORAGE_PUBLIC_URL_REQUIRED');
  } finally {
    if (oldStorageMode === undefined) delete process.env.STORAGE_MODE;
    else process.env.STORAGE_MODE = oldStorageMode;
    if (oldCloudPublicBaseUrl === undefined) delete process.env.CLOUD_PUBLIC_BASE_URL;
    else process.env.CLOUD_PUBLIC_BASE_URL = oldCloudPublicBaseUrl;
  }
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

test('miniapp WeChat mock should be explicit and never use one fixed phone', async () => {
  const oldEnv = snapshotEnv([
    'NODE_ENV',
    'MINIAPP_MOCK_ENABLED',
    'WECHAT_MINIAPP_APPID',
    'WECHAT_MINIAPP_SECRET'
  ]);
  const {
    codeToSession,
    getPhoneNumberByCode
  } = require('../src/server/services/miniappAuthService');

  try {
    process.env.NODE_ENV = 'development';
    delete process.env.MINIAPP_MOCK_ENABLED;
    delete process.env.WECHAT_MINIAPP_APPID;
    delete process.env.WECHAT_MINIAPP_SECRET;

    await assert.rejects(
      () => codeToSession('mini-no-mock-login'),
      (error) => error.code === 'WECHAT_CONFIG_ERROR'
    );
    await assert.rejects(
      () => getPhoneNumberByCode('mini-no-mock-phone'),
      (error) => error.code === 'WECHAT_CONFIG_ERROR'
    );

    process.env.NODE_ENV = 'production';
    process.env.MINIAPP_MOCK_ENABLED = 'true';
    await assert.rejects(
      () => getPhoneNumberByCode('mini-prod-mock-blocked'),
      (error) => error.code === 'WECHAT_CONFIG_ERROR'
    );

    process.env.NODE_ENV = 'test';
    process.env.MINIAPP_MOCK_ENABLED = 'true';
    const first = await getPhoneNumberByCode('mini-mock-phone-a');
    const firstAgain = await getPhoneNumberByCode('mini-mock-phone-a');
    const second = await getPhoneNumberByCode('mini-mock-phone-b');
    assert.match(first, /^1\d{10}$/);
    assert.equal(first, firstAgain);
    assert.notEqual(first, second);
    assert.notEqual(first, '13800000000');

    const explicit = await getPhoneNumberByCode('13888003001');
    assert.equal(explicit, '13888003001');
  } finally {
    restoreEnv(oldEnv);
  }
});

test('miniapp auth routes should fail closed without explicit mock config', async () => {
  const oldEnv = snapshotEnv([
    'NODE_ENV',
    'MINIAPP_MOCK_ENABLED',
    'WECHAT_MINIAPP_APPID',
    'WECHAT_MINIAPP_SECRET'
  ]);

  try {
    process.env.NODE_ENV = 'development';
    delete process.env.MINIAPP_MOCK_ENABLED;
    delete process.env.WECHAT_MINIAPP_APPID;
    delete process.env.WECHAT_MINIAPP_SECRET;

    const loginRes = await postJson('/api/miniapp/auth/login', { code: 'mini-route-no-mock' });
    assert.equal(loginRes.status, 502);
    assert.equal(loginRes.body.code, 'MINIAPP_WECHAT_NOT_CONFIGURED');
    assert.equal(loginRes.raw.includes('WECHAT_MINIAPP_APPID'), false);
    assert.equal(loginRes.raw.includes('WECHAT_MINIAPP_SECRET'), false);

    process.env.MINIAPP_MOCK_ENABLED = 'true';
    const loginOk = await postJson('/api/miniapp/auth/login', { code: 'mini-route-mock-enabled' });
    assert.equal(loginOk.status, 200);

    delete process.env.MINIAPP_MOCK_ENABLED;
    const bindRes = await postJson('/api/miniapp/auth/bind-phone', {
      code: 'mini-route-phone-code'
    }, loginOk.body.data.token);
    assert.equal(bindRes.status, 503);
    assert.equal(bindRes.body.code, 'MINIAPP_WECHAT_NOT_CONFIGURED');
    assert.equal(bindRes.body.message, '暂时无法获取微信手机号，请稍后重试。');
    assert.equal(bindRes.raw.includes('mini-route-phone-code'), false);
  } finally {
    restoreEnv(oldEnv);
  }
});

test('miniapp auth should login, reject bad token, and bind phone', async () => {
  const loginRes = await postJson('/api/miniapp/auth/login', { code: 'mini-auth' });
  assert.equal(loginRes.status, 200);
  assert.equal(loginRes.body.data.phone_bound, false);
  assert.ok(loginRes.body.data.token);
  const loginPayload = decodeJwtPayload(loginRes.body.data.token);
  assert.ok(loginPayload.account_id);
  const { getDatabaseSnapshot } = require('../src/server/services/dbService');
  let db = getDatabaseSnapshot();
  const accountsBeforeRepeat = db.accounts.length;
  const repeatLogin = await postJson('/api/miniapp/auth/login', { code: 'mini-auth' });
  assert.equal(repeatLogin.status, 200);
  db = getDatabaseSnapshot();
  assert.equal(db.users.filter((item) => item.openid === 'mock-openid-mini-auth').length, 1);
  assert.equal(db.accounts.length, accountsBeforeRepeat);

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

test('miniapp login should fail closed on duplicate openid identity', async () => {
  const {
    getDatabaseSnapshot,
    writeDatabaseSnapshot
  } = require('../src/server/services/dbService');

  const loginCode = 'mini-duplicate-openid-login';
  const duplicateOpenid = `mock-openid-${loginCode}`;
  let db = getDatabaseSnapshot();
  const nextUserId = Math.max(...db.users.map((item) => Number(item.id) || 0), 0) + 1;
  const userA = {
    id: nextUserId,
    phone: null,
    openid: duplicateOpenid,
    unionid: null,
    source: 'miniapp',
    created_at: '2026-07-27T00:00:02.000Z'
  };
  const userB = {
    id: nextUserId + 1,
    phone: '13900139999',
    openid: duplicateOpenid,
    unionid: null,
    source: 'web+miniapp',
    created_at: '2026-07-27T00:00:03.000Z'
  };
  attachTestAccount(db, userA, 'miniapp_openid');
  attachTestAccount(db, userB, 'web_phone');
  db.users.push(userA, userB);
  writeDatabaseSnapshot(db);

  const beforeLogin = JSON.stringify(getDatabaseSnapshot());
  const loginRes = await postJson('/api/miniapp/auth/login', { code: loginCode });
  assert.equal(loginRes.status, 409);
  assert.equal(loginRes.body.code, 'DUPLICATE_OPENID_IDENTITY');
  assert.equal(loginRes.body.data && loginRes.body.data.token, undefined);
  assert.equal(JSON.stringify(getDatabaseSnapshot()), beforeLogin);
});

test('miniapp tokens should verify account mapping from database context', async () => {
  const {
    getDatabaseSnapshot,
    writeDatabaseSnapshot
  } = require('../src/server/services/dbService');
  const { verifyMiniappToken } = require('../src/server/services/miniappAuthService');

  const token = await loginMiniappAndGetToken('mini-account-context');
  let db = getDatabaseSnapshot();
  const user = db.users.find((item) => item.openid === 'mock-openid-mini-account-context');
  assert.ok(user.account_id);
  const payload = verifyMiniappToken(token);
  assert.equal(payload.id, user.id);
  assert.equal(payload.openid, user.openid);
  assert.equal(payload.account_id, user.account_id);

  const oldToken = makeMiniappTokenForUser(user, { account_id: undefined });
  assert.equal(verifyMiniappToken(oldToken).account_id, null);
  const oldTokenRes = await postJson('/api/miniapp/auth/sms/send-code', { phone: '13888003101' }, oldToken);
  assert.equal(oldTokenRes.status, 200);

  const wrongAccountToken = makeMiniappTokenForUser(user, { account_id: 'ACC999999' });
  const wrongAccountRes = await postJson('/api/miniapp/auth/sms/send-code', { phone: '13888003102' }, wrongAccountToken);
  assert.equal(wrongAccountRes.status, 401);

  const wrongOpenidToken = makeMiniappTokenForUser(user, { openid: 'mock-openid-wrong-account-context' });
  const wrongOpenidRes = await postJson('/api/miniapp/auth/sms/send-code', { phone: '13888003103' }, wrongOpenidToken);
  assert.equal(wrongOpenidRes.status, 401);

  const wrongUserToken = makeMiniappTokenForUser(user, { id: 'missing-user-id' });
  const wrongUserRes = await postJson('/api/miniapp/auth/sms/send-code', { phone: '13888003104' }, wrongUserToken);
  assert.equal(wrongUserRes.status, 401);

  db = getDatabaseSnapshot();
  db.users = db.users.map((item) =>
    item.id === user.id ? { ...item, account_id: null } : item
  );
  writeDatabaseSnapshot(db);
  const missingAccountRes = await postJson('/api/miniapp/auth/sms/send-code', { phone: '13888003105' }, oldToken);
  assert.equal(missingAccountRes.status, 401);

  const reloginRes = await postJson('/api/miniapp/auth/login', { code: 'mini-account-context' });
  assert.equal(reloginRes.status, 409);
  assert.equal(reloginRes.body.code, 'ACCOUNT_MAPPING_REQUIRED');
});

test('miniapp sms fallback should send codes and bind first-time users without H5 session', async () => {
  const { verifyMiniappToken } = require('../src/server/services/miniappAuthService');

  const token = await loginMiniappAndGetToken('mini-sms-first-bind');
  const unauthedSend = await postJson('/api/miniapp/auth/sms/send-code', { phone: '13888002001' });
  assert.equal(unauthedSend.status, 401);

  const invalidSend = await postJson('/api/miniapp/auth/sms/send-code', { phone: '123' }, token);
  assert.equal(invalidSend.status, 400);
  assert.equal(invalidSend.body.code, 'INVALID_PHONE');
  assert.equal(invalidSend.body.message, '请输入正确的手机号。');

  const sendRes = await postJson('/api/miniapp/auth/sms/send-code', { phone: '13888002001' }, token);
  assert.equal(sendRes.status, 200);
  assert.equal(sendRes.body.data.sent, true);
  assert.ok(sendRes.body.data.verification_code);
  assert.equal(sendRes.headers['set-cookie'], undefined);

  const cooldownRes = await postJson('/api/miniapp/auth/sms/send-code', { phone: '13888002001' }, token);
  assert.equal(cooldownRes.status, 429);
  assert.equal(cooldownRes.body.code, 'SMS_SEND_TOO_FREQUENT');
  assert.equal(cooldownRes.body.message, '操作太频繁，请稍后再试。');

  const wrongCodeRes = await postJson('/api/miniapp/auth/sms/bind-phone', {
    phone: '13888002001',
    code: '000000'
  }, token);
  assert.equal(wrongCodeRes.status, 400);
  assert.equal(wrongCodeRes.body.code, 'INVALID_VERIFY_CODE');
  assert.equal(wrongCodeRes.body.message, '验证码不正确或已过期，请重新获取。');

  const bindRes = await postJson('/api/miniapp/auth/sms/bind-phone', {
    phone: '13888002001',
    code: sendRes.body.data.verification_code
  }, token);
  assert.equal(bindRes.status, 200);
  assert.equal(bindRes.body.data.phone_bound, true);
  assert.equal(bindRes.body.data.phone, '13888002001');
  assert.equal(bindRes.headers['set-cookie'], undefined);
  const payload = verifyMiniappToken(bindRes.body.data.token);
  assert.ok(payload);
  assert.equal(payload.phone, '13888002001');

  const repeatSend = await postJson('/api/miniapp/auth/sms/send-code', { phone: '13888002001' }, bindRes.body.data.token);
  assert.equal(repeatSend.status, 200);
  const repeatBind = await postJson('/api/miniapp/auth/sms/bind-phone', {
    phone: '13888002001',
    code: repeatSend.body.data.verification_code
  }, bindRes.body.data.token);
  assert.equal(repeatBind.status, 200);
  assert.equal(repeatBind.body.data.phone, '13888002001');
});

test('miniapp sms fallback should reuse safe binding conflict rules', async () => {
  const {
    getDatabaseSnapshot,
    writeDatabaseSnapshot
  } = require('../src/server/services/dbService');
  const { verifyMiniappToken } = require('../src/server/services/miniappAuthService');

  const ownerToken = await loginMiniappBindPhoneAndGetToken({
    code: 'mini-sms-conflict-owner',
    phone: '13888002010'
  });
  const conflictToken = await loginMiniappAndGetToken('mini-sms-conflict-claimant');
  const conflictSend = await postJson('/api/miniapp/auth/sms/send-code', { phone: '13888002010' }, conflictToken);
  assert.equal(conflictSend.status, 200);
  const conflictBind = await postJson('/api/miniapp/auth/sms/bind-phone', {
    phone: '13888002010',
    code: conflictSend.body.data.verification_code
  }, conflictToken);
  assert.equal(conflictBind.status, 409);
  assert.equal(conflictBind.body.code, 'PHONE_ALREADY_BOUND_TO_OTHER_WECHAT');
  assert.equal(conflictBind.body.message, '这个手机号已关联其他微信账号，暂时无法绑定。');

  let db = getDatabaseSnapshot();
  assert.equal(db.users.filter((item) => item.phone === '13888002010').length, 1);
  assert.ok(db.users.find((item) => item.openid === 'mock-openid-mini-sms-conflict-claimant' && !item.phone));
  assert.ok(verifyMiniappToken(ownerToken));

  const replaceToken = await loginMiniappBindPhoneAndGetToken({
    code: 'mini-sms-replace-blocked',
    phone: '13888002011'
  });
  const replaceSend = await postJson('/api/miniapp/auth/sms/send-code', { phone: '13888002012' }, replaceToken);
  assert.equal(replaceSend.status, 200);
  const replaceBind = await postJson('/api/miniapp/auth/sms/bind-phone', {
    phone: '13888002012',
    code: replaceSend.body.data.verification_code
  }, replaceToken);
  assert.equal(replaceBind.status, 409);
  assert.equal(replaceBind.body.code, 'MINIAPP_PHONE_REPLACE_REQUIRED');
  assert.equal(replaceBind.body.message, '当前微信账号已绑定手机号，更换手机号功能暂未开放。');
  db = getDatabaseSnapshot();
  assert.ok(db.users.find((item) => item.openid === 'mock-openid-mini-sms-replace-blocked' && item.phone === '13888002011'));
  assert.equal(db.users.some((item) => item.openid === 'mock-openid-mini-sms-replace-blocked' && item.phone === '13888002012'), false);

  const webPhone = '13888002013';
  const webRecordId = 'SMSWEB001';
  const nextUserId = Math.max(...db.users.map((item) => Number(item.id) || 0), 0) + 1;
  const smsWebUser = {
    id: nextUserId,
    phone: webPhone,
    openid: null,
    unionid: null,
    source: 'web',
    created_at: '2026-07-25T00:00:00.000Z'
  };
  attachTestAccount(db, smsWebUser, 'web_phone');
  db.users.push(smsWebUser);
  db.qr_codes.push({
    id: webRecordId,
    issue_status: 'issued',
    activation_status: 'activated',
    hidden: false,
    content: '短信关联 web 历史记录',
    image_url: '/uploads/sms-web-old.jpg',
    image_object_key: null,
    phone: webPhone,
    activated_at: '2026-07-25T00:00:00.000Z',
    blockchain_hash: null,
    co_creation_enabled: false,
    co_creation_owner_phone: null,
    co_creation_comments: [],
    show_brand_disclosure: false,
    brand_disclosure_text_snapshot: '',
    qr_access_token: null,
    created_at: '2026-07-25T00:00:00.000Z'
  });
  writeDatabaseSnapshot(db);

  const webToken = await loginMiniappAndGetToken('mini-sms-web-canonical');
  const webSend = await postJson('/api/miniapp/auth/sms/send-code', { phone: webPhone }, webToken);
  assert.equal(webSend.status, 200);
  const webBind = await postJson('/api/miniapp/auth/sms/bind-phone', {
    phone: webPhone,
    code: webSend.body.data.verification_code
  }, webToken);
  assert.equal(webBind.status, 200);
  assert.equal(webBind.body.data.phone, webPhone);
  const canonicalPayload = verifyMiniappToken(webBind.body.data.token);
  assert.ok(canonicalPayload);
  assert.equal(canonicalPayload.id, nextUserId);
  assert.equal(canonicalPayload.openid, 'mock-openid-mini-sms-web-canonical');
  assert.equal(canonicalPayload.phone, webPhone);

  db = getDatabaseSnapshot();
  const canonicalUsers = db.users.filter((item) => item.phone === webPhone);
  assert.equal(canonicalUsers.length, 1);
  assert.equal(canonicalUsers[0].id, nextUserId);
  assert.equal(canonicalUsers[0].openid, 'mock-openid-mini-sms-web-canonical');
  assert.equal(canonicalUsers[0].source, 'web+miniapp');
  assert.equal(db.users.some((item) => item.openid === 'mock-openid-mini-sms-web-canonical' && !item.phone), false);

  const webCookie = await loginUserAndGetCookie(webPhone);
  const h5Records = await getJsonWithCookie('/api/user/records', webCookie);
  assert.equal(h5Records.status, 200);
  assert.ok(h5Records.body.data.records.some((item) => item.id === webRecordId));

  const miniRecords = await getJson('/api/miniapp/user/records', webBind.body.data.token);
  assert.equal(miniRecords.status, 200);
  assert.ok(miniRecords.body.data.records.some((item) => item.id === webRecordId));
});

test('miniapp bind phone should be idempotent and protect canonical web accounts', async () => {
  const {
    getDatabaseSnapshot,
    writeDatabaseSnapshot
  } = require('../src/server/services/dbService');
  const { verifyMiniappToken } = require('../src/server/services/miniappAuthService');

  const tokenA = await loginMiniappAndGetToken('mini-safe-bind-a');
  const bindA = await postJson('/api/miniapp/auth/bind-phone', {
    code: '13888001001'
  }, tokenA);
  assert.equal(bindA.status, 200);
  assert.equal(bindA.body.data.phone, '13888001001');

  const repeatA = await postJson('/api/miniapp/auth/bind-phone', {
    code: '13888001001'
  }, bindA.body.data.token);
  assert.equal(repeatA.status, 200);
  assert.equal(repeatA.body.data.phone, '13888001001');

  const replaceA = await postJson('/api/miniapp/auth/bind-phone', {
    code: '13888001002'
  }, repeatA.body.data.token);
  assert.equal(replaceA.status, 409);
  assert.equal(replaceA.body.code, 'MINIAPP_PHONE_REPLACE_REQUIRED');
  assert.equal(replaceA.body.message, '当前微信账号已绑定其他手机号，如需修改，请使用更换手机号功能。');

  const conflictToken = await loginMiniappAndGetToken('mini-safe-bind-conflict');
  const conflict = await postJson('/api/miniapp/auth/bind-phone', {
    code: '13888001001'
  }, conflictToken);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'PHONE_ALREADY_BOUND_TO_OTHER_WECHAT');
  assert.equal(conflict.body.message, '这个手机号已关联其他微信账号，暂时无法绑定。');

  let db = getDatabaseSnapshot();
  assert.equal(db.users.filter((item) => item.phone === '13888001001').length, 1);
  assert.ok(db.users.find((item) => item.openid === 'mock-openid-mini-safe-bind-conflict' && !item.phone));

  const webPhone = '13888001003';
  const webRecordId = 'WEBBIND001';
  const nextUserId = Math.max(...db.users.map((item) => Number(item.id) || 0), 0) + 1;
  const safeWebUser = {
    id: nextUserId,
    phone: webPhone,
    openid: null,
    unionid: null,
    source: 'web',
    created_at: '2026-07-25T00:00:00.000Z'
  };
  attachTestAccount(db, safeWebUser, 'web_phone');
  db.users.push(safeWebUser);
  db.qr_codes.push({
    id: webRecordId,
    issue_status: 'issued',
    activation_status: 'activated',
    hidden: false,
    content: 'web 历史记录',
    image_url: '/uploads/web-old.jpg',
    image_object_key: null,
    phone: webPhone,
    activated_at: '2026-07-25T00:00:00.000Z',
    blockchain_hash: null,
    co_creation_enabled: false,
    co_creation_owner_phone: null,
    co_creation_comments: [],
    show_brand_disclosure: false,
    brand_disclosure_text_snapshot: '',
    qr_access_token: null,
    created_at: '2026-07-25T00:00:00.000Z'
  });
  writeDatabaseSnapshot(db);

  const tokenB = await loginMiniappAndGetToken('mini-safe-bind-web');
  const bindWeb = await postJson('/api/miniapp/auth/bind-phone', {
    code: webPhone
  }, tokenB);
  assert.equal(bindWeb.status, 200);
  assert.equal(bindWeb.body.data.phone, webPhone);
  const canonicalTokenPayload = verifyMiniappToken(bindWeb.body.data.token);
  assert.ok(canonicalTokenPayload);
  assert.equal(canonicalTokenPayload.openid, 'mock-openid-mini-safe-bind-web');
  assert.equal(canonicalTokenPayload.phone, webPhone);
  assert.equal(canonicalTokenPayload.id, nextUserId);

  db = getDatabaseSnapshot();
  const canonicalUsers = db.users.filter((item) => item.phone === webPhone);
  assert.equal(canonicalUsers.length, 1);
  assert.equal(canonicalUsers[0].id, nextUserId);
  assert.equal(canonicalUsers[0].openid, 'mock-openid-mini-safe-bind-web');
  assert.equal(canonicalUsers[0].source, 'web+miniapp');
  assert.equal(db.users.some((item) => item.openid === 'mock-openid-mini-safe-bind-web' && !item.phone), false);

  const webCookie = await loginUserAndGetCookie(webPhone);
  const h5Records = await getJsonWithCookie('/api/user/records', webCookie);
  assert.equal(h5Records.status, 200);
  assert.ok(h5Records.body.data.records.some((item) => item.id === webRecordId));

  const miniRecords = await getJson('/api/miniapp/user/records', bindWeb.body.data.token);
  assert.equal(miniRecords.status, 200);
  assert.ok(miniRecords.body.data.records.some((item) => item.id === webRecordId));
});

test('miniapp bind phone should reject abnormal data and unsafe phone auth failures', async () => {
  const {
    getDatabaseSnapshot,
    writeDatabaseSnapshot
  } = require('../src/server/services/dbService');

  let db = getDatabaseSnapshot();
  const duplicatePhone = '13888001011';
  let nextId = Math.max(...db.users.map((item) => Number(item.id) || 0), 0) + 1;
  db.users.push(
    {
      id: nextId,
      phone: duplicatePhone,
      openid: null,
      unionid: null,
      source: 'web',
      created_at: '2026-07-25T00:00:00.000Z'
    },
    {
      id: nextId + 1,
      phone: duplicatePhone,
      openid: null,
      unionid: null,
      source: 'web',
      created_at: '2026-07-25T00:00:01.000Z'
    }
  );
  writeDatabaseSnapshot(db);

  const duplicatePhoneToken = await loginMiniappAndGetToken('mini-safe-duplicate-phone');
  const duplicatePhoneRes = await postJson('/api/miniapp/auth/bind-phone', {
    code: duplicatePhone
  }, duplicatePhoneToken);
  assert.equal(duplicatePhoneRes.status, 409);
  assert.equal(duplicatePhoneRes.body.code, 'MINIAPP_ACCOUNT_CONFLICT');
  db = getDatabaseSnapshot();
  assert.equal(db.users.filter((item) => item.phone === duplicatePhone).length, 2);

  const duplicateOpenidToken = await loginMiniappAndGetToken('mini-safe-duplicate-openid');
  db = getDatabaseSnapshot();
  nextId = Math.max(...db.users.map((item) => Number(item.id) || 0), 0) + 1;
  db.users.push({
    id: nextId,
    phone: null,
    openid: 'mock-openid-mini-safe-duplicate-openid',
    unionid: null,
    source: 'miniapp',
    created_at: '2026-07-25T00:00:02.000Z'
  });
  writeDatabaseSnapshot(db);
  const duplicateOpenidRes = await postJson('/api/miniapp/auth/bind-phone', {
    code: '13888001012'
  }, duplicateOpenidToken);
  assert.equal(duplicateOpenidRes.status, 409);
  assert.equal(duplicateOpenidRes.body.code, 'MINIAPP_ACCOUNT_CONFLICT');

  db = getDatabaseSnapshot();
  const abnormalPhone = '13888001013';
  nextId = Math.max(...db.users.map((item) => Number(item.id) || 0), 0) + 1;
  db.users.push({
    id: nextId,
    phone: abnormalPhone,
    openid: null,
    unionid: null,
    source: 'miniapp',
    created_at: '2026-07-25T00:00:03.000Z'
  });
  writeDatabaseSnapshot(db);
  const abnormalToken = await loginMiniappAndGetToken('mini-safe-abnormal-phone-user');
  const abnormalRes = await postJson('/api/miniapp/auth/bind-phone', {
    code: abnormalPhone
  }, abnormalToken);
  assert.equal(abnormalRes.status, 409);
  assert.equal(abnormalRes.body.code, 'MINIAPP_ACCOUNT_CONFLICT');

  db = getDatabaseSnapshot();
  const blockedPhone = '13888001014';
  nextId = Math.max(...db.users.map((item) => Number(item.id) || 0), 0) + 1;
  db.users.push({
    id: nextId,
    phone: blockedPhone,
    openid: null,
    unionid: null,
    source: 'web',
    created_at: '2026-07-25T00:00:04.000Z'
  });
  writeDatabaseSnapshot(db);
  const blockedToken = await loginMiniappAndGetToken('mini-safe-blocked-temp');
  db = getDatabaseSnapshot();
  db.orders.push({
    id: 'ORDER_SAFE_BLOCKED_TEMP',
    openid: 'mock-openid-mini-safe-blocked-temp',
    phone: '',
    product_id: '',
    product_snapshot: {},
    quantity: 1,
    unit_price_cents: 0,
    total_amount_cents: 0,
    status: 'pending_payment',
    payment_status: 'unpaid',
    created_at: '2026-07-25T00:00:05.000Z',
    updated_at: '2026-07-25T00:00:05.000Z'
  });
  writeDatabaseSnapshot(db);
  const blockedRes = await postJson('/api/miniapp/auth/bind-phone', {
    code: blockedPhone
  }, blockedToken);
  assert.equal(blockedRes.status, 409);
  assert.equal(blockedRes.body.code, 'MINIAPP_ACCOUNT_CONFLICT');
  db = getDatabaseSnapshot();
  assert.ok(db.users.find((item) => item.phone === blockedPhone && !item.openid));
  assert.ok(db.users.find((item) => item.openid === 'mock-openid-mini-safe-blocked-temp' && !item.phone));

  const mappedTempPhone = '13888001015';
  nextId = Math.max(...db.users.map((item) => Number(item.id) || 0), 0) + 1;
  db.users.push({
    id: nextId,
    phone: mappedTempPhone,
    openid: null,
    unionid: null,
    source: 'web',
    created_at: '2026-07-25T00:00:06.000Z'
  });
  writeDatabaseSnapshot(db);
  const mappedTempToken = await loginMiniappAndGetToken('mini-safe-mapped-temp');
  db = getDatabaseSnapshot();
  db.users = db.users.map((item) =>
    item.openid === 'mock-openid-mini-safe-mapped-temp'
      ? { ...item, account_id: 'ACC888888' }
      : item
  );
  db.accounts = [
    ...(Array.isArray(db.accounts) ? db.accounts : []),
    {
      id: 'ACC888888',
      status: 'active',
      display_name: '',
      avatar_url: '',
      created_from: 'miniapp_openid',
      created_at: '2026-07-25T00:00:07.000Z',
      updated_at: '2026-07-25T00:00:07.000Z'
    }
  ];
  writeDatabaseSnapshot(db);
  const mappedTempRes = await postJson('/api/miniapp/auth/bind-phone', {
    code: mappedTempPhone
  }, mappedTempToken);
  assert.equal(mappedTempRes.status, 401);
  assert.equal(mappedTempRes.body.code, 'UNAUTHORIZED');
  db = getDatabaseSnapshot();
  assert.ok(db.users.find((item) => item.phone === mappedTempPhone && !item.openid));
  assert.ok(db.users.find((item) => item.openid === 'mock-openid-mini-safe-mapped-temp' && item.account_id === 'ACC888888'));

  const authFailureToken = await loginMiniappAndGetToken('mini-safe-auth-failure');
  const noCodeRes = await postJson('/api/miniapp/auth/bind-phone', { code: '' }, authFailureToken);
  assert.equal(noCodeRes.status, 400);
  assert.equal(noCodeRes.body.code, 'INVALID_PHONE_CODE');
  assert.equal(noCodeRes.body.message, '未获取到微信手机号，请再次尝试。');
  assert.equal(noCodeRes.raw.includes('INVALID_PHONE_CODE'), true);
  assert.equal(noCodeRes.raw.includes('微信 code'), false);

  const badCodeRes = await postJson('/api/miniapp/auth/bind-phone', { code: 'bad-phone-code' }, authFailureToken);
  assert.equal(badCodeRes.status, 502);
  assert.equal(badCodeRes.body.code, 'PHONE_BIND_FAILED');
  assert.equal(badCodeRes.body.message, '暂时无法获取微信手机号，请稍后重试。');
  assert.equal(badCodeRes.raw.includes('bad-phone-code'), false);
});

test('miniapp bind phone should allow only one concurrent claimant per phone', async () => {
  const phone = '13888001021';
  const tokenA = await loginMiniappAndGetToken('mini-safe-race-a');
  const tokenB = await loginMiniappAndGetToken('mini-safe-race-b');
  const responses = await Promise.all([
    postJson('/api/miniapp/auth/bind-phone', { code: phone }, tokenA),
    postJson('/api/miniapp/auth/bind-phone', { code: phone }, tokenB)
  ]);
  const successes = responses.filter((item) => item.status === 200);
  const rejections = responses.filter((item) => item.status !== 200);
  assert.equal(successes.length, 1);
  assert.equal(rejections.length, 1);
  assert.equal(rejections[0].status, 409);
  assert.ok(['PHONE_ALREADY_BOUND_TO_OTHER_WECHAT', 'MINIAPP_ACCOUNT_CONFLICT'].includes(rejections[0].body.code));

  const { getDatabaseSnapshot } = require('../src/server/services/dbService');
  const db = getDatabaseSnapshot();
  assert.equal(db.users.filter((item) => item.phone === phone).length, 1);
});

test('account migration dry-run and apply should create stable account mappings without moving data', () => {
  const {
    summarizeDbForAccountMigration,
    applyAccountMigrationToSnapshot
  } = require('../src/server/services/accountMigrationService');

  const db = {
    users: [
      {
        id: 10,
        phone: '13888003001',
        openid: null,
        unionid: null,
        source: 'web',
        created_at: '2026-07-26T00:00:00.000Z'
      },
      {
        id: 11,
        phone: null,
        openid: 'mock-openid-account-temp',
        unionid: null,
        source: 'miniapp',
        created_at: '2026-07-26T00:00:01.000Z'
      },
      {
        id: 12,
        phone: '13888003002',
        openid: 'mock-openid-account-bound',
        unionid: null,
        source: 'web+miniapp',
        created_at: '2026-07-26T00:00:02.000Z'
      }
    ],
    accounts: [],
    meta: { next_account_id: 5 },
    orders: [
      {
        id: 'ORDER_ACCOUNT_TEMP',
        openid: 'mock-openid-account-temp',
        status: 'pending_payment'
      }
    ],
    qr_codes: [
      {
        id: 'ACCOUNTREC001',
        activation_status: 'activated',
        phone: '13888003001'
      }
    ]
  };

  const summary = summarizeDbForAccountMigration(db);
  assert.equal(summary.can_apply, true);
  assert.equal(summary.mappable_users, 3);
  assert.equal(summary.temporary_users_with_orders.length, 1);
  assert.equal(summary.temporary_users_with_orders[0].order_ids[0], 'ORDER_ACCOUNT_TEMP');
  assert.equal(Object.prototype.hasOwnProperty.call(db.users[0], 'account_id'), false);

  const result = applyAccountMigrationToSnapshot(db);
  assert.equal(result.summary.created_accounts, 3);
  assert.equal(result.summary.mapped_users_in_run, 3);
  assert.deepEqual(result.db.accounts.map((item) => item.id), ['ACC000005', 'ACC000006', 'ACC000007']);
  assert.deepEqual(result.db.users.map((item) => item.account_id), ['ACC000005', 'ACC000006', 'ACC000007']);
  assert.equal(result.db.meta.accounts_migration_version, 'accounts_foundation_v1');
  assert.match(result.db.meta.accounts_migrated_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(result.db.accounts[0].created_from, 'web_phone');
  assert.equal(result.db.accounts[1].created_from, 'miniapp_openid');
  assert.equal(result.db.accounts[2].created_from, 'migration');
  assert.equal(result.db.orders[0].openid, 'mock-openid-account-temp');
  assert.equal(result.db.qr_codes[0].phone, '13888003001');

  const repeat = applyAccountMigrationToSnapshot(result.db);
  assert.equal(repeat.summary.created_accounts, 0);
  assert.equal(repeat.summary.mapped_users_in_run, 0);
  assert.equal(repeat.db.accounts.length, 3);
  assert.equal(repeat.db.meta.accounts_migrated_at, result.db.meta.accounts_migrated_at);
  assert.deepEqual(repeat.db.users.map((item) => item.account_id), ['ACC000005', 'ACC000006', 'ACC000007']);
});

test('account migration should fail closed on duplicate or ambiguous users with masked report', () => {
  const {
    summarizeDbForAccountMigration,
    applyAccountMigrationToSnapshot
  } = require('../src/server/services/accountMigrationService');

  const duplicatePhone = '13888003011';
  const duplicateOpenid = 'mock-openid-account-duplicate-secret';
  const db = {
    users: [
      { id: 20, phone: duplicatePhone, openid: null, source: 'web' },
      { id: 21, phone: duplicatePhone, openid: null, source: 'web' },
      { id: 22, phone: null, openid: duplicateOpenid, source: 'miniapp' },
      { id: 23, phone: null, openid: duplicateOpenid, source: 'miniapp' },
      { id: 24, phone: null, openid: null, source: 'web' },
      { id: 25, phone: '13888003012', openid: null, source: 'web', account_id: 'ACC999999' }
    ],
    accounts: [],
    meta: { next_account_id: 1 },
    orders: [],
    qr_codes: []
  };

  const summary = summarizeDbForAccountMigration(db);
  assert.equal(summary.can_apply, false);
  assert.ok(summary.blocked_reasons.includes('duplicate_phone'));
  assert.ok(summary.blocked_reasons.includes('duplicate_openid'));
  assert.ok(summary.blocked_reasons.includes('user_without_identity'));
  assert.ok(summary.blocked_reasons.includes('missing_account_reference'));
  const rawSummary = JSON.stringify(summary);
  assert.equal(rawSummary.includes(duplicatePhone), false);
  assert.equal(rawSummary.includes(duplicateOpenid), false);
  assert.equal(summary.duplicate_phone_groups[0].value, '138****3011');
  assert.match(summary.duplicate_openid_groups[0].value, /^mock-o\.\.\./);

  assert.throws(
    () => applyAccountMigrationToSnapshot(db),
    (error) => error && error.code === 'ACCOUNT_MIGRATION_BLOCKED'
  );
});

test('account migration should fail closed on duplicate user ids with masked report', () => {
  const {
    summarizeDbForAccountMigration,
    applyAccountMigrationToSnapshot
  } = require('../src/server/services/accountMigrationService');

  const duplicatePhone = '13888003061';
  const duplicateOpenid = 'mock-openid-duplicate-user-id-secret';
  const identicalRow = {
    id: 60,
    phone: duplicatePhone,
    openid: duplicateOpenid,
    unionid: null,
    source: 'web+miniapp',
    created_at: '2026-07-26T00:00:00.000Z'
  };
  const identicalDb = {
    users: [
      { ...identicalRow },
      { ...identicalRow }
    ],
    accounts: [],
    meta: { next_account_id: 1 },
    orders: [],
    qr_codes: []
  };

  const identicalSummary = summarizeDbForAccountMigration(identicalDb);
  assert.equal(identicalSummary.can_apply, false);
  assert.ok(identicalSummary.blocked_reasons.includes('duplicate_user_id'));
  assert.ok(identicalSummary.blocked_reasons.includes('duplicate_phone'));
  assert.ok(identicalSummary.blocked_reasons.includes('duplicate_openid'));
  assert.equal(identicalSummary.duplicate_user_id_groups.length, 1);
  assert.equal(identicalSummary.duplicate_user_id_groups[0].id, '60');
  assert.equal(identicalSummary.duplicate_user_id_groups[0].count, 2);
  assert.deepEqual(identicalSummary.duplicate_user_id_groups[0].array_indexes, [0, 1]);
  assert.deepEqual(identicalSummary.duplicate_user_id_groups[0].masked_phones, ['138****3061']);
  assert.match(identicalSummary.duplicate_user_id_groups[0].masked_openids[0], /^mock-o\.\.\./);
  assert.equal(identicalSummary.duplicate_user_id_groups[0].rows_identical, true);
  const identicalRawSummary = JSON.stringify(identicalSummary);
  assert.equal(identicalRawSummary.includes(duplicatePhone), false);
  assert.equal(identicalRawSummary.includes(duplicateOpenid), false);

  assert.throws(
    () => applyAccountMigrationToSnapshot(identicalDb),
    (error) => error && error.code === 'ACCOUNT_MIGRATION_BLOCKED'
  );

  const differentDb = {
    users: [
      {
        id: 61,
        phone: '13888003062',
        openid: 'mock-openid-duplicate-user-id-a',
        source: 'web+miniapp'
      },
      {
        id: 61,
        phone: '13888003063',
        openid: 'mock-openid-duplicate-user-id-b',
        source: 'web+miniapp'
      }
    ],
    accounts: [],
    meta: { next_account_id: 1 },
    orders: [],
    qr_codes: []
  };

  const differentSummary = summarizeDbForAccountMigration(differentDb);
  assert.equal(differentSummary.can_apply, false);
  assert.deepEqual(differentSummary.blocked_reasons, ['duplicate_user_id']);
  assert.equal(differentSummary.duplicate_user_id_groups[0].rows_identical, false);
  assert.deepEqual(differentSummary.duplicate_user_id_groups[0].array_indexes, [0, 1]);

  assert.throws(
    () => applyAccountMigrationToSnapshot(differentDb),
    (error) => error && error.code === 'ACCOUNT_MIGRATION_BLOCKED'
  );
});

test('account migration file apply should be atomic, guarded, and leave dry-run untouched', () => {
  const {
    auditAccountMigration,
    applyAccountMigration
  } = require('../src/server/services/accountMigrationService');

  const dbFile = process.env.DB_FILE;
  const dbDir = path.dirname(dbFile);
  const dbBase = path.basename(dbFile);
  const listTempFiles = () => fs.readdirSync(dbDir)
    .filter((name) => name.includes(`${dbBase}.accounts-migration`));
  const originalBytes = fs.readFileSync(dbFile);

  try {
    const blockedDb = {
      users: [
        { id: 30, phone: '13888003031', openid: null, source: 'web' },
        { id: 30, phone: '13888003031', openid: null, source: 'web' }
      ],
      accounts: [],
      meta: { next_account_id: 20 },
      orders: [],
      qr_codes: []
    };
    fs.writeFileSync(dbFile, JSON.stringify(blockedDb, null, 2), 'utf-8');
    const beforeDryRunBytes = fs.readFileSync(dbFile, 'utf-8');
    const beforeDryRunMtime = fs.statSync(dbFile).mtimeMs;
    const audit = auditAccountMigration();
    assert.equal(audit.can_apply, false);
    assert.ok(audit.blocked_reasons.includes('duplicate_user_id'));
    assert.equal(fs.readFileSync(dbFile, 'utf-8'), beforeDryRunBytes);
    assert.equal(fs.statSync(dbFile).mtimeMs, beforeDryRunMtime);

    assert.throws(
      () => applyAccountMigration(),
      (error) => error && error.code === 'ACCOUNT_MIGRATION_BLOCKED'
    );
    assert.equal(fs.readFileSync(dbFile, 'utf-8'), beforeDryRunBytes);
    assert.deepEqual(listTempFiles(), []);

    const validDb = {
      users: [
        { id: 40, phone: '13888003041', openid: null, source: 'web' },
        { id: 41, phone: null, openid: 'mock-openid-file-account', source: 'miniapp' }
      ],
      accounts: [],
      meta: { next_account_id: 30 },
      orders: [],
      qr_codes: []
    };
    fs.writeFileSync(dbFile, JSON.stringify(validDb, null, 2), 'utf-8');
    const applySummary = applyAccountMigration();
    assert.equal(applySummary.applied, true);
    assert.equal(applySummary.created_accounts, 2);
    assert.deepEqual(listTempFiles(), []);

    const appliedDb = JSON.parse(fs.readFileSync(dbFile, 'utf-8'));
    assert.deepEqual(appliedDb.accounts.map((item) => item.id), ['ACC000030', 'ACC000031']);
    assert.deepEqual(appliedDb.users.map((item) => item.account_id), ['ACC000030', 'ACC000031']);
    assert.equal(appliedDb.meta.next_account_id, 32);
    assert.equal(appliedDb.meta.accounts_migration_version, 'accounts_foundation_v1');
    assert.match(appliedDb.meta.accounts_migrated_at, /^\d{4}-\d{2}-\d{2}T/);
    const migratedAt = appliedDb.meta.accounts_migrated_at;

    const repeatSummary = applyAccountMigration();
    assert.equal(repeatSummary.applied, true);
    assert.equal(repeatSummary.created_accounts, 0);
    assert.equal(repeatSummary.mapped_users_in_run, 0);
    assert.deepEqual(listTempFiles(), []);
    const repeatedDb = JSON.parse(fs.readFileSync(dbFile, 'utf-8'));
    assert.equal(repeatedDb.meta.accounts_migrated_at, migratedAt);
    assert.deepEqual(repeatedDb.accounts.map((item) => item.id), ['ACC000030', 'ACC000031']);
  } finally {
    fs.writeFileSync(dbFile, originalBytes);
  }
});

test('user id generation should not reuse deleted array positions', async () => {
  const {
    getDatabaseSnapshot,
    writeDatabaseSnapshot
  } = require('../src/server/services/dbService');
  const { verifyMiniappToken } = require('../src/server/services/miniappAuthService');

  let db = getDatabaseSnapshot();
  const maxId = Math.max(...db.users.map((item) => Number(item.id) || 0), 0);
  const sentinelId = maxId + 50;
  db.meta = { ...(db.meta || {}), next_user_id: 1 };
  db.users.push({
    id: sentinelId,
    phone: '13888003021',
    openid: null,
    unionid: null,
    source: 'web',
    created_at: '2026-07-26T00:00:00.000Z'
  });
  writeDatabaseSnapshot(db);

  await loginUserAndGetCookie('13888003022');
  db = getDatabaseSnapshot();
  const h5User = db.users.find((item) => item.phone === '13888003022');
  assert.ok(h5User);
  assert.equal(h5User.id, sentinelId + 1);
  assert.equal(db.meta.next_user_id, sentinelId + 2);

  const token = await loginMiniappAndGetToken('mini-account-id-no-reuse');
  const payload = verifyMiniappToken(token);
  assert.equal(Number(payload.id), sentinelId + 2);
  db = getDatabaseSnapshot();
  assert.equal(db.meta.next_user_id, sentinelId + 3);
});

test('admin product management should expose only published products to miniapp', async () => {
  const login = await postJson('/api/admin/login', { username: 'admin', password: 'test-admin-pass' });
  const token = login.body.data.token;

  const publishedRes = await postJson('/api/admin/products', {
    title: '生日祝福酒瓶星贴',
    subtitle: '贴在酒瓶上的专属记录入口',
    cover_image: '/uploads/product.jpg',
    images: ['/uploads/detail-1.jpg'],
    price_text: '¥39 / 10枚装',
    price_cents: 3900,
    description: '适合生日和婚礼现场贴在酒瓶上使用，不含酒水。',
    product_type: 'wine_sticker',
    sticker_count: 10,
    stock: 50,
    is_customizable: true,
    shipping_note: '现货贴纸 48 小时内发出。',
    after_sale_note: '贴纸为印刷品，不含酒水。',
    status: 'published',
    scene_tags: ['birthday', 'wedding'],
    sort_order: 1
  }, token);
  assert.equal(publishedRes.status, 200);
  assert.equal(publishedRes.body.data.buy_type, 'miniapp_order');
  assert.equal(publishedRes.body.data.price_cents, 3900);
  assert.equal(publishedRes.body.data.sticker_count, 10);
  assert.equal(publishedRes.body.data.stock, 50);
  assert.equal(publishedRes.body.data.is_customizable, true);
  assert.deepEqual(publishedRes.body.data.scene_tags, ['birthday', 'wedding']);
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
  assert.deepEqual(adminList.body.data.products.find((item) => item.id === productId).scene_tags, ['birthday', 'wedding']);

  const miniList = await getJson('/api/miniapp/products');
  assert.equal(miniList.status, 200);
  assert.equal(miniList.body.data.products.some((item) => item.id === productId), true);
  assert.equal(miniList.body.data.products.some((item) => item.title === '隐藏商品'), false);
  const miniProduct = miniList.body.data.products.find((item) => item.id === productId);
  assert.equal(miniProduct.buy_type, 'miniapp_order');
  assert.equal(miniProduct.price_cents, 3900);
  assert.equal(miniProduct.sticker_count, 10);
  assert.equal(miniProduct.stock, 50);
  assert.deepEqual(miniProduct.scene_tags, ['birthday', 'wedding']);

  const detail = await getJson(`/api/miniapp/products/${productId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.buy_type, 'miniapp_order');
  assert.equal(detail.body.data.product_type, 'wine_sticker');
  assert.equal(detail.body.data.price_cents, 3900);
  assert.equal(detail.body.data.sticker_count, 10);
  assert.deepEqual(detail.body.data.scene_tags, ['birthday', 'wedding']);
});

test('miniapp sticker orders should create, mock pay, list, and allow admin shipping', async () => {
  const adminLogin = await postJson('/api/admin/login', { username: 'admin', password: 'test-admin-pass' });
  const adminToken = adminLogin.body.data.token;
  const productRes = await postJson('/api/admin/products', {
    title: '恋人酒瓶星贴',
    subtitle: '两个人的一瓶酒',
    price_text: '¥29 / 6枚装',
    price_cents: 2900,
    product_type: 'wine_sticker',
    sticker_count: 6,
    stock: 20,
    status: 'published',
    scene_tags: ['lover'],
    sort_order: 3
  }, adminToken);
  assert.equal(productRes.status, 200);
  const productId = productRes.body.data.id;

  const unboundToken = await loginMiniappAndGetToken('mini-order-unbound');
  const unboundOrder = await postJson('/api/miniapp/orders', {
    product_id: productId,
    quantity: 1,
    receiver_name: '张三',
    receiver_phone: '13888880001',
    region: '四川省 成都市 锦江区',
    address: '测试路 1 号'
  }, unboundToken);
  assert.equal(unboundOrder.status, 403);
  assert.equal(unboundOrder.body.code, 'PHONE_NOT_BOUND');

  const token = await loginMiniappBindPhoneAndGetToken({
    code: 'mini-order-bound',
    phone: '13888880001'
  });
  const orderRes = await postJson('/api/miniapp/orders', {
    product_id: productId,
    quantity: 2,
    receiver_name: '张三',
    receiver_phone: '13888880001',
    region: '四川省 成都市 锦江区',
    address: '测试路 1 号',
    remark: '请尽快发货'
  }, token);
  assert.equal(orderRes.status, 200);
  assert.equal(orderRes.body.data.status, 'pending_payment');
  assert.equal(orderRes.body.data.payment_status, 'unpaid');
  assert.equal(orderRes.body.data.total_amount_cents, 5800);
  assert.equal(orderRes.body.data.product_snapshot.title, '恋人酒瓶星贴');
  const orderId = orderRes.body.data.id;

  const unconfiguredPayRes = await postJson(`/api/miniapp/orders/${orderId}/pay`, {}, token);
  assert.equal(unconfiguredPayRes.status, 503);
  assert.equal(unconfiguredPayRes.body.code, 'WECHAT_PAY_NOT_CONFIGURED');

  const oldPayMock = process.env.WECHAT_PAY_MOCK;
  process.env.WECHAT_PAY_MOCK = 'true';
  try {
    const payRes = await postJson(`/api/miniapp/orders/${orderId}/pay`, {}, token);
    assert.equal(payRes.status, 200);
    assert.equal(payRes.body.data.payment_mock, true);
    assert.equal(payRes.body.data.order.status, 'paid');
  } finally {
    if (oldPayMock === undefined) delete process.env.WECHAT_PAY_MOCK;
    else process.env.WECHAT_PAY_MOCK = oldPayMock;
  }

  const listRes = await getJson('/api/miniapp/orders', token);
  assert.equal(listRes.status, 200);
  assert.equal(listRes.body.data.orders.some((item) => item.id === orderId), true);

  const detailRes = await getJson(`/api/miniapp/orders/${orderId}`, token);
  assert.equal(detailRes.status, 200);
  assert.equal(detailRes.body.data.status, 'paid');

  const cancelPaidRes = await postJson(`/api/miniapp/orders/${orderId}/cancel`, {}, token);
  assert.equal(cancelPaidRes.status, 409);
  assert.equal(cancelPaidRes.body.code, 'ORDER_NOT_CANCELABLE');

  const adminOrders = await getJson('/api/admin/orders', adminToken);
  assert.equal(adminOrders.status, 200);
  assert.equal(adminOrders.body.data.orders.some((item) => item.id === orderId), true);

  const shipRes = await postJson(`/api/admin/orders/${orderId}/ship`, {
    express_company: '顺丰速运',
    express_no: 'SF1234567890'
  }, adminToken);
  assert.equal(shipRes.status, 200);
  assert.equal(shipRes.body.data.status, 'shipped');
  assert.equal(shipRes.body.data.express_company, '顺丰速运');
  assert.equal(shipRes.body.data.express_no, 'SF1234567890');
});

test('miniapp order pay should return WeChat JSAPI payment params when configured', async () => {
  const oldEnv = snapshotEnv(WECHAT_PAY_ENV_KEYS);
  const keys = createWechatPayKeyFiles('wechat-jsapi');
  const httpsMock = mockWechatPayHttps({ prepay_id: 'wx-prepay-test' });
  try {
    clearWechatPayEnv();
    applyWechatPayEnv(keys);

    const adminLogin = await postJson('/api/admin/login', { username: 'admin', password: 'test-admin-pass' });
    const adminToken = adminLogin.body.data.token;
    const productRes = await postJson('/api/admin/products', {
      title: '微信支付测试星贴',
      price_text: '¥9.90 / 1枚装',
      price_cents: 990,
      product_type: 'wine_sticker',
      sticker_count: 1,
      stock: 10,
      status: 'published',
      scene_tags: ['free'],
      sort_order: 8
    }, adminToken);
    assert.equal(productRes.status, 200);

    const token = await loginMiniappBindPhoneAndGetToken({
      code: 'mini-order-wechat-pay',
      phone: '13888880011'
    });
    const orderRes = await postJson('/api/miniapp/orders', {
      product_id: productRes.body.data.id,
      quantity: 1,
      receiver_name: '李四',
      receiver_phone: '13888880011',
      region: '四川省 成都市 锦江区',
      address: '支付测试路 1 号'
    }, token);
    assert.equal(orderRes.status, 200);

    const payRes = await postJson(`/api/miniapp/orders/${orderRes.body.data.id}/pay`, {}, token);
    assert.equal(payRes.status, 200);
    assert.equal(payRes.body.data.payment.package, 'prepay_id=wx-prepay-test');
    assert.equal(payRes.body.data.payment.signType, 'RSA');
    assert.ok(payRes.body.data.payment.timeStamp);
    assert.ok(payRes.body.data.payment.nonceStr);
    assert.ok(payRes.body.data.payment.paySign);
    assert.equal(payRes.body.data.order.status, 'pending_payment');
    assert.equal(httpsMock.calls.length, 1);
    assert.ok(httpsMock.calls[0].url.includes('/v3/pay/transactions/jsapi'));
    const requestBody = JSON.parse(httpsMock.calls[0].body);
    assert.equal(requestBody.appid, process.env.WECHAT_PAY_APPID);
    assert.equal(requestBody.mchid, process.env.WECHAT_PAY_MCH_ID);
    assert.equal(requestBody.out_trade_no, orderRes.body.data.order_no);
    assert.equal(requestBody.amount.total, 990);
    assert.equal(typeof requestBody.payer.openid, 'string');
    assert.ok(requestBody.payer.openid.length > 8);
  } finally {
    httpsMock.restore();
    restoreEnv(oldEnv);
  }
});

test('WeChat Pay public key mode should add serial header and verify notify', async () => {
  const oldEnv = snapshotEnv(WECHAT_PAY_ENV_KEYS);
  const keys = createWechatPayKeyFiles('wechat-public-key');
  const httpsMock = mockWechatPayHttps({ prepay_id: 'wx-prepay-public-key' });
  try {
    clearWechatPayEnv();
    applyWechatPayPublicKeyEnv(keys);

    const adminLogin = await postJson('/api/admin/login', { username: 'admin', password: 'test-admin-pass' });
    const adminToken = adminLogin.body.data.token;
    const productRes = await postJson('/api/admin/products', {
      title: '公钥模式星贴',
      price_text: '¥12.00 / 1枚装',
      price_cents: 1200,
      product_type: 'wine_sticker',
      sticker_count: 1,
      stock: 10,
      status: 'published',
      scene_tags: ['free'],
      sort_order: 88
    }, adminToken);
    assert.equal(productRes.status, 200);

    const token = await loginMiniappBindPhoneAndGetToken({
      code: 'mini-order-wechat-public-key',
      phone: '13888880021'
    });
    const orderRes = await postJson('/api/miniapp/orders', {
      product_id: productRes.body.data.id,
      quantity: 1,
      receiver_name: '公钥用户',
      receiver_phone: '13888880021',
      region: '四川省 成都市 锦江区',
      address: '公钥测试路 1 号'
    }, token);
    assert.equal(orderRes.status, 200);

    const payRes = await postJson(`/api/miniapp/orders/${orderRes.body.data.id}/pay`, {}, token);
    assert.equal(payRes.status, 200);
    assert.equal(payRes.body.data.payment.package, 'prepay_id=wx-prepay-public-key');
    assert.equal(httpsMock.calls.length, 1);
    assert.equal(httpsMock.calls[0].options.headers['Wechatpay-Serial'], 'PUB_KEY_ID_TEST');

    const transaction = {
      appid: process.env.WECHAT_PAY_APPID,
      mchid: process.env.WECHAT_PAY_MCH_ID,
      out_trade_no: orderRes.body.data.order_no,
      transaction_id: '4200000000202607160000000099',
      trade_state: 'SUCCESS',
      success_time: '2026-07-16T11:00:00+08:00',
      amount: {
        total: orderRes.body.data.total_amount_cents,
        payer_total: orderRes.body.data.total_amount_cents,
        currency: 'CNY',
        payer_currency: 'CNY'
      }
    };
    const rawBody = JSON.stringify({
      id: 'notify-public-key',
      create_time: '2026-07-16T11:00:01+08:00',
      resource_type: 'encrypt-resource',
      event_type: 'TRANSACTION.SUCCESS',
      summary: '支付成功',
      resource: encryptWechatPayResource(transaction, process.env.WECHAT_PAY_API_V3_KEY)
    });
    const timestamp = '1784218801000';
    const nonce = 'notify-public-key-nonce';
    const signature = signWechatPayNotify({
      rawBody,
      timestamp,
      nonce,
      privateKey: keys.platformPrivateKey
    });
    const notifyRes = await requestRaw('POST', '/api/payment/wechat/notify', {
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(rawBody),
        'Wechatpay-Timestamp': timestamp,
        'Wechatpay-Nonce': nonce,
        'Wechatpay-Signature': signature,
        'Wechatpay-Serial': 'PUB_KEY_ID_TEST'
      },
      body: Buffer.from(rawBody, 'utf8')
    });
    assert.equal(notifyRes.status, 200);
    assert.equal(notifyRes.body.code, 'SUCCESS');

    const detailRes = await getJson(`/api/miniapp/orders/${orderRes.body.data.id}`, token);
    assert.equal(detailRes.status, 200);
    assert.equal(detailRes.body.data.status, 'paid');
    assert.equal(detailRes.body.data.wechat_transaction_id, transaction.transaction_id);
  } finally {
    httpsMock.restore();
    restoreEnv(oldEnv);
  }
});

test('WeChat payment notify should verify, decrypt, and mark order paid', async () => {
  const oldEnv = snapshotEnv(WECHAT_PAY_ENV_KEYS);
  const keys = createWechatPayKeyFiles('wechat-notify');
  try {
    clearWechatPayEnv();
    applyWechatPayEnv(keys);

    const adminLogin = await postJson('/api/admin/login', { username: 'admin', password: 'test-admin-pass' });
    const adminToken = adminLogin.body.data.token;
    const productRes = await postJson('/api/admin/products', {
      title: '回调测试星贴',
      price_text: '¥19.90 / 2枚装',
      price_cents: 1990,
      product_type: 'wine_sticker',
      sticker_count: 2,
      stock: 10,
      status: 'published',
      scene_tags: ['free'],
      sort_order: 9
    }, adminToken);
    assert.equal(productRes.status, 200);

    const token = await loginMiniappBindPhoneAndGetToken({
      code: 'mini-order-wechat-notify',
      phone: '13888880012'
    });
    const orderRes = await postJson('/api/miniapp/orders', {
      product_id: productRes.body.data.id,
      quantity: 2,
      receiver_name: '王五',
      receiver_phone: '13888880012',
      region: '四川省 成都市 锦江区',
      address: '回调测试路 2 号'
    }, token);
    assert.equal(orderRes.status, 200);

    const transaction = {
      appid: process.env.WECHAT_PAY_APPID,
      mchid: process.env.WECHAT_PAY_MCH_ID,
      out_trade_no: orderRes.body.data.order_no,
      transaction_id: '4200000000202607160000000001',
      trade_state: 'SUCCESS',
      success_time: '2026-07-16T10:00:00+08:00',
      amount: {
        total: orderRes.body.data.total_amount_cents,
        payer_total: orderRes.body.data.total_amount_cents,
        currency: 'CNY',
        payer_currency: 'CNY'
      }
    };
    const notifyBody = {
      id: 'notify-test-1',
      create_time: '2026-07-16T10:00:01+08:00',
      resource_type: 'encrypt-resource',
      event_type: 'TRANSACTION.SUCCESS',
      summary: '支付成功',
      resource: encryptWechatPayResource(transaction, process.env.WECHAT_PAY_API_V3_KEY)
    };
    const rawBody = JSON.stringify(notifyBody);
    const timestamp = '1784215201000';
    const nonce = 'notify-sign-nonce';
    const signature = signWechatPayNotify({
      rawBody,
      timestamp,
      nonce,
      privateKey: keys.platformPrivateKey
    });
    const notifyRes = await requestRaw('POST', '/api/payment/wechat/notify', {
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(rawBody),
        'Wechatpay-Timestamp': timestamp,
        'Wechatpay-Nonce': nonce,
        'Wechatpay-Signature': signature,
        'Wechatpay-Serial': 'WECHATPAY_TEST_SERIAL'
      },
      body: Buffer.from(rawBody, 'utf8')
    });
    assert.equal(notifyRes.status, 200);
    assert.equal(notifyRes.body.code, 'SUCCESS');

    const detailRes = await getJson(`/api/miniapp/orders/${orderRes.body.data.id}`, token);
    assert.equal(detailRes.status, 200);
    assert.equal(detailRes.body.data.status, 'paid');
    assert.equal(detailRes.body.data.payment_status, 'paid');
    assert.equal(detailRes.body.data.payment_method, 'wechat');
    assert.equal(detailRes.body.data.wechat_transaction_id, transaction.transaction_id);
  } finally {
    restoreEnv(oldEnv);
  }
});

test('WeChat payment notify should reject amount mismatch', async () => {
  const oldEnv = snapshotEnv(WECHAT_PAY_ENV_KEYS);
  const keys = createWechatPayKeyFiles('wechat-notify-mismatch');
  try {
    clearWechatPayEnv();
    applyWechatPayEnv(keys);

    const adminLogin = await postJson('/api/admin/login', { username: 'admin', password: 'test-admin-pass' });
    const adminToken = adminLogin.body.data.token;
    const productRes = await postJson('/api/admin/products', {
      title: '金额校验星贴',
      price_text: '¥10.00 / 1枚装',
      price_cents: 1000,
      product_type: 'wine_sticker',
      sticker_count: 1,
      stock: 10,
      status: 'published',
      scene_tags: ['free'],
      sort_order: 10
    }, adminToken);
    assert.equal(productRes.status, 200);

    const token = await loginMiniappBindPhoneAndGetToken({
      code: 'mini-order-wechat-mismatch',
      phone: '13888880013'
    });
    const orderRes = await postJson('/api/miniapp/orders', {
      product_id: productRes.body.data.id,
      quantity: 1,
      receiver_name: '赵六',
      receiver_phone: '13888880013',
      region: '四川省 成都市 锦江区',
      address: '金额测试路 3 号'
    }, token);
    assert.equal(orderRes.status, 200);

    const transaction = {
      appid: process.env.WECHAT_PAY_APPID,
      mchid: process.env.WECHAT_PAY_MCH_ID,
      out_trade_no: orderRes.body.data.order_no,
      transaction_id: '4200000000202607160000000002',
      trade_state: 'SUCCESS',
      success_time: '2026-07-16T10:03:00+08:00',
      amount: {
        total: orderRes.body.data.total_amount_cents + 1,
        payer_total: orderRes.body.data.total_amount_cents + 1,
        currency: 'CNY',
        payer_currency: 'CNY'
      }
    };
    const rawBody = JSON.stringify({
      id: 'notify-test-amount',
      create_time: '2026-07-16T10:03:01+08:00',
      resource_type: 'encrypt-resource',
      event_type: 'TRANSACTION.SUCCESS',
      summary: '支付成功',
      resource: encryptWechatPayResource(transaction, process.env.WECHAT_PAY_API_V3_KEY)
    });
    const timestamp = '1784215381000';
    const nonce = 'notify-mismatch-nonce';
    const signature = signWechatPayNotify({
      rawBody,
      timestamp,
      nonce,
      privateKey: keys.platformPrivateKey
    });
    const notifyRes = await requestRaw('POST', '/api/payment/wechat/notify', {
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(rawBody),
        'Wechatpay-Timestamp': timestamp,
        'Wechatpay-Nonce': nonce,
        'Wechatpay-Signature': signature,
        'Wechatpay-Serial': 'WECHATPAY_TEST_SERIAL'
      },
      body: Buffer.from(rawBody, 'utf8')
    });
    assert.equal(notifyRes.status, 400);
    assert.equal(notifyRes.body.code, 'FAIL');

    const detailRes = await getJson(`/api/miniapp/orders/${orderRes.body.data.id}`, token);
    assert.equal(detailRes.status, 200);
    assert.equal(detailRes.body.data.status, 'pending_payment');
    assert.equal(detailRes.body.data.payment_status, 'unpaid');
  } finally {
    restoreEnv(oldEnv);
  }
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
  assert.ok(recordRes.body.data.image_url);
  assert.equal(recordRes.body.data.image_object_key, uploadRes.body.data.object_key);
  assert.equal(recordRes.body.data.show_brand_disclosure, true);
  assert.equal(recordRes.body.data.brand_disclosure_text_snapshot, '品牌露出文案-MINI');
  assert.equal(recordRes.body.data.brand_name, '星酒品牌');
  assert.ok(recordRes.body.data.blockchain_hash);
  assert.ok(recordRes.body.data.manifest_hash);
  assert.equal(recordRes.body.data.blockchain_hash, recordRes.body.data.manifest_hash);
  assert.ok(['manifest_ready', 'submitting', 'submitted', 'confirmed', 'failed'].includes(recordRes.body.data.chain_status));
  assert.equal(typeof recordRes.body.data.chain_status_text, 'string');

  const activatedStatusRes = await getJson(`/api/miniapp/qr/${accessToken}`, token);
  assert.equal(activatedStatusRes.status, 200);
  assert.equal(activatedStatusRes.body.data.activation_status, 'activated');
  assert.ok(activatedStatusRes.body.data.image_url);
  assert.equal(activatedStatusRes.body.data.image_object_key, uploadRes.body.data.object_key);

  const detailRes = await getJson('/api/miniapp/user/records/MQR00001', token);
  assert.equal(detailRes.status, 200);
  assert.ok(detailRes.body.data.image_url);
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

test('miniapp record payload should use public cloud url for object-key-only images', async () => {
  const oldStorageMode = process.env.STORAGE_MODE;
  const oldCloudPublicBaseUrl = process.env.CLOUD_PUBLIC_BASE_URL;
  try {
    process.env.STORAGE_MODE = 'cloud';
    process.env.CLOUD_PUBLIC_BASE_URL = 'https://cdn.example.com/xingxing';

    const adminLogin = await postJson('/api/admin/login', { username: 'admin', password: 'test-admin-pass' });
    const adminToken = adminLogin.body.data.token;
    const genRes = await postJson('/api/admin/qr/generate', {
      prefix: 'MOU',
      count: 1
    }, adminToken);
    assert.equal(genRes.status, 200);
    const accessToken = genRes.body.data.records[0].qr_access_token;

    const token = await loginMiniappBindPhoneAndGetToken({
      code: 'mini-object-url',
      phone: '13877770009'
    });
    const objectKey = 'stars/MOU00001/photo.jpg';
    const recordRes = await postJson(`/api/miniapp/qr/${accessToken}/record`, {
      mode: 'co_create',
      content: '只有 object_key 的旧记录',
      image_object_key: objectKey
    }, token);
    assert.equal(recordRes.status, 200);
    assert.equal(recordRes.body.data.image_url, `https://cdn.example.com/xingxing/${objectKey}`);

    const statusRes = await getJson(`/api/miniapp/qr/${accessToken}`, token);
    assert.equal(statusRes.status, 200);
    assert.equal(statusRes.body.data.image_url, `https://cdn.example.com/xingxing/${objectKey}`);
  } finally {
    if (oldStorageMode === undefined) delete process.env.STORAGE_MODE;
    else process.env.STORAGE_MODE = oldStorageMode;
    if (oldCloudPublicBaseUrl === undefined) delete process.env.CLOUD_PUBLIC_BASE_URL;
    else process.env.CLOUD_PUBLIC_BASE_URL = oldCloudPublicBaseUrl;
  }
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

test('cloud saveImage should return stable public image urls and keep object key', async () => {
  const Module = require('module');
  const originalLoad = Module._load;
  const oldEnv = snapshotEnv([
    'STORAGE_MODE',
    'CLOUD_PUBLIC_BASE_URL',
    'OSS_ENDPOINT',
    'OSS_REGION',
    'OSS_BUCKET',
    'OSS_ACCESS_KEY_ID',
    'OSS_ACCESS_KEY_SECRET'
  ]);
  const putCalls = [];

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'ali-oss') {
      return class MockOssClient {
        constructor(config) {
          this.config = config;
        }

        async put(objectKey, localPath, options) {
          putCalls.push({ objectKey, localPath, options, config: this.config });
          return {};
        }

        signatureUrl(objectKey) {
          return `https://signed.example.com/${objectKey}`;
        }
      };
    }
    return originalLoad.apply(this, [request, parent, isMain]);
  };

  try {
    process.env.STORAGE_MODE = 'cloud';
    process.env.CLOUD_PUBLIC_BASE_URL = 'https://oss-public.example.com/base/';
    process.env.OSS_ENDPOINT = 'oss-cn-test.aliyuncs.com';
    process.env.OSS_REGION = 'oss-cn-test';
    process.env.OSS_BUCKET = 'xingxing-test';
    process.env.OSS_ACCESS_KEY_ID = 'test-key';
    process.env.OSS_ACCESS_KEY_SECRET = 'test-secret';

    const { saveImage, getPublicObjectUrl } = require('../src/server/services/storageService');
    const saved = await saveImage({
      qrId: 'MIMG00001',
      file: {
        originalname: 'mini.png',
        mimetype: 'image/png',
        buffer: Buffer.from('cloud-public-image')
      }
    });

    assert.equal(putCalls.length, 1);
    assert.equal(saved.object_key.startsWith('stars/MIMG00001/'), true);
    assert.equal(saved.url, `https://oss-public.example.com/base/${saved.object_key}`);
    assert.equal(saved.preview_url, saved.url);
    assert.equal(saved.url.includes('signed.example.com'), false);
    assert.equal(getPublicObjectUrl('stars/OLD00001/photo.jpg'), 'https://oss-public.example.com/base/stars/OLD00001/photo.jpg');
  } finally {
    Module._load = originalLoad;
    restoreEnv(oldEnv);
  }
});
