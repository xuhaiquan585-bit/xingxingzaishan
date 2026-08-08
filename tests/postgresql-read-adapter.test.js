'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  PublicQrReadAdapter,
  PublicQrReadError,
  publicComments,
  publicLegacyCommentId,
  publicTimestamp
} = require('../src/server/services/postgres/publicQrReadAdapter');
const {
  comparePublicQrDtos
} = require('../src/server/services/postgres/publicQrDtoComparator');
const {
  IdentityReadAdapter,
  IdentityReadError,
  legacyIdentityId,
  presentIdentity
} = require('../src/server/services/postgres/identityReadAdapter');
const {
  IdentityWriteError,
  IdentityWriteTransaction,
  createIdentityWriteService,
  sourceWithMiniapp
} = require('../src/server/services/postgres/identityWriteService');
const {
  QrLifecycleWriteError,
  QrLifecycleWriteTransaction,
  createQrLifecycleWriteService
} = require('../src/server/services/postgres/qrLifecycleWriteService');
const {
  OutboxWorkerError,
  createOutboxWorker,
  safeErrorCode
} = require('../src/server/services/postgres/outboxWorkerService');
const {
  PersonalRecordReadAdapter
} = require('../src/server/services/postgres/personalRecordReadAdapter');

function makeHarness({
  qr = null,
  record = null,
  coCreation = null,
  comments = [],
  proof = null,
  batch = null,
  batchReader,
  assetResolver
} = {}) {
  const calls = [];
  const dependencies = {
    qrRepository: {
      async findByKey(key) {
        calls.push(['qr.findByKey', key]);
        return qr;
      }
    },
    recordRepository: {
      async findByQrId(qrId) {
        calls.push(['record.findByQrId', qrId]);
        return record;
      }
    },
    coCreationRepository: {
      async findByQrId(qrId) {
        calls.push(['coCreation.findByQrId', qrId]);
        return coCreation;
      },
      async listPublicCommentsCandidate(coCreationId, options) {
        calls.push(['coCreation.listPublicCommentsCandidate', coCreationId, options.limit]);
        return comments;
      }
    },
    proofRepository: {
      async findByRecordId(recordQrId) {
        calls.push(['proof.findByRecordId', recordQrId]);
        return proof;
      }
    },
    batchReader: batchReader === undefined ? {
      async findById(batchId) {
        calls.push(['batch.findById', batchId]);
        return batch;
      }
    } : batchReader,
    assetResolver: assetResolver === undefined ? {
      async resolveRecordImage({ record: currentRecord, channel }) {
        calls.push(['asset.resolveRecordImage', currentRecord.qr_id, channel]);
        return `resolved://${channel}/${currentRecord.image_object_key}`;
      },
      async resolveCertificate({ proof: currentProof, channel }) {
        calls.push(['asset.resolveCertificate', currentProof.id, channel]);
        return `certificate://${channel}/${currentProof.certificate_object_key}`;
      }
    } : assetResolver,
    publicRuntimeMetadata: { storage_mode: 'oss' }
  };
  return {
    adapter: new PublicQrReadAdapter(dependencies),
    calls
  };
}

function identityFixture(overrides = {}) {
  return {
    id: '31',
    legacy_id: null,
    account_id: 'ACC000028',
    phone: '13800000028',
    openid: 'openid-28',
    unionid: null,
    source: 'web+miniapp',
    created_at: new Date('2026-08-04T01:02:03.000Z'),
    updated_at: new Date('2026-08-04T01:02:04.000Z'),
    ...overrides
  };
}

function activatedFixture(overrides = {}) {
  return {
    qr: {
      id: 'QR_PUBLIC_1',
      lifecycle_status: 'activated',
      issue_status: 'issued',
      hidden: false,
      batch_id: 'BATCH_1',
      ...overrides.qr
    },
    record: {
      qr_id: 'QR_PUBLIC_1',
      account_id: 'ACC_INTERNAL_OWNER',
      content: 'A public memory',
      image_url_snapshot: '',
      image_object_key: 'records/public.jpg',
      phone_snapshot: 'not-public',
      sealed_at: '2026-07-01T12:00:00.000Z',
      show_brand_disclosure: true,
      brand_disclosure_text_snapshot: 'Brand disclosure',
      ...overrides.record
    },
    coCreation: {
      id: '00000000-0000-0000-0000-000000000101',
      qr_id: 'QR_PUBLIC_1',
      owner_account_id: 'ACC_INTERNAL_OWNER',
      owner_phone_snapshot: 'not-public',
      status: 'finalized',
      ...overrides.coCreation
    },
    comments: [
      {
        id: '00000000-0000-0000-0000-000000000201',
        legacy_comment_id: 'COMMENT_OLD',
        source_position: 0,
        account_id: 'ACC_OTHER',
        author_name: 'Older',
        content: 'First',
        status: 'kept',
        created_at: '2026-07-01T10:00:00.000Z'
      },
      {
        id: '00000000-0000-0000-0000-000000000202',
        legacy_comment_id: 'COMMENT_DELETED',
        source_position: 1,
        account_id: 'ACC_INTERNAL_OWNER',
        author_name: 'Deleted',
        content: 'Deleted content',
        status: 'deleted',
        created_at: '2026-07-01T12:00:00.000Z'
      },
      {
        id: '00000000-0000-0000-0000-000000000203',
        legacy_comment_id: 'COMMENT_NEW',
        source_position: 2,
        account_id: 'ACC_INTERNAL_OWNER',
        author_name: 'Newer',
        content: 'Second',
        status: 'kept',
        created_at: '2026-07-01T11:00:00.000Z'
      }
    ],
    proof: {
      id: '00000000-0000-0000-0000-000000000301',
      record_qr_id: 'QR_PUBLIC_1',
      provider: 'avata_wenchang',
      status: 'confirmed',
      manifest_hash: 'a'.repeat(64),
      transaction_hash: 'transaction-public',
      provider_certificate_url: null,
      certificate_object_key: 'proofs/certificate.json',
      confirmed_at: '2026-07-01T12:01:00.000Z'
    },
    batch: {
      id: 'BATCH_1',
      brand_name: 'Test Brand',
      disclosure_text: 'Batch disclosure',
      show_brand_disclosure_default: true
    }
  };
}

test('identity read adapter requires narrow repository dependencies', () => {
  assert.throws(
    () => new IdentityReadAdapter(),
    (error) => (
      error instanceof IdentityReadError
      && error.code === 'IDENTITY_READ_DEPENDENCY_REQUIRED'
    )
  );
});

test('identity read adapter is isolated from JSON, SQL, connections, and runtime config', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../src/server/services/postgres/identityReadAdapter.js'),
    'utf8'
  );
  assert.doesNotMatch(source, /dbService|readDB|writeDB|process\.env/);
  assert.doesNotMatch(source, /require\(['"](?:pg|\.\.\/\.\.\/database)/);
  assert.doesNotMatch(source, /\b(?:SELECT|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK)\b/);
});

test('identity read adapter preserves legacy identity shape for phone and OpenID lookups', async () => {
  const identity = identityFixture();
  const calls = [];
  const adapter = new IdentityReadAdapter({
    identityRepository: {
      async findById(id) {
        calls.push(['identity.findById', id]);
        return identity;
      },
      async findUniqueByPhone(phone) {
        calls.push(['identity.findUniqueByPhone', phone]);
        return phone === identity.phone ? identity : null;
      },
      async findUniqueByOpenid(openid) {
        calls.push(['identity.findUniqueByOpenid', openid]);
        return openid === identity.openid ? identity : null;
      }
    },
    accountRepository: {
      async findById(accountId) {
        calls.push(['account.findById', accountId]);
        return accountId === identity.account_id ? { id: accountId } : null;
      }
    }
  });

  const byPhone = await adapter.findExistingByPhone(` ${identity.phone} `);
  const byOpenid = await adapter.findExistingByOpenid(` ${identity.openid} `);
  assert.deepEqual(byPhone, {
    id: 31,
    phone: identity.phone,
    openid: identity.openid,
    unionid: null,
    source: 'web+miniapp',
    created_at: '2026-08-04T01:02:03.000Z',
    updated_at: '2026-08-04T01:02:04.000Z',
    account_id: identity.account_id
  });
  assert.deepEqual(byOpenid, byPhone);
  assert.equal(Object.isFrozen(byPhone), true);
  assert.equal(await adapter.findExistingByPhone(''), null);
  assert.equal(await adapter.findExistingByOpenid('missing-openid'), null);
  assert.deepEqual(calls, [
    ['identity.findUniqueByPhone', identity.phone],
    ['account.findById', identity.account_id],
    ['identity.findUniqueByOpenid', identity.openid],
    ['account.findById', identity.account_id],
    ['identity.findUniqueByOpenid', 'missing-openid']
  ]);
});

test('identity read adapter fails closed for broken account and session mappings', async () => {
  const identity = identityFixture();
  let account = { id: identity.account_id };
  const queryFailure = Object.assign(new Error('database unavailable'), {
    code: 'REPOSITORY_DATABASE_UNAVAILABLE'
  });
  const adapter = new IdentityReadAdapter({
    identityRepository: {
      findById: async (id) => {
        if (id === 'database-error') throw queryFailure;
        return id === String(identity.id) ? identity : null;
      },
      findUniqueByPhone: async () => identity,
      findUniqueByOpenid: async () => identity
    },
    accountRepository: {
      findById: async () => account
    }
  });

  account = null;
  await assert.rejects(
    adapter.findExistingByPhone(identity.phone),
    (error) => error.code === 'ACCOUNT_MAPPING_REQUIRED'
  );
  account = { id: identity.account_id };
  assert.deepEqual(
    await adapter.getAuthenticatedIdentity({ identityId: 'missing' }),
    { error: 'UNAUTHORIZED' }
  );
  assert.deepEqual(
    await adapter.getAuthenticatedIdentity({
      identityId: identity.id,
      accountId: 'ACC999999'
    }),
    { error: 'ACCOUNT_MAPPING_MISMATCH' }
  );
  assert.deepEqual(
    await adapter.getAuthenticatedIdentity({
      identityId: identity.id,
      accountId: identity.account_id,
      openid: 'different-openid'
    }),
    { error: 'ACCOUNT_IDENTITY_MISMATCH' }
  );
  const authenticated = await adapter.getAuthenticatedIdentity({
    identityId: identity.id,
    accountId: identity.account_id,
    openid: identity.openid
  });
  assert.equal(authenticated.data.id, 31);
  await assert.rejects(
    adapter.getAuthenticatedIdentity({ identityId: 'database-error' }),
    (error) => error === queryFailure
  );
});

test('identity presentation prefers legacy IDs and keeps unsafe bigint IDs as strings', () => {
  assert.equal(legacyIdentityId({ id: '31', legacy_id: null }), 31);
  assert.equal(legacyIdentityId({ id: '32', legacy_id: 'legacy-user' }), 'legacy-user');
  assert.equal(
    presentIdentity(identityFixture({ id: '9007199254740993' })).id,
    '9007199254740993'
  );
});

function makeIdentityWriteHarness({ accounts = [], identities = [], references = [] } = {}) {
  const state = {
    accounts: accounts.map((item) => ({ ...item })),
    identities: identities.map((item) => ({ ...item })),
    references: new Set(references)
  };
  const calls = [];
  let nextAccountNumber = 29;
  let nextIdentityId = 32;
  const accountRepository = {
    async allocateId() {
      return `ACC${String(nextAccountNumber++).padStart(6, '0')}`;
    },
    async insert(account) {
      state.accounts.push({ ...account });
      return { ...account };
    },
    async findByIdForUpdate(accountId) {
      return state.accounts.find((item) => item.id === accountId) || null;
    },
    async deleteById(accountId) {
      const index = state.accounts.findIndex((item) => item.id === accountId);
      if (index === -1) return null;
      return state.accounts.splice(index, 1)[0];
    }
  };
  const identityRepository = {
    async lockIdentityKeys(keys) {
      calls.push(['identity.lock', [...keys].sort()]);
    },
    async findUniqueByPhoneForUpdate(phone) {
      return state.identities.find((item) => item.phone === phone) || null;
    },
    async findUniqueByOpenidForUpdate(openid) {
      return state.identities.find((item) => item.openid === openid) || null;
    },
    async countByAccountId(accountId) {
      return state.identities.filter((item) => item.account_id === accountId).length;
    },
    async insert(identity) {
      const inserted = { id: String(nextIdentityId++), ...identity };
      state.identities.push(inserted);
      return inserted;
    },
    async updateIdentity(identityId, patch) {
      const index = state.identities.findIndex(
        (item) => String(item.id) === String(identityId)
      );
      if (index === -1) return null;
      state.identities[index] = { ...state.identities[index], ...patch };
      return state.identities[index];
    },
    async deleteById(identityId) {
      const index = state.identities.findIndex(
        (item) => String(item.id) === String(identityId)
      );
      if (index === -1) return null;
      return state.identities.splice(index, 1)[0];
    }
  };
  const identityReferenceRepository = {
    async hasBusinessReferences({ accountId, openid }) {
      return state.references.has(accountId) || state.references.has(openid);
    }
  };
  return {
    accountRepository,
    calls,
    identityReferenceRepository,
    identityRepository,
    state
  };
}

function makeIdentityWriteTransaction(harness) {
  return new IdentityWriteTransaction({
    ...harness,
    clock: () => new Date('2026-08-08T08:00:00.000Z')
  });
}

test('identity write transaction requires narrow transaction-scoped dependencies', () => {
  assert.throws(
    () => new IdentityWriteTransaction(),
    (error) => (
      error instanceof IdentityWriteError
      && error.code === 'IDENTITY_WRITE_DEPENDENCY_REQUIRED'
    )
  );
});

test('identity write source transitions stay inside the PostgreSQL constraint', () => {
  assert.equal(sourceWithMiniapp('miniapp'), 'miniapp');
  assert.equal(sourceWithMiniapp('web'), 'web+miniapp');
  assert.equal(sourceWithMiniapp('web+miniapp'), 'web+miniapp');
  assert.equal(sourceWithMiniapp('migration'), 'web+miniapp');
  assert.throws(
    () => sourceWithMiniapp('unknown-source'),
    (error) => error.code === 'IDENTITY_SOURCE_CONFLICT'
  );
});

test('identity write transaction creates idempotent web and miniapp identities', async () => {
  const harness = makeIdentityWriteHarness();
  const transaction = makeIdentityWriteTransaction(harness);

  const web = await transaction.createOrGetWebIdentity({ phone: ' 13800000029 ' });
  const repeatedWeb = await transaction.createOrGetWebIdentity({ phone: '13800000029' });
  const miniapp = await transaction.createOrGetMiniappIdentity({
    openid: ' openid-new ',
    unionid: ''
  });
  const updatedMiniapp = await transaction.createOrGetMiniappIdentity({
    openid: 'openid-new',
    unionid: 'unionid-new'
  });

  assert.equal(web.account_id, 'ACC000029');
  assert.deepEqual(repeatedWeb, web);
  assert.equal(miniapp.account_id, 'ACC000030');
  assert.equal(updatedMiniapp.unionid, 'unionid-new');
  assert.equal(harness.state.accounts.length, 2);
  assert.equal(harness.state.identities.length, 2);
  assert.deepEqual(
    harness.state.accounts.map((account) => account.created_from),
    ['web_phone', 'miniapp_openid']
  );
  assert.deepEqual(
    harness.state.identities.map((identity) => identity.source),
    ['web', 'miniapp']
  );
  assert.equal(Object.isFrozen(web), true);
});

test('identity write transaction binds a phone idempotently and rejects replacement', async () => {
  const harness = makeIdentityWriteHarness({
    accounts: [{ id: 'ACC000029' }],
    identities: [{
      id: '32', legacy_id: null, account_id: 'ACC000029', phone: null,
      openid: 'openid-mini', unionid: null, source: 'miniapp',
      created_at: '2026-08-08T07:00:00.000Z',
      updated_at: '2026-08-08T07:00:00.000Z'
    }]
  });
  const transaction = makeIdentityWriteTransaction(harness);

  const bound = await transaction.bindMiniappPhone({
    openid: 'openid-mini', phone: '13800000029', unionid: 'unionid-mini'
  });
  const repeated = await transaction.bindMiniappPhone({
    openid: 'openid-mini', phone: '13800000029'
  });
  assert.equal(bound.data.phone, '13800000029');
  assert.equal(bound.data.unionid, 'unionid-mini');
  assert.equal(repeated.data.id, 32);
  await assert.rejects(
    transaction.bindMiniappPhone({
      openid: 'openid-mini', phone: '13800000030'
    }),
    (error) => error.code === 'MINIAPP_PHONE_REPLACE_REQUIRED'
  );
  assert.equal(harness.state.identities.length, 1);
});

test('identity write transaction merges disposable miniapp identity into web account', async () => {
  const initial = {
    accounts: [{ id: 'ACC000028' }, { id: 'ACC000029' }],
    identities: [
      {
        id: '31', legacy_id: null, account_id: 'ACC000028', phone: '13800000028',
        openid: null, unionid: null, source: 'web',
        created_at: '2026-08-08T06:00:00.000Z',
        updated_at: '2026-08-08T06:00:00.000Z'
      },
      {
        id: '32', legacy_id: null, account_id: 'ACC000029', phone: null,
        openid: 'openid-mini', unionid: null, source: 'miniapp',
        created_at: '2026-08-08T07:00:00.000Z',
        updated_at: '2026-08-08T07:00:00.000Z'
      }
    ]
  };
  const harness = makeIdentityWriteHarness(initial);
  const result = await makeIdentityWriteTransaction(harness).bindMiniappPhone({
    openid: 'openid-mini', phone: '13800000028', unionid: 'unionid-merged'
  });

  assert.equal(result.data.id, 31);
  assert.equal(result.data.account_id, 'ACC000028');
  assert.equal(result.data.source, 'web+miniapp');
  assert.equal(result.data.openid, 'openid-mini');
  assert.equal(harness.state.accounts.length, 1);
  assert.equal(harness.state.identities.length, 1);

  const referencedHarness = makeIdentityWriteHarness({
    ...initial,
    references: ['openid-mini']
  });
  await assert.rejects(
    makeIdentityWriteTransaction(referencedHarness).bindMiniappPhone({
      openid: 'openid-mini', phone: '13800000028'
    }),
    (error) => error.code === 'MINIAPP_ACCOUNT_CONFLICT'
  );
  assert.equal(referencedHarness.state.accounts.length, 2);
  assert.equal(referencedHarness.state.identities.length, 2);
});

test('identity write service owns one explicit database transaction per operation', async () => {
  const harness = makeIdentityWriteHarness();
  const transactionCalls = [];
  const pool = { connect() {} };
  const repositoryTypes = {
    AccountRepository: class { constructor() { return harness.accountRepository; } },
    IdentityRepository: class { constructor() { return harness.identityRepository; } },
    IdentityReferenceRepository: class {
      constructor() { return harness.identityReferenceRepository; }
    }
  };
  const service = createIdentityWriteService({
    pool,
    repositoryTypes,
    clock: () => new Date('2026-08-08T08:00:00.000Z'),
    async transactionRunner(currentPool, callback, options) {
      transactionCalls.push({ currentPool, options });
      return callback({ query() {} });
    }
  });

  const identity = await service.createOrGetWebIdentity({ phone: '13800000029' });
  assert.equal(identity.account_id, 'ACC000029');
  assert.deepEqual(transactionCalls, [{
    currentPool: pool,
    options: { isolationLevel: 'read committed' }
  }]);
});

test('identity write service converts bind errors only after transaction rejection', async () => {
  const transactionCalls = [];
  const pool = { connect() {} };
  const service = createIdentityWriteService({
    pool,
    repositoryTypes: {},
    async transactionRunner(currentPool, _callback, options) {
      transactionCalls.push({ currentPool, options });
      throw new IdentityWriteError('MINIAPP_ACCOUNT_CONFLICT');
    }
  });

  assert.deepEqual(
    await service.bindMiniappPhone({ openid: 'openid', phone: 'phone' }),
    { error: 'MINIAPP_ACCOUNT_CONFLICT' }
  );
  assert.equal(transactionCalls.length, 1);
});

function makeQrLifecycleWriteHarness({
  lifecycleStatus = 'unactivated',
  ownerAccountId = 'ACC_OWNER',
  comments = []
} = {}) {
  const state = {
    qr: {
      id: 'QR_WRITE', issue_status: 'issued', lifecycle_status: lifecycleStatus,
      hidden: false, batch_id: 'BATCH_WRITE', print_batch_id: null,
      qr_image_url_snapshot: '', access_token: 'token-write',
      created_at: '2026-08-09T00:00:00.000Z',
      updated_at: '2026-08-09T00:00:00.000Z'
    },
    record: lifecycleStatus === 'unactivated' ? null : {
      qr_id: 'QR_WRITE', account_id: ownerAccountId, content: 'co content',
      image_url_snapshot: '', image_object_key: 'records/co.jpg', image_sha256: null,
      phone_snapshot: '13800000001', sealed_at: null,
      show_brand_disclosure: true,
      brand_disclosure_text_snapshot: 'Write disclosure',
      created_at: '2026-08-09T00:00:00.000Z',
      updated_at: '2026-08-09T00:00:00.000Z'
    },
    coCreation: lifecycleStatus === 'co_creating' ? {
      id: '00000000-0000-0000-0000-000000000101', qr_id: 'QR_WRITE',
      owner_account_id: ownerAccountId, owner_phone_snapshot: '13800000001',
      status: 'active', started_at: '2026-08-09T00:00:00.000Z', finalized_at: null,
      created_at: '2026-08-09T00:00:00.000Z',
      updated_at: '2026-08-09T00:00:00.000Z'
    } : null,
    comments: comments.map((comment, index) => ({
      id: `00000000-0000-0000-0000-${String(200 + index).padStart(12, '0')}`,
      co_creation_id: '00000000-0000-0000-0000-000000000101',
      account_id: `ACC_COMMENT_${index}`, legacy_comment_id: String(index + 1),
      source_position: index, legacy_duplicate: false, phone_snapshot: '',
      author_name: 'Witness', content: 'Comment', status: 'kept',
      created_at: '2026-08-09T00:00:00.000Z', deleted_at: null,
      ...comment
    })),
    outboxJobs: []
  };
  const qrRepository = {
    async findByKeyForUpdate(key) {
      return key === 'token-write' || key === 'QR_WRITE' ? state.qr : null;
    },
    async updateLifecycle({ expected_status: expectedStatus, next_status: nextStatus, updated_at: at }) {
      if (state.qr.lifecycle_status !== expectedStatus) return null;
      state.qr = { ...state.qr, lifecycle_status: nextStatus, updated_at: at };
      return state.qr;
    }
  };
  const batchRepository = {
    async findById(batchId) {
      return batchId === 'BATCH_WRITE'
        ? { id: batchId, disclosure_text: 'Write disclosure' }
        : null;
    }
  };
  const recordRepository = {
    async findByQrIdForUpdate() { return state.record; },
    async insert(record) { state.record = record; return record; },
    async seal({ sealed_at: sealedAt, updated_at: updatedAt }) {
      if (!state.record || state.record.sealed_at) return null;
      state.record = { ...state.record, sealed_at: sealedAt, updated_at: updatedAt };
      return state.record;
    }
  };
  const coCreationRepository = {
    async findByQrIdForUpdate() { return state.coCreation; },
    async listEffectiveComments() {
      return state.comments.filter((comment) => comment.status === 'kept');
    },
    async nextCommentSourcePosition() {
      return state.comments.reduce(
        (maximum, comment) => Math.max(maximum, comment.source_position),
        -1
      ) + 1;
    },
    async findEffectiveCommentByPublicIdForUpdate(_creationId, publicId) {
      return state.comments.find((comment) => (
        comment.status === 'kept'
        && (comment.legacy_comment_id === publicId
          || (!comment.legacy_comment_id && comment.id === publicId))
      )) || null;
    },
    async insert(coCreation) { state.coCreation = coCreation; return coCreation; },
    async insertComment(comment) { state.comments.push(comment); return comment; },
    async deleteEffectiveComment({ id, deleted_at: deletedAt }) {
      const index = state.comments.findIndex(
        (comment) => comment.id === id && comment.status === 'kept'
      );
      if (index === -1) return null;
      state.comments[index] = { ...state.comments[index], status: 'deleted', deleted_at: deletedAt };
      return state.comments[index];
    },
    async finalize({ finalized_at: finalizedAt, updated_at: updatedAt }) {
      if (!state.coCreation || state.coCreation.status !== 'active') return null;
      state.coCreation = {
        ...state.coCreation,
        status: 'finalized',
        finalized_at: finalizedAt,
        updated_at: updatedAt
      };
      return state.coCreation;
    }
  };
  const outboxRepository = {
    async insertPending(job) {
      const saved = {
        ...job,
        status: 'pending',
        attempt_count: 0,
        locked_at: null,
        locked_by: null,
        last_error: ''
      };
      state.outboxJobs.push(saved);
      return saved;
    }
  };
  return {
    batchRepository,
    coCreationRepository,
    outboxRepository,
    qrRepository,
    recordRepository,
    state
  };
}

function makeQrLifecycleWriteTransaction(harness, uuids = []) {
  let uuidIndex = 0;
  return new QrLifecycleWriteTransaction({
    ...harness,
    clock: () => new Date('2026-08-09T08:30:00.000Z'),
    randomUUID: () => uuids[uuidIndex++] || '00000000-0000-0000-0000-000000000999'
  });
}

test('QR lifecycle write transaction requires narrow transaction-scoped dependencies', () => {
  assert.throws(
    () => new QrLifecycleWriteTransaction(),
    (error) => error instanceof QrLifecycleWriteError
      && error.code === 'QR_LIFECYCLE_WRITE_DEPENDENCY_REQUIRED'
  );
});

test('QR lifecycle direct activation creates one sealed record and advances the locked QR', async () => {
  const harness = makeQrLifecycleWriteHarness();
  const result = await makeQrLifecycleWriteTransaction(harness).activateByKey({
    key: 'token-write',
    payload: {
      account_id: 'ACC_OWNER', phone: '13800000001', content: 'Direct record',
      image_object_key: 'records/direct.jpg', show_brand_disclosure: true
    }
  });

  assert.equal(result.qr.lifecycle_status, 'activated');
  assert.equal(result.record.sealed_at, '2026-08-09T08:30:00.000Z');
  assert.equal(result.record.brand_disclosure_text_snapshot, 'Write disclosure');
  assert.equal(result.co_creation, null);
  assert.deepEqual(harness.state.outboxJobs.map((job) => ({
    id: job.id,
    job_type: job.job_type,
    idempotency_key: job.idempotency_key,
    payload: job.payload,
    status: job.status
  })), [{
    id: '00000000-0000-0000-0000-000000000999',
    job_type: 'record_proof_prepare_submit',
    idempotency_key: 'record-proof:QR_WRITE',
    payload: { record_qr_id: 'QR_WRITE' },
    status: 'pending'
  }]);
  await assert.rejects(
    makeQrLifecycleWriteTransaction(harness).activateByKey({
      key: 'token-write', payload: { account_id: 'ACC_OWNER' }
    }),
    (error) => error.code === 'QR_ALREADY_ACTIVATED'
  );
});

test('QR lifecycle co-creation serializes comments, deletion, and final sealing', async () => {
  const harness = makeQrLifecycleWriteHarness();
  const transaction = makeQrLifecycleWriteTransaction(harness, [
    '00000000-0000-0000-0000-000000000101',
    '00000000-0000-0000-0000-000000000201',
    '00000000-0000-0000-0000-000000000202'
  ]);

  const started = await transaction.startCoCreationByKey({
    key: 'QR_WRITE',
    payload: {
      account_id: 'ACC_OWNER', phone: '13800000001', content: 'Co record',
      image_url: 'https://fixture.invalid/co.jpg', show_brand_disclosure: true
    }
  });
  assert.equal(started.qr.lifecycle_status, 'co_creating');
  assert.equal(started.record.sealed_at, null);
  assert.equal(started.co_creation.status, 'active');
  assert.equal(harness.state.outboxJobs.length, 0);

  const first = await transaction.addCommentByKey({
    key: 'token-write',
    payload: {
      account_id: 'ACC_PARTICIPANT', phone: '13800000002',
      authorName: 'Participant', content: 'First witness'
    }
  });
  assert.equal(first.comment.source_position, 0);
  assert.equal(first.comment.legacy_comment_id, null);
  await assert.rejects(
    transaction.addCommentByKey({
      key: 'token-write',
      payload: { account_id: 'ACC_PARTICIPANT', content: 'Duplicate' }
    }),
    (error) => error.code === 'CO_CREATION_COMMENT_EXISTS'
  );
  await assert.rejects(
    transaction.deleteCommentByKey({
      key: 'token-write', commentId: first.comment.id, account_id: 'ACC_PARTICIPANT'
    }),
    (error) => error.code === 'FORBIDDEN'
  );

  const deleted = await transaction.deleteCommentByKey({
    key: 'token-write', commentId: first.comment.id, account_id: 'ACC_OWNER'
  });
  assert.equal(deleted.comment.status, 'deleted');
  const replacement = await transaction.addCommentByKey({
    key: 'token-write',
    payload: { account_id: 'ACC_PARTICIPANT', authorName: 'Again', content: 'Replacement' }
  });
  assert.equal(replacement.comment.source_position, 1);

  const finalized = await transaction.finalizeByKey({
    key: 'token-write', account_id: 'ACC_OWNER'
  });
  assert.equal(finalized.qr.lifecycle_status, 'activated');
  assert.equal(finalized.record.sealed_at, '2026-08-09T08:30:00.000Z');
  assert.equal(finalized.co_creation.status, 'finalized');
  assert.equal(harness.state.outboxJobs.length, 1);
  assert.equal(harness.state.outboxJobs[0].idempotency_key, 'record-proof:QR_WRITE');
});

test('QR lifecycle write enforces the effective comment limit before insertion', async () => {
  const comments = Array.from({ length: 12 }, (_, index) => ({
    account_id: `ACC_LIMIT_${index}`
  }));
  const harness = makeQrLifecycleWriteHarness({ lifecycleStatus: 'co_creating', comments });
  await assert.rejects(
    makeQrLifecycleWriteTransaction(harness).addCommentByKey({
      key: 'QR_WRITE', payload: { account_id: 'ACC_LIMIT_NEW', content: 'Overflow' }
    }),
    (error) => error.code === 'CO_CREATION_COMMENT_LIMIT_REACHED'
  );
  assert.equal(harness.state.comments.length, 12);
});

test('QR lifecycle write service owns one transaction and translates route business errors', async () => {
  const harness = makeQrLifecycleWriteHarness();
  const calls = [];
  const pool = { connect() {} };
  const repositoryTypes = {
    QrRepository: class { constructor() { return harness.qrRepository; } },
    QrBatchRepository: class { constructor() { return harness.batchRepository; } },
    RecordRepository: class { constructor() { return harness.recordRepository; } },
    CoCreationRepository: class { constructor() { return harness.coCreationRepository; } },
    OutboxRepository: class { constructor() { return harness.outboxRepository; } }
  };
  const service = createQrLifecycleWriteService({
    pool,
    repositoryTypes,
    clock: () => new Date('2026-08-09T08:30:00.000Z'),
    async transactionRunner(currentPool, callback, options) {
      calls.push({ currentPool, options });
      return callback({ query() {} });
    }
  });

  assert.deepEqual(
    await service.activateQRByKey('missing', { account_id: 'ACC_OWNER' }),
    { error: 'QR_NOT_FOUND' }
  );
  assert.deepEqual(calls, [{
    currentPool: pool,
    options: { isolationLevel: 'read committed' }
  }]);
});

test('QR lifecycle write never reports success when durable proof work cannot be queued', async () => {
  const harness = makeQrLifecycleWriteHarness();
  harness.outboxRepository.insertPending = async () => {
    const error = new Error('queue unavailable');
    error.code = 'REPOSITORY_QUERY_FAILED';
    throw error;
  };
  const service = createQrLifecycleWriteService({
    pool: { connect() {} },
    repositoryTypes: {
      QrRepository: class { constructor() { return harness.qrRepository; } },
      QrBatchRepository: class { constructor() { return harness.batchRepository; } },
      RecordRepository: class { constructor() { return harness.recordRepository; } },
      CoCreationRepository: class { constructor() { return harness.coCreationRepository; } },
      OutboxRepository: class { constructor() { return harness.outboxRepository; } }
    },
    async transactionRunner(_pool, callback) {
      return callback({ query() {} });
    }
  });

  await assert.rejects(
    service.activateQRByKey('token-write', { account_id: 'ACC_OWNER' }),
    (error) => error.code === 'REPOSITORY_QUERY_FAILED'
  );
});

test('QR lifecycle write service is isolated from JSON, SQL, and runtime environment state', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../src/server/services/postgres/qrLifecycleWriteService.js'),
    'utf8'
  );
  assert.doesNotMatch(source, /dbService|readDB|writeDB|process\.env/);
  assert.doesNotMatch(source, /\b(?:SELECT|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK)\b/);
});

test('outbox worker executes handlers outside transactions and records safe outcomes', async () => {
  let transactionDepth = 0;
  const transitions = [];
  const jobs = [
    { id: 'JOB_OK', job_type: 'proof', attempt_count: 1 },
    { id: 'JOB_RETRY', job_type: 'proof', attempt_count: 1 },
    { id: 'JOB_UNKNOWN', job_type: 'unknown', attempt_count: 1 }
  ];
  const repository = {
    async recoverStale(input) {
      transitions.push(['recovered', input]);
      return [];
    },
    async claimPending(input) {
      transitions.push(['claim', input]);
      return jobs;
    },
    async markSucceeded(input) {
      transitions.push(['succeeded', input]);
      return { id: input.id };
    },
    async releaseForRetry(input) {
      transitions.push(['retry', input]);
      return { id: input.id };
    },
    async markFailed(input) {
      transitions.push(['failed', input]);
      return { id: input.id };
    }
  };
  const worker = createOutboxWorker({
    pool: { connect() {} },
    workerId: 'unit-worker',
    jobTypes: ['proof'],
    aggregateIds: ['QR_ALLOWED'],
    repositoryTypes: {
      OutboxRepository: class { constructor() { return repository; } }
    },
    handlers: {
      async proof(job) {
        assert.equal(transactionDepth, 0);
        if (job.id === 'JOB_RETRY') {
          const error = new Error('sensitive provider response');
          error.code = 'PROVIDER_TIMEOUT';
          throw error;
        }
      }
    },
    clock: () => new Date('2026-08-09T09:00:00.000Z'),
    async transactionRunner(_pool, callback, options) {
      assert.deepEqual(options, { isolationLevel: 'read committed' });
      transactionDepth += 1;
      try {
        return await callback({ query() {} });
      } finally {
        transactionDepth -= 1;
      }
    }
  });

  assert.deepEqual(await worker.runOnce(), {
    recovered: 0,
    claimed: 3,
    succeeded: 1,
    retried: 1,
    failed: 1
  });
  const retry = transitions.find(([kind]) => kind === 'retry')[1];
  assert.equal(retry.last_error, 'PROVIDER_TIMEOUT');
  assert.equal(retry.available_at, '2026-08-09T09:00:01.000Z');
  const failed = transitions.find(([kind]) => kind === 'failed')[1];
  assert.equal(failed.last_error, 'OUTBOX_HANDLER_NOT_REGISTERED');
  assert.equal(JSON.stringify(transitions).includes('sensitive provider response'), false);
  assert.deepEqual(transitions.find(([kind]) => kind === 'recovered')[1], {
    stale_before: '2026-08-09T08:55:00.000Z',
    recovered_at: '2026-08-09T09:00:00.000Z',
    limit: 10,
    job_types: ['proof'],
    aggregate_ids: ['QR_ALLOWED']
  });
  assert.deepEqual(transitions.find(([kind]) => kind === 'claim')[1], {
    worker_id: 'unit-worker',
    claimed_at: '2026-08-09T09:00:00.000Z',
    limit: 10,
    job_types: ['proof'],
    aggregate_ids: ['QR_ALLOWED']
  });
});

test('outbox worker validates configuration and sanitizes untrusted errors', () => {
  assert.throws(
    () => createOutboxWorker({ pool: { connect() {} } }),
    (error) => error instanceof OutboxWorkerError
      && error.code === 'OUTBOX_WORKER_ID_REQUIRED'
  );
  assert.equal(safeErrorCode({ code: 'UPSTREAM_TIMEOUT' }), 'UPSTREAM_TIMEOUT');
  assert.equal(safeErrorCode({ code: 'unsafe error text' }), 'OUTBOX_HANDLER_FAILED');
  assert.throws(
    () => createOutboxWorker({
      pool: { connect() {} },
      workerId: 'unit-worker',
      aggregateIds: []
    }),
    (error) => error.code === 'OUTBOX_WORKER_AGGREGATE_IDS_INVALID'
  );
});

test('outbox worker is isolated from JSON, SQL, environment, and automatic startup', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../src/server/services/postgres/outboxWorkerService.js'),
    'utf8'
  );
  assert.doesNotMatch(source, /dbService|readDB|writeDB|process\.env/);
  assert.doesNotMatch(source, /\b(?:SELECT|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK)\b/);
  assert.doesNotMatch(source, /setInterval|setTimeout/);
});

test('public QR adapter is isolated from JSON, SQL, connections, and transaction control', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../src/server/services/postgres/publicQrReadAdapter.js'),
    'utf8'
  );
  assert.doesNotMatch(source, /dbService|readDB|writeDB|process\.env/);
  assert.doesNotMatch(source, /require\(['"](?:pg|\.\.\/\.\.\/database)/);
  assert.doesNotMatch(source, /\b(?:SELECT|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK)\b/);
});

test('public QR adapter preserves not-found and hidden fail-closed behavior', async () => {
  const missing = makeHarness();
  await assert.rejects(
    missing.adapter.read({ key: 'missing', channel: 'h5' }),
    (error) => error instanceof PublicQrReadError && error.code === 'QR_NOT_FOUND'
  );
  assert.deepEqual(missing.calls, [['qr.findByKey', 'missing']]);

  const hidden = makeHarness({
    qr: {
      id: 'QR_HIDDEN_1',
      lifecycle_status: 'activated',
      issue_status: 'issued',
      hidden: true,
      batch_id: null
    }
  });
  await assert.rejects(
    hidden.adapter.read({ key: 'hidden-token', channel: 'miniapp' }),
    (error) => error.code === 'QR_HIDDEN'
  );
  assert.deepEqual(hidden.calls, [['qr.findByKey', 'hidden-token']]);
});

test('unactivated H5 and miniapp DTOs keep their existing channel differences', async () => {
  const qr = {
    id: 'QR_NEW_1',
    lifecycle_status: 'unactivated',
    issue_status: 'issued',
    hidden: false,
    batch_id: null,
    show_brand_disclosure: true
  };
  const h5 = await makeHarness({ qr }).adapter.read({
    key: 'QR_NEW_1',
    channel: 'h5'
  });
  const miniapp = await makeHarness({ qr }).adapter.read({
    key: 'QR_NEW_1',
    channel: 'miniapp'
  });

  assert.equal(h5.show_brand_disclosure, false);
  assert.equal(
    Object.prototype.hasOwnProperty.call(h5, 'brand_disclosure_text_snapshot'),
    false
  );
  assert.equal(Object.prototype.hasOwnProperty.call(h5, 'phone_bound'), false);
  assert.equal(miniapp.phone_bound, false);
  assert.equal(Object.prototype.hasOwnProperty.call(miniapp, 'show_brand_disclosure'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(miniapp, 'content'), false);
});

test('unbound co-creation view stops after base reads and does not expose content', async () => {
  const harness = makeHarness({
    qr: {
      id: 'QR_CO_1',
      lifecycle_status: 'co_creating',
      issue_status: 'issued',
      hidden: false,
      batch_id: null
    }
  });
  const payload = await harness.adapter.read({
    key: 'QR_CO_1',
    channel: 'miniapp',
    viewer: { account_id: 'ACC_VIEWER', phone_bound: false }
  });

  assert.equal(payload.phone_bound, false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'content'), false);
  assert.deepEqual(harness.calls, [['qr.findByKey', 'QR_CO_1']]);
});

test('co-creation projection uses account IDs internally and strips them from the DTO', async () => {
  const fixture = activatedFixture({
    qr: { lifecycle_status: 'co_creating' },
    coCreation: { status: 'active' }
  });
  const harness = makeHarness({ ...fixture, proof: null });
  const payload = await harness.adapter.read({
    key: 'QR_PUBLIC_1',
    channel: 'miniapp',
    viewer: { account_id: 'ACC_INTERNAL_OWNER', phone_bound: true }
  });

  assert.equal(payload.is_co_creation_owner, true);
  assert.equal(payload.has_my_co_creation_comment, true);
  assert.equal(payload.co_creation_comment_count, 2);
  assert.deepEqual(
    payload.co_creation_comments.map((comment) => comment.id),
    ['COMMENT_NEW', 'COMMENT_OLD']
  );
  assert.equal(payload.brand_name, 'Test Brand');
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'chain_status'), false);

  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes('ACC_INTERNAL_OWNER'), false);
  assert.equal(serialized.includes('ACC_OTHER'), false);
  assert.equal(serialized.includes('not-public'), false);
  assert.equal(serialized.includes('COMMENT_DELETED'), false);
  assert.equal(serialized.includes('source_position'), false);
});

test('public comments use source position when creation timestamps are equal', () => {
  const comments = publicComments([
    {
      id: 'FIRST',
      source_position: 1,
      account_id: 'ACC_1',
      content: 'First',
      status: 'kept',
      created_at: '2026-07-01T10:00:00.000Z'
    },
    {
      id: 'SECOND',
      source_position: 0,
      account_id: 'ACC_2',
      content: 'Second',
      status: 'kept',
      created_at: '2026-07-01T10:00:00.000Z'
    }
  ]);
  assert.deepEqual(comments.map((comment) => comment.id), ['SECOND', 'FIRST']);
  assert.equal(JSON.stringify(comments).includes('source_position'), false);
});

test('legacy numeric comment IDs retain the existing JSON number type', () => {
  assert.equal(publicLegacyCommentId('42', 'UUID_FALLBACK'), 42);
  assert.equal(publicLegacyCommentId('-2', 'UUID_FALLBACK'), -2);
  assert.equal(publicLegacyCommentId('COMMENT_42', 'UUID_FALLBACK'), 'COMMENT_42');
  assert.equal(publicLegacyCommentId('0042', 'UUID_FALLBACK'), '0042');
  assert.equal(
    publicLegacyCommentId('9007199254740992', 'UUID_FALLBACK'),
    '9007199254740992'
  );
  assert.equal(publicLegacyCommentId(null, 'UUID_FALLBACK'), 'UUID_FALLBACK');

  const comments = publicComments([{
    id: 'UUID_FALLBACK',
    legacy_comment_id: '7',
    source_position: 0,
    status: 'kept',
    created_at: '2026-07-01T10:00:00.000Z'
  }]);
  assert.equal(comments[0].id, 7);
});

test('public comments fail closed without a valid stable source position', () => {
  [
    {},
    { source_position: -1 },
    { source_position: 1.5 }
  ].forEach((overrides) => {
    assert.throws(
      () => publicComments([{
        id: 'COMMENT_INVALID_POSITION',
        status: 'kept',
        created_at: '2026-07-01T10:00:00.000Z',
        ...overrides
      }]),
      (error) => error.code === 'PUBLIC_QR_COMMENT_POSITION_INVALID'
    );
  });
});

test('PostgreSQL timestamp objects serialize to the existing public ISO string shape', () => {
  const timestamp = new Date('2026-07-01T10:00:00.000Z');
  assert.equal(publicTimestamp(timestamp), '2026-07-01T10:00:00.000Z');
  assert.equal(publicTimestamp(null), null);
  assert.equal(publicTimestamp(new Date('invalid'), ''), '');
  assert.equal(publicComments([{
    id: 'COMMENT_DATE',
    source_position: 0,
    status: 'kept',
    created_at: timestamp
  }])[0].created_at, '2026-07-01T10:00:00.000Z');
});

test('activated projection preserves channel fields, proof fields, and resolver boundaries', async () => {
  const fixture = activatedFixture();
  const h5Harness = makeHarness(fixture);
  const h5 = await h5Harness.adapter.read({
    key: 'public-token',
    channel: 'h5',
    viewer: { account_id: 'ACC_OTHER', phone_bound: true }
  });
  const miniapp = await makeHarness(fixture).adapter.read({
    key: 'public-token',
    channel: 'miniapp',
    viewer: { account_id: 'ACC_OTHER', phone_bound: true }
  });

  assert.equal(h5.activation_status, 'activated');
  assert.equal(h5.image_url, 'resolved://h5/records/public.jpg');
  assert.equal(h5.blockchain_hash, 'a'.repeat(64));
  assert.equal(h5.chain_status, 'confirmed');
  assert.equal(h5.chain_certificate_url, 'certificate://h5/proofs/certificate.json');
  assert.equal(h5.has_my_co_creation_comment, true);
  assert.equal(h5.is_co_creation_owner, false);
  assert.equal(Object.prototype.hasOwnProperty.call(h5, 'brand_name'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(h5, 'phone_bound'), false);
  assert.equal(miniapp.brand_name, 'Test Brand');
  assert.equal(miniapp.phone_bound, true);
  assert.deepEqual(h5Harness.calls, [
    ['qr.findByKey', 'public-token'],
    ['batch.findById', 'BATCH_1'],
    ['record.findByQrId', 'QR_PUBLIC_1'],
    ['coCreation.findByQrId', 'QR_PUBLIC_1'],
    ['coCreation.listPublicCommentsCandidate', '00000000-0000-0000-0000-000000000101', 13],
    ['proof.findByRecordId', 'QR_PUBLIC_1'],
    ['asset.resolveRecordImage', 'QR_PUBLIC_1', 'h5'],
    ['asset.resolveCertificate', '00000000-0000-0000-0000-000000000301', 'h5']
  ]);
});

test('activated projection preserves a legacy proof marker without exposing its internal column', async () => {
  const legacyHash = 'legacy-proof-marker-1';
  const fixture = activatedFixture();
  fixture.proof = {
    ...fixture.proof,
    manifest_hash: null,
    legacy_hash_snapshot: legacyHash
  };
  const payload = await makeHarness(fixture).adapter.read({
    key: 'public-token',
    channel: 'h5',
    viewer: { account_id: 'ACC_OTHER', phone_bound: true }
  });

  assert.equal(payload.blockchain_hash, legacyHash);
  assert.equal(payload.manifest_hash, legacyHash);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'legacy_hash_snapshot'), false);
});

test('missing required read dependencies fail closed instead of broadening the adapter', async () => {
  const fixture = activatedFixture();
  const noBatchReader = makeHarness({ ...fixture, batchReader: null });
  await assert.rejects(
    noBatchReader.adapter.read({ key: 'QR_PUBLIC_1', channel: 'h5' }),
    (error) => error.code === 'PUBLIC_QR_BATCH_REPOSITORY_GAP'
  );

  const noRecord = makeHarness({ ...fixture, record: null });
  await assert.rejects(
    noRecord.adapter.read({ key: 'QR_PUBLIC_1', channel: 'h5' }),
    (error) => error.code === 'PUBLIC_QR_RECORD_MISSING'
  );
});

test('object-key records require an injected resolver and never fall back silently', async () => {
  const fixture = activatedFixture();
  const harness = makeHarness({ ...fixture, assetResolver: null });
  await assert.rejects(
    harness.adapter.read({ key: 'QR_PUBLIC_1', channel: 'h5' }),
    (error) => error.code === 'PUBLIC_QR_IMAGE_RESOLVER_REQUIRED'
  );
});

test('adapter separates database snapshot loading from asset presentation', async () => {
  const fixture = activatedFixture();
  const harness = makeHarness(fixture);
  const snapshot = await harness.adapter.loadSnapshot({
    key: 'public-token',
    channel: 'h5',
    viewer: null
  });
  assert.equal(harness.calls.some((call) => call[0].startsWith('asset.')), false);
  const payload = await harness.adapter.present(snapshot);
  assert.equal(payload.image_url, 'resolved://h5/records/public.jpg');
  assert.equal(harness.calls.some((call) => call[0] === 'asset.resolveRecordImage'), true);
});

test('candidate comment overflow stops before DTO presentation', async () => {
  const fixture = activatedFixture({ qr: { lifecycle_status: 'co_creating' } });
  const comments = Array.from({ length: 13 }, (_, index) => ({
    id: `COMMENT_${index}`,
    source_position: index,
    status: 'kept',
    created_at: '2026-07-01T10:00:00.000Z'
  }));
  const harness = makeHarness({ ...fixture, comments, proof: null });
  await assert.rejects(
    harness.adapter.loadSnapshot({
      key: 'public-token',
      channel: 'h5',
      viewer: { phone_bound: true }
    }),
    (error) => error.code === 'CANDIDATE_COMMENT_OVERFLOW'
  );
  assert.equal(harness.calls.some((call) => call[0].startsWith('asset.')), false);
});

test('DTO comparator reports structure without including compared values', () => {
  const baseline = {
    content: 'private baseline content',
    image_url: 'https://private.example/baseline.jpg',
    comments: [{ id: 'comment-secret', content: 'private comment' }],
    status: null
  };
  const candidate = {
    content: 'private candidate content',
    image_url: 'https://private.example/candidate.jpg',
    comments: [],
    status: 'activated',
    unexpected: 'sensitive-extra'
  };
  const baselineBefore = JSON.stringify(baseline);
  const candidateBefore = JSON.stringify(candidate);
  const report = comparePublicQrDtos({
    baseline,
    candidate,
    channel: 'miniapp',
    mismatchLimit: 2
  });
  const serializedReport = JSON.stringify(report);

  assert.equal(report.matches, false);
  assert.equal(report.channel, 'miniapp');
  assert.equal(report.mismatch_count > report.mismatches.length, true);
  assert.equal(report.truncated, true);
  [
    'private baseline content',
    'private candidate content',
    'private comment',
    'comment-secret',
    'https://private.example',
    'sensitive-extra'
  ].forEach((secret) => assert.equal(serializedReport.includes(secret), false));
  assert.equal(JSON.stringify(baseline), baselineBefore);
  assert.equal(JSON.stringify(candidate), candidateBefore);
});

test('DTO comparator accepts equal DTOs without producing mismatch details', () => {
  const dto = {
    id: 'QR_PUBLIC_1',
    activation_status: 'activated',
    comments: [{ id: 'COMMENT_1', created_at: null }]
  };
  assert.deepEqual(comparePublicQrDtos({
    baseline: dto,
    candidate: JSON.parse(JSON.stringify(dto)),
    channel: 'h5'
  }), {
    channel: 'h5',
    matches: true,
    mismatch_count: 0,
    truncated: false,
    mismatches: []
  });
});

test('personal record adapter lists only repository-scoped rows in the existing DTO shape', async () => {
  const adapter = new PersonalRecordReadAdapter({
    qrRepository: { findById: async () => null, findByKey: async () => null },
    recordRepository: {
      findByQrId: async () => null,
      findOwnedByAccountId: async () => null,
      listPersonalByAccountId: async (accountId, options) => {
        assert.equal(accountId, 'ACC_OWNER');
        assert.deepEqual(options, { limit: 1001 });
        return [{
          qr_id: 'QR_LIST_1',
          lifecycle_status: 'co_creating',
          content: 'Memory',
          image_url_snapshot: null,
          image_object_key: 'records/list.jpg',
          sealed_at: null,
          co_creation_started_at: new Date('2026-08-04T01:02:03.000Z'),
          created_at: new Date('2026-08-04T01:00:00.000Z')
        }];
      }
    },
    coCreationRepository: {
      findByQrId: async () => null,
      listPublicCommentsCandidate: async () => []
    },
    proofRepository: { findByRecordId: async () => null },
    batchReader: { findById: async () => null },
    publicRuntimeMetadata: { storage_mode: 'oss' }
  });
  const snapshot = await adapter.loadSnapshot({
    readKind: 'list',
    accountId: 'ACC_OWNER',
    channel: 'h5'
  });
  const dto = await adapter.present(snapshot, {
    assetResolver: {
      resolveRecordImage: ({ record, channel }) => `${channel}://${record.image_object_key}`
    }
  });
  assert.deepEqual(dto, {
    total: 1,
    records: [{
      id: 'QR_LIST_1',
      content: 'Memory',
      activated_at: null,
      display_at: '2026-08-04T01:02:03.000Z',
      activation_status: 'co_creating',
      image_url: 'h5://records/list.jpg'
    }]
  });
  assert.doesNotMatch(JSON.stringify(dto), /ACC_OWNER/);
});

test('personal record detail enforces account ownership and projects channel-specific DTOs', async () => {
  const fixture = activatedFixture();
  const dependencies = {
    qrRepository: {
      findById: async () => fixture.qr,
      findByKey: async () => fixture.qr
    },
    recordRepository: {
      findByQrId: async () => fixture.record,
      findOwnedByAccountId: async (accountId) => (
        accountId === 'ACC_INTERNAL_OWNER' ? fixture.record : null
      ),
      listPersonalByAccountId: async () => []
    },
    coCreationRepository: {
      findByQrId: async () => fixture.coCreation,
      listPublicCommentsCandidate: async () => fixture.comments
    },
    proofRepository: { findByRecordId: async () => fixture.proof },
    batchReader: { findById: async () => fixture.batch },
    publicRuntimeMetadata: { storage_mode: 'oss' }
  };
  const adapter = new PersonalRecordReadAdapter(dependencies);
  await assert.rejects(
    adapter.loadSnapshot({
      readKind: 'detail',
      accountId: 'ACC_OTHER',
      recordId: fixture.qr.id,
      channel: 'h5'
    }),
    (error) => error.code === 'PERSONAL_RECORD_NOT_FOUND'
  );

  const snapshot = await adapter.loadSnapshot({
    readKind: 'detail',
    accountId: 'ACC_INTERNAL_OWNER',
    recordId: fixture.qr.id,
    channel: 'miniapp'
  });
  const dto = await adapter.present(snapshot, {
    assetResolver: {
      resolveRecordImage: () => 'https://public.example/record.jpg',
      resolveCertificate: () => 'https://public.example/certificate'
    }
  });
  assert.equal(dto.id, fixture.qr.id);
  assert.equal(dto.image_url, 'https://public.example/record.jpg');
  assert.equal(dto.brand_name, fixture.batch.brand_name);
  assert.equal(Object.hasOwn(dto, 'activation_status'), false);
  assert.equal(Object.hasOwn(dto, 'display_at'), false);
  assert.doesNotMatch(JSON.stringify(dto), /ACC_INTERNAL_OWNER|phone_snapshot/);

  const h5Snapshot = await adapter.loadSnapshot({
    readKind: 'detail',
    accountId: 'ACC_INTERNAL_OWNER',
    recordId: fixture.qr.id,
    channel: 'h5'
  });
  const h5Dto = await adapter.present(h5Snapshot, {
    assetResolver: {
      resolveRecordImage: () => 'https://public.example/record.jpg',
      resolveCertificate: () => 'https://public.example/certificate'
    }
  });
  assert.equal(h5Dto.id, fixture.qr.id);
  assert.equal(h5Dto.brand_name, fixture.batch.brand_name);
  assert.equal(h5Dto.co_creation_enabled, true);
  assert.doesNotMatch(JSON.stringify(h5Dto), /ACC_INTERNAL_OWNER|phone_snapshot/);
});
