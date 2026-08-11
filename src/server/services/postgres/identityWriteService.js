'use strict';

const { presentIdentity } = require('./identityReadAdapter');

const BIND_CONFLICT_CODES = new Set([
  'DUPLICATE_OPENID_IDENTITY',
  'DUPLICATE_PHONE_IDENTITY',
  'REPOSITORY_CHECK_CONFLICT',
  'REPOSITORY_FOREIGN_KEY_CONFLICT',
  'REPOSITORY_UNIQUE_CONFLICT'
]);

class IdentityWriteError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'IdentityWriteError';
    this.code = code;
  }
}

function requireMethod(target, method) {
  if (!target || typeof target[method] !== 'function') {
    throw new IdentityWriteError(
      'IDENTITY_WRITE_DEPENDENCY_REQUIRED',
      'A required identity write dependency is unavailable.'
    );
  }
  return target[method].bind(target);
}

function normalizeIdentityValue(value) {
  return String(value || '').trim();
}

function normalizedUnionid(value) {
  return normalizeIdentityValue(value) || null;
}

function sourceWithMiniapp(source) {
  const value = normalizeIdentityValue(source);
  if (value === 'miniapp' || value === 'web+miniapp') return value;
  if (value === 'web' || value === 'migration') return 'web+miniapp';
  throw new IdentityWriteError('IDENTITY_SOURCE_CONFLICT');
}

function operationTimestamp(clock) {
  const candidate = clock();
  const value = candidate instanceof Date ? candidate : new Date(candidate);
  if (Number.isNaN(value.getTime())) {
    throw new IdentityWriteError('IDENTITY_WRITE_CLOCK_INVALID');
  }
  return value.toISOString();
}

function identityLockKey(kind, value) {
  return `xingxingzaishan:identity:${kind}:${value}`;
}

class IdentityWriteTransaction {
  constructor({
    accountRepository,
    identityRepository,
    identityReferenceRepository,
    clock = () => new Date()
  } = {}) {
    this.allocateAccountId = requireMethod(accountRepository, 'allocateId');
    this.insertAccount = requireMethod(accountRepository, 'insert');
    this.findAccountForUpdate = requireMethod(accountRepository, 'findByIdForUpdate');
    this.deleteAccount = requireMethod(accountRepository, 'deleteById');
    this.lockIdentityKeys = requireMethod(identityRepository, 'lockIdentityKeys');
    this.findPhoneForUpdate = requireMethod(identityRepository, 'findUniqueByPhoneForUpdate');
    this.findOpenidForUpdate = requireMethod(identityRepository, 'findUniqueByOpenidForUpdate');
    this.countAccountIdentities = requireMethod(identityRepository, 'countByAccountId');
    this.insertIdentity = requireMethod(identityRepository, 'insert');
    this.updateIdentity = requireMethod(identityRepository, 'updateIdentity');
    this.deleteIdentity = requireMethod(identityRepository, 'deleteById');
    this.hasBusinessReferences = requireMethod(
      identityReferenceRepository,
      'hasBusinessReferences'
    );
    if (typeof clock !== 'function') {
      throw new IdentityWriteError('IDENTITY_WRITE_CLOCK_REQUIRED');
    }
    this.clock = clock;
  }

  async createOrGetWebIdentity({ phone } = {}) {
    const normalizedPhone = normalizeIdentityValue(phone);
    if (!normalizedPhone) throw new IdentityWriteError('IDENTITY_PHONE_REQUIRED');
    await this.lockIdentityKeys([identityLockKey('phone', normalizedPhone)]);
    const existing = await this.findPhoneForUpdate(normalizedPhone);
    if (existing) return presentIdentity(await this.#requireMappedIdentity(existing));
    return this.#createIdentity({
      phone: normalizedPhone,
      openid: null,
      unionid: null,
      source: 'web',
      createdFrom: 'web_phone'
    });
  }

  async createOrGetMiniappIdentity({ openid, unionid = null } = {}) {
    const normalizedOpenid = normalizeIdentityValue(openid);
    if (!normalizedOpenid) throw new IdentityWriteError('IDENTITY_OPENID_REQUIRED');
    await this.lockIdentityKeys([identityLockKey('openid', normalizedOpenid)]);
    const existing = await this.findOpenidForUpdate(normalizedOpenid);
    if (!existing) {
      return this.#createIdentity({
        phone: null,
        openid: normalizedOpenid,
        unionid: normalizedUnionid(unionid),
        source: 'miniapp',
        createdFrom: 'miniapp_openid'
      });
    }

    await this.#requireMappedIdentity(existing);
    const nextUnionid = normalizedUnionid(unionid);
    if (!nextUnionid || nextUnionid === existing.unionid) return presentIdentity(existing);
    return presentIdentity(await this.#updateRequired(existing, {
      unionid: nextUnionid,
      updated_at: operationTimestamp(this.clock)
    }));
  }

  async bindMiniappPhone({ openid, phone, unionid = null } = {}) {
    const normalizedOpenid = normalizeIdentityValue(openid);
    const normalizedPhone = normalizeIdentityValue(phone);
    if (!normalizedOpenid) throw new IdentityWriteError('IDENTITY_OPENID_REQUIRED');
    if (!normalizedPhone) throw new IdentityWriteError('IDENTITY_PHONE_REQUIRED');

    return this.#bindMiniappPhone({
      openid: normalizedOpenid,
      phone: normalizedPhone,
      unionid: normalizedUnionid(unionid)
    });
  }

  async #bindMiniappPhone({ openid, phone, unionid }) {
    await this.lockIdentityKeys([
      identityLockKey('openid', openid),
      identityLockKey('phone', phone)
    ]);
    const miniIdentity = await this.findOpenidForUpdate(openid);
    if (!miniIdentity) throw new IdentityWriteError('MINIAPP_USER_NOT_FOUND');
    await this.#requireMappedIdentity(miniIdentity);
    if (await this.countAccountIdentities(miniIdentity.account_id) !== 1) {
      throw new IdentityWriteError('MINIAPP_ACCOUNT_CONFLICT');
    }

    const phoneIdentity = await this.findPhoneForUpdate(phone);
    const miniPhone = normalizeIdentityValue(miniIdentity.phone);
    const nextUnionid = unionid || miniIdentity.unionid || null;

    if (miniPhone) {
      if (miniPhone !== phone) {
        throw new IdentityWriteError('MINIAPP_PHONE_REPLACE_REQUIRED');
      }
      if (nextUnionid === miniIdentity.unionid) {
        return { data: presentIdentity(miniIdentity) };
      }
      return {
        data: presentIdentity(await this.#updateRequired(miniIdentity, {
          unionid: nextUnionid,
          updated_at: operationTimestamp(this.clock)
        }))
      };
    }

    if (!phoneIdentity || String(phoneIdentity.id) === String(miniIdentity.id)) {
      return {
        data: presentIdentity(await this.#updateRequired(miniIdentity, {
          phone,
          unionid: nextUnionid,
          updated_at: operationTimestamp(this.clock)
        }))
      };
    }

    try {
      await this.#requireMappedIdentity(phoneIdentity);
    } catch (_error) {
      throw new IdentityWriteError('MINIAPP_ACCOUNT_CONFLICT');
    }
    if (await this.countAccountIdentities(phoneIdentity.account_id) !== 1) {
      throw new IdentityWriteError('MINIAPP_ACCOUNT_CONFLICT');
    }
    if (
      normalizeIdentityValue(miniIdentity.phone)
      || normalizeIdentityValue(miniIdentity.openid) !== openid
      || normalizeIdentityValue(miniIdentity.source) !== 'miniapp'
    ) {
      throw new IdentityWriteError('MINIAPP_ACCOUNT_CONFLICT');
    }
    if (await this.hasBusinessReferences({
      accountId: miniIdentity.account_id,
      openid: miniIdentity.openid
    })) {
      throw new IdentityWriteError('MINIAPP_ACCOUNT_CONFLICT');
    }

    const removedIdentity = await this.deleteIdentity(miniIdentity.id);
    if (!removedIdentity) throw new IdentityWriteError('MINIAPP_ACCOUNT_CONFLICT');
    const updatedAt = operationTimestamp(this.clock);
    const merged = await this.#updateRequired(phoneIdentity, {
      openid,
      unionid: nextUnionid,
      source: sourceWithMiniapp(phoneIdentity.source),
      updated_at: updatedAt
    });
    const removedAccount = await this.deleteAccount(miniIdentity.account_id);
    if (!removedAccount) throw new IdentityWriteError('MINIAPP_ACCOUNT_CONFLICT');
    return { data: presentIdentity(merged) };
  }

  async #createIdentity({ phone, openid, unionid, source, createdFrom }) {
    const timestamp = operationTimestamp(this.clock);
    const accountId = await this.allocateAccountId();
    const account = await this.insertAccount({
      id: accountId,
      status: 'active',
      display_name: '',
      avatar_url: '',
      created_from: createdFrom,
      created_at: timestamp,
      updated_at: timestamp
    });
    if (!account) throw new IdentityWriteError('IDENTITY_ACCOUNT_CREATE_FAILED');
    const identity = await this.insertIdentity({
      legacy_id: null,
      account_id: accountId,
      phone,
      openid,
      unionid,
      source,
      created_at: timestamp,
      updated_at: timestamp
    });
    if (!identity) throw new IdentityWriteError('IDENTITY_CREATE_FAILED');
    return presentIdentity(identity);
  }

  async #requireMappedIdentity(identity) {
    const accountId = normalizeIdentityValue(identity && identity.account_id);
    const account = accountId ? await this.findAccountForUpdate(accountId) : null;
    if (!account) throw new IdentityWriteError('ACCOUNT_MAPPING_REQUIRED');
    return identity;
  }

  async #updateRequired(identity, patch) {
    const updated = await this.updateIdentity(identity.id, {
      phone: identity.phone || null,
      openid: identity.openid || null,
      unionid: identity.unionid || null,
      source: identity.source,
      updated_at: identity.updated_at,
      ...patch
    });
    if (!updated) throw new IdentityWriteError('MINIAPP_ACCOUNT_CONFLICT');
    return updated;
  }
}

function createIdentityWriteService({
  pool,
  transactionRunner,
  repositoryTypes,
  clock,
  beforeOperation
} = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new IdentityWriteError('IDENTITY_WRITE_POOL_REQUIRED');
  }
  const runTransaction = transactionRunner
    || require('../../database/transaction').withTransaction;
  const repositories = repositoryTypes || require('../../repositories');

  async function execute(operation, input) {
    return runTransaction(pool, async (transactionContext) => {
      if (typeof beforeOperation === 'function') {
        await beforeOperation({ transactionContext, operation, input });
      }
      const transaction = new IdentityWriteTransaction({
        accountRepository: new repositories.AccountRepository(transactionContext),
        identityRepository: new repositories.IdentityRepository(transactionContext),
        identityReferenceRepository:
          new repositories.IdentityReferenceRepository(transactionContext),
        clock
      });
      return transaction[operation](input);
    }, { isolationLevel: 'read committed' });
  }

  return Object.freeze({
    createOrGetWebIdentity: (input) => execute('createOrGetWebIdentity', input),
    createOrGetMiniappIdentity: (input) => execute('createOrGetMiniappIdentity', input),
    async bindMiniappPhone(input) {
      try {
        return await execute('bindMiniappPhone', input);
      } catch (error) {
        if (error instanceof IdentityWriteError) return { error: error.code };
        if (BIND_CONFLICT_CODES.has(error && error.code)) {
          return { error: 'MINIAPP_ACCOUNT_CONFLICT' };
        }
        throw error;
      }
    }
  });
}

module.exports = {
  IdentityWriteError,
  IdentityWriteTransaction,
  createIdentityWriteService,
  sourceWithMiniapp
};
