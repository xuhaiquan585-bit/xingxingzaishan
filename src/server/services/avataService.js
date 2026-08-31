const crypto = require('crypto');

const STAGE_BASE = 'https://stage.apis.avata.bianjie.ai';
const PROD_BASE = 'https://apis.avata.bianjie.ai';
const REQUEST_TIMEOUT_MS = 15_000;
const PROVIDER_RESPONSE_MAX_BYTES = 1024 * 1024;
const USER_AGENT = 'xingxingzaishan/record-proof-runtime';
const AMBIGUOUS_NOT_FOUND_CODES = new Set(['NOT_FOUND']);
const PROVIDER_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const AVATA_REQUEST_ERROR_MARKER = Symbol('avataRequestError');
const OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const RECORD_TYPES = new Set(Array.from({ length: 14 }, (_value, index) => index + 1));
const HASH_TYPES = new Set([1, 2, 3, 4]);

function configuredOperationNotFoundCode(value) {
  const normalized = String(value || '').trim();
  if (
    !PROVIDER_ERROR_CODE_PATTERN.test(normalized)
    || AMBIGUOUS_NOT_FOUND_CODES.has(normalized)
  ) return '';
  return normalized;
}

function getAvataConfig() {
  const env = process.env.AVATA_ENV === 'prod' || process.env.AVATA_ENV === 'production' ? 'prod' : 'stage';
  return {
    env,
    baseUrl: (process.env.AVATA_API_BASE || (env === 'prod' ? PROD_BASE : STAGE_BASE)).replace(/\/$/, ''),
    apiKey: process.env.AVATA_API_KEY || '',
    apiSecret: process.env.AVATA_API_SECRET || '',
    callbackUrl: process.env.CHAIN_CALLBACK_URL || '',
    projectId: process.env.AVATA_PROJECT_ID || '',
    chainId: process.env.AVATA_CHAIN_ID || '',
    operationNotFoundCode: configuredOperationNotFoundCode(
      process.env.AVATA_OPERATION_NOT_FOUND_CODE
    ),
    recordType: Number(process.env.AVATA_RECORD_TYPE || 1),
    hashType: Number(process.env.AVATA_HASH_TYPE || 1)
  };
}

function isAvataConfigured() {
  const config = getAvataConfig();
  return !!(config.apiKey && config.apiSecret);
}

function isAvataRecordConfigured() {
  const config = getAvataConfig();
  return !!(
    config.apiKey
    && config.apiSecret
    && hasValidAvataRecordContractConfig(config)
  );
}

function shouldUseRealAvata() {
  return process.env.CHAIN_ENABLED === 'true' && isAvataRecordConfigured();
}

function hasValidAvataRecordContractConfig(config = {}) {
  return Boolean(
    RECORD_TYPES.has(config.recordType)
    && HASH_TYPES.has(config.hashType)
  );
}

function validateProviderBase(config) {
  const expected = config.env === 'prod' ? PROD_BASE : STAGE_BASE;
  if (config.baseUrl !== expected) {
    const error = new Error('AVATA endpoint is not allowed');
    error.code = 'AVATA_ENDPOINT_NOT_ALLOWED';
    throw error;
  }
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map((item) => sortValue(item));
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        if (value[key] !== undefined) {
          acc[key] = sortValue(value[key]);
        }
        return acc;
      }, {});
  }
  return value;
}

function buildSignParams({ path, query, body }) {
  const params = {
    path_url: path
  };
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      params[`query_${key}`] = value;
    }
  });
  Object.entries(body || {}).forEach(([key, value]) => {
    if (value !== undefined) {
      params[`body_${key}`] = value;
    }
  });
  return sortValue(params);
}

function stableJson(value) {
  return JSON.stringify(sortValue(value));
}

function signRequest({ path, query, body, timestamp, apiSecret }) {
  const params = buildSignParams({ path, query, body });
  const payload = `${stableJson(params)}${timestamp}${apiSecret}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function avataRequestError(code = 'AVATA_REQUEST_FAILED') {
  const error = new Error('AVATA request failed');
  error.code = code;
  error[AVATA_REQUEST_ERROR_MARKER] = true;
  return error;
}

function providerRequestErrorCode(status, providerCode) {
  const normalizedStatus = Number(status);
  if (
    !Number.isInteger(normalizedStatus)
    || normalizedStatus < 400
    || normalizedStatus > 599
  ) return 'AVATA_REQUEST_FAILED';
  const normalizedProviderCode = String(providerCode || '').trim();
  return PROVIDER_ERROR_CODE_PATTERN.test(normalizedProviderCode)
    ? `AVATA_HTTP_${normalizedStatus}_${normalizedProviderCode}`
    : `AVATA_HTTP_${normalizedStatus}`;
}

async function readBoundedResponseText(response, {
  controller,
  maxBytes = PROVIDER_RESPONSE_MAX_BYTES
} = {}) {
  const body = response && response.body;
  if (!body || typeof body.getReader !== 'function') {
    const text = response && typeof response.text === 'function'
      ? await response.text()
      : '';
    if (Buffer.byteLength(String(text || ''), 'utf8') > maxBytes) {
      if (controller) controller.abort();
      throw avataRequestError('AVATA_RESPONSE_TOO_LARGE');
    }
    return String(text || '');
  }

  const reader = body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        if (controller) controller.abort();
        try {
          await reader.cancel();
        } catch (_error) {
          // Abort is already authoritative; cancellation is best-effort cleanup.
        }
        throw avataRequestError('AVATA_RESPONSE_TOO_LARGE');
      }
      chunks.push(chunk);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch (_error) {
      // A cancelled or errored stream may have released its lock already.
    }
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

async function requestAvata(
  { method, path, query, body, serializedBody },
  {
    fetchImpl = globalThis.fetch,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    timeoutMs = REQUEST_TIMEOUT_MS,
    maxResponseBytes = PROVIDER_RESPONSE_MAX_BYTES
  } = {}
) {
  const config = getAvataConfig();
  validateProviderBase(config);
  const payload = serializedBody === undefined
    ? (body ? JSON.stringify(body) : '')
    : serializedBody;
  const timestamp = String(Date.now());
  const signature = signRequest({
    path,
    query,
    body,
    timestamp,
    apiSecret: config.apiSecret
  });
  const queryText = query && Object.keys(query).length > 0 ? `?${new URLSearchParams(query).toString()}` : '';

  const controller = new AbortController();
  const timeout = setTimer(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${config.baseUrl}${path}${queryText}`, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        'X-Api-Key': config.apiKey,
        'X-Timestamp': timestamp,
        'X-Signature': signature
      },
      body: payload || undefined,
      redirect: 'error',
      signal: controller.signal
    });
    const text = await readBoundedResponseText(response, {
      controller,
      maxBytes: maxResponseBytes
    });
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (_error) {
        throw avataRequestError('AVATA_RESPONSE_INVALID');
      }
    }

    if (!response.ok) {
      const providerCode = providerErrorCode(data);
      const error = avataRequestError(
        providerRequestErrorCode(response.status, providerCode)
      );
      error.status = response.status;
      error.providerCode = providerCode;
      throw error;
    }

    return data;
  } catch (error) {
    if (error && error[AVATA_REQUEST_ERROR_MARKER] === true) {
      throw error;
    }
    throw avataRequestError();
  } finally {
    clearTimer(timeout);
  }
}

function providerErrorCode(data) {
  const candidate = data && typeof data === 'object'
    ? (data.code || (data.error && data.error.code))
    : '';
  const normalized = String(candidate || '').trim();
  return PROVIDER_ERROR_CODE_PATTERN.test(normalized) ? normalized : '';
}

function mapAvataQueryError(error, operationNotFoundCode) {
  const configuredCode = configuredOperationNotFoundCode(operationNotFoundCode);
  if (
    configuredCode
    && Number(error && error.status) === 404
    && String(error && error.providerCode || '') === configuredCode
  ) {
    const mapped = new Error('AVATA operation was not found');
    mapped.code = 'RECORD_PROOF_EXTERNAL_OPERATION_NOT_FOUND';
    return mapped;
  }
  return error;
}

async function submitRecordProof({
  operationId,
  manifestHash,
  starId,
  sealedAt,
  preparedSubmission
}) {
  const prepared = preparedSubmission
    ? preparedSubmission
    : prepareRecordProofSubmission({ operationId, manifestHash, starId, sealedAt });
  if (
    !prepared
    || prepared.method !== 'POST'
    || prepared.path !== '/v3/native/record/records'
    || !prepared.body
    || prepared.body.operation_id !== operationId
    || prepared.body.hash !== manifestHash
    || prepared.serialized_body !== JSON.stringify(prepared.body)
  ) {
    const error = new Error('AVATA prepared submission is invalid');
    error.code = 'AVATA_PREPARED_SUBMISSION_INVALID';
    throw error;
  }
  if (!shouldUseRealAvata()) {
    return {
      mock: true,
      operation_id: operationId,
      status: 'confirmed',
      tx_hash: `mock_tx_${manifestHash.slice(0, 24)}`,
      block_height: 0,
      record_id: `mock_record_${starId}`,
      certificate_url: ''
    };
  }

  return requestAvata({
    method: 'POST',
    path: prepared.path,
    body: prepared.body,
    serializedBody: prepared.serialized_body
  });
}

function prepareRecordProofSubmission({ operationId, manifestHash, starId, sealedAt }) {
  const config = getAvataConfig();
  validateProviderBase(config);
  if (
    !OPERATION_ID_PATTERN.test(String(operationId || '').trim())
    || !/^[0-9a-f]{64}$/.test(String(manifestHash || '').trim().toLowerCase())
    || !String(starId || '').trim()
    || !String(sealedAt || '').trim()
    || !hasValidAvataRecordContractConfig(config)
  ) {
    const error = new Error('AVATA submission is invalid');
    error.code = 'AVATA_SUBMISSION_INVALID';
    throw error;
  }
  if (!isAvataRecordConfigured()) {
    const error = new Error('AVATA configuration is incomplete');
    error.code = 'AVATA_CONFIGURATION_REQUIRED';
    throw error;
  }
  const body = Object.freeze(buildRecordProofBody({
    operationId,
    manifestHash,
    starId,
    sealedAt,
    config
  }));
  if (
    body.name.length < 1
    || body.name.length > 64
    || body.description.length < 1
    || body.description.length > 512
  ) {
    const error = new Error('AVATA submission is invalid');
    error.code = 'AVATA_SUBMISSION_INVALID';
    throw error;
  }
  const path = '/v3/native/record/records';
  const serializedBody = JSON.stringify(body);
  stableJson(buildSignParams({ path, body }));
  return Object.freeze({
    method: 'POST',
    path,
    body,
    serialized_body: serializedBody
  });
}

function buildRecordProofBody({ operationId, manifestHash, starId, sealedAt, config = getAvataConfig() }) {
  const name = `记在星上-${starId}`.slice(0, 64);
  return {
    type: config.recordType,
    hash_type: config.hashType,
    operation_id: operationId,
    hash: manifestHash,
    name,
    description: `星星ID ${starId} 于 ${sealedAt || ''} 生成的链上存证`
  };
}

async function queryOperation(operationId) {
  const config = getAvataConfig();
  if (!shouldUseRealAvata()) {
    return {
      mock: true,
      operation_id: operationId,
      status: 'confirmed'
    };
  }
  try {
    return await requestAvata({
      method: 'GET',
      path: `/v3/native/tx/${encodeURIComponent(operationId)}`
    });
  } catch (error) {
    throw mapAvataQueryError(error, config.operationNotFoundCode);
  }
}

function normalizeAvataResult(data = {}) {
  const source = data.data || data;
  const record = source.record || data.record || {};
  const createRecord = record.create_record || record;
  return {
    status: source.status ?? source.tx_status ?? data.status ?? '',
    operation_id: source.operation_id || data.operation_id || '',
    tx_hash: source.tx_hash || source.hash || '',
    block_height: source.block_height || source.height || null,
    record_id: source.record_id || createRecord.record_id || source.id || '',
    certificate_url: source.certificate_url || createRecord.certificate_url || source.cert_url || ''
  };
}

function verifyAvataCallback({ path, body, headers = {} }) {
  if (!shouldUseRealAvata()) return { ok: false, reason: 'PROVIDER_DISABLED' };
  const config = getAvataConfig();
  let callbackUrl;
  try {
    callbackUrl = new URL(config.callbackUrl);
  } catch (_error) {
    return { ok: false, reason: 'CALLBACK_DISABLED' };
  }
  if (callbackUrl.protocol !== 'https:' || callbackUrl.username || callbackUrl.password) {
    return { ok: false, reason: 'CALLBACK_DISABLED' };
  }
  const apiKey = headers['x-api-key'] || headers['X-Api-Key'];
  const timestamp = headers['x-timestamp'] || headers['X-Timestamp'];
  const signature = headers['x-signature'] || headers['X-Signature'];
  if (!secureTextEqual(apiKey, config.apiKey)) return { ok: false, reason: 'INVALID_API_KEY' };
  if (!timestamp || !signature) return { ok: false, reason: 'MISSING_SIGNATURE' };
  const now = Date.now();
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 10 * 60 * 1000) {
    return { ok: false, reason: 'INVALID_TIMESTAMP' };
  }
  const expected = signRequest({
    path,
    body,
    timestamp: String(timestamp),
    apiSecret: config.apiSecret
  });
  const valid = /^[0-9a-f]{64}$/i.test(String(signature))
    && secureTextEqual(expected.toLowerCase(), String(signature).toLowerCase());
  return { ok: valid, reason: valid ? '' : 'INVALID_SIGNATURE' };
}

function secureTextEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  return leftBuffer.length === rightBuffer.length
    && leftBuffer.length > 0
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

module.exports = {
  REQUEST_TIMEOUT_MS,
  PROVIDER_RESPONSE_MAX_BYTES,
  getAvataConfig,
  hasValidAvataRecordContractConfig,
  isAvataConfigured,
  isAvataRecordConfigured,
  shouldUseRealAvata,
  signRequest,
  buildSignParams,
  stableJson,
  configuredOperationNotFoundCode,
  providerRequestErrorCode,
  mapAvataQueryError,
  buildRecordProofBody,
  prepareRecordProofSubmission,
  requestAvata,
  readBoundedResponseText,
  submitRecordProof,
  queryOperation,
  normalizeAvataResult,
  verifyAvataCallback
};
