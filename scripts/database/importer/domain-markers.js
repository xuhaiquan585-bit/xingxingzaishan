'use strict';

const crypto = require('node:crypto');
const { mapSourceToPlan } = require('./mapping');

const PUBLIC_QR_DOMAIN_CHECKSUM_KEY = 'public_qr_v1_sha256';
const PUBLIC_QR_DOMAIN_COLLECTIONS = Object.freeze([
  'qr_batches',
  'qr_codes',
  'records',
  'co_creations',
  'co_creation_comments',
  'record_proofs',
  'record_archives'
]);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = stableValue(value[key]);
      return result;
    }, {});
  }
  return value;
}

function canonicalRows(rows, collection) {
  if (!Array.isArray(rows)) {
    throw new TypeError(`Public QR domain collection is missing: ${collection}`);
  }
  return rows
    .map((row) => stableValue(row))
    .sort((left, right) => {
      const leftText = JSON.stringify(left);
      const rightText = JSON.stringify(right);
      if (leftText < rightText) return -1;
      if (leftText > rightText) return 1;
      return 0;
    });
}

function publicQrDomainSha256(plan) {
  const collections = {};
  for (const collection of PUBLIC_QR_DOMAIN_COLLECTIONS) {
    collections[collection] = canonicalRows(plan && plan[collection], collection);
  }
  const payload = {
    version: 'public_qr_v1',
    collections
  };
  return crypto.createHash('sha256')
    .update(JSON.stringify(stableValue(payload)))
    .digest('hex');
}

function publicQrDomainSha256FromSource(source) {
  return publicQrDomainSha256(mapSourceToPlan(source).plan);
}

module.exports = {
  PUBLIC_QR_DOMAIN_CHECKSUM_KEY,
  PUBLIC_QR_DOMAIN_COLLECTIONS,
  publicQrDomainSha256,
  publicQrDomainSha256FromSource
};
