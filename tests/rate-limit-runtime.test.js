'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { configureTrustedProxy, createReadinessHandler } = require('../src/server/app');
const { createRateLimiter } = require('../src/server/middlewares/rateLimit');

function invoke(middleware, { ip = '127.0.0.1', method = 'POST' } = {}) {
  const headers = {};
  const response = {
    statusCode: 200,
    body: null,
    setHeader(name, value) {
      headers[name] = value;
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
  let continued = false;
  middleware({ ip, method }, response, () => {
    continued = true;
  });
  return { continued, headers, response };
}

test('application trusts only a loopback reverse proxy', () => {
  const app = express();
  configureTrustedProxy(app);
  const trustProxy = app.get('trust proxy fn');

  assert.equal(trustProxy('127.0.0.1'), true);
  assert.equal(trustProxy('::1'), true);
  assert.equal(trustProxy('203.0.113.10'), false);
});

test('rate limiter keeps different client IP buckets independent', () => {
  const middleware = createRateLimiter({
    window_ms: 60_000,
    max_requests: 1
  });

  assert.equal(invoke(middleware, { ip: '198.51.100.1' }).continued, true);
  assert.equal(invoke(middleware, { ip: '198.51.100.2' }).continued, true);
  const repeated = invoke(middleware, { ip: '198.51.100.1' });
  assert.equal(repeated.continued, false);
  assert.equal(repeated.response.statusCode, 429);
  assert.equal(repeated.response.body.code, 'RATE_LIMITED');
});

test('rate limiter removes expired buckets during later requests', () => {
  const store = new Map();
  let currentTime = 0;
  const middleware = createRateLimiter({
    window_ms: 100,
    max_requests: 10,
    store,
    clock: () => currentTime
  });

  invoke(middleware, { ip: '198.51.100.1' });
  invoke(middleware, { ip: '198.51.100.2' });
  assert.equal(store.size, 2);

  currentTime = 100;
  invoke(middleware, { ip: '198.51.100.3' });
  assert.deepEqual([...store.keys()], ['198.51.100.3']);
});

test('rate limiter starts a fresh bucket exactly at the reset boundary', () => {
  let currentTime = 0;
  const middleware = createRateLimiter({
    window_ms: 100,
    max_requests: 1,
    clock: () => currentTime
  });

  assert.equal(invoke(middleware).continued, true);
  assert.equal(invoke(middleware).response.statusCode, 429);
  currentTime = 100;
  assert.equal(invoke(middleware).continued, true);
});

test('readiness handler fails closed when its checker throws', async () => {
  const headers = {};
  const response = {
    statusCode: 200,
    body: null,
    setHeader(name, value) {
      headers[name] = value;
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
  const handler = createReadinessHandler(async () => {
    throw new Error('hidden readiness failure');
  });

  await handler({}, response);

  assert.equal(response.statusCode, 503);
  assert.equal(headers['Cache-Control'], 'no-store');
  assert.deepEqual(response.body, { status: 'error', code: 'NOT_READY' });
});
