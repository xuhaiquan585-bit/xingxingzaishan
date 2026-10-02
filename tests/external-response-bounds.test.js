'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  readBoundedFetchResponse,
  readBoundedNodeResponse
} = require('../src/server/utils/boundedResponse');

test('Node upstream responses are rejected once streamed bytes exceed the limit', async () => {
  const response = new EventEmitter();
  response.headers = {};
  let destroyed = false;
  response.destroy = () => {
    destroyed = true;
  };
  const pending = readBoundedNodeResponse(response, {
    maxBytes: 4,
    errorCode: 'TEST_RESPONSE_TOO_LARGE'
  });
  process.nextTick(() => {
    response.emit('data', Buffer.from('abc'));
    response.emit('data', Buffer.from('de'));
  });
  await assert.rejects(pending, (error) => error.code === 'TEST_RESPONSE_TOO_LARGE');
  assert.equal(destroyed, true);
  assert.equal(response.listenerCount('data'), 0);
  assert.equal(response.listenerCount('end'), 0);
  assert.equal(response.listenerCount('error'), 0);
  assert.equal(response.listenerCount('aborted'), 0);
  assert.equal(response.listenerCount('close'), 0);
});

test('Node upstream responses reject when the stream closes before ending', async () => {
  const response = new EventEmitter();
  response.headers = {};
  const pending = readBoundedNodeResponse(response, {
    maxBytes: 4,
    errorCode: 'TEST_RESPONSE_INTERRUPTED'
  });
  process.nextTick(() => response.emit('close'));
  await assert.rejects(pending, (error) => error.code === 'TEST_RESPONSE_INTERRUPTED');
});

test('fetch responses reject an oversized declared length before buffering', async () => {
  const response = {
    headers: { get: (name) => (name === 'content-length' ? '5' : null) },
    arrayBuffer: async () => Buffer.from('abcde')
  };
  await assert.rejects(
    readBoundedFetchResponse(response, {
      maxBytes: 4,
      errorCode: 'TEST_FETCH_TOO_LARGE'
    }),
    (error) => error.code === 'TEST_FETCH_TOO_LARGE'
  );
});

test('fetch responses cancel a streaming body when bytes exceed the limit', async () => {
  let cancelledWith = null;
  let readCount = 0;
  const reader = {
    async read() {
      readCount += 1;
      return readCount === 1
        ? { done: false, value: Buffer.from('abcde') }
        : { done: true, value: undefined };
    },
    async cancel(error) {
      cancelledWith = error;
    },
    releaseLock() {}
  };
  const response = {
    headers: { get: () => null },
    body: { getReader: () => reader }
  };

  await assert.rejects(
    readBoundedFetchResponse(response, {
      maxBytes: 4,
      errorCode: 'TEST_FETCH_TOO_LARGE'
    }),
    (error) => error.code === 'TEST_FETCH_TOO_LARGE'
  );
  assert.equal(cancelledWith.code, 'TEST_FETCH_TOO_LARGE');
});

test('bounded response readers preserve normal payload bytes', async () => {
  const response = new EventEmitter();
  response.headers = { 'content-length': '4' };
  const pending = readBoundedNodeResponse(response, { maxBytes: 4 });
  process.nextTick(() => {
    response.emit('data', Buffer.from('safe'));
    response.emit('end');
  });
  assert.equal((await pending).toString('utf8'), 'safe');
  assert.equal(response.listenerCount('data'), 0);
  assert.equal(response.listenerCount('end'), 0);
  assert.equal(response.listenerCount('error'), 0);
  assert.equal(response.listenerCount('aborted'), 0);
  assert.equal(response.listenerCount('close'), 0);
});
