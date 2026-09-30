'use strict';

const { findPublicQrReadContextByKey } = require('./dbService');
const { readPublicQrPrimary } = require('./postgres/publicQrPrimaryReadRuntime');
const { createPublicQrAssetResolver } = require('./publicQrAssetResolver');

async function readSharedRecord(key, { assetResolver = createPublicQrAssetResolver() } = {}) {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return null;
  const { qr, publicQrDomainHash } = findPublicQrReadContextByKey(normalizedKey);
  const selected = await readPublicQrPrimary({
    key: normalizedKey,
    publicQrId: qr && qr.id,
    domainHash: publicQrDomainHash,
    channel: 'h5',
    viewer: { accountId: '', phoneBound: false },
    assetResolver
  });
  if (selected.selected) {
    return selected.dto && selected.dto.activation_status === 'activated' ? selected.dto : null;
  }
  if (!qr || qr.hidden === true || qr.activation_status !== 'activated') return null;
  return {
    id: qr.id,
    content: qr.content || '',
    image_url: await assetResolver.resolveRecordImage({
      record: qr,
      channel: 'h5',
      authority: { qrId: qr.id, accessToken: qr.qr_access_token }
    })
  };
}

module.exports = { readSharedRecord };
