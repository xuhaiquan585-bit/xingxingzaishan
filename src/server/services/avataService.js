const crypto = require('crypto');

const STAGE_BASE = 'https://stage.apis.avata.bianjie.ai';
const PROD_BASE = 'https://apis.avata.bianjie.ai';

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

  const response = await fetch(`${config.baseUrl}${path}${queryText}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': config.apiKey,
      'X-Timestamp': timestamp,
      'X-Signature': signature
    },
    body: payload || undefined
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_error) {
    data = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(data.message || data.error || `AVATA request failed: ${response.status}`);
    error.code = 'AVATA_REQUEST_FAILED';
    error.status = response.status;
    error.response = data;
    throw error;
  }

  return data;
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
  if (!shouldUseRealAvata()) {
    return {
      mock: true,
      operation_id: operationId,
      status: 'confirmed'
    };
  }
  return requestAvata({
    method: 'GET',
    path: `/v3/native/tx/${encodeURIComponent(operationId)}`
  });
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
  if (!shouldUseRealAvata()) return { ok: true, skipped: true };
  const config = getAvataConfig();
  const apiKey = headers['x-api-key'] || headers['X-Api-Key'];
  const timestamp = headers['x-timestamp'] || headers['X-Timestamp'];
  const signature = headers['x-signature'] || headers['X-Signature'];
  if (!apiKey || apiKey !== config.apiKey) return { ok: false, reason: 'INVALID_API_KEY' };
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
  return {
    ok: expected === signature,
    reason: expected === signature ? '' : 'INVALID_SIGNATURE'
  };
}

module.exports = {
  getAvataConfig,
  isAvataConfigured,
  isAvataRecordConfigured,
  shouldUseRealAvata,
  signRequest,
  buildSignParams,
  stableJson,
  buildRecordProofBody,
  submitRecordProof,
  queryOperation,
  normalizeAvataResult,
  verifyAvataCallback
};
