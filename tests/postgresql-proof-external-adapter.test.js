'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
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
const {
  PROVIDER_RESPONSE_MAX_BYTES,
  prepareRecordProofSubmission,
  requestAvata,
  verifyAvataCallback
} = require('../src/server/services/avataService');

const CREATED_AT = '2026-08-09T12:00:00.000Z';
const SEALED_AT = '2026-08-09T11:00:00.000Z';
const IMAGE_HASH = 'b'.repeat(64);

async function startLocalProvider() {
  const sockets = new Set();
  let acceptedPostCount = 0;
  const server = http.createServer((request, response) => {
    if (request.method === 'POST') acceptedPostCount += 1;
    if (request.url === '/stalled') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.flushHeaders();
      response.write('{"accepted":true');
      return;
    }
    if (request.url === '/oversized') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ value: 'x'.repeat(1024) }));
      return;
    }
    if (request.url === '/malformed') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"provider_secret":"must-not-leak"');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{"status":"submitted"}');
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    acceptedPostCount: () => acceptedPostCount,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

async function withAvataRequestEnvironment(callback) {
  const keys = ['AVATA_ENV', 'AVATA_API_BASE', 'AVATA_API_KEY', 'AVATA_API_SECRET'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    AVATA_ENV: 'stage',
    AVATA_API_BASE: 'https://stage.apis.avata.bianjie.ai',
    AVATA_API_KEY: 'bounded-test-key',
    AVATA_API_SECRET: 'bounded-test-secret'
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
    prepareRecordProofSubmission: (input) => ({
      method: 'POST',
      path: '/v3/native/record/records',
      body: { operation_id: input.operationId, hash: input.manifestHash }
    }),
    submitRecordProof: async () => ({
      status: 'confirmed',
      tx_hash: 'tx-external',
      block_height: 42,
      record_id: 'provider-record',
      certificate_url: 'https://example.test/certificate.pdf'
    }),
    queryOperation: async (operationId) => ({
      status: 'confirmed',
      operation_id: operationId,
      tx_hash: 'tx-query',
      block_height: 43,
      record_id: 'provider-query',
      certificate_url: 'https://example.test/query.pdf'
    }),
    normalizeAvataResult: (value) => value,
    ...overrides
  };
}

function preparedSubmission(adapter, overrides = {}) {
  return adapter.prepareSubmission(submission(overrides));
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
    adapter.submitRecord(preparedSubmission(adapter)),
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
  assert.deepEqual(await adapter.submitRecord(preparedSubmission(adapter)), {
    status: 'confirmed',
    operation_id: null,
    transaction_hash: 'tx-external',
    block_height: 42,
    provider_record_id: 'provider-record',
    provider_certificate_url: 'https://example.test/certificate.pdf'
  });
  assert.deepEqual(await adapter.queryRecordResult({
    operation_id: submission().operation_id
  }), {
    status: 'confirmed',
    operation_id: submission().operation_id,
    transaction_hash: 'tx-query',
    block_height: 43,
    provider_record_id: 'provider-query',
    provider_certificate_url: 'https://example.test/query.pdf'
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
    invalidCertificateAdapter.submitRecord(preparedSubmission(invalidCertificateAdapter)),
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
    conflictingOperationAdapter.submitRecord(preparedSubmission(conflictingOperationAdapter)),
    (error) => error.code === 'RECORD_PROOF_PROVIDER_RESULT_CONFLICT'
  );

  const conflictingQueryAdapter = createRecordProofExternalAdapter(
    adapterOptions({
      queryOperation: async () => ({
        status: 'submitted',
        operation_id: 'record_QR_OTHER_bbbbbbbbbbbbbbbb'
      })
    })
  );
  await assert.rejects(
    conflictingQueryAdapter.queryRecordResult({
      operation_id: submission().operation_id
    }),
    (error) => error.code === 'RECORD_PROOF_PROVIDER_RESULT_CONFLICT'
  );

  await assert.rejects(
    adapter.submitRecord(submission()),
    (error) => error.code === 'RECORD_PROOF_SUBMISSION_PREFLIGHT_REQUIRED'
  );
});

test('external adapter preflight is synchronous, serializable, and performs no submission', () => {
  let submissionCalls = 0;
  const adapter = createRecordProofExternalAdapter(adapterOptions({
    submitRecordProof: async () => {
      submissionCalls += 1;
      return { status: 'submitted' };
    }
  }));

  const prepared = adapter.prepareSubmission(submission());

  assert.equal(prepared.operation_id, submission().operation_id);
  assert.doesNotThrow(() => JSON.stringify(prepared));
  assert.equal(submissionCalls, 0);

  const asynchronousPreflight = createRecordProofExternalAdapter(adapterOptions({
    prepareRecordProofSubmission: async () => ({ prepared: true })
  }));
  assert.throws(
    () => asynchronousPreflight.prepareSubmission(submission()),
    (error) => error.code === 'RECORD_PROOF_PROVIDER_PREFLIGHT_INVALID'
  );
});

test('AVATA provider preflight performs no network work and contains no credentials', () => {
  const keys = [
    'CHAIN_ENABLED',
    'CHAIN_CALLBACK_URL',
    'AVATA_ENV',
    'AVATA_API_BASE',
    'AVATA_API_KEY',
    'AVATA_API_SECRET',
    'AVATA_IDENTITY_NAME',
    'AVATA_IDENTITY_NUM',
    'AVATA_IDENTITY_TYPE',
    'AVATA_RECORD_TYPE',
    'AVATA_HASH_TYPE'
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const previousFetch = global.fetch;
  let fetchCalls = 0;
  try {
    Object.assign(process.env, {
      CHAIN_ENABLED: 'true',
      CHAIN_CALLBACK_URL: '',
      AVATA_ENV: 'stage',
      AVATA_API_BASE: 'https://stage.apis.avata.bianjie.ai',
      AVATA_API_KEY: 'preflight-api-key',
      AVATA_API_SECRET: 'preflight-api-secret',
      AVATA_IDENTITY_NAME: 'identity-name',
      AVATA_IDENTITY_NUM: 'identity-number',
      AVATA_IDENTITY_TYPE: '1',
      AVATA_RECORD_TYPE: '1',
      AVATA_HASH_TYPE: '1'
    });
    global.fetch = async () => {
      fetchCalls += 1;
      throw new Error('preflight must not fetch');
    };

    const prepared = prepareRecordProofSubmission({
      operationId: submission().operation_id,
      manifestHash: submission().manifest_hash,
      starId: submission().record_qr_id,
      sealedAt: submission().sealed_at
    });
    const serialized = JSON.stringify(prepared);

    assert.equal(fetchCalls, 0);
    assert.equal(prepared.path, '/v3/native/record/records');
    assert.doesNotMatch(serialized, /preflight-api-key|preflight-api-secret|signature|timestamp/i);
    assert.deepEqual(verifyAvataCallback({ path: '/callback', body: {}, headers: {} }), {
      ok: false,
      reason: 'CALLBACK_DISABLED'
    });
    process.env.AVATA_API_BASE = 'https://attacker.example.test';
    assert.throws(
      () => prepareRecordProofSubmission({
        operationId: submission().operation_id,
        manifestHash: submission().manifest_hash,
        starId: submission().record_qr_id,
        sealedAt: submission().sealed_at
      }),
      (error) => error.code === 'AVATA_ENDPOINT_NOT_ALLOWED'
    );
  } finally {
    global.fetch = previousFetch;
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test('AVATA shared request bounds stalled, oversized, and malformed GET and POST bodies', {
  timeout: 8000
}, async () => {
  const provider = await startLocalProvider();
  const nativeFetch = globalThis.fetch;
  let clearedTimerCount = 0;
  const dependencies = {
    fetchImpl(url, options) {
      const requested = new URL(url);
      return nativeFetch(`${provider.baseUrl}${requested.pathname}${requested.search}`, options);
    },
    timeoutMs: 1000,
    maxResponseBytes: 64,
    clearTimer(timer) {
      clearedTimerCount += 1;
      clearTimeout(timer);
    }
  };
  try {
    await withAvataRequestEnvironment(async () => {
      await assert.rejects(
        requestAvata({ method: 'GET', path: '/stalled' }, dependencies),
        (error) => error.code === 'AVATA_REQUEST_FAILED'
          && !/bounded-test|accepted|secret/i.test(error.message)
      );
      await assert.rejects(
        requestAvata({
          method: 'POST',
          path: '/stalled',
          body: { operation_id: 'operation-bounded-timeout' }
        }, dependencies),
        (error) => error.code === 'AVATA_REQUEST_FAILED'
          && !/operation-bounded-timeout|bounded-test|accepted|secret/i.test(error.message)
      );
      assert.equal(provider.acceptedPostCount(), 1);

      await assert.rejects(
        requestAvata({ method: 'GET', path: '/oversized' }, dependencies),
        (error) => error.code === 'AVATA_RESPONSE_TOO_LARGE'
          && !error.message.includes('x'.repeat(64))
      );
      await assert.rejects(
        requestAvata({ method: 'POST', path: '/oversized', body: { value: 1 } }, dependencies),
        (error) => error.code === 'AVATA_RESPONSE_TOO_LARGE'
          && !error.message.includes('x'.repeat(64))
      );
      assert.equal(provider.acceptedPostCount(), 2);

      await assert.rejects(
        requestAvata({ method: 'GET', path: '/malformed' }, dependencies),
        (error) => error.code === 'AVATA_RESPONSE_INVALID'
          && !/provider_secret|must-not-leak/i.test(error.message)
      );
      assert.deepEqual(
        await requestAvata({ method: 'GET', path: '/ok' }, dependencies),
        { status: 'submitted' }
      );
    });
    assert.equal(clearedTimerCount, 6);
    assert.equal(PROVIDER_RESPONSE_MAX_BYTES, 1024 * 1024);
  } finally {
    await provider.close();
  }
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
