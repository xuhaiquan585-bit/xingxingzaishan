'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  createPostgresCutoverWriteFreeze,
  readPostgresCutoverWriteFreezeConfig
} = require('../src/server/middlewares/postgresCutoverWriteFreeze');

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
