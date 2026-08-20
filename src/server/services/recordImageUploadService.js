'use strict';

const { normalizeUploadedImage } = require('./imageUploadSecurityService');
const { issueRecordImageUploadProof } = require('./uploadProofService');
const { resolveRecordImageUploadEligibility } = require('./recordImageUploadEligibilityService');
const { saveRecordImage } = require('./storageService');

async function processRecordImageUpload({
  file,
  accessToken,
  accountId,
  maxOutputWidth,
  jpegQuality,
  validateNormalizedImage = null
} = {}, {
  eligibilityResolver = resolveRecordImageUploadEligibility,
  imageNormalizer = normalizeUploadedImage,
  imageSaver = saveRecordImage,
  proofIssuer = issueRecordImageUploadProof
} = {}) {
  const canonicalQr = await eligibilityResolver({ accessToken, accountId });
  const normalizedFile = await imageNormalizer(file, { maxOutputWidth, jpegQuality });
  if (typeof validateNormalizedImage === 'function') {
    await validateNormalizedImage(normalizedFile);
  }
  const stored = await imageSaver({ file: normalizedFile, qrId: canonicalQr.id });
  const uploadProof = proofIssuer({
    accountId,
    qrId: canonicalQr.id,
    objectKey: stored.object_key
  });
  return Object.freeze({ canonicalQr, normalizedFile, stored, uploadProof });
}

module.exports = { processRecordImageUpload };
