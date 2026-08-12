'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const test = require('node:test');

const {
  closePostgresPool,
  createPostgresPool
} = require('../src/server/database/connection');
const { readPostgresConfig } = require('../src/server/database/config');
const { createApp } = require('../src/server/app');
const { generateToken } = require('../src/server/services/authService');
const {
  generateMiniappToken
} = require('../src/server/services/miniappAuthService');
const {
  closeIdentityAuthorityRuntime
} = require('../src/server/services/postgres/identityAuthorityRuntime');
const {
  closePersonalRecordPrimaryReadRuntime
} = require('../src/server/services/postgres/personalRecordPrimaryReadRuntime');
const {
  closePublicQrPrimaryReadRuntime
} = require('../src/server/services/postgres/publicQrPrimaryReadRuntime');
const {
  closeQrIssuanceAuthorityRuntime
} = require('../src/server/services/postgres/qrIssuanceAuthorityRuntime');
const {
  closeQrLifecycleWriteRuntime
} = require('../src/server/services/postgres/qrLifecycleWriteRuntime');
const { sha256 } = require('../scripts/database/importer/reader');

const RUN_E2E =
  process.env.RUN_CLEAN_POSTGRES_CANDIDATE_E2E === 'true';
const EXPECTED_SOURCE_SHA256 =
  process.env.CLEAN_CANDIDATE_EXPECTED_SOURCE_SHA256 || '';
const EXPECTED_PLAN_SHA256 =
  process.env.CLEAN_CANDIDATE_EXPECTED_PLAN_SHA256 || '';
const EXPECTED_DOMAIN_SHA256 =
  process.env.CLEAN_CANDIDATE_EXPECTED_DOMAIN_SHA256 || '';
const TEST_PREFIX = 'PGE2E';
const TEST_QR_ID = `${TEST_PREFIX}00001`;
const TEST_PHONE = '13900000992';
const TEST_OPENID = 'mock-openid-clean-candidate-e2e';
const TEST_CONTENT = 'Clean PostgreSQL candidate end-to-end record';

function request({ port, method, requestPath, body = null, headers = {} }) {
  const payload = body === null ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      method,
      headers: {
        ...headers,
        ...(payload ? {
          'Content-Type': 'application/json',
          'Content-Length': payload.length
        } : {})
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const contentType = String(res.headers['content-type'] || '');
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: contentType.includes('application/json') && buffer.length > 0
            ? JSON.parse(buffer.toString('utf8'))
            : buffer
        });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function closeApplicationRuntimes() {
  await Promise.all([
    closePublicQrPrimaryReadRuntime(),
    closeQrLifecycleWriteRuntime(),
    closePersonalRecordPrimaryReadRuntime(),
    closeIdentityAuthorityRuntime(),
    closeQrIssuanceAuthorityRuntime()
  ]);
}

async function loadExistingFixture(pool, qrId = null) {
  const result = await pool.query(
    `SELECT
       qr.id,
       qr.access_token AS qr_access_token,
       qr.issue_status,
       qr.lifecycle_status,
       record.account_id,
       record.content,
       record.image_object_key,
       record.sealed_at::text,
       phone_identity.id AS phone_identity_id,
       phone_identity.phone,
       mini_identity.id AS mini_identity_id,
       mini_identity.openid,
       mini_identity.phone AS mini_identity_phone
     FROM app.qr_codes qr
     JOIN app.records record ON record.qr_id = qr.id
     JOIN LATERAL (
       SELECT id, phone
       FROM app.users
       WHERE account_id = record.account_id
         AND phone IS NOT NULL AND phone <> ''
       ORDER BY id
       LIMIT 1
     ) phone_identity ON true
     JOIN LATERAL (
       SELECT id, openid, phone
       FROM app.users
       WHERE account_id = record.account_id
         AND openid IS NOT NULL AND openid <> ''
         AND phone IS NOT NULL AND phone <> ''
       ORDER BY id
       LIMIT 1
     ) mini_identity ON true
     WHERE qr.issue_status = 'issued'
       AND qr.lifecycle_status = 'activated'
       AND ($1::text IS NULL OR qr.id = $1)
     ORDER BY qr.id
     LIMIT 1`,
    [qrId]
  );
  return result.rows[0] || null;
}

function contentFingerprint(value) {
  return sha256(String(value || ''));
}

test('clean candidate supports one PostgreSQL-only QR end-to-end', {
  skip: RUN_E2E
    ? false
    : 'Set RUN_CLEAN_POSTGRES_CANDIDATE_E2E=true with the disposable clone.'
}, async () => {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.match(String(process.env.PGDATABASE || ''), /_test$/);
  assert.equal(Boolean(process.env.DATABASE_URL), false);
  assert.match(EXPECTED_SOURCE_SHA256, /^[0-9a-f]{64}$/);
  assert.match(EXPECTED_PLAN_SHA256, /^[0-9a-f]{64}$/);
  assert.match(EXPECTED_DOMAIN_SHA256, /^[0-9a-f]{64}$/);
  assert.equal(process.env.PUBLIC_QR_POSTGRES_READ_SCOPE, 'all');
  assert.equal(process.env.QR_LIFECYCLE_POSTGRES_WRITE_SCOPE, 'all');
  assert.equal(process.env.PERSONAL_RECORD_POSTGRES_READ_SCOPE, 'all');
  assert.equal(process.env.IDENTITY_POSTGRES_AUTHORITY_SCOPE, 'all');
  assert.equal(process.env.QR_ISSUANCE_POSTGRES_AUTHORITY_SCOPE, 'all');
  assert.equal(process.env.RECORD_PROOF_RUNTIME_ENABLED, 'false');
  assert.equal(Boolean(process.env.RECORD_PROOF_RUNTIME_SCOPE), false);
  assert.equal(Boolean(process.env.RECORD_PROOF_WORKER_ID), false);
  assert.equal(Boolean(process.env.AVATA_API_KEY), false);
  assert.equal(Boolean(process.env.AVATA_API_SECRET), false);

  const sourceHashBefore = sha256(fs.readFileSync(process.env.DB_FILE));
  assert.equal(sourceHashBefore, EXPECTED_SOURCE_SHA256);

  const pool = createPostgresPool({ config: readPostgresConfig(process.env) });
  const originalFetch = global.fetch;
  let externalFetchCalls = 0;
  let server = null;
  let port = null;

  global.fetch = async () => {
    externalFetchCalls += 1;
    throw new Error('EXTERNAL_FETCH_FORBIDDEN_IN_CANDIDATE_E2E');
  };

  try {
    const baseline = await pool.query(
      `SELECT
         (SELECT count(*)::integer FROM app.qr_codes) AS qr_count,
         (SELECT count(*)::integer FROM app.records) AS record_count,
         (SELECT count(*)::integer FROM app.outbox_jobs) AS outbox_count,
         (SELECT count(*)::integer FROM app.import_runs
          WHERE status = 'passed') AS passed_import_count,
         (SELECT checksum_summary->>'source_sha256'
          FROM app.import_runs WHERE status = 'passed'
          ORDER BY completed_at DESC LIMIT 1) AS source_sha256,
         (SELECT checksum_summary->>'plan_sha256'
          FROM app.import_runs WHERE status = 'passed'
          ORDER BY completed_at DESC LIMIT 1) AS plan_sha256,
         (SELECT checksum_summary->>'public_qr_v1_sha256'
          FROM app.import_runs WHERE status = 'passed'
          ORDER BY completed_at DESC LIMIT 1) AS domain_sha256,
         (SELECT count(*)::integer FROM app.qr_codes
          WHERE id LIKE $1) AS test_prefix_count,
         (SELECT count(*)::integer FROM app.users
          WHERE phone = $2 OR openid = $3) AS test_identity_count`,
      [`${TEST_PREFIX}%`, TEST_PHONE, TEST_OPENID]
    );
    assert.deepEqual(baseline.rows, [{
      qr_count: 103,
      record_count: 55,
      outbox_count: 0,
      passed_import_count: 1,
      source_sha256: EXPECTED_SOURCE_SHA256,
      plan_sha256: EXPECTED_PLAN_SHA256,
      domain_sha256: EXPECTED_DOMAIN_SHA256,
      test_prefix_count: 0,
      test_identity_count: 0
    }]);
    const existingFixture = await loadExistingFixture(pool);
    assert.ok(existingFixture);
    assert.match(existingFixture.id, /^[A-Z0-9]+$/);
    assert.match(existingFixture.account_id, /^ACC\d{6}$/);
    assert.equal(String(existingFixture.qr_access_token || '').length, 32);
    const existingFixtureFingerprint = sha256(JSON.stringify(existingFixture));

    ({ server, port } = await startServer(createApp()));
    const adminToken = generateToken({
      id: 1,
      username: 'clean-candidate-e2e-admin',
      role: 'admin',
      name: 'Clean candidate E2E admin'
    });

    const existingH5Login = await request({
      port,
      method: 'POST',
      requestPath: '/api/user/login',
      body: { phone: existingFixture.phone }
    });
    assert.equal(existingH5Login.status, 200);
    const existingH5Cookie = String(
      existingH5Login.headers['set-cookie'][0] || ''
    ).split(';')[0];
    assert.match(existingH5Cookie, /^user_session_id=/);
    const existingMiniappToken = generateMiniappToken({
      id: existingFixture.mini_identity_id,
      openid: existingFixture.openid,
      account_id: existingFixture.account_id,
      phone: existingFixture.mini_identity_phone
    });

    for (const requestPath of [
      `/api/qr/${existingFixture.qr_access_token}`,
      `/api/miniapp/qr/${existingFixture.qr_access_token}`
    ]) {
      const response = await request({ port, method: 'GET', requestPath });
      assert.equal(response.status, 200);
      assert.equal(response.body.data.id, existingFixture.id);
      assert.equal(
        contentFingerprint(response.body.data.content),
        contentFingerprint(existingFixture.content)
      );
    }

    const existingPersonalCases = [
      {
        path: '/api/user/records',
        headers: { Cookie: existingH5Cookie },
        detail: false
      },
      {
        path: `/api/user/records/${existingFixture.id}`,
        headers: { Cookie: existingH5Cookie },
        detail: true
      },
      {
        path: '/api/miniapp/user/records',
        headers: { Authorization: `Bearer ${existingMiniappToken}` },
        detail: false
      },
      {
        path: `/api/miniapp/user/records/${existingFixture.id}`,
        headers: { Authorization: `Bearer ${existingMiniappToken}` },
        detail: true
      }
    ];
    for (const current of existingPersonalCases) {
      const response = await request({
        port,
        method: 'GET',
        requestPath: current.path,
        headers: current.headers
      });
      assert.equal(response.status, 200);
      const record = current.detail
        ? response.body.data
        : response.body.data.records.find(
          (item) => item.id === existingFixture.id
        );
      assert.ok(record);
      assert.equal(record.id, existingFixture.id);
      assert.equal(
        contentFingerprint(record.content),
        contentFingerprint(existingFixture.content)
      );
    }
    console.log('CLEAN_CANDIDATE_EXISTING_H5_ROUTES=PASS');
    console.log('CLEAN_CANDIDATE_EXISTING_MINIAPP_ROUTES=PASS');
    console.log('CLEAN_CANDIDATE_COORDINATED_PREWRITE=PASS');

    const issuance = await request({
      port,
      method: 'POST',
      requestPath: '/api/admin/qr/generate',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { prefix: TEST_PREFIX, count: 1 }
    });
    assert.equal(issuance.status, 200);
    const issued = issuance.body.data.records[0];
    assert.equal(issued.id, TEST_QR_ID);
    assert.equal(issued.issue_status, 'issued');
    assert.equal(issued.activation_status, 'unactivated');
    assert.match(issued.qr_access_token, /^[0-9a-f]{32}$/);

    const image = await request({
      port,
      method: 'GET',
      requestPath: `/api/qr/image/${issued.qr_access_token}`
    });
    assert.equal(image.status, 200);
    assert.match(String(image.headers['content-type']), /^image\/png/);
    assert.ok(image.body.length > 0);

    const h5Login = await request({
      port,
      method: 'POST',
      requestPath: '/api/user/login',
      body: { phone: TEST_PHONE }
    });
    assert.equal(h5Login.status, 200);
    const h5Cookie = String(h5Login.headers['set-cookie'][0] || '').split(';')[0];
    assert.match(h5Cookie, /^user_session_id=/);

    const miniappLogin = await request({
      port,
      method: 'POST',
      requestPath: '/api/miniapp/auth/login',
      body: { code: 'clean-candidate-e2e' }
    });
    assert.equal(miniappLogin.status, 200);
    const temporaryToken = miniappLogin.body.data.token;
    const miniappBind = await request({
      port,
      method: 'POST',
      requestPath: '/api/miniapp/auth/bind-phone',
      headers: { Authorization: `Bearer ${temporaryToken}` },
      body: { code: TEST_PHONE }
    });
    assert.equal(miniappBind.status, 200);
    const miniappToken = miniappBind.body.data.token;

    const save = await request({
      port,
      method: 'POST',
      requestPath: `/api/qr/${issued.qr_access_token}/record`,
      headers: { Cookie: h5Cookie },
      body: {
        content: TEST_CONTENT,
        image_object_key: 'records/clean-candidate-e2e.jpg'
      }
    });
    assert.equal(save.status, 200);
    assert.equal(save.body.data.id, TEST_QR_ID);
    assert.equal(save.body.data.activation_status, 'activated');
    assert.equal(save.body.data.content, TEST_CONTENT);

    for (const requestPath of [
      `/api/qr/${issued.qr_access_token}`,
      `/api/miniapp/qr/${issued.qr_access_token}`
    ]) {
      const response = await request({ port, method: 'GET', requestPath });
      assert.equal(response.status, 200);
      assert.equal(response.body.data.id, TEST_QR_ID);
      assert.equal(response.body.data.content, TEST_CONTENT);
    }

    const personalCases = [
      { path: '/api/user/records', headers: { Cookie: h5Cookie }, detail: false },
      {
        path: `/api/user/records/${TEST_QR_ID}`,
        headers: { Cookie: h5Cookie },
        detail: true
      },
      {
        path: '/api/miniapp/user/records',
        headers: { Authorization: `Bearer ${miniappToken}` },
        detail: false
      },
      {
        path: `/api/miniapp/user/records/${TEST_QR_ID}`,
        headers: { Authorization: `Bearer ${miniappToken}` },
        detail: true
      }
    ];
    for (const current of personalCases) {
      const response = await request({
        port,
        method: 'GET',
        requestPath: current.path,
        headers: current.headers
      });
      assert.equal(response.status, 200);
      const record = current.detail
        ? response.body.data
        : response.body.data.records.find((item) => item.id === TEST_QR_ID);
      assert.ok(record);
      assert.equal(record.id, TEST_QR_ID);
      assert.equal(record.content, TEST_CONTENT);
    }

    const durableProofWork = await pool.query(
      `SELECT
         (SELECT lifecycle_status FROM app.qr_codes
          WHERE id = $1) AS lifecycle_status,
         (SELECT account_id FROM app.records
          WHERE qr_id = $1) AS owner_account_id,
         (SELECT count(*)::integer FROM app.record_proofs
          WHERE record_qr_id = $1) AS proof_count,
         (SELECT count(*)::integer FROM app.proof_attempts attempt
          JOIN app.record_proofs proof ON proof.id = attempt.proof_id
          WHERE proof.record_qr_id = $1) AS proof_attempt_count,
         (SELECT job_type FROM app.outbox_jobs
          WHERE aggregate_id = $1) AS outbox_job_type,
         (SELECT status FROM app.outbox_jobs
          WHERE aggregate_id = $1) AS outbox_status,
         (SELECT attempt_count FROM app.outbox_jobs
          WHERE aggregate_id = $1) AS outbox_attempt_count,
         (SELECT locked_at IS NULL AND locked_by IS NULL
          FROM app.outbox_jobs
          WHERE aggregate_id = $1) AS outbox_unlocked,
         (SELECT identity.openid
          FROM app.users identity
          JOIN app.records record ON record.account_id = identity.account_id
          WHERE record.qr_id = $1 AND identity.openid IS NOT NULL) AS openid`,
      [TEST_QR_ID]
    );
    assert.deepEqual(durableProofWork.rows, [{
      lifecycle_status: 'activated',
      owner_account_id: durableProofWork.rows[0].owner_account_id,
      proof_count: 0,
      proof_attempt_count: 0,
      outbox_job_type: 'record_proof_prepare_submit',
      outbox_status: 'pending',
      outbox_attempt_count: 0,
      outbox_unlocked: true,
      openid: TEST_OPENID
    }]);
    assert.match(durableProofWork.rows[0].owner_account_id, /^ACC\d{6}$/);

    const finalState = await pool.query(
      `SELECT
         (SELECT count(*)::integer FROM app.qr_codes) AS qr_count,
         (SELECT count(*)::integer FROM app.records) AS record_count,
         (SELECT count(*)::integer FROM app.record_proofs
          WHERE record_qr_id = $1) AS proof_count,
         (SELECT status FROM app.outbox_jobs
          WHERE aggregate_id = $1) AS outbox_status,
         (SELECT count(*)::integer FROM app.proof_attempts attempt
          JOIN app.record_proofs proof ON proof.id = attempt.proof_id
          WHERE proof.record_qr_id = $1) AS proof_attempt_count`,
      [TEST_QR_ID]
    );
    assert.deepEqual(finalState.rows, [{
      qr_count: 104,
      record_count: 56,
      proof_count: 0,
      outbox_status: 'pending',
      proof_attempt_count: 0
    }]);
    const existingFixtureAfter = await loadExistingFixture(
      pool,
      existingFixture.id
    );
    assert.ok(existingFixtureAfter);
    assert.equal(
      sha256(JSON.stringify(existingFixtureAfter)),
      existingFixtureFingerprint
    );
    assert.equal(sha256(fs.readFileSync(process.env.DB_FILE)), sourceHashBefore);
    assert.equal(externalFetchCalls, 0);

    console.log('CLEAN_CANDIDATE_EXISTING_DATA_UNCHANGED=PASS');
    console.log('CLEAN_CANDIDATE_POSTGRES_ONLY_QR_ISSUANCE=PASS');
    console.log('CLEAN_CANDIDATE_POSTGRES_ONLY_IDENTITY=PASS');
    console.log('CLEAN_CANDIDATE_POSTGRES_ONLY_LIFECYCLE=PASS');
    console.log('CLEAN_CANDIDATE_POSTGRES_ONLY_PUBLIC_READ=PASS');
    console.log('CLEAN_CANDIDATE_POSTGRES_ONLY_PERSONAL_READ=PASS');
    console.log('CLEAN_CANDIDATE_POSTGRES_ONLY_PROOF_OUTBOX=PASS');
    console.log('CLEAN_CANDIDATE_PROOF_WORKER_RUNTIME=DISABLED');
    console.log('CLEAN_CANDIDATE_EXTERNAL_FETCH_CALLS=0');
    console.log('CLEAN_CANDIDATE_COORDINATED_JOINT_REHEARSAL=PASS');
  } finally {
    global.fetch = originalFetch;
    if (server) await stopServer(server);
    await closeApplicationRuntimes();
    await closePostgresPool(pool);
  }
});
