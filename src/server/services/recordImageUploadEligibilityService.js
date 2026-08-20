'use strict';

const {
  findRecordImageUploadEligibilityByAccessToken
} = require('./dbService');
const {
  authorizeRecordImageUpload
} = require('./postgres/qrLifecycleWriteRuntime');

class RecordImageUploadEligibilityError extends Error {
  constructor() {
    super('UPLOAD_QR_NOT_ELIGIBLE');
    this.name = 'RecordImageUploadEligibilityError';
    this.code = 'UPLOAD_QR_NOT_ELIGIBLE';
  }
}

async function resolveRecordImageUploadEligibility({ accessToken, accountId } = {}, {
  authorityAuthorizer = authorizeRecordImageUpload,
  jsonEligibilityFinder = findRecordImageUploadEligibilityByAccessToken
} = {}) {
  const key = String(accessToken || '').trim();
  const normalizedAccountId = String(accountId || '').trim();
  if (!key || !normalizedAccountId) throw new RecordImageUploadEligibilityError();

  const authority = await authorityAuthorizer({
    key,
    accountId: normalizedAccountId
  });
  const qr = authority.selected
    ? authority.qr
    : jsonEligibilityFinder(key);
  if (!qr || !String(qr.id || '').trim()) {
    throw new RecordImageUploadEligibilityError();
  }
  return Object.freeze({ id: String(qr.id) });
}

module.exports = {
  RecordImageUploadEligibilityError,
  resolveRecordImageUploadEligibility
};
