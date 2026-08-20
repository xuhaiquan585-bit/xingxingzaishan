'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  UPLOAD_PROOF_PURPOSE,
  UPLOAD_PROOF_TTL_SECONDS,
  UPLOAD_PROOF_VERSION,
  UploadProofError,
  issueRecordImageUploadProof,
  verifyRecordImageUploadProof
} = require('../src/server/services/uploadProofService');
const {
  classifyRecordImageReference,
  isLegacyPrefixedRecordImageObjectKeyForAuthority,
  isRecordImageObjectKeyForQrId,
  recordImageQrIdSha256
} = require('../src/server/services/storageService');
const { validateRuntimeConfig } = require('../src/server/services/configService');
const { buildCookieHeader } = require('../src/server/middlewares/userSession');
const {
  RecordImageUploadEligibilityError,
  resolveRecordImageUploadEligibility
} = require('../src/server/services/recordImageUploadEligibilityService');
const {
  processRecordImageUpload
} = require('../src/server/services/recordImageUploadService');

const env = {
  AUTH_SECRET: 'separate-auth-secret',
  UPLOAD_PROOF_SECRET: 'upload-proof-secret-with-32-bytes-minimum'
};

test('record image upload proof binds version, purpose, account, QR, key, and 15 minute TTL', () => {
  const now = Date.parse('2026-08-14T00:00:00.000Z');
  const objectKey = `stars/record-images/${recordImageQrIdSha256('SSS00001')}/photo.jpg`;
  const proof = issueRecordImageUploadProof({
    accountId: 'ACC000001', qrId: 'SSS00001', objectKey, now, env
  });
  const payload = verifyRecordImageUploadProof({
    proof, accountId: 'ACC000001', now: now + 899000, env
  });
  assert.equal(payload.v, UPLOAD_PROOF_VERSION);
  assert.equal(payload.purpose, UPLOAD_PROOF_PURPOSE);
  assert.equal(payload.qr_id, 'SSS00001');
  assert.equal(isRecordImageObjectKeyForQrId(payload.object_key, payload.qr_id), true);
  assert.equal(payload.exp - payload.iat, UPLOAD_PROOF_TTL_SECONDS);
  assert.equal(payload.object_key, objectKey);
});

test('record image upload proof rejects tampering, expiry, cross-account, and cross-QR reuse', () => {
  const now = Date.parse('2026-08-14T00:00:00.000Z');
  const proof = issueRecordImageUploadProof({
    accountId: 'ACC000001',
    qrId: 'SSS00001',
    objectKey: `stars/record-images/${recordImageQrIdSha256('SSS00001')}/photo.jpg`,
    now,
    env
  });
  const invalidCases = [
    { proof: `${proof.slice(0, -1)}x`, accountId: 'ACC000001', now },
    { proof, accountId: 'ACC000002', now },
    { proof, accountId: 'ACC000001', now: now + 900000, env }
  ];
  for (const input of invalidCases) {
    assert.throws(
      () => verifyRecordImageUploadProof({ env, ...input }),
      (error) => error instanceof UploadProofError && error.code === 'UPLOAD_PROOF_INVALID'
    );
  }
});

test('record image upload proof binds the server canonical QR id and rejects qr_id tampering', () => {
  const now = Date.parse('2026-08-14T00:00:00.000Z');
  const objectKey = `stars/record-images/${recordImageQrIdSha256('SSS00001')}/photo.jpg`;
  const proof = issueRecordImageUploadProof({
    accountId: 'ACC000001', qrId: 'SSS00001', objectKey, now, env
  });
  const [encodedPayload, signature] = proof.split('.');
  const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  payload.qr_id = 'SSS00002';
  const tampered = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}`;
  assert.throws(
    () => verifyRecordImageUploadProof({
      proof: tampered, accountId: 'ACC000001', now, env
    }),
    (error) => error instanceof UploadProofError && error.code === 'UPLOAD_PROOF_INVALID'
  );
});

test('scope-all upload eligibility never reads JSON and authority failures stay unavailable', async () => {
  let jsonReads = 0;
  const canonical = await resolveRecordImageUploadEligibility({
    accessToken: 'exact-token', accountId: 'ACC000001'
  }, {
    authorityAuthorizer: async () => ({ selected: true, qr: { id: 'SSS00001' } }),
    jsonEligibilityFinder: () => { jsonReads += 1; return { id: 'JSON_QR' }; }
  });
  assert.deepEqual(canonical, { id: 'SSS00001' });
  assert.equal(jsonReads, 0);

  const unavailable = Object.assign(new Error('unavailable'), {
    code: 'QR_LIFECYCLE_POSTGRES_WRITE_OPERATION_FAILED'
  });
  await assert.rejects(
    resolveRecordImageUploadEligibility({
      accessToken: 'exact-token', accountId: 'ACC000001'
    }, {
      authorityAuthorizer: async () => { throw unavailable; },
      jsonEligibilityFinder: () => { jsonReads += 1; return { id: 'JSON_QR' }; }
    }),
    (error) => error === unavailable
  );
  assert.equal(jsonReads, 0);
});

test('ineligible QR input stops before normalization, storage, and proof issuance', async () => {
  const calls = { normalize: 0, save: 0, proof: 0 };
  await assert.rejects(
    processRecordImageUpload({
      file: { buffer: Buffer.from('image') },
      accessToken: 'invalid',
      accountId: 'ACC000001',
      maxOutputWidth: 1080,
      jpegQuality: 80
    }, {
      eligibilityResolver: async () => { throw new RecordImageUploadEligibilityError(); },
      imageNormalizer: async () => { calls.normalize += 1; },
      imageSaver: async () => { calls.save += 1; },
      proofIssuer: () => { calls.proof += 1; }
    }),
    (error) => error.code === 'UPLOAD_QR_NOT_ELIGIBLE'
  );
  assert.deepEqual(calls, { normalize: 0, save: 0, proof: 0 });
});

test('record image upload derives storage and proof identity from canonical QR id', async () => {
  const calls = [];
  const result = await processRecordImageUpload({
    file: { buffer: Buffer.from('image') },
    accessToken: 'client-token',
    accountId: 'ACC000001',
    maxOutputWidth: 1080,
    jpegQuality: 80
  }, {
    eligibilityResolver: async () => ({ id: 'SSS_CANONICAL' }),
    imageNormalizer: async (file) => ({ ...file, mimetype: 'image/jpeg' }),
    imageSaver: async ({ qrId }) => {
      calls.push(['save', qrId]);
      return { object_key: 'stars/record-images/hash/photo.jpg' };
    },
    proofIssuer: ({ qrId, objectKey }) => {
      calls.push(['proof', qrId, objectKey]);
      return 'proof';
    }
  });
  assert.equal(result.canonicalQr.id, 'SSS_CANONICAL');
  assert.deepEqual(calls, [
    ['save', 'SSS_CANONICAL'],
    ['proof', 'SSS_CANONICAL', 'stars/record-images/hash/photo.jpg']
  ]);
});

test('record image upload proof requires a dedicated strong secret', () => {
  for (const invalidEnv of [
    { AUTH_SECRET: 'auth', UPLOAD_PROOF_SECRET: '' },
    { AUTH_SECRET: 'same-secret-value-with-enough-length', UPLOAD_PROOF_SECRET: 'same-secret-value-with-enough-length' }
  ]) {
    assert.throws(
      () => issueRecordImageUploadProof({
        accountId: 'ACC', qrId: 'SSS00001', objectKey: 'records/photo.jpg', env: invalidEnv
      }),
      { code: 'UPLOAD_PROOF_INVALID' }
    );
  }
});

test('record image resolver accepts only QR-bound current and historical media references', () => {
  const authority = {
    qrId: 'SSS00001',
    accessToken: '0123456789abcdef0123456789abcdef'
  };
  const hash = recordImageQrIdSha256('SSS00001');
  const currentKey = `stars/record-images/${hash}/photo.jpg`;
  assert.deepEqual(
    classifyRecordImageReference({ record: { image_object_key: currentKey }, authority }),
    { kind: 'object', objectKey: currentKey, namespace: 'current' }
  );
  assert.equal(
    isRecordImageObjectKeyForQrId(currentKey, 'SSS00001'),
    true
  );
  assert.equal(
    isRecordImageObjectKeyForQrId(`stars/record-images/${hash}/photo.jpg`, 'SSS00002'),
    false
  );
  for (const extension of ['jpg', 'png']) {
    const legacyKey = `stars/${authority.accessToken}/historical.${extension}`;
    assert.equal(
      isLegacyPrefixedRecordImageObjectKeyForAuthority(legacyKey, authority),
      true
    );
  }
  const legacyKey = `stars/${authority.accessToken}/historical.png`;
  assert.equal(
    isLegacyPrefixedRecordImageObjectKeyForAuthority(legacyKey, {
      ...authority,
      accessToken: 'SSS00001'
    }),
    false
  );
  assert.deepEqual(
    classifyRecordImageReference({
      record: {
        image_object_key: 'historical.jpg',
        image_url_snapshot: '/uploads/historical.jpg'
      },
      authority
    }),
    { kind: 'local', url: '/uploads/historical.jpg', namespace: 'legacy-single-file' }
  );
  for (const key of [
    'backups/xingxingzaishan/production/db.dump',
    'stars/backup/photo.jpg',
    'stars/backups/photo.jpg',
    'stars/admin/photo.jpg',
    'stars/proofs/photo.jpg',
    'stars/proof/photo.jpg',
    'stars/admin-private/photo.jpg',
    'stars/private/photo.jpg',
    'stars/manifest/photo.jpg',
    'stars/manifests/photo.jpg',
    'stars/archive/photo.jpg',
    'stars/archives/photo.jpg',
    'stars/BACKUPS/photo.jpg',
    'stars/SSS00001/photo.jpg',
    'stars/random/photo.jpg',
    'records/historical.jpg',
    'records/QR1/photo.jpg',
    'records/QR1/manifest.json',
    'stars/record-images/../../backup.dump',
    'stars/record-images/%2e%2e/backup.dump',
    'stars/record-images/%252e%252e/backup.dump',
    'stars\\record-images\\photo.jpg',
    'https://example.com/stars/record-images/photo.jpg',
    '//example.com/photo.jpg',
    'untrusted/photo.jpg',
    `stars/${authority.accessToken}/photo.JPG`,
    'historical.png'
  ]) {
    assert.deepEqual(
      classifyRecordImageReference({
        record: { image_object_key: key, image_url_snapshot: '/uploads/historical.jpg' },
        authority
      }),
      { kind: 'rejected' },
      key
    );
  }

  for (const record of [
    { image_object_key: 'historical.jpg' },
    { image_object_key: 'historical.jpg', image_url: '/uploads/other.jpg' },
    { image_object_key: 'historical.jpg', image_url: 'https://example.com/historical.jpg' },
    { image_object_key: 'historical.jpg', image_url: '//example.com/historical.jpg' },
    { image_object_key: 'historical.jpg', image_url: '/uploads/a/historical.jpg' },
    { image_object_key: 'historical.jpg', image_url: '/uploads/../historical.jpg' },
    { image_object_key: 'historical.jpg', image_url: '/uploads/%2e%2e/historical.jpg' },
    { image_object_key: 'nested/historical.jpg', image_url: '/uploads/historical.jpg' },
    { image_object_key: 'historical.JPG', image_url: '/uploads/historical.JPG' }
  ]) {
    assert.deepEqual(classifyRecordImageReference({ record, authority }), { kind: 'rejected' });
  }
});

test('production runtime config fails closed for environment, legacy login, SMS, cookie, and proof secret', () => {
  const original = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.NODE_ENV = 'production';
    process.env.AUTH_SECRET = 'production-auth-secret-value-123456';
    process.env.UPLOAD_PROOF_SECRET = 'production-upload-proof-secret-value';
    process.env.SMS_PROVIDER = 'mock';
    process.env.USER_LEGACY_LOGIN_ENABLED = 'true';
    process.env.USER_SESSION_SECURE = 'false';
    process.env.WECHAT_MINIAPP_APPID = 'present';
    process.env.WECHAT_MINIAPP_SECRET = 'present';
    const result = validateRuntimeConfig();
    assert.equal(result.errors.some((item) => item.includes('SMS_PROVIDER must be aliyun')), true);
    assert.equal(result.errors.some((item) => item.includes('USER_LEGACY_LOGIN_ENABLED')), true);
    assert.equal(result.errors.some((item) => item.includes('USER_SESSION_SECURE')), true);
    assert.match(buildCookieHeader('value', 60), /; Secure(?:;|$)/);

    process.env.NODE_ENV = '';
    assert.equal(
      validateRuntimeConfig().errors.some((item) => item.includes('NODE_ENV must be explicitly set')),
      true
    );
    process.env.NODE_ENV = 'test';
    process.env.UPLOAD_PROOF_SECRET = process.env.AUTH_SECRET;
    assert.equal(
      validateRuntimeConfig().errors.some((item) => item.includes('must not reuse AUTH_SECRET')),
      true
    );
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, original);
  }
});
