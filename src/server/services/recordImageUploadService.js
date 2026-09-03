'use strict';

const {
  createRecordImageThumbnail,
  normalizeRecordImageUpload
} = require('./imageUploadSecurityService');
const { issueRecordImageUploadProof } = require('./uploadProofService');
const { resolveRecordImageUploadEligibility } = require('./recordImageUploadEligibilityService');
const { saveRecordImage } = require('./storageService');

async function processRecordImageUpload({
  file,
  accessToken,
  accountId,
  validateNormalizedImage = null
} = {}, {
  eligibilityResolver = resolveRecordImageUploadEligibility,
  imageNormalizer = normalizeRecordImageUpload,
  thumbnailNormalizer = createRecordImageThumbnail,
  imageSaver = saveRecordImage,
  proofIssuer = issueRecordImageUploadProof
} = {}) {
  const canonicalQr = await eligibilityResolver({ accessToken, accountId });
  const normalizedFile = await imageNormalizer(file);
  if (typeof validateNormalizedImage === 'function') {
    await validateNormalizedImage(normalizedFile);
  }
  const thumbnailFile = await thumbnailNormalizer(normalizedFile);
  const stored = await imageSaver({
    file: normalizedFile,
    thumbnailFile,
    qrId: canonicalQr.id
  });
  const uploadProof = proofIssuer({
    accountId,
    qrId: canonicalQr.id,
    objectKey: stored.object_key
  });
  return Object.freeze({ canonicalQr, normalizedFile, thumbnailFile, stored, uploadProof });
}

module.exports = { processRecordImageUpload };
