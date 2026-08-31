'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const { requestAvata } = require('../src/server/services/avataService');
const {
  RECOVERY_DEFERRED_CODE,
  RecordProofJobError,
  createRecordProofJobHandler,
  normalizePreparation,
  normalizeSubmission,
  operationId,
  validateJob
} = require('../src/server/services/postgres/recordProofJobHandler');

const NOW = '2026-08-09T10:00:00.000Z';
const MANIFEST_HASH = 'a'.repeat(64);
const IMAGE_HASH = 'b'.repeat(64);

test('record proof operation IDs preserve short IDs and compact long IDs to provider bounds', () => {
  assert.equal(
    operationId('QR_PROOF', MANIFEST_HASH),
    `record_QR_PROOF_${MANIFEST_HASH.slice(0, 16)}`
  );
  const longQrId = `Q${'R'.repeat(63)}`;
  const compact = operationId(longQrId, MANIFEST_HASH);
  assert.match(compact, /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(compact, operationId(longQrId, MANIFEST_HASH));
  assert.notEqual(compact, operationId(`S${'R'.repeat(63)}`, MANIFEST_HASH));
});

async function startUncertainSubmissionProvider() {
  const sockets = new Set();
  let getCount = 0;
  let postCount = 0;
  const server = http.createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/submit') {
      postCount += 1;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.flushHeaders();
      response.write('{"status":"submitted"');
      return;
    }
    if (request.method === 'GET' && request.url.startsWith('/query?')) {
      getCount += 1;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"status":"submitted"}');
      return;
    }
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end('{"code":"TEST_ROUTE_NOT_FOUND"}');
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    getCount: () => getCount,
    postCount: () => postCount,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

async function withAvataTestEnvironment(callback) {
  const keys = ['AVATA_ENV', 'AVATA_API_BASE', 'AVATA_API_KEY', 'AVATA_API_SECRET'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    AVATA_ENV: 'stage',
    AVATA_API_BASE: 'https://stage.apis.avata.bianjie.ai',
    AVATA_API_KEY: 'uncertain-test-key',
    AVATA_API_SECRET: 'uncertain-test-secret'
  });
  try {
    return await callback();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

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
    outboxJobs: [],
    failSubmissionPersistenceOnce: false,
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
      async findPendingAttemptForUpdate(proofId) {
        return [...state.attempts].reverse().find((attempt) => (
          attempt.proof_id === proofId && attempt.result_status === 'pending'
        )) || null;
      },
      async findLatestAttemptForUpdate(proofId) {
        return [...state.attempts].reverse().find((attempt) => (
          attempt.proof_id === proofId
        )) || null;
      },
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
      async markSubmitted(input) {
        if (state.failSubmissionPersistenceOnce) {
          state.failSubmissionPersistenceOnce = false;
          throw new Error('simulated local persistence failure');
        }
        return transitionResult('submitted', input);
      },
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
      async markRecoveryDeferred(input) {
        if (['submitted', 'confirmed'].includes(state.proof.status)) {
          return state.proof;
        }
        state.proof = {
          ...state.proof,
          status: 'retrying',
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
    },
    outbox: {
      async insertPendingOnce(input) {
        const existing = state.outboxJobs.find((item) => (
          item.idempotency_key === input.idempotency_key
        ));
        if (existing) return null;
        state.outboxJobs.push({ ...input });
        return input;
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
    ArchiveRepository: class { constructor() { return repositories.archive; } },
    OutboxRepository: class { constructor() { return repositories.outbox; } }
  };

  let transactionTail = Promise.resolve();
  async function transactionRunner(currentPool, callback, options) {
    assert.equal(currentPool, pool);
    assert.deepEqual(options, { isolationLevel: 'read committed' });
    const previous = transactionTail;
    let release;
    transactionTail = new Promise((resolve) => { release = resolve; });
    await previous;
    state.transactionCount += 1;
    state.transactionDepth += 1;
    try {
      return await callback({ query() {} });
    } finally {
      state.transactionDepth -= 1;
      release();
    }
  }

  const pool = { connect() {} };
  async function queryRecord() {
    const error = new Error('recovery query was not configured');
    error.code = 'RECORD_PROOF_RECOVERY_QUERY_FAILED';
    throw error;
  }
  async function applyQueryResult(result) {
    assert.equal(state.transactionDepth, 0);
    if (!state.proof || result.operation_id !== state.proof.operation_id) {
      return { outcome: 'not_found', status: null };
    }
    if (state.proof.status === 'confirmed' && result.status !== 'confirmed') {
      return { outcome: 'stale', status: 'confirmed' };
    }
    const outcome = state.proof.status === result.status ? 'duplicate' : 'applied';
    state.proof = {
      ...state.proof,
      status: result.status,
      transaction_hash: result.transaction_hash || state.proof.transaction_hash,
      block_height: result.block_height ?? state.proof.block_height,
      provider_record_id: result.provider_record_id || state.proof.provider_record_id,
      provider_certificate_url:
        state.proof.provider_certificate_url
        || result.provider_certificate_url
        || null,
      last_error: result.status === 'failed'
        ? 'RECORD_PROOF_PROVIDER_REPORTED_FAILURE'
        : ''
    };
    return { outcome, status: state.proof.status };
  }
  return {
    pool,
    repositoryTypes,
    state,
    transactionRunner,
    queryRecord,
    applyQueryResult,
    prepareSubmission(input) {
      return { ...input, provider_submission: { prepared: true } };
    }
  };
}

function preparation() {
  return {
    manifest_hash: MANIFEST_HASH,
    manifest_object_key: 'records/QR_PROOF/record_manifest.json',
    image_sha256: IMAGE_HASH,
    index_object_key: 'indexes/by-star/QR_PROOF.json'
  };
}

function uncertainState(proofOverrides = {}) {
  const current = proof({
    status: 'retrying',
    operation_id: `record_QR_PROOF_${MANIFEST_HASH.slice(0, 16)}`,
    manifest_object_key: 'records/QR_PROOF/record_manifest.json',
    manifest_hash: MANIFEST_HASH,
    retry_count: 1,
    last_error: 'RECORD_PROOF_SUBMISSION_FAILED',
    ...proofOverrides
  });
  return {
    proof: current,
    attempts: [{
      id: 1,
      proof_id: current.id,
      attempt_number: 1,
      request_state: 'started',
      result_status: 'pending',
      sanitized_error: '',
      requested_at: NOW,
      completed_at: null
    }]
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
      assert.equal(harness.state.attempts.length, 1);
      assert.equal(harness.state.attempts[0].request_state, 'started');
      submissionCalls += 1;
      return {
        status: 'confirmed',
        transaction_hash: 'tx-proof',
        block_height: 42,
        provider_record_id: 'provider-record',
        provider_certificate_url: 'https://cert.example.test/proof.pdf'
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
  assert.equal(harness.state.outboxJobs.length, 1);
  assert.equal(
    harness.state.outboxJobs[0].job_type,
    'record_proof_archive_certificate'
  );
  assert.equal(preparationCalls, 1);
  assert.equal(submissionCalls, 1);
  assert.equal(harness.state.outboxJobs.length, 1);

  assert.equal((await handler(job())).status, 'confirmed');
  assert.equal(preparationCalls, 1);
  assert.equal(submissionCalls, 1);
});

test('submission preflight failure creates no attempt and does not consume the first POST', async () => {
  const harness = createHarness();
  let preflightFails = true;
  let submissionCalls = 0;
  const handler = createRecordProofJobHandler({
    ...harness,
    clock: () => new Date(NOW),
    randomUUID: () => '00000000-0000-0000-0000-000000000801',
    prepareRecord: async () => preparation(),
    prepareSubmission(input) {
      if (preflightFails) {
        const error = new Error('configuration details must stay hidden');
        error.code = 'RECORD_PROOF_LOCAL_PREFLIGHT_INVALID';
        throw error;
      }
      return { ...input, provider_submission: { prepared: true } };
    },
    async submitRecord() {
      submissionCalls += 1;
      return { status: 'submitted', transaction_hash: 'tx-after-preflight' };
    }
  });

  await assert.rejects(
    handler(job()),
    (error) => error.code === 'RECORD_PROOF_LOCAL_PREFLIGHT_INVALID'
      && !error.message.includes('configuration details')
  );
  assert.equal(harness.state.attempts.length, 0);
  assert.equal(submissionCalls, 0);

  preflightFails = false;
  assert.equal((await handler(job())).status, 'submitted');
  assert.equal(harness.state.attempts.length, 1);
  assert.equal(submissionCalls, 1);
});

test('accepted submission with failed local persistence recovers by query without another POST', async () => {
  const harness = createHarness({ failSubmissionPersistenceOnce: true });
  let submissionCalls = 0;
  let queryCalls = 0;
  const handler = createRecordProofJobHandler({
    ...harness,
    clock: () => new Date(NOW),
    recoveryMinAgeMs: 0,
    randomUUID: () => '00000000-0000-0000-0000-000000000801',
    async prepareRecord() {
      return preparation();
    },
    async submitRecord() {
      submissionCalls += 1;
      return { status: 'submitted', transaction_hash: 'tx-accepted' };
    },
    async queryRecord({ operation_id: operationId }) {
      queryCalls += 1;
      return {
        status: 'submitted',
        operation_id: operationId,
        transaction_hash: 'tx-accepted'
      };
    }
  });

  await assert.rejects(
    handler(job()),
    (error) => error instanceof RecordProofJobError
      && error.code === RECOVERY_DEFERRED_CODE
  );
  assert.equal(harness.state.proof.status, 'retrying');
  assert.equal(harness.state.attempts[0].result_status, 'pending');

  const result = await handler(job());
  assert.equal(result.status, 'submitted');
  assert.equal(queryCalls, 1);
  assert.equal(submissionCalls, 1);
  assert.equal(harness.state.attempts[0].result_status, 'succeeded');
});

test('accepted POST with stalled response body recovers by GET for the original operation only', {
  timeout: 5000
}, async () => {
  const provider = await startUncertainSubmissionProvider();
  const nativeFetch = globalThis.fetch;
  const harness = createHarness();
  const expectedOperationId = `record_QR_PROOF_${MANIFEST_HASH.slice(0, 16)}`;
  let queryCalls = 0;
  const requestDependencies = {
    fetchImpl(url, options) {
      const requested = new URL(url);
      return nativeFetch(
        `${provider.baseUrl}${requested.pathname}${requested.search}`,
        options
      );
    },
    timeoutMs: 1000,
    maxResponseBytes: 1024
  };
  try {
    await withAvataTestEnvironment(async () => {
      const handler = createRecordProofJobHandler({
        ...harness,
        clock: () => new Date(NOW),
        recoveryMinAgeMs: 0,
        randomUUID: () => '00000000-0000-0000-0000-000000000801',
        prepareRecord: async () => preparation(),
        async submitRecord(input) {
          assert.equal(input.operation_id, expectedOperationId);
          const result = await requestAvata({
            method: 'POST',
            path: '/submit',
            body: { operation_id: input.operation_id }
          }, requestDependencies);
          return { ...result, operation_id: input.operation_id };
        },
        async queryRecord({ operation_id: operationId }) {
          queryCalls += 1;
          assert.equal(operationId, expectedOperationId);
          const result = await requestAvata({
            method: 'GET',
            path: '/query',
            query: { operation_id: operationId }
          }, requestDependencies);
          return { ...result, operation_id: operationId };
        }
      });

      await assert.rejects(
        handler(job()),
        (error) => error.code === RECOVERY_DEFERRED_CODE
      );
      assert.equal(harness.state.proof.operation_id, expectedOperationId);
      assert.equal(harness.state.attempts.length, 1);
      assert.equal(provider.postCount(), 1);

      const recovered = await handler(job());
      assert.equal(recovered.status, 'submitted');
      assert.equal(recovered.operation_id, expectedOperationId);
      assert.equal(provider.postCount(), 1);
      assert.equal(provider.getCount(), 1);
      assert.equal(queryCalls, 1);
      assert.equal(harness.state.attempts.length, 1);
    });
  } finally {
    await provider.close();
  }
});

for (const ambiguousCode of [
  'ETIMEDOUT',
  'ECONNRESET',
  'AVATA_REQUEST_FAILED',
  'AVATA_HTTP_400_BAD_REQUEST',
  'AVATA_RESPONSE_TOO_LARGE',
  'AVATA_RESPONSE_INVALID',
  'RECORD_PROOF_PROVIDER_STATUS_INVALID'
]) {
  test(`ambiguous submission ${ambiguousCode} becomes query-only`, async () => {
    const harness = createHarness();
    let submissionCalls = 0;
    let queryCalls = 0;
    const handler = createRecordProofJobHandler({
      ...harness,
      clock: () => new Date(NOW),
      recoveryMinAgeMs: 0,
      randomUUID: () => '00000000-0000-0000-0000-000000000801',
      prepareRecord: async () => preparation(),
      async submitRecord() {
        submissionCalls += 1;
        const error = new Error('provider response must stay hidden');
        error.code = ambiguousCode;
        throw error;
      },
      async queryRecord() {
        queryCalls += 1;
        const error = new Error('query details must stay hidden');
        error.code = 'RECORD_PROOF_RECOVERY_QUERY_FAILED';
        throw error;
      }
    });

    await assert.rejects(handler(job()), (error) => error.code === RECOVERY_DEFERRED_CODE);
    assert.equal(harness.state.proof.last_error, ambiguousCode);
    await assert.rejects(handler(job()), (error) => error.code === RECOVERY_DEFERRED_CODE);
    assert.equal(submissionCalls, 1);
    assert.equal(queryCalls, 1);
    assert.equal(harness.state.attempts.length, 1);
    assert.equal(harness.state.proof.status, 'retrying');
    assert.equal(harness.state.proof.last_error, ambiguousCode);
  });
}

test('recovery query synchronizes confirmed state and continues certificate archive', async () => {
  const harness = createHarness(uncertainState());
  let submissionCalls = 0;
  const handler = createRecordProofJobHandler({
    ...harness,
    clock: () => new Date(NOW),
    recoveryMinAgeMs: 0,
    prepareRecord: async () => assert.fail('prepared proof must not be rebuilt'),
    submitRecord: async () => { submissionCalls += 1; },
    async queryRecord({ operation_id: operationId }) {
      return {
        status: 'confirmed',
        operation_id: operationId,
        transaction_hash: 'tx-recovered',
        provider_certificate_url: 'https://cert.example.test/recovered.pdf'
      };
    }
  });

  assert.equal((await handler(job())).status, 'confirmed');
  assert.equal(submissionCalls, 0);
  assert.equal(harness.state.attempts[0].result_status, 'succeeded');
  assert.equal(harness.state.outboxJobs.length, 1);
  assert.equal(
    harness.state.outboxJobs[0].job_type,
    'record_proof_archive_certificate'
  );
});

test('documented operation-not-found remains query-only and never resubmits', async () => {
  const harness = createHarness(uncertainState());
  let submissionCalls = 0;
  const handler = createRecordProofJobHandler({
    ...harness,
    clock: () => new Date(NOW),
    recoveryMinAgeMs: 0,
    prepareRecord: async () => assert.fail('prepared proof must not be rebuilt'),
    async queryRecord() {
      const error = new Error('provider response is intentionally hidden');
      error.code = 'RECORD_PROOF_EXTERNAL_OPERATION_NOT_FOUND';
      throw error;
    },
    async submitRecord() {
      submissionCalls += 1;
      return { status: 'submitted', transaction_hash: 'tx-forbidden' };
    }
  });

  await assert.rejects(
    handler(job()),
    (error) => error.code === RECOVERY_DEFERRED_CODE
  );
  assert.equal(submissionCalls, 0);
  assert.equal(harness.state.proof.status, 'retrying');
  assert.equal(harness.state.proof.retry_count, 1);
  assert.equal(harness.state.attempts.length, 1);
  assert.equal(harness.state.attempts[0].result_status, 'pending');
});

test('generic NOT_FOUND remains query-only and never resubmits', async () => {
  const harness = createHarness(uncertainState());
  let submissionCalls = 0;
  const handler = createRecordProofJobHandler({
    ...harness,
    clock: () => new Date(NOW),
    recoveryMinAgeMs: 0,
    prepareRecord: async () => assert.fail('prepared proof must not be rebuilt'),
    async queryRecord() {
      const error = new Error('ambiguous provider response');
      error.code = 'NOT_FOUND';
      throw error;
    },
    submitRecord: async () => { submissionCalls += 1; }
  });

  await assert.rejects(handler(job()), (error) => error.code === RECOVERY_DEFERRED_CODE);
  assert.equal(submissionCalls, 0);
  assert.equal(harness.state.attempts.length, 1);
  assert.equal(harness.state.proof.status, 'retrying');
});

test('unknown recovery query remains retryable and never submits', async () => {
  const harness = createHarness(uncertainState());
  let submissionCalls = 0;
  const handler = createRecordProofJobHandler({
    ...harness,
    clock: () => new Date(NOW),
    recoveryMinAgeMs: 0,
    prepareRecord: async () => assert.fail('prepared proof must not be rebuilt'),
    submitRecord: async () => { submissionCalls += 1; },
    async queryRecord() {
      const error = new Error('sensitive upstream response');
      error.code = 'ETIMEDOUT';
      throw error;
    }
  });

  await assert.rejects(
    handler(job()),
    (error) => error.code === RECOVERY_DEFERRED_CODE
      && !error.message.includes('sensitive upstream response')
  );
  assert.equal(submissionCalls, 0);
  assert.equal(harness.state.proof.status, 'retrying');
  assert.equal(harness.state.proof.last_error, 'ETIMEDOUT');
  assert.equal(harness.state.attempts[0].result_status, 'pending');
});

test('legacy completed submission attempt remains query-only', async () => {
  const legacy = uncertainState();
  legacy.attempts[0] = {
    ...legacy.attempts[0],
    request_state: 'sent',
    result_status: 'failed',
    sanitized_error: 'LEGACY_UNCERTAIN_RESULT',
    completed_at: NOW
  };
  const harness = createHarness(legacy);
  let submissionCalls = 0;
  const handler = createRecordProofJobHandler({
    ...harness,
    clock: () => new Date(NOW),
    recoveryMinAgeMs: 0,
    prepareRecord: async () => assert.fail('prepared proof must not be rebuilt'),
    submitRecord: async () => { submissionCalls += 1; },
    async queryRecord({ operation_id: operationId }) {
      return { status: 'submitted', operation_id: operationId };
    }
  });

  assert.equal((await handler(job())).status, 'submitted');
  assert.equal(submissionCalls, 0);
  assert.equal(harness.state.attempts.length, 1);
});

test('provider failed recovery uses the existing state machine without a new operation', async () => {
  const harness = createHarness(uncertainState());
  let submissionCalls = 0;
  const handler = createRecordProofJobHandler({
    ...harness,
    clock: () => new Date(NOW),
    recoveryMinAgeMs: 0,
    prepareRecord: async () => assert.fail('prepared proof must not be rebuilt'),
    submitRecord: async () => { submissionCalls += 1; },
    async queryRecord({ operation_id: operationId }) {
      return { status: 'failed', operation_id: operationId };
    }
  });

  await assert.rejects(
    handler(job()),
    (error) => error.code === 'RECORD_PROOF_PROVIDER_REPORTED_FAILURE'
  );
  assert.equal(submissionCalls, 0);
  assert.equal(harness.state.proof.status, 'failed');
  assert.equal(harness.state.attempts[0].result_status, 'failed');
});

test('concurrent recovery cannot create duplicate external submissions', async () => {
  const harness = createHarness(uncertainState());
  let submissionCalls = 0;
  let queryCalls = 0;
  const handler = createRecordProofJobHandler({
    ...harness,
    clock: () => new Date(NOW),
    recoveryMinAgeMs: 0,
    prepareRecord: async () => assert.fail('prepared proof must not be rebuilt'),
    async queryRecord() {
      queryCalls += 1;
      await new Promise((resolve) => setImmediate(resolve));
      const error = new Error('not found');
      error.code = 'RECORD_PROOF_EXTERNAL_OPERATION_NOT_FOUND';
      throw error;
    },
    async submitRecord() {
      submissionCalls += 1;
      return { status: 'submitted', transaction_hash: 'tx-concurrent' };
    }
  });

  const outcomes = await Promise.allSettled([handler(job()), handler(job())]);
  assert.equal(queryCalls, 2);
  assert.equal(submissionCalls, 0);
  assert.equal(outcomes.filter((item) => item.status === 'rejected').length, 2);
  assert.equal(harness.state.proof.status, 'retrying');
  assert.equal(harness.state.attempts.length, 1);
});

test('confirmed recovery without a certificate stays confirmed and never resubmits', async () => {
  const harness = createHarness(uncertainState());
  let submissionCalls = 0;
  const handler = createRecordProofJobHandler({
    ...harness,
    clock: () => new Date(NOW),
    recoveryMinAgeMs: 0,
    prepareRecord: async () => assert.fail('prepared proof must not be rebuilt'),
    submitRecord: async () => { submissionCalls += 1; },
    async queryRecord({ operation_id: operationId }) {
      return {
        status: 'confirmed',
        operation_id: operationId,
        transaction_hash: 'tx-confirmed-no-certificate'
      };
    }
  });

  assert.equal((await handler(job())).status, 'confirmed');
  assert.equal((await handler(job())).status, 'confirmed');
  assert.equal(submissionCalls, 0);
  assert.equal(harness.state.proof.provider_certificate_url, null);
  assert.equal(harness.state.outboxJobs.length, 0);
});

test('manual reconciliation blocks duplicate jobs without query, POST, or evidence mutation', async () => {
  const manualReason = 'RECORD_PROOF_MANUAL_RECONCILIATION_QUERY_LIMIT';
  const initial = uncertainState({
    retry_count: 5,
    last_error: manualReason
  });
  const originalOperationId = initial.proof.operation_id;
  const harness = createHarness(initial);
  let queryCalls = 0;
  let submissionCalls = 0;
  const handler = createRecordProofJobHandler({
    ...harness,
    clock: () => new Date(NOW),
    recoveryMinAgeMs: 0,
    prepareRecord: async () => assert.fail('prepared proof must not be rebuilt'),
    async queryRecord() { queryCalls += 1; },
    async submitRecord() { submissionCalls += 1; }
  });

  await assert.rejects(
    handler(job()),
    (error) => error.code === 'RECORD_PROOF_AUTOMATIC_RESOLUTION_BLOCKED'
  );
  assert.equal(queryCalls, 0);
  assert.equal(submissionCalls, 0);
  assert.equal(harness.state.proof.operation_id, originalOperationId);
  assert.equal(harness.state.proof.retry_count, 5);
  assert.equal(harness.state.proof.last_error, manualReason);
});

test('late provider-terminal failure short-circuits stale jobs before GET, POST, or certificate work', async () => {
  const initial = uncertainState({
    retry_count: 5,
    last_error: 'RECORD_PROOF_MANUAL_RECONCILIATION_QUERY_LIMIT'
  });
  const originalOperationId = initial.proof.operation_id;
  const harness = createHarness(initial);
  await harness.applyQueryResult({
    status: 'failed',
    operation_id: originalOperationId
  });
  assert.equal(harness.state.proof.status, 'failed');
  assert.equal(
    harness.state.proof.last_error,
    'RECORD_PROOF_PROVIDER_REPORTED_FAILURE'
  );

  let queryCalls = 0;
  let submissionCalls = 0;
  const handler = createRecordProofJobHandler({
    ...harness,
    clock: () => new Date(NOW),
    recoveryMinAgeMs: 0,
    prepareRecord: async () => assert.fail('provider-terminal proof must not be rebuilt'),
    async queryRecord() { queryCalls += 1; },
    async submitRecord() { submissionCalls += 1; }
  });

  assert.equal((await handler(job())).status, 'failed');
  assert.equal(queryCalls, 0);
  assert.equal(submissionCalls, 0);
  assert.equal(harness.state.outboxJobs.length, 0);
  assert.equal(harness.state.proof.operation_id, originalOperationId);
  assert.equal(harness.state.attempts.length, 1);
});

test('non-provider failed proof preserves query-only recovery semantics', async () => {
  const initial = uncertainState({
    status: 'failed',
    last_error: 'RECORD_PROOF_RECOVERY_RESULT_PERSIST_FAILED'
  });
  const originalOperationId = initial.proof.operation_id;
  const harness = createHarness(initial);
  let queryCalls = 0;
  let submissionCalls = 0;
  const handler = createRecordProofJobHandler({
    ...harness,
    clock: () => new Date(NOW),
    recoveryMinAgeMs: 0,
    prepareRecord: async () => assert.fail('prepared proof must not be rebuilt'),
    async queryRecord({ operation_id: operationId }) {
      queryCalls += 1;
      assert.equal(operationId, originalOperationId);
      return { status: 'submitted', operation_id: operationId };
    },
    async submitRecord() { submissionCalls += 1; }
  });

  assert.equal((await handler(job())).status, 'submitted');
  assert.equal(queryCalls, 1);
  assert.equal(submissionCalls, 0);
  assert.equal(harness.state.proof.operation_id, originalOperationId);
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
  assert.equal(normalizeSubmission({
    status: 'confirmed',
    confirmed_at: '2000-01-01T00:00:00.000Z'
  }, NOW).confirmed_at, NOW);

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
