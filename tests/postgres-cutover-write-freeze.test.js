'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createPostgresCutoverWriteFreeze,
  readPostgresCutoverWriteFreezeConfig
} = require('../src/server/middlewares/postgresCutoverWriteFreeze');
const {
  main: capturePublicFingerprints,
  normalizeDto,
  normalizeUrl
} = require('../scripts/database/capture-stable-cutover-public-fingerprints');

function responseHarness() {
  return {
    body: null,
    headers: {},
    statusCode: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    }
  };
}

test('PostgreSQL cutover write freeze is strict and disabled by default', () => {
  assert.deepEqual(readPostgresCutoverWriteFreezeConfig({}), {
    enabled: false
  });
  assert.deepEqual(readPostgresCutoverWriteFreezeConfig({
    POSTGRES_CUTOVER_WRITE_FREEZE_ENABLED: 'false'
  }), { enabled: false });
  assert.deepEqual(readPostgresCutoverWriteFreezeConfig({
    POSTGRES_CUTOVER_WRITE_FREEZE_ENABLED: 'true'
  }), { enabled: true });
  assert.throws(
    () => readPostgresCutoverWriteFreezeConfig({
      POSTGRES_CUTOVER_WRITE_FREEZE_ENABLED: 'yes'
    }),
    error => error &&
      error.code === 'POSTGRES_CUTOVER_WRITE_FREEZE_CONFIG_INVALID'
  );
});

test('PostgreSQL cutover write freeze permits only read-safe methods', () => {
  const middleware = createPostgresCutoverWriteFreeze({ enabled: true });

  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    let nextCount = 0;
    const response = responseHarness();
    middleware({ method }, response, () => { nextCount += 1; });
    assert.equal(nextCount, 1);
    assert.equal(response.statusCode, null);
    assert.equal(response.body, null);
  }
});

test('PostgreSQL cutover write freeze rejects every mutating method generically', () => {
  const middleware = createPostgresCutoverWriteFreeze({ enabled: true });

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'CONNECT']) {
    let nextCount = 0;
    const response = responseHarness();
    middleware({ method }, response, () => { nextCount += 1; });
    assert.equal(nextCount, 0);
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers['Retry-After'], '60');
    assert.deepEqual(response.body, {
      status: 'error',
      code: 'POSTGRES_CUTOVER_WRITE_FROZEN',
      message: '系统维护中，请稍后重试。'
    });
  }
});

test('application wires the write freeze before parsers, sessions, and routes', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../src/server/app.js'),
    'utf8'
  );
  const freezeIndex = source.indexOf('app.use(postgresCutoverWriteFreeze)');
  const parserIndex = source.indexOf('app.use(express.json');
  const sessionIndex = source.indexOf('app.use(attachUserSession())');
  const routeIndex = source.indexOf("app.use('/api/user', userRoutes)");

  assert.ok(freezeIndex > 0);
  assert.ok(parserIndex > freezeIndex);
  assert.ok(sessionIndex > freezeIndex);
  assert.ok(routeIndex > freezeIndex);
});

test('stable cutover fingerprints ignore signed URL churn and key order', () => {
  const first = normalizeDto({
    message: 'unchanged',
    image_url: 'https://example.test/object.jpg?token=old#preview',
    nested: { z: 2, a: 1 }
  });
  const second = normalizeDto({
    nested: { a: 1, z: 2 },
    image_url: 'https://example.test/object.jpg?token=new',
    message: 'unchanged'
  });

  assert.deepEqual(first, second);
  assert.equal(
    normalizeUrl('https://example.test/object.jpg?token=secret#preview'),
    'https://example.test/object.jpg'
  );
  assert.equal(normalizeUrl('not-a-url'), 'not-a-url');
});

test('stable cutover fingerprint capture persists hashes without raw DTOs', async (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'cutover-fingerprint-')
  );
  const output = path.join(temporaryRoot, 'fingerprints.json');
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({
      status: 'success',
      data: {
        id: 'A00001',
        message: 'raw-business-content-must-not-persist',
        image_url: `https://example.test/image.jpg?route=${request.url}`
      }
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  const { port } = server.address();
  const report = await capturePublicFingerprints([
    `--base-url=http://127.0.0.1:${port}/`,
    '--qr-id=A00001',
    `--output=${output}`
  ]);
  const persisted = fs.readFileSync(output, 'utf8');

  assert.equal(report.status, 'PASS');
  assert.equal(report.route_count, 2);
  assert.equal(report.raw_dto_persisted, false);
  assert.equal(typeof report.combined_sha256, 'string');
  assert.doesNotMatch(persisted, /raw-business-content|example\.test/);
  assert.match(persisted, /"raw_dto_persisted": false/);
  await assert.rejects(
    capturePublicFingerprints([
      '--base-url=https://example.test/',
      '--qr-id=A00001',
      `--output=${path.join(temporaryRoot, 'forbidden.json')}`
    ]),
    error => error && error.code === 'CUTOVER_FINGERPRINT_BASE_URL_INVALID'
  );
});

test('stable cutover fingerprint failures identify the route without persisting bodies', async (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'cutover-fingerprint-failure-')
  );
  const output = path.join(temporaryRoot, 'fingerprints.json');
  const server = http.createServer((_request, response) => {
    response.statusCode = 503;
    response.end('sensitive-response-must-not-persist');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  const { port } = server.address();
  await assert.rejects(
    capturePublicFingerprints([
      `--base-url=http://127.0.0.1:${port}/`,
      '--qr-id=A00001',
      `--output=${output}`
    ]),
    error => error && error.code === 'CUTOVER_FINGERPRINT_HTTP_INVALID_H5_503'
  );
  assert.equal(fs.existsSync(output), false);
});
