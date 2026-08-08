'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  RecordProofResultError,
  canonicalResult,
  createRecordProofResultService
} = require('../src/server/services/postgres/recordProofResultService');

const NOW = '2026-08-09T14:00:00.000Z';
const OPERATION_ID = 'record_QR_RESULT_aaaaaaaaaaaaaaaa';

function proof(overrides = {}) {
  return {
    id: '00000000-0000-0000-0000-000000000951',
    record_qr_id: 'QR_RESULT',
    provider: 'avata_wenchang',
    status: 'submitted',
    operation_id: OPERATION_ID,
    transaction_hash: null,
    block_height: null,
    provider_record_id: null,
    provider_certificate_url: null,
    confirmed_at: null,
    callback_received_at: null,
    last_error: '',
    created_at: NOW,
    updated_at: NOW,
    ...overrides
  };
}

function providerResult(overrides = {}) {
  return {
    status: 'confirmed',
    operation_id: OPERATION_ID,
    transaction_hash: 'tx-result',
    block_height: 99,
    provider_record_id: 'provider-result',
    provider_certificate_url: null,
    ...overrides
  };
}

function createHarness(initialProof = proof(), overrides = {}) {
  const state = {
    proof: initialProof,
    transactionDepth: 0,
    updateCount: 0
  };
  const repository = {
    async findByOperationIdForUpdate(provider, operationId) {
      assert.equal(provider, 'avata_wenchang');
      return state.proof && state.proof.operation_id === operationId
        ? state.proof
        : null;
    },
    async applyProviderEvent(input) {
      state.updateCount += 1;
      state.proof = {
        ...state.proof,
        status: input.status,
        transaction_hash:
          input.transaction_hash || state.proof.transaction_hash,
        block_height:
          input.block_height === null
            ? state.proof.block_height
            : input.block_height,
        provider_record_id:
          input.provider_record_id || state.proof.provider_record_id,
        provider_certificate_url:
          state.proof.provider_certificate_url
          || input.provider_certificate_url,
        confirmed_at: input.confirmed_at || state.proof.confirmed_at,
        callback_received_at:
          state.proof.callback_received_at
          || input.callback_received_at,
        last_error: input.last_error,
        updated_at: input.updated_at
      };
      return state.proof;
    }
  };
  const pool = { connect() {} };
  async function transactionRunner(currentPool, callback, options) {
    assert.equal(currentPool, pool);
    assert.deepEqual(options, { isolationLevel: 'read committed' });
    state.transactionDepth += 1;
    try {
      return await callback({ query() {} });
    } finally {
      state.transactionDepth -= 1;
    }
  }
  const repositoryTypes = {
    ProofRepository: class { constructor() { return repository; } }
  };
  const normalizeProviderResult = overrides.normalizeProviderResult
    || ((value) => {
      assert.equal(state.transactionDepth, 0);
      return value;
    });
  const service = createRecordProofResultService({
    pool,
    repositoryTypes,
    transactionRunner,
    normalizeProviderResult,
    clock: () => new Date(NOW)
  });
  return { service, state };
}

test('proof result callback confirms once and enriches a duplicate safely', async () => {
  const harness = createHarness();

  assert.deepEqual(
    await harness.service.applyCallback(providerResult()),
    { outcome: 'applied', status: 'confirmed' }
  );
  assert.equal(harness.state.proof.callback_received_at, NOW);
  assert.equal(harness.state.proof.confirmed_at, NOW);
  assert.equal(harness.state.proof.transaction_hash, 'tx-result');

  assert.deepEqual(
    await harness.service.applyCallback(providerResult({
      provider_certificate_url: 'https://example.test/certificate.pdf'
    })),
    { outcome: 'duplicate', status: 'confirmed' }
  );
  assert.equal(
    harness.state.proof.provider_certificate_url,
    'https://example.test/certificate.pdf'
  );
  assert.deepEqual(
    await harness.service.applyCallback(providerResult({
      provider_certificate_url: 'https://example.test/renewed-certificate.pdf'
    })),
    { outcome: 'duplicate', status: 'confirmed' }
  );
  assert.equal(
    harness.state.proof.provider_certificate_url,
    'https://example.test/certificate.pdf'
  );
  assert.equal(harness.state.updateCount, 3);
});

test('proof result service rejects conflicts and never regresses confirmation', async () => {
  const harness = createHarness(proof({
    status: 'confirmed',
    transaction_hash: 'tx-result',
    confirmed_at: NOW
  }));

  assert.deepEqual(
    await harness.service.applyQueryResult(providerResult({
      status: 'failed',
      transaction_hash: null,
      block_height: null,
      provider_record_id: null
    })),
    { outcome: 'stale', status: 'confirmed' }
  );
  assert.equal(harness.state.proof.status, 'confirmed');
  assert.equal(harness.state.updateCount, 0);

  await assert.rejects(
    harness.service.applyCallback(providerResult({
      transaction_hash: 'tx-conflict'
    })),
    (error) => error.code === 'RECORD_PROOF_PROVIDER_RESULT_CONFLICT'
  );
});

test('proof result service can recover a failed local attempt from confirmation', async () => {
  const harness = createHarness(proof({
    status: 'failed',
    last_error: 'RECORD_PROOF_SUBMISSION_FAILED'
  }));

  assert.deepEqual(
    await harness.service.applyCallback(providerResult()),
    { outcome: 'applied', status: 'confirmed' }
  );
  assert.equal(harness.state.proof.last_error, '');
  assert.equal(harness.state.proof.status, 'confirmed');
});

test('proof result service fails closed on invalid, unknown, and unready state', async () => {
  assert.throws(
    () => canonicalResult(providerResult({
      provider_certificate_url: 'http://example.test/certificate.pdf'
    })),
    (error) => error.code === 'RECORD_PROOF_PROVIDER_RESULT_INVALID'
  );

  const missing = createHarness(null);
  assert.deepEqual(
    await missing.service.applyCallback(providerResult()),
    { outcome: 'not_found', status: null }
  );

  const unready = createHarness(proof({ status: 'manifest_ready' }));
  await assert.rejects(
    unready.service.applyCallback(providerResult()),
    (error) => error.code === 'RECORD_PROOF_PROVIDER_STATE_INVALID'
  );

  const unsafeNormalizer = createHarness(proof(), {
    normalizeProviderResult() {
      throw new Error('sensitive provider body');
    }
  });
  await assert.rejects(
    unsafeNormalizer.service.applyCallback({ secret: 'provider-secret' }),
    (error) => error instanceof RecordProofResultError
      && error.code === 'RECORD_PROOF_PROVIDER_RESULT_INVALID'
      && !error.message.includes('sensitive provider body')
  );
});

test('proof result service has no JSON, SQL, environment, or route wiring', () => {
  const source = fs.readFileSync(
    path.join(
      __dirname,
      '../src/server/services/postgres/recordProofResultService.js'
    ),
    'utf8'
  );
  assert.doesNotMatch(source, /dbService|readDB|writeDB|process\.env/);
  assert.doesNotMatch(
    source,
    /\b(?:SELECT|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK)\b/
  );
  assert.doesNotMatch(source, /express|router|setInterval|setTimeout|pm2/);
});
