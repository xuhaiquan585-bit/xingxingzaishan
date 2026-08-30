'use strict';

const crypto = require('node:crypto');

const {
  getPublicObjectUrl,
  getSignedUrl,
  classifyRecordImageReference,
  recordImageQrIdSha256
} = require('./storageService');

function certificateObjectKey(proof) {
  return proof && (proof.certificate_object_key || proof.chain_certificate_object_key) || null;
}

function buildRecordImageCacheKey({ decision, authority, channel }) {
  const qrId = String(authority && (authority.qrId || authority.qr_id) || '').trim();
  const qrHash = qrId ? recordImageQrIdSha256(qrId) : 'none';
  const reference = decision.kind === 'object'
    ? decision.objectKey
    : decision.url || '';
  const referenceHash = crypto.createHash('sha256').update(reference, 'utf8').digest('hex');
  return `image:${channel}:${qrHash}:${decision.kind}:${referenceHash}`;
}

function buildLegacyRecordImageProxyUrl(authority, env = process.env) {
  const qrId = String(authority && (authority.qrId || authority.qr_id) || '').trim();
  if (!qrId) return null;
  const relativeUrl = `/api/qr/media/${encodeURIComponent(qrId)}`;
  const baseUrl = String(env.BASE_URL || '').trim().replace(/\/$/, '');
  return baseUrl ? `${baseUrl}${relativeUrl}` : relativeUrl;
}

function createPublicQrAssetResolver({
  resolveSignedUrl = getSignedUrl,
  resolvePublicObjectUrl = getPublicObjectUrl
} = {}) {
  const cache = new Map();

  function memoized(cacheKey, factory) {
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const value = factory();
    cache.set(cacheKey, value);
    return value;
  }

  function resolveRecordImage({ record, authority, channel }) {
    const normalizedChannel = channel === 'miniapp' ? 'miniapp' : 'h5';
    const decision = classifyRecordImageReference({ record, authority });
    const cacheKey = buildRecordImageCacheKey({
      decision,
      authority,
      channel: normalizedChannel
    });
    return memoized(cacheKey, () => {
      if (decision.kind === 'rejected') return null;
      if (decision.kind === 'snapshot' || decision.kind === 'local') return decision.url;
      if (decision.namespace === 'legacy-prefixed') {
        return buildLegacyRecordImageProxyUrl(authority);
      }
      const objectKey = decision.objectKey;
      if (normalizedChannel === 'miniapp') {
        try {
          const publicUrl = resolvePublicObjectUrl(objectKey);
          if (publicUrl) return publicUrl;
        } catch (_error) {
          // Preserve the current miniapp signed URL fallback.
        }
        try {
          return resolveSignedUrl(objectKey);
        } catch (_error) {
          return null;
        }
      }

      try {
        return resolveSignedUrl(objectKey);
      } catch (_error) {
        return null;
      }
    });
  }

  function resolveCertificate({ proof, channel }) {
    const objectKey = certificateObjectKey(proof);
    if (!objectKey) return null;
    const normalizedChannel = channel === 'miniapp' ? 'miniapp' : 'h5';
    return memoized(`certificate:${normalizedChannel}:${objectKey}`, () => resolveSignedUrl(objectKey));
  }

  return Object.freeze({
    resolveRecordImage,
    resolveCertificate
  });
}

module.exports = {
  buildLegacyRecordImageProxyUrl,
  buildRecordImageCacheKey,
  createPublicQrAssetResolver
};
