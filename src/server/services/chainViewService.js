const { getSignedUrl } = require('./storageService');

function chainStatusForCustomer(status) {
  if (status === 'confirmed') return '已完成区块链存证';
  if (status === 'failed') return '存证暂未完成，系统会继续处理';
  return '存证生成中';
}

function chainPublicPayload(record = {}) {
  const status = record.chain_status || (record.blockchain_hash ? 'confirmed' : 'not_started');
  const certificateUrl = record.chain_certificate_object_key
    ? getSignedUrl(record.chain_certificate_object_key)
    : record.chain_certificate_url || null;
  return {
    chain_provider: record.chain_provider || 'avata_wenchang',
    chain_status: status,
    chain_status_text: chainStatusForCustomer(status),
    manifest_hash: record.manifest_hash || record.blockchain_hash || null,
    chain_tx_hash: status === 'confirmed' ? record.chain_tx_hash || null : null,
    chain_certificate_url: status === 'confirmed' ? certificateUrl : null,
    chain_confirmed_at: status === 'confirmed' ? record.chain_confirmed_at || null : null
  };
}

module.exports = {
  chainStatusForCustomer,
  chainPublicPayload
};
