'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_TIMEOUT_MS,
  readPublicQrShadowConfig
} = require('../src/server/services/postgres/publicQrShadowConfig');
const {
  PublicQrMismatchSink,
  sanitizeMismatchRecord
} = require('../src/server/services/postgres/publicQrMismatchSink');
const {
  createPublicQrShadowObserver
} = require('../src/server/services/postgres/publicQrShadowObserver');

function enabledConfig(overrides = {}) {
  return {
    enabled: true,
    allowlist: new Set(['QR_PUBLIC_1']),
    timeoutMs: 250,
    maxConcurrency: 2,
    ...overrides
  };
}

function event(overrides = {}) {
  return {
    endpointTemplate: '/api/qr/:key',
    channel: 'h5',
    key: 'memory-only-key',
    publicQrId: 'QR_PUBLIC_1',
    viewer: { accountId: 'memory-only-account', phoneBound: true },
    sourceHash: 'a'.repeat(64),
    baselineDto: { id: 'QR_PUBLIC_1', activation_status: 'activated', content: 'private' },
    ...overrides
  };
}

function matchingComparator({ baseline, candidate }) {
  return {
    matches: JSON.stringify(baseline) === JSON.stringify(candidate),
    mismatch_count: 0,
    mismatches: []
  };
}

test('shadow config is disabled by default and never requires PostgreSQL settings', () => {
  const config = readPublicQrShadowConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.reason, 'DISABLED_BY_DEFAULT');
  assert.equal(config.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(config.maxConcurrency, DEFAULT_MAX_CONCURRENCY);
});

test('shadow config fails closed for invalid enable, allowlist, or log directory', () => {
  assert.equal(readPublicQrShadowConfig({ PUBLIC_QR_SHADOW_READ_ENABLED: 'TRUE' }).enabled, false);
  assert.equal(readPublicQrShadowConfig({ PUBLIC_QR_SHADOW_READ_ENABLED: 'true' }).reason, 'ALLOWLIST_REQUIRED');
  const inside = readPublicQrShadowConfig({
    PUBLIC_QR_SHADOW_READ_ENABLED: 'true',
    PUBLIC_QR_SHADOW_READ_ALLOWLIST: 'QR_PUBLIC_1',
    PUBLIC_QR_SHADOW_READ_LOG_DIR: path.resolve(__dirname, '..', 'shadow-log')
  });
  assert.equal(inside.enabled, false);
  assert.equal(inside.reason, 'LOG_DIRECTORY_MUST_BE_OUTSIDE_REPOSITORY');
});

test('shadow config accepts an explicit allowlist and external absolute log directory', () => {
  const config = readPublicQrShadowConfig({
    PUBLIC_QR_SHADOW_READ_ENABLED: 'true',
    PUBLIC_QR_SHADOW_READ_ALLOWLIST: 'QR_PUBLIC_1, QR_PUBLIC_2',
    PUBLIC_QR_SHADOW_READ_LOG_DIR: path.join(os.tmpdir(), 'public-qr-shadow-test')
  });
  assert.equal(config.enabled, true);
  assert.deepEqual([...config.allowlist], ['QR_PUBLIC_1', 'QR_PUBLIC_2']);
});

test('disabled observer does not call candidate, comparator, or sink', async () => {
  const calls = [];
  const observer = createPublicQrShadowObserver({
    getConfig: () => ({ enabled: false }),
    readCandidate: async () => { calls.push('candidate'); },
    compareDtos: () => { calls.push('compare'); },
    sink: { enqueue: () => { calls.push('sink'); } }
  });
  assert.deepEqual(await observer.observe(event()), { outcome: 'DISABLED' });
  assert.deepEqual(calls, []);
});

test('allowlist miss and missing source version skip before candidate', async () => {
  let candidateCalls = 0;
  const observer = createPublicQrShadowObserver({
    getConfig: () => enabledConfig(),
    readCandidate: async () => { candidateCalls += 1; },
    compareDtos: matchingComparator
  });
  assert.equal((await observer.observe(event({ publicQrId: 'QR_OTHER' }))).outcome, 'SKIPPED_NOT_ALLOWLISTED');
  assert.equal((await observer.observe(event({ sourceHash: '' }))).outcome, 'INELIGIBLE_NO_VERSION');
  assert.equal(candidateCalls, 0);
});

test('observer protects the original baseline DTO from comparator mutation', async () => {
  const original = event();
  const observer = createPublicQrShadowObserver({
    getConfig: () => enabledConfig(),
    readCandidate: async () => ({ eligibility: 'ELIGIBLE', dto: { ...original.baselineDto } }),
    compareDtos: ({ baseline }) => {
      baseline.content = 'changed';
      return { matches: true, mismatch_count: 0, mismatches: [] };
    }
  });
  assert.equal((await observer.observe(original)).outcome, 'MATCH');
  assert.equal(original.baselineDto.content, 'private');
});

test('stale and ineligible candidate outcomes do not call comparator', async () => {
  let compareCalls = 0;
  const observer = createPublicQrShadowObserver({
    getConfig: () => enabledConfig(),
    readCandidate: async () => ({ eligibility: 'STALE_SOURCE' }),
    compareDtos: () => { compareCalls += 1; }
  });
  assert.equal((await observer.observe(event())).outcome, 'STALE_SOURCE');
  assert.equal(compareCalls, 0);
});

test('observer allows two candidates and skips additional work without a queue', async () => {
  const resolvers = [];
  const observer = createPublicQrShadowObserver({
    getConfig: () => enabledConfig(),
    readCandidate: () => new Promise((resolve) => resolvers.push(resolve)),
    compareDtos: matchingComparator
  });
  const first = observer.observe(event());
  const second = observer.observe(event());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await observer.observe(event())).outcome, 'SKIPPED_CAPACITY');
  resolvers.forEach((resolve) => resolve({ eligibility: 'ELIGIBLE', dto: event().baselineDto }));
  assert.equal((await first).outcome, 'MATCH');
  assert.equal((await second).outcome, 'MATCH');
});

test('candidate timeout aborts the signal and does not leak a late rejection', async () => {
  let signal;
  const observer = createPublicQrShadowObserver({
    getConfig: () => enabledConfig({ timeoutMs: 10 }),
    readCandidate: ({ signal: currentSignal }) => {
      signal = currentSignal;
      return new Promise((_, reject) => setTimeout(() => reject(new Error('late failure')), 25));
    },
    compareDtos: matchingComparator
  });
  assert.equal((await observer.observe(event())).outcome, 'CANDIDATE_TIMEOUT');
  assert.equal(signal.aborted, true);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(observer.getState().active, 0);
});

test('five infrastructure failures open the circuit and one successful half-open probe closes it', async () => {
  let currentTime = 1000;
  let shouldFail = true;
  const observer = createPublicQrShadowObserver({
    getConfig: () => enabledConfig(),
    readCandidate: async () => {
      if (shouldFail) {
        const error = new Error('query failed');
        error.code = 'POSTGRES_QUERY_FAILED';
        throw error;
      }
      return { eligibility: 'ELIGIBLE', dto: event().baselineDto };
    },
    compareDtos: matchingComparator,
    now: () => currentTime
  });
  for (let index = 0; index < 5; index += 1) {
    assert.equal((await observer.observe(event())).outcome, 'POSTGRES_QUERY_FAILED');
  }
  assert.equal((await observer.observe(event())).outcome, 'SKIPPED_CIRCUIT_OPEN');
  currentTime += 300001;
  shouldFail = false;
  assert.equal((await observer.observe(event())).outcome, 'MATCH');
  assert.equal(observer.getState().circuitOpen, false);
});

test('mismatch sink receives metadata only and never receives compared values or identity context', async () => {
  const records = [];
  const observer = createPublicQrShadowObserver({
    getConfig: () => enabledConfig(),
    readCandidate: async () => ({
      eligibility: 'ELIGIBLE',
      lifecycle: 'activated',
      dto: { id: 'QR_PUBLIC_1', activation_status: 'activated', content: 'other private text' }
    }),
    compareDtos: () => ({
      matches: false,
      mismatch_count: 1,
      truncated: false,
      mismatches: [{
        path: '$.content', kind: 'value_mismatch', baseline_type: 'string', candidate_type: 'string'
      }]
    }),
    sink: {
      enqueue: (record) => {
        records.push(record);
        return { accepted: true, completion: Promise.resolve(true) };
      }
    }
  });
  assert.equal((await observer.observe(event())).outcome, 'MISMATCH');
  const serialized = JSON.stringify(records);
  assert.match(serialized, /\$\.content/);
  assert.doesNotMatch(serialized, /private|memory-only|QR_PUBLIC_1/);
});

test('sanitizeMismatchRecord uses a strict value-free field allowlist', () => {
  const record = sanitizeMismatchRecord({
    endpoint_template: '/api/qr/secret-key',
    channel: 'h5',
    lifecycle: 'activated',
    field_path: '$.image_url',
    difference_type: 'value_mismatch',
    baseline_type: 'string',
    candidate_type: 'string',
    baseline_value: 'https://private.example/image',
    candidate_value: 'token-value',
    account_id: 'ACCOUNT_PRIVATE',
    mismatch_count: 1
  }, {
    now: new Date('2026-01-01T00:00:00.000Z'),
    randomUUID: () => 'observation-test'
  });
  assert.equal(record.endpoint_template, 'unknown');
  assert.equal(record.observation_id, 'observation-test');
  assert.equal(record.mismatch_count, 1);
  const serialized = JSON.stringify(record);
  assert.doesNotMatch(serialized, /private\.example|token-value|ACCOUNT_PRIVATE|baseline_value/);
});

test('file sink is lazy, rotates at the byte boundary, and removes expired files', async () => {
  const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'public-qr-shadow-'));
  const directory = path.join(parent, 'sink');
  try {
    assert.equal(fs.existsSync(directory), false);
    const expired = path.join(directory, 'public-qr-shadow-expired.jsonl');
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(expired, '{}\n');
    const old = new Date('2025-01-01T00:00:00.000Z');
    await fs.promises.utimes(expired, old, old);

    const sink = new PublicQrMismatchSink({
      directory,
      maxBytes: 160,
      now: () => new Date('2026-01-20T00:00:00.000Z')
    });
    const first = sink.enqueue({ field_path: '$.one', difference_type: 'value_mismatch' });
    const second = sink.enqueue({ field_path: '$.two', difference_type: 'value_mismatch' });
    assert.equal(first.accepted, true);
    assert.equal(second.accepted, true);
    await sink.flush();

    const files = await fs.promises.readdir(directory);
    assert.equal(files.includes('public-qr-shadow-expired.jsonl'), false);
    assert.equal(files.some((name) => name === 'public-qr-shadow-current.jsonl'), true);
    assert.equal(files.some((name) => name !== 'public-qr-shadow-current.jsonl'), true);
  } finally {
    await fs.promises.rm(parent, { recursive: true, force: true });
  }
});

test('file sink bounds its queue and isolates write failures', async () => {
  let releaseMkdir;
  let mkdirCalls = 0;
  const errors = [];
  const blockedFs = {
    mkdir: () => {
      mkdirCalls += 1;
      if (mkdirCalls > 1) return Promise.resolve();
      return new Promise((resolve) => { releaseMkdir = resolve; });
    },
    readdir: async () => [],
    stat: async () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; },
    appendFile: async () => { throw new Error('write failed'); },
    rename: async () => {},
    unlink: async () => {}
  };
  const sink = new PublicQrMismatchSink({
    directory: path.join(os.tmpdir(), 'not-created-shadow-sink'),
    queueLimit: 1,
    fsPromises: blockedFs,
    onError: (error) => errors.push(error.message)
  });
  const first = sink.enqueue({ field_path: '$.one' });
  await new Promise((resolve) => setImmediate(resolve));
  const second = sink.enqueue({ field_path: '$.two' });
  const third = sink.enqueue({ field_path: '$.three' });
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  assert.equal(third.accepted, false);
  releaseMkdir();
  await sink.flush();
  assert.equal(sink.dropped, 1);
  assert.equal(errors.includes('PUBLIC_QR_SHADOW_SINK_QUEUE_FULL'), true);
  assert.equal(errors.includes('write failed'), true);
});
