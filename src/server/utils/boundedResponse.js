'use strict';

function responseLimitError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function declaredLength(headers) {
  if (!headers) return null;
  const raw = typeof headers.get === 'function'
    ? headers.get('content-length')
    : headers['content-length'];
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function readBoundedNodeResponse(response, {
  maxBytes,
  errorCode = 'UPSTREAM_RESPONSE_TOO_LARGE',
  errorMessage = '上游服务响应过大。'
}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    return Promise.reject(responseLimitError('RESPONSE_LIMIT_INVALID', '响应大小限制无效。'));
  }
  if (declaredLength(response && response.headers) > maxBytes) {
    if (response && typeof response.destroy === 'function') response.destroy();
    return Promise.reject(responseLimitError(errorCode, errorMessage));
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    function cleanup() {
      response.removeListener('data', onData);
      response.removeListener('end', onEnd);
      response.removeListener('error', onError);
      response.removeListener('aborted', onAborted);
      response.removeListener('close', onClose);
    }

    function finish(error, value) {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    }

    function onData(chunk) {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > maxBytes) {
        const error = responseLimitError(errorCode, errorMessage);
        finish(error);
        if (typeof response.destroy === 'function') response.destroy();
        return;
      }
      chunks.push(bytes);
    }

    function onEnd() {
      finish(null, Buffer.concat(chunks, total));
    }

    function onError(error) {
      finish(error);
    }

    function onAborted() {
      finish(responseLimitError(errorCode, errorMessage));
    }

    function onClose() {
      if (!settled) finish(responseLimitError(errorCode, errorMessage));
    }

    response.on('data', onData);
    response.on('end', onEnd);
    response.on('error', onError);
    response.on('aborted', onAborted);
    response.on('close', onClose);
  });
}

async function readBoundedFetchResponse(response, {
  maxBytes,
  errorCode = 'UPSTREAM_RESPONSE_TOO_LARGE',
  errorMessage = '上游服务响应过大。',
  controller = null
}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw responseLimitError('RESPONSE_LIMIT_INVALID', '响应大小限制无效。');
  }
  if (declaredLength(response && response.headers) > maxBytes) {
    if (controller) controller.abort();
    throw responseLimitError(errorCode, errorMessage);
  }
  if (!response || !response.body || typeof response.body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw responseLimitError(errorCode, errorMessage);
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = Buffer.from(value);
      total += bytes.length;
      if (total > maxBytes) {
        if (controller) controller.abort();
        const error = responseLimitError(errorCode, errorMessage);
        try {
          await reader.cancel(error);
        } catch (_error) {
          // The abort may already have cancelled the stream.
        }
        throw error;
      }
      chunks.push(bytes);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch (_error) {
      // A cancelled stream may release its lock before this cleanup.
    }
  }
  return Buffer.concat(chunks, total);
}

module.exports = {
  readBoundedFetchResponse,
  readBoundedNodeResponse
};
