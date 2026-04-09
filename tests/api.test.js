const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xingxingzaishan-'));
  process.env.DB_FILE = path.join(tmpDir, 'db.json');
  process.env.STORAGE_ROOT = path.join(tmpDir, 'storage');

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
  const formData = new FormData();
  formData.append('image', new Blob(['not-image'], { type: 'text/plain' }), 'not-image.txt');

  const response = await fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    body: formData
  });

  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.code, 'UPLOAD_FAILED');
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

test('POST /api/qc/check should reject unauthorized request', async () => {
  const res = await postJson('/api/qc/check', { qr_id: 'STAR0001' });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'UNAUTHORIZED');
});
