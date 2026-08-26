const crypto = require('crypto');

const STAGE_BASE = 'https://stage.apis.avata.bianjie.ai';
const PROD_BASE = 'https://apis.avata.bianjie.ai';
const REQUEST_TIMEOUT_MS = 15_000;
const USER_AGENT = 'xingxingzaishan/record-proof-runtime';
const AMBIGUOUS_NOT_FOUND_CODES = new Set(['NOT_FOUND']);
const PROVIDER_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;

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
    identityType: Number(process.env.AVATA_IDENTITY_TYPE || 1),
    identityName: process.env.AVATA_IDENTITY_NAME || '',
    identityNum: process.env.AVATA_IDENTITY_NUM || '',
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
    && config.identityName
    && config.identityNum
    && Number.isFinite(config.identityType)
    && Number.isFinite(config.recordType)
    && Number.isFinite(config.hashType)
  );
}

function shouldUseRealAvata() {
  return process.env.CHAIN_ENABLED === 'true' && isAvataRecordConfigured();
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

async function requestAvata({ method, path, query, body }) {
  const config = getAvataConfig();
  const payload = body ? JSON.stringify(body) : '';
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
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${config.baseUrl}${path}${queryText}`, {
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
  } catch (_error) {
    const error = new Error('AVATA request failed');
    error.code = 'AVATA_REQUEST_FAILED';
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_error) {
    data = { raw: text };
  }

  if (!response.ok) {
    const error = new Error('AVATA request failed');
    error.code = 'AVATA_REQUEST_FAILED';
    error.status = response.status;
    error.providerCode = providerErrorCode(data);
    throw error;
  }

  return data;
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

async function submitRecordProof({ operationId, manifestHash, starId, sealedAt }) {
  const config = getAvataConfig();
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

  const body = buildRecordProofBody({
    operationId,
    manifestHash,
    starId,
    sealedAt,
    config
  });

  return requestAvata({
    method: 'POST',
    path: '/v3/native/record/records',
    body
  });
}

function buildRecordProofBody({ operationId, manifestHash, starId, sealedAt, config = getAvataConfig() }) {
  return {
    identity_type: config.identityType,
    identity_name: config.identityName,
    identity_num: config.identityNum,
    identities: [{
      identity_type: config.identityType,
      identity_name: config.identityName,
      identity_num: config.identityNum
    }],
    type: config.recordType,
    hash_type: config.hashType,
    operation_id: operationId,
    hash: manifestHash,
    name: `记在星上-${starId}`,
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
  getAvataConfig,
  isAvataConfigured,
  isAvataRecordConfigured,
  shouldUseRealAvata,
  signRequest,
  buildSignParams,
  stableJson,
  configuredOperationNotFoundCode,
  mapAvataQueryError,
  buildRecordProofBody,
  submitRecordProof,
  queryOperation,
  normalizeAvataResult,
  verifyAvataCallback
};
