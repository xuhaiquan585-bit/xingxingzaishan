'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('local formal artifacts stay outside public uploads and require the private reader', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'print-artifact-storage-'));
  const source = path.join(root, 'source.zip');
  const body = Buffer.from('immutable-production-artifact');
  await fs.writeFile(source, body);

  const previousRoot = process.env.STORAGE_ROOT;
  const previousMode = process.env.STORAGE_MODE;
  process.env.STORAGE_ROOT = root;
  process.env.STORAGE_MODE = 'local';
  const modulePath = require.resolve('../src/server/services/storageService');
  delete require.cache[modulePath];
  const storage = require(modulePath);

  try {
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    const objectKey = 'printing/production/task-1/artifact.zip';
    const stored = await storage.saveProtectedArtifactFile({
      objectKey,
      localPath: source,
      contentType: 'application/zip',
      sha256,
      size: body.length
    });
    assert.equal(stored.object_key, objectKey);

    await assert.rejects(
      fs.stat(path.join(root, 'public', 'uploads', ...objectKey.split('/'))),
      { code: 'ENOENT' }
    );
    const privatePath = path.join(root, 'private', 'objects', ...objectKey.split('/'));
    const privateStats = await fs.stat(privatePath);
    assert.equal(privateStats.size, body.length);

    const opened = await storage.openPrivateObjectStream(objectKey);
    const chunks = [];
    for await (const chunk of opened.stream) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), body);
  } finally {
    if (previousRoot === undefined) delete process.env.STORAGE_ROOT;
    else process.env.STORAGE_ROOT = previousRoot;
    if (previousMode === undefined) delete process.env.STORAGE_MODE;
    else process.env.STORAGE_MODE = previousMode;
    delete require.cache[modulePath];
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('production print runtime fails closed when private cloud storage is not configured', () => {
  const { createPrintProductionRuntime } = require('../src/server/services/postgres/printProductionRuntime');
  assert.throws(() => createPrintProductionRuntime({
    env: {
      NODE_ENV: 'production',
      STORAGE_MODE: 'local',
      QR_ISSUANCE_POSTGRES_AUTHORITY_ENABLED: 'true',
      QR_ISSUANCE_POSTGRES_AUTHORITY_SCOPE: 'all',
      QR_ISSUANCE_POSTGRES_AUTHORITY_SOURCE_SHA256: 'a'.repeat(64),
      QR_ISSUANCE_POSTGRES_AUTHORITY_DOMAIN_SHA256: 'b'.repeat(64)
    }
  }), (error) => error?.code === 'PRINT_PRODUCTION_PRIVATE_OSS_REQUIRED');
});
