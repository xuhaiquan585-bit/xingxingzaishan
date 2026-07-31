'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  PublicQrReadAdapter,
  PublicQrReadError,
  publicComments,
  publicTimestamp
} = require('../src/server/services/postgres/publicQrReadAdapter');
const {
  comparePublicQrDtos
} = require('../src/server/services/postgres/publicQrDtoComparator');

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
