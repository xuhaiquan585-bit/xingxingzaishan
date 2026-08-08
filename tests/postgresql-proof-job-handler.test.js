'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  RecordProofJobError,
  createRecordProofJobHandler,
  normalizePreparation,
  normalizeSubmission,
  validateJob
} = require('../src/server/services/postgres/recordProofJobHandler');

const NOW = '2026-08-09T10:00:00.000Z';
const MANIFEST_HASH = 'a'.repeat(64);
const IMAGE_HASH = 'b'.repeat(64);

function job(overrides = {}) {
  return {
    id: '00000000-0000-0000-0000-000000000901',
    job_type: 'record_proof_prepare_submit',
    aggregate_type: 'record',
    aggregate_id: 'QR_PROOF',
    payload: { record_qr_id: 'QR_PROOF' },
    ...overrides
  };
}

function proof(overrides = {}) {
  return {
    id: '00000000-0000-0000-0000-000000000801',
    record_qr_id: 'QR_PROOF',
    provider: 'avata_wenchang',
    status: 'not_started',
    operation_id: null,
    manifest_object_key: null,
    manifest_hash: null,
    legacy_hash_snapshot: null,
    transaction_hash: null,
    block_height: null,
    provider_record_id: null,
    provider_certificate_url: null,
    certificate_object_key: null,
    certificate_object_url_snapshot: null,
    confirmed_at: null,
    callback_received_at: null,
    retry_count: 0,
    last_error: '',
    created_at: NOW,
    updated_at: NOW,
    ...overrides
  };
}

function createHarness(overrides = {}) {
  const state = {
    transactionDepth: 0,
    transactionCount: 0,
    qr: {
      id: 'QR_PROOF', lifecycle_status: 'activated', batch_id: 'BATCH_PROOF'
    },
    record: {
      qr_id: 'QR_PROOF', content: 'Proof fixture', image_url_snapshot: '',
      image_object_key: 'records/proof.jpg', image_sha256: null,
      sealed_at: NOW, show_brand_disclosure: true,
      brand_disclosure_text_snapshot: 'Proof disclosure', updated_at: NOW
    },
    coCreation: null,
    comments: [],
    batch: { id: 'BATCH_PROOF' },
    proof: null,
    archive: null,
    attempts: [],
    ...overrides
  };
  const repositories = {
    qr: {
      async findById() { return state.qr; }
    },
    record: {
      async findByQrIdForUpdate() { return state.record; },
      async setImageSha256(input) {
        if (state.record.image_sha256 && state.record.image_sha256 !== input.image_sha256) {
          return null;
        }
        state.record = {
          ...state.record,
          image_sha256: input.image_sha256,
          updated_at: input.updated_at
        };
        return state.record;
      }
    },
    coCreation: {
      async findByQrId() { return state.coCreation; },
      async listEffectiveComments() { return state.comments; }
    },
    batch: {
      async findById() { return state.batch; }
    },
    proof: {
      async findByRecordIdForUpdate() { return state.proof; },
      async insertPending(input) { state.proof = { ...input }; return state.proof; },
      async findForUpdate() { return state.proof; },
      async markManifestReady(input) {
        state.proof = {
          ...state.proof,
          status: 'manifest_ready',
          operation_id: input.operation_id,
          manifest_object_key: input.manifest_object_key,
          manifest_hash: input.manifest_hash,
          legacy_hash_snapshot: null,
          last_error: '',
          updated_at: input.updated_at
        };
        return state.proof;
      },
      async failPendingAttempts(input) {
        let count = 0;
        state.attempts = state.attempts.map((attempt) => {
          if (attempt.proof_id !== input.proof_id || attempt.result_status !== 'pending') {
            return attempt;
          }
          count += 1;
          return {
            ...attempt,
            result_status: 'failed',
            sanitized_error: input.sanitized_error,
            completed_at: input.completed_at
          };
        });
        return count;
      },
      async markSubmitting(input) {
        state.proof = {
          ...state.proof,
          status: 'submitting',
          retry_count: input.retry_count,
          last_error: '',
          updated_at: input.updated_at
        };
        return state.proof;
      },
      async appendAttempt(input) {
        const attempt = { id: state.attempts.length + 1, ...input };
        state.attempts.push(attempt);
        return attempt;
      },
      async markSubmitted(input) { return transitionResult('submitted', input); },
      async markConfirmed(input) { return transitionResult('confirmed', input); },
      async markFailed(input) {
        if (['submitted', 'confirmed'].includes(state.proof.status)) return null;
        state.proof = {
          ...state.proof,
          status: 'failed',
          last_error: input.last_error,
          updated_at: input.updated_at
        };
        return state.proof;
      },
      async completeAttempt(input) {
        const index = state.attempts.findIndex((attempt) => (
          attempt.proof_id === input.proof_id
          && attempt.attempt_number === input.attempt_number
          && attempt.result_status === 'pending'
        ));
        if (index === -1) return null;
        state.attempts[index] = {
          ...state.attempts[index],
          request_state: 'sent',
          result_status: input.result_status,
          sanitized_error: input.sanitized_error,
          completed_at: input.completed_at
        };
        return state.attempts[index];
      }
    },
    archive: {
      async upsertReady(input) {
        state.archive = { ...input, status: 'ready', last_error: '' };
        return state.archive;
      },
      async markFailed(input) {
        if (state.archive && state.archive.status === 'ready') return null;
        state.archive = { ...input, status: 'failed' };
        return state.archive;
      }
    }
  };

  function transitionResult(status, input) {
    state.proof = {
      ...state.proof,
      ...input,
      status,
      last_error: ''
    };
    return state.proof;
  }

  const repositoryTypes = {
    QrRepository: class { constructor() { return repositories.qr; } },
    RecordRepository: class { constructor() { return repositories.record; } },
    CoCreationRepository: class { constructor() { return repositories.coCreation; } },
    QrBatchRepository: class { constructor() { return repositories.batch; } },
    ProofRepository: class { constructor() { return repositories.proof; } },
    ArchiveRepository: class { constructor() { return repositories.archive; } }
  };

  async function transactionRunner(currentPool, callback, options) {
    assert.equal(currentPool, pool);
    assert.deepEqual(options, { isolationLevel: 'read committed' });
    state.transactionCount += 1;
    state.transactionDepth += 1;
    try {
      return await callback({ query() {} });
    } finally {
      state.transactionDepth -= 1;
    }
  }

  const pool = { connect() {} };
  return { pool, repositoryTypes, state, transactionRunner };
}

function preparation() {
  return {
    manifest_hash: MANIFEST_HASH,
    manifest_object_key: 'records/QR_PROOF/record_manifest.json',
    image_sha256: IMAGE_HASH,
    index_object_key: 'indexes/by-star/QR_PROOF.json'
  };
}

test('record proof job prepares, submits, persists audit state, and becomes idempotent', async () => {
  const harness = createHarness();
  let preparationCalls = 0;
  let submissionCalls = 0;
  const handler = createRecordProofJobHandler({
    ...harness,
    clock: () => new Date(NOW),
    randomUUID: () => '00000000-0000-0000-0000-000000000801',
    async prepareRecord({ record }) {
      assert.equal(harness.state.transactionDepth, 0);
      assert.equal(record.id, 'QR_PROOF');
      assert.equal(record.activation_status, 'activated');
      preparationCalls += 1;
      return preparation();
    },
    async submitRecord(input) {
      assert.equal(harness.state.transactionDepth, 0);
      assert.equal(input.operation_id, `record_QR_PROOF_${MANIFEST_HASH.slice(0, 16)}`);
      submissionCalls += 1;
      return {
        status: 'confirmed',
        transaction_hash: 'tx-proof',
        block_height: 42,
        provider_record_id: 'provider-record'
      };
    }
  });

  const result = await handler(job());
  assert.equal(result.status, 'confirmed');
  assert.equal(harness.state.proof.retry_count, 1);
  assert.equal(harness.state.record.image_sha256, IMAGE_HASH);
  assert.equal(harness.state.archive.status, 'ready');
  assert.equal(harness.state.attempts[0].result_status, 'succeeded');
  assert.equal(harness.state.attempts[0].request_state, 'sent');
  assert.equal(preparationCalls, 1);
  assert.equal(submissionCalls, 1);

  assert.equal((await handler(job())).status, 'confirmed');
  assert.equal(preparationCalls, 1);
  assert.equal(submissionCalls, 1);
});

test('record proof job retries submission without repeating durable preparation', async () => {
  const harness = createHarness();
  let preparationCalls = 0;
  let submissionCalls = 0;
  const handler = createRecordProofJobHandler({
    ...harness,
    clock: () => new Date(NOW),
    randomUUID: () => '00000000-0000-0000-0000-000000000801',
    async prepareRecord() {
      preparationCalls += 1;
      return preparation();
    },
    async submitRecord() {
      submissionCalls += 1;
      if (submissionCalls === 1) throw new Error('sensitive provider response');
      return { status: 'submitted', transaction_hash: 'tx-retry' };
    }
  });

  await assert.rejects(
    handler(job()),
    (error) => error instanceof RecordProofJobError
      && error.code === 'RECORD_PROOF_SUBMISSION_FAILED'
      && !error.message.includes('sensitive provider response')
  );
  assert.equal(harness.state.proof.status, 'failed');
  assert.equal(harness.state.proof.last_error, 'RECORD_PROOF_SUBMISSION_FAILED');
  assert.equal(harness.state.attempts[0].result_status, 'failed');

  const result = await handler(job());
  assert.equal(result.status, 'submitted');
  assert.equal(result.retry_count, 2);
  assert.equal(preparationCalls, 1);
  assert.equal(submissionCalls, 2);
  assert.deepEqual(
    harness.state.attempts.map((attempt) => attempt.result_status),
    ['failed', 'succeeded']
  );
});

test('record proof job closes an interrupted attempt before idempotent resubmission', async () => {
  const harness = createHarness({
    proof: proof({
      status: 'submitting',
      operation_id: `record_QR_PROOF_${MANIFEST_HASH.slice(0, 16)}`,
      manifest_object_key: 'records/QR_PROOF/record_manifest.json',
      manifest_hash: MANIFEST_HASH,
      retry_count: 1
    }),
    attempts: [{
      id: 1,
      proof_id: '00000000-0000-0000-0000-000000000801',
      attempt_number: 1,
      request_state: 'started',
      result_status: 'pending',
      sanitized_error: '',
      requested_at: NOW,
      completed_at: null
    }]
  });
  const handler = createRecordProofJobHandler({
    ...harness,
    clock: () => new Date(NOW),
    prepareRecord: async () => assert.fail('prepared proof must not be rebuilt'),
    submitRecord: async () => ({ status: 'submitted' })
  });

  assert.equal((await handler(job())).status, 'submitted');
  assert.equal(harness.state.attempts[0].result_status, 'failed');
  assert.equal(
    harness.state.attempts[0].sanitized_error,
    'RECORD_PROOF_ATTEMPT_INTERRUPTED'
  );
  assert.equal(harness.state.attempts[1].attempt_number, 2);
  assert.equal(harness.state.attempts[1].result_status, 'succeeded');
});

test('record proof job validates contracts and preserves legacy proof evidence', async () => {
  assert.throws(
    () => createRecordProofJobHandler({ pool: { connect() {} } }),
    (error) => error.code === 'RECORD_PROOF_PREPARER_REQUIRED'
  );
  assert.throws(
    () => validateJob(job({ payload: { record_qr_id: 'QR_OTHER' } })),
    (error) => error.code === 'RECORD_PROOF_JOB_RECORD_MISMATCH'
  );
  assert.throws(
    () => normalizePreparation({ manifest_hash: 'not-a-hash', manifest_object_key: 'x' }),
    (error) => error.code === 'RECORD_PROOF_PREPARATION_RESULT_INVALID'
  );
  assert.throws(
    () => normalizeSubmission({ status: 'unknown' }, NOW),
    (error) => error.code === 'RECORD_PROOF_SUBMISSION_RESULT_INVALID'
  );

  const harness = createHarness({
    proof: proof({ status: 'failed', legacy_hash_snapshot: 'legacy-evidence' })
  });
  const handler = createRecordProofJobHandler({
    ...harness,
    prepareRecord: async () => assert.fail('legacy proof must fail closed'),
    submitRecord: async () => assert.fail('legacy proof must fail closed')
  });
  await assert.rejects(
    handler(job()),
    (error) => error.code === 'RECORD_PROOF_LEGACY_STATE_UNSUPPORTED'
  );
  assert.equal(harness.state.proof.legacy_hash_snapshot, 'legacy-evidence');
});

test('record proof job handler contains no JSON store, SQL, environment, or automatic runtime wiring', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../src/server/services/postgres/recordProofJobHandler.js'),
    'utf8'
  );
  assert.doesNotMatch(source, /dbService|readDB|writeDB|process\.env/);
  assert.doesNotMatch(source, /\b(?:SELECT|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK)\b/);
  assert.doesNotMatch(source, /setInterval|setTimeout|pm2|server\.js/);
});
