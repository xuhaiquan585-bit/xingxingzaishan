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

function getJson(urlPath, token) {
  const headers = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return requestRaw('GET', urlPath, { headers });
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

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xingxingzaishan-'));
  process.env.DB_FILE = path.join(tmpDir, 'db.json');
  process.env.STORAGE_ROOT = path.join(tmpDir, 'storage');
  process.env.AUTH_SECRET = 'test-secret-123';

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
  const response = await postMultipart('/api/upload', {
    files: [
      {
        fieldName: 'image',
        filename: 'not-image.txt',
        contentType: 'text/plain',
        content: 'not-image'
      }
    ]
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'UPLOAD_FAILED');
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
  const res = await postJson('/api/admin/login', { username: 'admin', password: 'admin123' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'success');
  assert.ok(res.body.data.token);
});

test('GET /api/admin/dashboard should work with valid token', async () => {
  const login = await postJson('/api/admin/login', { username: 'admin', password: 'admin123' });
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
  const qcLogin = await postJson('/api/admin/login', { username: 'qc', password: 'qc123456' });
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
  const imageData = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZQ1EAAAAASUVORK5CYII=',
    'base64'
  );

  const uploadRes = await postMultipart('/api/upload', {
    fields: { qr_id: 'STAR0002' },
    files: [
      {
        fieldName: 'image',
        filename: 'pixel.png',
        contentType: 'image/png',
        content: imageData
      }
    ]
  });

  assert.equal(uploadRes.status, 200);
  const uploadBody = uploadRes.body;
  assert.ok(uploadBody.data.object_key);

  const recordRes = await postJson('/api/qr/STAR0002/record', {
    phone: '13800138000',
    content: 'demo',
    image_url: uploadBody.data.url,
    image_object_key: uploadBody.data.object_key
  });
  assert.equal(recordRes.status, 200);

  const downloadRes = await getJson('/api/nft/STAR0002/download');
  assert.equal(downloadRes.status, 200);
  assert.ok(downloadRes.body.data.download_url);
});
