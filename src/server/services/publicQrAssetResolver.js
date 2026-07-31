'use strict';

const {
  getPublicObjectUrl,
  getSignedUrl
} = require('./storageService');

function recordImageUrl(record) {
  return record && (record.image_url_snapshot || record.image_url) || null;
}

function recordImageObjectKey(record) {
  return record && record.image_object_key || null;
}

function certificateUrl(proof) {
  return proof && (
    proof.provider_certificate_url
    || proof.certificate_object_url_snapshot
    || proof.chain_certificate_url
  ) || null;
}

function certificateObjectKey(proof) {
  return proof && (proof.certificate_object_key || proof.chain_certificate_object_key) || null;
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

  function resolveRecordImage({ record, channel }) {
    const imageUrl = recordImageUrl(record);
    const objectKey = recordImageObjectKey(record);
    const normalizedChannel = channel === 'miniapp' ? 'miniapp' : 'h5';
    return memoized(`image:${normalizedChannel}:${objectKey || ''}:${imageUrl || ''}`, () => {
      if (normalizedChannel === 'miniapp') {
        if (imageUrl) return imageUrl;
        if (!objectKey) return imageUrl;
        try {
          const publicUrl = resolvePublicObjectUrl(objectKey);
          if (publicUrl) return publicUrl;
        } catch (_error) {
          // Preserve the current miniapp signed URL fallback.
        }
        try {
          return resolveSignedUrl(objectKey);
        } catch (_error) {
          return imageUrl;
        }
      }

      if (!objectKey) return imageUrl;
      try {
        return resolveSignedUrl(objectKey);
      } catch (_error) {
        return imageUrl;
      }
    });
  }

  function resolveCertificate({ proof, channel }) {
    const objectKey = certificateObjectKey(proof);
    const fallback = certificateUrl(proof);
    const normalizedChannel = channel === 'miniapp' ? 'miniapp' : 'h5';
    return memoized(`certificate:${normalizedChannel}:${objectKey || ''}:${fallback || ''}`, () => (
      objectKey ? resolveSignedUrl(objectKey) : fallback
    ));
  }

  return Object.freeze({
    resolveRecordImage,
    resolveCertificate
  });
}

module.exports = {
  createPublicQrAssetResolver
};
