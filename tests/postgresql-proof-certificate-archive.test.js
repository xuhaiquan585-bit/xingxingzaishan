'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  JOB_TYPE,
  MAX_CERTIFICATE_BYTES,
  certificateObjectKey,
  createRecordProofCertificateArchiveHandler,
  enqueueCertificateArchiveJob,
  validatedCertificateUrl
} = require('../src/server/services/postgres/recordProofCertificateArchive');

const RECORD_QR_ID = 'QR_PRIVATE_ARCHIVE_TEST';
const PROOF_ID = 'proof-archive-test';
const CERTIFICATE_URL = 'https://cert.example.test/proofs/certificate.pdf';

function archiveJob() {
  return {
    job_type: JOB_TYPE,
    aggregate_type: 'record',
    aggregate_id: RECORD_QR_ID,
    payload: { proof_id: PROOF_ID }
  };
}

function response({
  status = 200,
  contentType = 'application/pdf',
  contentLength,
  omitContentLength = false,
  chunks,
  body = Buffer.from('%PDF-1.7\nfixture\n%%EOF', 'ascii')
} = {}) {
  const bodyChunks = chunks || [body];
  let cancelled = false;
  return {
    status,
    get cancelled() { return cancelled; },
    headers: {
      get(name) {
        if (String(name).toLowerCase() === 'content-type') return contentType;
        if (String(name).toLowerCase() === 'content-length') {
          if (omitContentLength) return null;
          return contentLength === undefined ? String(body.length) : String(contentLength);
        }
        return null;
      }
    },
    body: {
      async *[Symbol.asyncIterator]() {
        try {
          for (const chunk of bodyChunks) yield chunk;
        } finally {
          cancelled = true;
        }
      }
    }
  };
}

function harness({ fetchImpl } = {}) {
  const state = {
    proof: {
      id: PROOF_ID,
      record_qr_id: RECORD_QR_ID,
      status: 'confirmed',
      provider_certificate_url: CERTIFICATE_URL,
      certificate_object_key: null
    },
    fetches: [],
    saves: [],
    transactions: []
  };
  const proofs = {
    async findById(id) {
      return id === state.proof.id ? { ...state.proof } : null;
    },
    async findForUpdate(id) {
      return id === state.proof.id ? { ...state.proof } : null;
    },
    async markCertificateArchived(input) {
      state.proof = {
        ...state.proof,
        certificate_object_key: input.certificate_object_key,
        certificate_object_url_snapshot: input.certificate_object_url_snapshot,
        updated_at: input.updated_at
      };
      return { ...state.proof };
    }
  };
  const handler = createRecordProofCertificateArchiveHandler({
    pool: { connect() {} },
    allowedHosts: ['cert.example.test'],
    objectPrefix: 'xingxing',
    fetchImpl: fetchImpl || (async (url, options) => {
      state.fetches.push({ url, options });
      return response();
    }),
    async saveObject(input) {
      state.saves.push(input);
      return { object_key: input.objectKey };
    },
    repositoryTypes: {
      ProofRepository: class { constructor() { return proofs; } }
    },
    async transactionRunner(_pool, callback, options) {
      state.transactions.push(options);
      return callback({ query() {} });
    },
    clock: () => new Date('2026-08-25T00:00:00.000Z')
  });
  return { handler, state };
}

test('certificate URL validation uses an exact HTTPS host allowlist', () => {
  const hosts = new Set(['cert.example.test']);
  assert.equal(validatedCertificateUrl(CERTIFICATE_URL, hosts), CERTIFICATE_URL);
  for (const value of [
    'http://cert.example.test/proof.pdf',
    'https://cert.example.test.evil.test/proof.pdf',
    'https://sub.cert.example.test/proof.pdf',
    'https://user:pass@cert.example.test/proof.pdf',
    'https://cert.example.test:444/proof.pdf',
    'https://127.0.0.1/proof.pdf',
    'https://localhost/proof.pdf',
    'https://cert.example.test/proof.pdf#fragment'
  ]) {
    assert.throws(
      () => validatedCertificateUrl(value, hosts),
      (error) => error.code === 'RECORD_PROOF_CERTIFICATE_URL_REJECTED'
    );
  }
});

test('certificate archive stores one deterministic PDF without cloud fallback', async () => {
  const { handler, state } = harness();
  const first = await handler(archiveJob());
  assert.equal(state.fetches.length, 1);
  assert.equal(state.fetches[0].options.redirect, 'error');
  assert.equal(state.fetches[0].options.headers.Accept.includes('application/pdf'), true);
  assert.equal(Boolean(state.fetches[0].options.headers['User-Agent']), true);
  assert.equal(state.saves.length, 1);
  assert.equal(state.saves[0].allowCloudFallback, false);
  assert.equal(state.saves[0].contentType, 'application/pdf');
  assert.equal(state.saves[0].objectKey, first.certificate_object_key);
  assert.equal(state.saves[0].objectKey.includes(RECORD_QR_ID), false);
  assert.match(
    state.saves[0].objectKey,
    /^xingxing\/proof-certificates\/[a-f0-9]{64}\/[a-f0-9]{64}\.pdf$/
  );
  assert.deepEqual(state.transactions, [
    { isolationLevel: 'read committed', readOnly: true },
    { isolationLevel: 'read committed' }
  ]);

  const second = await handler(archiveJob());
  assert.equal(second.certificate_object_key, first.certificate_object_key);
  assert.equal(state.fetches.length, 1);
  assert.equal(state.saves.length, 1);
});

test('certificate archive rejects oversized and non-PDF responses before storage', async () => {
  let selectedResponse = response({ contentLength: MAX_CERTIFICATE_BYTES + 1 });
  const { handler, state } = harness({ fetchImpl: async () => selectedResponse });
  await assert.rejects(
    handler(archiveJob()),
    (error) => error.code === 'RECORD_PROOF_CERTIFICATE_RESPONSE_INVALID'
  );
  assert.equal(state.saves.length, 0);

  selectedResponse = response({
    omitContentLength: true,
    chunks: [
      Buffer.from('%PDF-', 'ascii'),
      Buffer.alloc(MAX_CERTIFICATE_BYTES, 0x20)
    ]
  });
  await assert.rejects(
    handler(archiveJob()),
    (error) => error.code === 'RECORD_PROOF_CERTIFICATE_RESPONSE_INVALID'
  );
  assert.equal(selectedResponse.cancelled, true);
  assert.equal(state.saves.length, 0);

  selectedResponse = response({
    contentType: 'text/html',
    body: Buffer.from('<html>not a certificate</html>', 'utf8')
  });
  await assert.rejects(
    handler(archiveJob()),
    (error) => error.code === 'RECORD_PROOF_CERTIFICATE_RESPONSE_INVALID'
  );
  assert.equal(state.saves.length, 0);
});

test('certificate archive rejects an untrusted proof URL before network or storage', async () => {
  const { handler, state } = harness();
  state.proof.provider_certificate_url = 'https://cert.example.test.evil.test/proof.pdf';
  await assert.rejects(
    handler(archiveJob()),
    (error) => error.code === 'RECORD_PROOF_CERTIFICATE_URL_REJECTED'
  );
  assert.equal(state.fetches.length, 0);
  assert.equal(state.saves.length, 0);
});

test('certificate archive outbox enqueue and object key are deterministic and idempotent', async () => {
  const jobs = [];
  const proof = {
    id: PROOF_ID,
    record_qr_id: RECORD_QR_ID,
    status: 'confirmed',
    provider_certificate_url: CERTIFICATE_URL,
    certificate_object_key: null
  };
  const outboxRepository = {
    async insertPendingOnce(input) {
      if (jobs.some((item) => item.idempotency_key === input.idempotency_key)) return null;
      jobs.push(input);
      return input;
    }
  };
  await enqueueCertificateArchiveJob({
    outboxRepository,
    proof,
    now: '2026-08-25T00:00:00.000Z',
    randomUUID: () => 'archive-job-id'
  });
  await enqueueCertificateArchiveJob({
    outboxRepository,
    proof,
    now: '2026-08-25T00:00:00.000Z',
    randomUUID: () => 'archive-job-id-duplicate'
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].idempotency_key, `record-proof-certificate:${PROOF_ID}`);

  const pdf = Buffer.from('%PDF-1.7\nfixture\n%%EOF', 'ascii');
  const key = certificateObjectKey({ prefix: 'xingxing', recordQrId: RECORD_QR_ID, buffer: pdf });
  const expectedRecordHash = crypto.createHash('sha256').update(RECORD_QR_ID).digest('hex');
  const expectedContentHash = crypto.createHash('sha256').update(pdf).digest('hex');
  assert.equal(key, `xingxing/proof-certificates/${expectedRecordHash}/${expectedContentHash}.pdf`);
});
