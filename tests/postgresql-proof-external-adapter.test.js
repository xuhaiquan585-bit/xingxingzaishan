'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  buildRecordManifest,
  hashManifest
} = require('../src/server/services/manifestService');
const {
  RecordProofExternalError,
  createRecordProofExternalAdapter,
  normalizeProviderStatus
} = require('../src/server/services/postgres/recordProofExternalAdapter');

const CREATED_AT = '2026-08-09T12:00:00.000Z';
const SEALED_AT = '2026-08-09T11:00:00.000Z';
const IMAGE_HASH = 'b'.repeat(64);

function record(overrides = {}) {
  return {
    id: 'QR_EXTERNAL',
    activation_status: 'activated',
    activated_at: SEALED_AT,
    content: 'External proof adapter fixture',
    image_object_key: 'records/QR_EXTERNAL/image.jpg',
    image_url: 'https://example.test/image.jpg',
    image_sha256: null,
    phone: '13800000000',
    openid: 'openid-must-not-leak',
    co_creation_enabled: true,
    co_creation_comments: [{
      id: 'comment-1',
      author_name: 'Author',
      content: 'Comment',
      phone: '13900000000',
      created_at: SEALED_AT
    }],
    show_brand_disclosure: true,
    brand_disclosure_text_snapshot: 'Disclosure',
    batch_id: 'BATCH_EXTERNAL',
    ...overrides
  };
}

function proof(overrides = {}) {
  return {
    id: '00000000-0000-0000-0000-000000000801',
    created_at: CREATED_AT,
    ...overrides
  };
}

function submission(overrides = {}) {
  return {
    record_qr_id: 'QR_EXTERNAL',
    sealed_at: SEALED_AT,
    operation_id: `record_QR_EXTERNAL_${'a'.repeat(16)}`,
    manifest_hash: 'a'.repeat(64),
    ...overrides
  };
}

function adapterOptions(overrides = {}) {
  return {
    buildRecordManifest,
    hashManifest,
    hashImageForRecord: async () => IMAGE_HASH,
    writeRecordArchive: async () => ({
      manifest_object_key: 'stars/QR_EXTERNAL/record_manifest.json',
      archive_index_object_key: 'indexes/by-star/QR_EXTERNAL.json'
    }),
    submitRecordProof: async () => ({
      status: 'confirmed',
      tx_hash: 'tx-external',
      block_height: 42,
      record_id: 'provider-record',
      certificate_url: 'https://example.test/certificate.pdf'
    }),
    normalizeAvataResult: (value) => value,
    ...overrides
  };
}

test('record manifest supports a stable explicit generation timestamp', () => {
  const first = buildRecordManifest(record(), { generatedAt: CREATED_AT });
  const second = buildRecordManifest(record(), { generatedAt: CREATED_AT });

  assert.deepEqual(first, second);
  assert.equal(first.generated_at, CREATED_AT);
  assert.equal(hashManifest(first), hashManifest(second));
  assert.throws(
    () => buildRecordManifest(record(), { generatedAt: 'invalid' }),
    (error) => error.code === 'RECORD_MANIFEST_GENERATED_AT_INVALID'
  );
});

test('external adapter prepares the same privacy-safe manifest across retries', async () => {
  const archives = [];
  const adapter = createRecordProofExternalAdapter(adapterOptions({
    async writeRecordArchive(input) {
      archives.push(input);
      return {
        manifest_object_key: 'stars/QR_EXTERNAL/record_manifest.json',
        archive_index_object_key: 'indexes/by-star/QR_EXTERNAL.json'
      };
    }
  }));

  const first = await adapter.prepareRecord({ record: record(), proof: proof() });
  const second = await adapter.prepareRecord({ record: record(), proof: proof() });

  assert.deepEqual(first, second);
  assert.equal(first.image_sha256, IMAGE_HASH);
  assert.equal(first.manifest_hash, hashManifest(archives[0].manifest));
  assert.equal(archives[0].manifest.generated_at, CREATED_AT);
  assert.deepEqual(archives[0].manifest, archives[1].manifest);
  const serialized = JSON.stringify(archives[0].manifest);
  assert.doesNotMatch(serialized, /13800000000|13900000000|openid-must-not-leak/);
});

test('external adapter rejects a disabled provider mock by default', async () => {
  const adapter = createRecordProofExternalAdapter(adapterOptions({
    submitRecordProof: async () => ({ mock: true, status: 'confirmed' })
  }));

  await assert.rejects(
    adapter.submitRecord(submission()),
    (error) => error instanceof RecordProofExternalError
      && error.code === 'RECORD_PROOF_PROVIDER_DISABLED'
  );
});

test('external adapter normalizes only known provider outcomes', async () => {
  assert.equal(normalizeProviderStatus(1), 'confirmed');
  assert.equal(normalizeProviderStatus('pending'), 'submitted');
  assert.equal(normalizeProviderStatus('FAIL'), 'failed');
  assert.throws(
    () => normalizeProviderStatus('unknown-provider-state'),
    (error) => error.code === 'RECORD_PROOF_PROVIDER_STATUS_INVALID'
  );

  const adapter = createRecordProofExternalAdapter(adapterOptions());
  assert.deepEqual(await adapter.submitRecord(submission()), {
    status: 'confirmed',
    operation_id: null,
    transaction_hash: 'tx-external',
    block_height: 42,
    provider_record_id: 'provider-record',
    provider_certificate_url: 'https://example.test/certificate.pdf'
  });

  const invalidCertificateAdapter = createRecordProofExternalAdapter(
    adapterOptions({
      submitRecordProof: async () => ({
        status: 'confirmed',
        certificate_url: 'javascript:alert(1)'
      })
    })
  );
  await assert.rejects(
    invalidCertificateAdapter.submitRecord(submission()),
    (error) => error.code === 'RECORD_PROOF_PROVIDER_RESULT_INVALID'
  );

  const conflictingOperationAdapter = createRecordProofExternalAdapter(
    adapterOptions({
      submitRecordProof: async () => ({
        status: 'submitted',
        operation_id: 'record_QR_OTHER_bbbbbbbbbbbbbbbb'
      })
    })
  );
  await assert.rejects(
    conflictingOperationAdapter.submitRecord(submission()),
    (error) => error.code === 'RECORD_PROOF_PROVIDER_RESULT_CONFLICT'
  );
});

test('external adapter has no database, environment, or runtime startup wiring', () => {
  const source = fs.readFileSync(
    path.join(
      __dirname,
      '../src/server/services/postgres/recordProofExternalAdapter.js'
    ),
    'utf8'
  );
  assert.doesNotMatch(source, /dbService|repositories|process\.env/);
  assert.doesNotMatch(
    source,
    /\b(?:SELECT|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK)\b/
  );
  assert.doesNotMatch(source, /setInterval|setTimeout|pm2|server\.js/);
});
