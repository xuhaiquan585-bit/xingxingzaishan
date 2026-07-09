const {
  buildRecordManifest,
  hashManifest
} = require('./manifestService');
const { saveJsonObject } = require('./storageService');
const {
  submitRecordProof,
  queryOperation,
  normalizeAvataResult,
  getAvataConfig,
  isAvataConfigured,
  isAvataRecordConfigured,
  shouldUseRealAvata
} = require('./avataService');
const {
  saveBinaryObject
} = require('./storageService');
function getDbService() {
  // Lazy require keeps tests that swap DB_FILE and clear module cache isolated.
  // eslint-disable-next-line global-require
  return require('./dbService');
}

function makeOperationId(record, manifestHash) {
  return `record_${record.id}_${manifestHash.slice(0, 16)}`;
}

function normalizeStatus(resultStatus) {
  if (resultStatus === 1 || resultStatus === '1') return 'confirmed';
  if (resultStatus === 2 || resultStatus === '2') return 'failed';
  const value = String(resultStatus || '').toLowerCase();
  if (['success', 'succeed', 'confirmed', 'completed', 'ok'].includes(value)) return 'confirmed';
  if (['failed', 'fail', 'error'].includes(value)) return 'failed';
  if (['pending', 'processing', 'submitted'].includes(value)) return 'submitted';
  return 'submitted';
}

function certificateFileName(recordId, certificateUrl) {
  const path = new URL(certificateUrl).pathname;
  const ext = path.toLowerCase().endsWith('.pdf') ? '.pdf' : '.pdf';
  return `chain_certificate_${String(recordId || 'record').replace(/[^a-zA-Z0-9_-]/g, '_')}${ext}`;
}

async function saveCertificateSnapshot({ record, certificateUrl }) {
  if (!certificateUrl || !shouldUseRealAvata()) return {};
  const response = await fetch(certificateUrl);
  if (!response.ok) {
    throw new Error(`certificate download failed: ${response.status}`);
  }
  const contentType = response.headers.get('content-type') || 'application/pdf';
  const buffer = Buffer.from(await response.arrayBuffer());
  const stored = await saveBinaryObject({
    qrId: record.id,
    fileName: certificateFileName(record.id, certificateUrl),
    buffer,
    contentType
  });
  return {
    chain_certificate_object_key: stored.object_key
  };
}

async function buildChainUpdatePatch({ record, result, status, successErrorMessage = '' }) {
  const patch = {
    chain_status: status,
    chain_tx_hash: result.tx_hash || record.chain_tx_hash || '',
    chain_block_height: result.block_height || record.chain_block_height || null,
    chain_record_id: result.record_id || record.chain_record_id || '',
    chain_certificate_url: result.certificate_url || record.chain_certificate_url || '',
    chain_confirmed_at: status === 'confirmed' ? new Date().toISOString() : record.chain_confirmed_at || null,
    chain_last_error: successErrorMessage
  };
  if (status === 'confirmed' && result.certificate_url) {
    try {
      Object.assign(patch, await saveCertificateSnapshot({
        record,
        certificateUrl: result.certificate_url
      }));
    } catch (error) {
      patch.chain_last_error = error.message || 'certificate download failed';
    }
  }
  return patch;
}

async function prepareRecordManifest(record) {
  const manifest = buildRecordManifest(record);
  const manifestHash = hashManifest(manifest);
  const operationId = record.chain_operation_id || makeOperationId(record, manifestHash);

  let stored;
  try {
    stored = await saveJsonObject({
      qrId: record.id,
      fileName: `record_manifest_${manifestHash.slice(0, 12)}.json`,
      data: {
        ...manifest,
        manifest_hash: manifestHash
      }
    });
  } catch (error) {
    return getDbService().updateRecordChainProof(record.id, {
      chain_provider: 'avata_wenchang',
      chain_status: 'failed',
      chain_operation_id: operationId,
      manifest_hash: manifestHash,
      blockchain_hash: manifestHash,
      chain_last_error: error.message || 'manifest save failed'
    }) || record;
  }

  return getDbService().updateRecordChainProof(record.id, {
    chain_provider: 'avata_wenchang',
    chain_status: 'manifest_ready',
    chain_operation_id: operationId,
    manifest_object_key: stored.object_key,
    manifest_hash: manifestHash,
    blockchain_hash: manifestHash
  }) || record;
}

async function submitPreparedRecord(record) {
  const prepared = record.manifest_hash ? record : await prepareRecordManifest(record);
  getDbService().updateRecordChainProof(prepared.id, {
    chain_status: 'submitting',
    chain_last_error: ''
  });

  try {
    const raw = await submitRecordProof({
      operationId: prepared.chain_operation_id,
      manifestHash: prepared.manifest_hash,
      starId: prepared.id,
      sealedAt: prepared.activated_at
    });
    const result = normalizeAvataResult(raw);
    const status = normalizeStatus(result.status);
    const patch = await buildChainUpdatePatch({ record: prepared, result, status });
    return getDbService().updateRecordChainProof(prepared.id, patch);
  } catch (error) {
    return getDbService().updateRecordChainProof(prepared.id, {
      chain_status: 'failed',
      chain_last_error: error.message || 'AVATA submit failed',
      chain_retry_count: Number(prepared.chain_retry_count || 0) + 1
    });
  }
}

async function startRecordChainProof(record) {
  const prepared = await prepareRecordManifest(record);
  return submitPreparedRecord(prepared);
}

async function queryRecordChainProof(qrId) {
  const { getQRCode, updateRecordChainProof } = getDbService();
  const record = getQRCode(qrId);
  if (!record || !record.chain_operation_id) {
    return { error: 'CHAIN_OPERATION_NOT_FOUND' };
  }

  try {
    const raw = await queryOperation(record.chain_operation_id);
    const result = normalizeAvataResult(raw);
    const status = normalizeStatus(result.status);
    const patch = await buildChainUpdatePatch({ record, result, status });
    const updated = updateRecordChainProof(record.id, patch);
    return { data: updated };
  } catch (error) {
    const updated = updateRecordChainProof(record.id, {
      chain_status: 'failed',
      chain_last_error: error.message || 'AVATA query failed',
      chain_retry_count: Number(record.chain_retry_count || 0) + 1
    });
    return { data: updated };
  }
}

async function retryRecordChainProof(qrId) {
  const { getQRCode } = getDbService();
  const record = getQRCode(qrId);
  if (!record) return { error: 'QR_NOT_FOUND' };
  if (record.activation_status !== 'activated') return { error: 'RECORD_NOT_SEALED' };
  const updated = await submitPreparedRecord(record);
  return { data: updated };
}

async function applyAvataCallback(payload = {}) {
  const result = normalizeAvataResult(payload);
  const operationId = result.operation_id || payload.operation_id;
  const { findRecordByChainOperationId, updateRecordChainProof } = getDbService();
  const record = findRecordByChainOperationId(operationId);
  if (!record) {
    return { error: 'CHAIN_OPERATION_NOT_FOUND' };
  }
  const status = normalizeStatus(result.status);
  const patch = await buildChainUpdatePatch({
    record,
    result,
    status,
    successErrorMessage: status === 'failed' ? (payload.message || 'AVATA callback failed') : ''
  });
  const updated = updateRecordChainProof(record.id, {
    ...patch,
    chain_callback_received_at: new Date().toISOString(),
  });
  return { data: updated };
}

function getChainSystemStatus() {
  const config = getAvataConfig();
  return {
    provider: 'avata_wenchang',
    env: config.env,
    base_url: config.baseUrl,
    enabled: process.env.CHAIN_ENABLED === 'true',
    configured: isAvataConfigured(),
    ready_for_real_submit: isAvataRecordConfigured(),
    callback_url_configured: !!config.callbackUrl,
    project_id_configured: !!config.projectId,
    chain_id_configured: !!config.chainId,
    identity_configured: !!(config.identityName && config.identityNum),
    record_type_configured: Number.isFinite(config.recordType),
    hash_type_configured: Number.isFinite(config.hashType)
  };
}

module.exports = {
  prepareRecordManifest,
  submitPreparedRecord,
  startRecordChainProof,
  queryRecordChainProof,
  retryRecordChainProof,
  applyAvataCallback,
  getChainSystemStatus
};
