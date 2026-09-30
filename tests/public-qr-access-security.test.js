'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const {
  signAssetAccess, verifyAssetAccess, signLocalAssetUrl, MAX_ASSET_TTL_SECONDS
} = require('../src/server/services/assetAccessService');
const { QrRepository } = require('../src/server/repositories/qrRepository');
const { PublicQrReadAdapter } = require('../src/server/services/postgres/publicQrReadAdapter');
const { sanitizeAuditPath } = require('../src/server/middlewares/auditLogger');

const env = { AUTH_SECRET: 'isolated-asset-signing-fixture' };
const now = 1790640000000;

test('SEC-007 audit paths redact scan credentials and signed-media resources', () => {
  const credential = '0123456789abcdef0123456789abcdef';
  assert.equal(
    sanitizeAuditPath(`/api/nft/${credential}/share-meta?ignored=1`),
    '/api/nft/[credential]/share-meta'
  );
  assert.equal(
    sanitizeAuditPath(`/api/qr/image/${credential}`),
    '/api/qr/image/[credential]'
  );
  assert.equal(
    sanitizeAuditPath(`/api/qr/${credential}/comments`),
    '/api/qr/[credential]/comments'
  );
  assert.equal(
    sanitizeAuditPath(`/api/miniapp/qr/${credential}`),
    '/api/miniapp/qr/[credential]'
  );
  assert.equal(
    sanitizeAuditPath('/api/qr/media/S2609A00014?expires=1&signature=secret'),
    '/api/qr/media/[resource]'
  );
  assert.equal(sanitizeAuditPath('/api/admin/operators?role=admin'), '/api/admin/operators');
});

test('SEC-004 media grants are expiring and bound to resource and purpose', () => {
  const grant = signAssetAccess({ purpose: 'record-media', resource: 'ID1', now, env });
  const input = { purpose: 'record-media', resource: 'ID1', now, env, ...grant };
  assert.equal(verifyAssetAccess(input), true);
  assert.equal(verifyAssetAccess({ ...input, resource: 'ID2' }), false);
  assert.equal(verifyAssetAccess({ ...input, purpose: 'local-asset' }), false);
  assert.equal(verifyAssetAccess({ ...input, signature: '0'.repeat(64) }), false);
  assert.equal(verifyAssetAccess({ ...input, expires: String(Number(grant.expires) + 1) }), false);
  assert.equal(verifyAssetAccess({ ...input, now: now + MAX_ASSET_TTL_SECONDS * 1000 }), false);
  assert.equal(verifyAssetAccess({ ...input, now: now - 1000 }), false);
  assert.equal(verifyAssetAccess({ ...input, env: {} }), false);
  for (const value of [null, '', [], {}, ['one', 'two']]) {
    assert.equal(verifyAssetAccess({ ...input, signature: value }), false);
    assert.equal(verifyAssetAccess({ ...input, expires: value }), false);
  }
  assert.throws(() => signAssetAccess({ purpose: 'record-media', resource: 'ID1', env: {} }), /UNAVAILABLE/);
});

test('SEC-004 local signatures refresh approved paths without signing traversal or remote URLs', () => {
  const original = '/uploads/fixture.png?expires=1&signature=expired';
  const signed = new URL(signLocalAssetUrl(original, { now, env }), 'https://fixture.invalid');
  assert.equal(signed.pathname, '/uploads/fixture.png');
  assert.equal(verifyAssetAccess({
    purpose: 'local-asset', resource: signed.pathname, now, env,
    ...Object.fromEntries(signed.searchParams)
  }), true);
  for (const invalid of [
    '/uploads/../data.json', '/uploads/%2e%2e/data.json', '/uploads//data.json',
    '/uploads/a\\b.png', 'https://external.invalid/a.png', '//external.invalid/a.png'
  ]) assert.equal(signLocalAssetUrl(invalid, { now, env }), invalid);
  const absolute = new URL(signLocalAssetUrl('https://app.invalid/uploads/legacy.jpg', {
    now, env: { ...env, BASE_URL: 'https://app.invalid' }
  }));
  assert.equal(absolute.origin, 'https://app.invalid');
  assert.ok(absolute.searchParams.get('signature'));
});

test('SEC-004 cloud customer media uses OSS signatures on H5 and miniapp, never the public CDN', () => {
  const source = `
    const assert = require('node:assert/strict');
    const { createPublicQrAssetResolver } = require('./src/server/services/publicQrAssetResolver');
    const { buildRecordImageObjectKey } = require('./src/server/services/storageService');
    const authority = { qrId: 'FIXTURE001' };
    const key = buildRecordImageObjectKey({ qrId: authority.qrId, fileName: 'fixture-record-v2.jpg' });
    for (const channel of ['h5', 'miniapp']) {
      const result = createPublicQrAssetResolver().resolveRecordImage({
        record: { image_object_key: key }, authority, channel
      });
      const url = new URL(result);
      assert.equal(url.pathname, '/' + key);
      assert.equal(url.hostname, 'fixture-bucket.oss-cn-test.aliyuncs.com');
      assert.ok(url.searchParams.get('Signature'));
      assert.ok(url.searchParams.get('Expires'));
    }
  `;
  execFileSync(process.execPath, ['-e', source], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, STORAGE_MODE: 'cloud', OSS_REGION: 'oss-cn-test',
      OSS_ENDPOINT: 'oss-cn-test.aliyuncs.com', OSS_BUCKET: 'fixture-bucket',
      OSS_ACCESS_KEY_ID: 'fixture-key', OSS_ACCESS_KEY_SECRET: 'fixture-secret',
      OSS_SECURE: 'true', CLOUD_PUBLIC_BASE_URL: 'https://marketing.invalid'
    },
    timeout: 5000, stdio: 'pipe'
  });
});

test('SEC-001/002 actual PostgreSQL repository and public adapter reject IDs on both channels', async () => {
  const qr = {
    id: 'SEQ00001', access_token: '6f81125b68d916c6a9eabff46e1d8e21',
    lifecycle_status: 'activated', issue_status: 'issued', hidden: false, batch_id: null
  };
  const queries = [];
  const repository = new QrRepository({
    async query(sql, params) {
      queries.push({ sql, params });
      assert.match(sql, /WHERE access_token = \$1(?: FOR UPDATE)?$/);
      assert.doesNotMatch(sql, /\bOR\b|\bUNION\b/);
      return { rows: params[0] === qr.access_token ? [qr] : [] };
    }
  });
  let recordReads = 0;
  let assetReads = 0;
  const adapter = new PublicQrReadAdapter({
    qrRepository: repository,
    recordRepository: { async findByQrId(id) {
      recordReads += 1;
      assert.equal(id, qr.id);
      return { qr_id: id, content: 'authorized-memory', image_object_key: 'image.jpg' };
    } },
    coCreationRepository: { findByQrId: async () => null, listPublicCommentsCandidate: async () => [] },
    proofRepository: { findByRecordId: async () => null },
    batchReader: { findById: async () => null },
    assetResolver: { resolveRecordImage() { assetReads += 1; return 'https://fixture.invalid/signed-image'; } },
    publicRuntimeMetadata: { storage_mode: 'oss' }
  });
  for (const channel of ['h5', 'miniapp']) {
    for (const key of [qr.id, 'SEQ00002', 'invalid-credential']) {
      await assert.rejects(adapter.read({ key, channel, viewer: { accountId: 'OTHER', phoneBound: true } }),
        error => error.code === 'QR_NOT_FOUND');
    }
    const before = queries.length;
    const result = await adapter.read({ key: qr.access_token, channel });
    assert.equal(queries.length, before + 1);
    assert.equal(result.id, qr.id);
    assert.equal(result.content, 'authorized-memory');
    assert.equal(JSON.stringify(result).includes(qr.access_token), false);
  }
  assert.equal(recordReads, 2);
  assert.equal(assetReads, 2);
  assert.equal(await repository.findByKeyForUpdate(qr.id), null);
  assert.equal((await repository.findByKeyForUpdate(qr.access_token)).id, qr.id);
});

test('SEC-003 H5 share handler sends the scanned credential, not the displayed record ID', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/frontend/js/record.js'), 'utf8');
  const offset = source.indexOf("shareBtn.addEventListener('click'");
  assert.ok(offset >= 0);
  for (const nativeShare of [true, false]) {
    let click;
    const requests = [];
    const shared = [];
    const copied = [];
    const credential = 'unpredictable-existing-scan-key';
    vm.runInNewContext(source.slice(offset), {
      shareBtn: { addEventListener(_type, callback) { click = callback; } },
      currentResult: { qr_id: 'SEQUENTIAL00001' },
      qrId: credential,
      apiRequest: async (url) => {
        requests.push(url);
        return { data: { title: 'Memory', text: 'fixture', url: `https://fixture.invalid/record.html?t=${credential}` } };
      },
      navigator: nativeShare ? { share: async payload => shared.push(payload) } : {},
      copyText: async value => copied.push(value),
      alert() {}, encodeURIComponent
    });
    await click();
    assert.deepEqual(requests, [`/api/nft/${credential}/share-meta`]);
    assert.equal(nativeShare ? shared[0].url : copied[0], `https://fixture.invalid/record.html?t=${credential}`);
  }
});

test('SEC-009 miniapp owner resume uses its authorized key and never invents an ID fallback', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/miniprogram/pages/me/me.js'), 'utf8');
  let page;
  const navigations = [];
  const notices = [];
  vm.runInNewContext(source, {
    require: () => ({}),
    Page(value) { page = value; },
    wx: { navigateTo({ url }) { navigations.push(url); }, showToast(value) { notices.push(value); } }
  });
  page.data.records = [
    { id: 'CO1', activation_status: 'co_creating', resume_key: 'owner-resume-credential' },
    { id: 'CO2', activation_status: 'co_creating' },
    { id: 'SAVED1', activation_status: 'activated' }
  ];
  for (const id of ['CO1', 'CO2', 'SAVED1']) page.openRecord({ currentTarget: { dataset: { id } } });
  assert.deepEqual(navigations, [
    '/pages/co-create/co-create?key=owner-resume-credential', '/pages/record-detail/record-detail?id=SAVED1'
  ]);
  assert.equal(notices.length, 1);
});

test('SEC-003/DB-001 shared reads honor PostgreSQL selection and never fall back after failure', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/server/services/publicRecordAccessService.js'), 'utf8');
  const key = 'synthetic-scan-credential';
  const legacy = {
    id: 'SEQ00001', qr_access_token: key, activation_status: 'activated',
    content: 'stale-json-content'
  };
  let result = { selected: true, dto: { id: legacy.id, activation_status: 'activated', content: 'postgres-content' } };
  let failure = null;
  let assetReads = 0;
  const inputs = [];
  const sandbox = {
    module: { exports: {} },
    require(name) {
      if (name === './dbService') return {
        findPublicQrReadContextByKey(value) {
          return { qr: value === key ? legacy : null, publicQrDomainHash: 'a'.repeat(64) };
        }
      };
      if (name === './postgres/publicQrPrimaryReadRuntime') return {
        async readPublicQrPrimary(input) {
          inputs.push(input);
          if (failure) throw failure;
          return result;
        }
      };
      if (name === './publicQrAssetResolver') return {
        createPublicQrAssetResolver: () => ({ resolveRecordImage() { assetReads += 1; return '/legacy-image'; } })
      };
      throw new Error(`Unexpected dependency: ${name}`);
    }
  };
  vm.runInNewContext(source, sandbox);
  const { readSharedRecord } = sandbox.module.exports;
  assert.equal((await readSharedRecord(key)).content, 'postgres-content');
  assert.equal(inputs[0].key, key);
  assert.equal(inputs[0].viewer.accountId, '');
  assert.equal(inputs[0].viewer.phoneBound, false);
  for (const dto of [null, { activation_status: 'unactivated' }, { activation_status: 'co_creating' }]) {
    result = { selected: true, dto };
    assert.equal(await readSharedRecord(key), null);
  }
  failure = Object.assign(new Error('isolated database failure'), { code: 'PUBLIC_QR_POSTGRES_READ_UNAVAILABLE' });
  await assert.rejects(readSharedRecord(key), error => error === failure);
  assert.equal(assetReads, 0);
  failure = null;
  result = { selected: false };
  assert.equal(await readSharedRecord(legacy.id), null);
  assert.equal((await readSharedRecord(key)).content, legacy.content);
  assert.equal(assetReads, 1);
});
