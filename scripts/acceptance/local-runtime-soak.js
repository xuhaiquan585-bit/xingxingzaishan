'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function boundedInteger(value, fallback, minimum, maximum, code) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
  return parsed;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) return resolve();
    server.close(() => resolve());
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  });
}

async function runRequests({ baseUrl, count, concurrency }) {
  const targets = [
    { path: '/', status: 200 },
    { path: '/api/health/ready', status: 200 },
    { path: '/record.html', status: 200 },
    { path: '/api/qr/S2609A00014', status: 404 }
  ];
  let nextIndex = 0;
  const statusCounts = new Map();

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= count) return;
      const target = targets[index % targets.length];
      const response = await fetch(`${baseUrl}${target.path}`, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(5000)
      });
      await response.arrayBuffer();
      if (response.status !== target.status) {
        const error = new Error('LOCAL_RUNTIME_SOAK_HTTP_STATUS_MISMATCH');
        error.code = 'LOCAL_RUNTIME_SOAK_HTTP_STATUS_MISMATCH';
        throw error;
      }
      statusCounts.set(response.status, (statusCounts.get(response.status) || 0) + 1);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return statusCounts;
}

async function main() {
  const requestCount = boundedInteger(process.env.SOAK_REQUEST_COUNT, 5000, 100, 100000, 'SOAK_REQUEST_COUNT_INVALID');
  const warmupCount = boundedInteger(process.env.SOAK_WARMUP_COUNT, 500, 20, 10000, 'SOAK_WARMUP_COUNT_INVALID');
  const concurrency = boundedInteger(process.env.SOAK_CONCURRENCY, 20, 1, 100, 'SOAK_CONCURRENCY_INVALID');
  const maximumHeapGrowth = boundedInteger(
    process.env.SOAK_MAX_HEAP_GROWTH_BYTES,
    64 * 1024 * 1024,
    1024 * 1024,
    1024 * 1024 * 1024,
    'SOAK_MAX_HEAP_GROWTH_INVALID'
  );
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xingxing-runtime-soak-'));
  let server;

  Object.assign(process.env, {
    NODE_ENV: 'test',
    AUTH_SECRET: 'local-runtime-soak-auth-secret-at-least-32-bytes',
    UPLOAD_PROOF_SECRET: 'local-runtime-soak-upload-secret-at-least-32-bytes',
    DB_FILE: path.join(temporaryRoot, 'db.json'),
    AUDIT_LOG_DIR: path.join(temporaryRoot, 'logs'),
    STORAGE_MODE: 'local',
    SMS_PROVIDER: 'mock',
    CHAIN_ENABLED: 'false',
    PUBLIC_QR_POSTGRES_READ_ENABLED: 'false',
    PERSONAL_RECORD_POSTGRES_READ_ENABLED: 'false',
    IDENTITY_POSTGRES_AUTHORITY_ENABLED: 'false',
    QR_LIFECYCLE_POSTGRES_WRITE_ENABLED: 'false',
    QR_ISSUANCE_POSTGRES_AUTHORITY_ENABLED: 'false',
    RECORD_PROOF_RUNTIME_ENABLED: 'false',
    PUBLIC_QR_SHADOW_READ_ENABLED: 'false',
    PERSONAL_RECORD_SHADOW_READ_ENABLED: 'false',
    IDENTITY_SHADOW_READ_ENABLED: 'false'
  });
  for (const name of [
    'DATABASE_URL', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGPASSWORD_FILE',
    'PGDATABASE', 'OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET', 'AVATA_API_KEY',
    'AVATA_API_SECRET'
  ]) delete process.env[name];

  try {
    const { createApp } = require('../../src/server/app');
    const app = createApp();
    server = require('node:http').createServer(app);
    const address = await listen(server);
    const baseUrl = `http://127.0.0.1:${address.port}`;

    await runRequests({ baseUrl, count: warmupCount, concurrency });
    if (typeof global.gc === 'function') global.gc();
    const before = process.memoryUsage();

    const statusCounts = await runRequests({ baseUrl, count: requestCount, concurrency });
    if (typeof global.gc === 'function') global.gc();
    const after = process.memoryUsage();
    const heapGrowth = after.heapUsed - before.heapUsed;
    const rssGrowth = after.rss - before.rss;
    if (heapGrowth > maximumHeapGrowth) {
      const error = new Error('LOCAL_RUNTIME_SOAK_HEAP_GROWTH_EXCEEDED');
      error.code = 'LOCAL_RUNTIME_SOAK_HEAP_GROWTH_EXCEEDED';
      throw error;
    }

    console.log(`SOAK_REQUESTS=${requestCount}`);
    console.log(`SOAK_CONCURRENCY=${concurrency}`);
    console.log(`SOAK_HTTP_200=${statusCounts.get(200) || 0}`);
    console.log(`SOAK_HTTP_404=${statusCounts.get(404) || 0}`);
    console.log(`SOAK_HEAP_GROWTH_BYTES=${heapGrowth}`);
    console.log(`SOAK_RSS_GROWTH_BYTES=${rssGrowth}`);
    console.log('SOAK_GUESSED_DISPLAY_ID=PASS_404');
    console.log('EXTERNAL_PROVIDER_CALLS=NONE');
    console.log('LOCAL_RUNTIME_SOAK=PASS');
  } finally {
    await close(server);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('LOCAL_RUNTIME_SOAK=FAIL');
  console.error(`ERROR_CODE=${String(error && error.code || 'LOCAL_RUNTIME_SOAK_FAILED')}`);
  process.exitCode = 1;
});
