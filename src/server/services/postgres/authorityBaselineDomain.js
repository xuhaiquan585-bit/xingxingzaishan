'use strict';

const DOMAIN_HASH_PATTERN = /^[a-f0-9]{64}$/;
const BASELINE_DOMAIN_ENV = 'POSTGRES_AUTHORITY_BASELINE_DOMAIN_SHA256';

function readAuthorityBaselineDomain(env, targetDomainHash) {
  const rawValue = env && env[BASELINE_DOMAIN_ENV];
  const baselineDomainHash = String(rawValue || '').trim();
  if (!baselineDomainHash) {
    return Object.freeze({
      baselineDomainHash: targetDomainHash,
      explicit: false
    });
  }
  if (!DOMAIN_HASH_PATTERN.test(baselineDomainHash)) {
    return Object.freeze({ error: 'BASELINE_DOMAIN_SHA256_INVALID' });
  }
  return Object.freeze({ baselineDomainHash, explicit: true });
}

module.exports = {
  BASELINE_DOMAIN_ENV,
  DOMAIN_HASH_PATTERN,
  readAuthorityBaselineDomain
};
