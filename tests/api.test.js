const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// 手动构建 multipart/form-data（兼容所有 Node.js 版本）
function buildMultipart(fields) {
  const boundary = 'XB' + crypto.randomBytes(8).toString('hex');
  const parts = [];
  for (const [name, field] of Object.entries(fields)) {
    const def = field && typeof field === 'object' && field.data !== undefined ? field : { data: field };
    const buf = Buffer.isBuffer(def.data) ? def.data : Buffer.from(String(def.data || ''));
    const disposition = def.filename
      ? `form-data; name="${name}"; filename="${def.filename}"`
      : `form-data; name="${name}"`;
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disposition}\r\nContent-Type: ${def.contentType || 'text/plain'}\r\n\r\n`));
    parts.push(buf);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(parts) };
}

async function multipartPost(url, fields, token) {
  const { boundary, body } = buildMultipart(fields);
  const headers = { 'Content-Type': `multipart/form-data; boundary=${boundary}` };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${url}`, { method: 'POST', headers, body });
  let json;
  try { json = await res.json(); } catch { json = {}; }
  return { status: res.status, body: json };
}

let server;
let baseUrl;
let tmpDir;

async function postJson(url, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${baseUrl}${url}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  return {
    status: res.status,
    body: await res.json()
  };
}


async function getJson(url, token) {
  const headers = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${baseUrl}${url}`, {
    method: 'GET',
    headers
  });
  return {
    status: res.status,
    body: await res.json()
  };
}

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xingxingzaishan-'));
  process.env.DB_FILE = path.join(tmpDir, 'db.json');
  process.env.STORAGE_ROOT = path.join(tmpDir, 'storage');
  process.env.AUTH_SECRET = 'test-secret-123';
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
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DB_FILE;
  delete process.env.STORAGE_ROOT;
  delete process.env.AUTH_SECRET;
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
});

test('POST /api/upload should reject non-image file', async () => {
  // 发送 text/plain 类型文件，multer 应拒绝
  const res = await multipartPost('/api/upload', {
    image: {
      data: Buffer.from('this is not an image'),
      filename: 'not-image.txt',
      contentType: 'text/plain'
    }
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'UPLOAD_FAILED');
});

test('POST /api/qr/:id/record should validate image_url required', async () => {
  const res = await postJson('/api/qr/STAR0001/record', { phone: '13800138000', content: 'hello' });
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
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZQ1EAAAAASUVORK5CYII=';
  const pngBuffer = Buffer.from(pngBase64, 'base64');

  const uploadRes = await multipartPost('/api/upload', {
    image: { data: pngBuffer, filename: 'pixel.png', contentType: 'image/png' },
    qr_id: 'STAR0002'
  });
  assert.equal(uploadRes.status, 200);
  assert.ok(uploadRes.body.data.object_key);

  const recordRes = await postJson('/api/qr/STAR0002/record', {
    phone: '13800138000',
    content: 'demo',
    image_url: uploadRes.body.data.url,
    image_object_key: uploadRes.body.data.object_key
  });
  assert.equal(recordRes.status, 200);

  const downloadRes = await getJson('/api/nft/STAR0002/download');
  assert.equal(downloadRes.status, 200);
  assert.ok(downloadRes.body.data.download_url);
});
