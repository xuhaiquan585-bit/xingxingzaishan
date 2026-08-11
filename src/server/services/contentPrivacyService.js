'use strict';

const PHONE_PATTERN = /^1\d{10}$/;
const CONTENT_PRIVACY_POLICY = 'cross-account-full-phone-v1';

function normalizedText(value) {
  return String(value || '');
}

function normalizedAccountId(value) {
  return normalizedText(value).trim();
}

function validPhone(value) {
  const phone = normalizedText(value).trim();
  return PHONE_PATTERN.test(phone) ? phone : '';
}

function crossAccountPhones({ ownerAccountId, identities } = {}) {
  const owner = normalizedAccountId(ownerAccountId);
  const phones = new Set();

  (Array.isArray(identities) ? identities : []).forEach((identity) => {
    if (!identity || typeof identity !== 'object') return;
    if (normalizedAccountId(identity.account_id || identity.accountId) === owner) return;
    const phone = validPhone(identity.phone);
    if (phone) phones.add(phone);
  });

  return [...phones].sort();
}

function maskPhone(phone) {
  return `${phone.slice(0, 3)}****${phone.slice(7)}`;
}

function inspectCrossAccountPhoneReferences({
  content,
  ownerAccountId,
  identities
} = {}) {
  const original = normalizedText(content);
  let redacted = original;
  let matchCount = 0;
  let matchedIdentityCount = 0;

  crossAccountPhones({ ownerAccountId, identities }).forEach((phone) => {
    const parts = redacted.split(phone);
    const occurrences = parts.length - 1;
    if (occurrences === 0) return;
    redacted = parts.join(maskPhone(phone));
    matchCount += occurrences;
    matchedIdentityCount += 1;
  });

  return Object.freeze({
    content: redacted,
    has_reference: matchCount > 0,
    match_count: matchCount,
    matched_identity_count: matchedIdentityCount
  });
}

function hasCrossAccountPhoneReference(input) {
  return inspectCrossAccountPhoneReferences(input).has_reference;
}

function redactCrossAccountPhoneReferences(input) {
  return inspectCrossAccountPhoneReferences(input);
}

module.exports = {
  CONTENT_PRIVACY_POLICY,
  PHONE_PATTERN,
  hasCrossAccountPhoneReference,
  inspectCrossAccountPhoneReferences,
  maskPhone,
  redactCrossAccountPhoneReferences
};
