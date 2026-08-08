'use strict';

class IdentityReadError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'IdentityReadError';
    this.code = code;
  }
}

function requireMethod(target, method) {
  if (!target || typeof target[method] !== 'function') {
    throw new IdentityReadError(
      'IDENTITY_READ_DEPENDENCY_REQUIRED',
      'A required identity read dependency is unavailable.'
    );
  }
  return target[method].bind(target);
}

function normalizeIdentityValue(value) {
  return String(value || '').trim();
}

function legacyIdentityId(identity) {
  const value = identity && identity.legacy_id !== null
    && identity.legacy_id !== undefined
    && identity.legacy_id !== ''
    ? identity.legacy_id
    : identity && identity.id;
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const numericValue = Number(value);
    if (Number.isSafeInteger(numericValue)) return numericValue;
  }
  return value;
}

function identityTimestamp(value) {
  if (value instanceof Date) return value.toISOString();
  return value === null || value === undefined ? null : String(value);
}

function presentIdentity(identity) {
  if (!identity) return null;
  return Object.freeze({
    id: legacyIdentityId(identity),
    phone: identity.phone || null,
    openid: identity.openid || null,
    unionid: identity.unionid || null,
    source: identity.source,
    created_at: identityTimestamp(identity.created_at),
    updated_at: identityTimestamp(identity.updated_at),
    account_id: identity.account_id
  });
}

class IdentityReadAdapter {
  constructor({ identityRepository, accountRepository } = {}) {
    this.findById = requireMethod(identityRepository, 'findById');
    this.findUniqueByPhone = requireMethod(identityRepository, 'findUniqueByPhone');
    this.findUniqueByOpenid = requireMethod(identityRepository, 'findUniqueByOpenid');
    this.findAccountById = requireMethod(accountRepository, 'findById');
  }

  async findExistingByPhone(phone) {
    const normalizedPhone = normalizeIdentityValue(phone);
    if (!normalizedPhone) return null;
    const identity = await this.findUniqueByPhone(normalizedPhone);
    if (!identity) return null;
    return presentIdentity(await this.#requireMappedIdentity(identity));
  }

  async findExistingByOpenid(openid) {
    const normalizedOpenid = normalizeIdentityValue(openid);
    if (!normalizedOpenid) return null;
    const identity = await this.findUniqueByOpenid(normalizedOpenid);
    if (!identity) return null;
    return presentIdentity(await this.#requireMappedIdentity(identity));
  }

  async getAuthenticatedIdentity({ identityId, accountId = null, openid = null } = {}) {
    const normalizedIdentityId = normalizeIdentityValue(identityId);
    if (!normalizedIdentityId) return { error: 'UNAUTHORIZED' };
    const identity = await this.findById(normalizedIdentityId);
    if (!identity) return { error: 'UNAUTHORIZED' };
    try {
      const mapped = await this.#requireMappedIdentity(identity, { accountId, openid });
      return { data: presentIdentity(mapped) };
    } catch (error) {
      if (error instanceof IdentityReadError) return { error: error.code };
      throw error;
    }
  }

  async #requireMappedIdentity(identity, { accountId = null, openid = null } = {}) {
    const mappedAccountId = normalizeIdentityValue(identity && identity.account_id);
    const account = mappedAccountId
      ? await this.findAccountById(mappedAccountId)
      : null;
    if (!account) {
      throw new IdentityReadError('ACCOUNT_MAPPING_REQUIRED');
    }
    const expectedAccountId = normalizeIdentityValue(accountId);
    if (expectedAccountId && expectedAccountId !== mappedAccountId) {
      throw new IdentityReadError('ACCOUNT_MAPPING_MISMATCH');
    }
    const expectedOpenid = normalizeIdentityValue(openid);
    if (
      expectedOpenid
      && normalizeIdentityValue(identity.openid) !== expectedOpenid
    ) {
      throw new IdentityReadError('ACCOUNT_IDENTITY_MISMATCH');
    }
    return identity;
  }
}

module.exports = {
  IdentityReadAdapter,
  IdentityReadError,
  legacyIdentityId,
  presentIdentity
};
