'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  QrAdministrationError,
  createQrAdministrationService,
  presentAdminQr
} = require('../src/server/services/postgres/qrAdministrationService');

function createHarness(Repository, clock = () => new Date('2026-08-13T01:02:03.000Z')) {
  const events = [];
  const service = createQrAdministrationService({
    pool: { connect() {} },
    transactionRunner: async (_pool, callback, options) => {
      events.push(options);
      return callback({ query: async () => {} });
    },
    repositoryType: Repository,
    beforeOperation: async ({ operation }) => events.push(operation),
    clock
  });
  return { events, service };
}

test('QR administration creates deterministic concurrent-safe batches', async () => {
  const events = [];
  class Repository {
    async lockBatchDay(dayKey) { events.push(`lock:${dayKey}`); }
    async listBatchIdsForDay() {
      return ['BATCH_20260813_001', 'BATCH_20260813_003'];
    }
    async insertBatch(batch) {
      events.push(`insert:${batch.id}`);
      return {
        ...batch,
        note: batch.note,
        created_by_snapshot: batch.created_by_snapshot
      };
    }
  }
  const harness = createHarness(Repository);
  const batch = await harness.service.createBatch({
    name: 'Stable batch',
    brandName: 'Brand',
    brandDisclosureText: 'Disclosure',
    brandDisclosureDefault: true,
    createdBy: 'admin'
  });
  assert.equal(batch.id, 'BATCH_20260813_004');
  assert.equal(batch.brand_disclosure_default, true);
  assert.deepEqual(events, [
    'lock:20260813',
    'insert:BATCH_20260813_004'
  ]);
  assert.deepEqual(harness.events, [
    { isolationLevel: 'read committed', readOnly: false },
    'create_batch'
  ]);
});

test('QR administration lists, hides, and presents PostgreSQL records', async () => {
  const row = {
    id: 'PGA00001',
    issue_status: 'issued',
    lifecycle_status: 'activated',
    hidden: false,
    batch_id: 'BATCH_20260813_001',
    access_token: 'a'.repeat(32),
    content: 'record',
    image_object_key: 'records/pga.jpg',
    phone_snapshot: '13900000000',
    sealed_at: new Date('2026-08-13T01:00:00.000Z'),
    created_at: new Date('2026-08-13T00:00:00.000Z'),
    quality_checked_at: new Date('2026-08-13T00:30:00.000Z'),
    quality_checked_by: 'qc',
    co_creation_id: '00000000-0000-0000-0000-000000000001',
    co_creation_owner_account_id: 'ACC_TEST',
    co_creation_comments: [{
      id: 'COMMENT_1',
      content: 'comment',
      status: 'kept',
      created_at: new Date('2026-08-13T00:15:00.000Z'),
      deleted_at: null
    }],
    chain_status: 'not_started'
  };
  let listCall = 0;
  class Repository {
    async listAdminRecords(filters) {
      listCall += 1;
      if (listCall === 1) {
        assert.equal(filters.activationStatus, 'content');
      } else {
        assert.deepEqual(filters.ids, ['PGA00001']);
      }
      return { total: 1, records: [row] };
    }
    async setHidden(ids, hidden) {
      assert.deepEqual(ids, ['PGA00001']);
      assert.equal(hidden, true);
      return ids;
    }
  }
  const { service } = createHarness(Repository);
  const listed = await service.listRecords({
    activationStatus: 'content', page: 1, limit: 20
  });
  assert.equal(listed.records[0].activation_status, 'activated');
  assert.equal(listed.records[0].quality_check.checked, true);
  assert.equal(listed.records[0].co_creation_enabled, true);
  assert.equal(listed.records[0].co_creation_owner_account_id, 'ACC_TEST');
  assert.equal(listed.records[0].co_creation_comments[0].id, 'COMMENT_1');
  assert.equal(Object.isFrozen(listed.records[0].co_creation_comments), true);
  const hidden = await service.setHidden({ ids: ['PGA00001'], hidden: true });
  assert.equal(hidden[0].id, 'PGA00001');
});

test('QR administration quality checks preserve pass, duplicate, and bound contracts', async () => {
  const states = [
    { id: 'PGA00001', lifecycle_status: 'unactivated', has_quality_log: false },
    { id: 'PGA00001', lifecycle_status: 'unactivated', has_quality_log: true },
    { id: 'PGA00001', lifecycle_status: 'activated', has_quality_log: true }
  ];
  class Repository {
    async findQrForQualityCheck() { return states.shift(); }
    async insertQualityCheckLog(input) {
      return {
        checked_at: input.checkedAt,
        checked_by_snapshot: input.checkedBy
      };
    }
  }
  const { service } = createHarness(Repository);
  assert.equal((await service.runQualityCheck({
    qrId: 'PGA00001', checkedBy: 'qc'
  })).result, 'pass');
  assert.equal((await service.runQualityCheck({
    qrId: 'PGA00001', checkedBy: 'qc'
  })).result, 'duplicate');
  assert.equal((await service.runQualityCheck({
    qrId: 'PGA00001', checkedBy: 'qc'
  })).result, 'bound');
});

test('QR administration validates mutation scope and null presentation', async () => {
  class Repository {}
  const { service } = createHarness(Repository);
  await assert.rejects(
    service.setHidden({ ids: [], hidden: true }),
    (error) => error instanceof QrAdministrationError
      && error.code === 'QR_ADMINISTRATION_IDS_INVALID'
  );
  assert.equal(presentAdminQr(null), null);
});
