'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DEFAULT_JSON_DATABASE,
  analyzeAuditSource,
  auditFile,
  main,
  parseArguments,
  sha256
} = require('../scripts/database/audit-public-qr-gap');

function baseSource(overrides = {}) {
  return {
    qr_codes: [{
      activation_status: 'unactivated',
      show_brand_disclosure: false,
      co_creation_enabled: false,
      co_creation_comments: []
    }],
    ...overrides
  };
}

function writeFixture(directory, source, { bom = false } = {}) {
  const filePath = path.join(directory, 'public-qr-audit.json');
  const json = JSON.stringify(source);
  const bytes = Buffer.from(`${bom ? '\ufeff' : ''}${json}`, 'utf8');
  fs.writeFileSync(filePath, bytes);
  return {
    filePath,
    sourceHash: sha256(bytes)
  };
}

test('audit CLI requires explicit absolute input, expected hash, and dry-run', () => {
  assert.throws(
    () => parseArguments([]),
    (error) => error.code === 'PUBLIC_QR_AUDIT_DRY_RUN_REQUIRED'
  );
  assert.throws(
    () => parseArguments(['--dry-run']),
    (error) => error.code === 'PUBLIC_QR_AUDIT_INPUT_REQUIRED'
  );
  assert.throws(
    () => parseArguments(['--dry-run', '--input=relative.json']),
    (error) => error.code === 'PUBLIC_QR_AUDIT_ABSOLUTE_INPUT_REQUIRED'
  );
  assert.throws(
    () => parseArguments(['--dry-run', `--input=${path.resolve('fixture.json')}`]),
    (error) => error.code === 'PUBLIC_QR_AUDIT_EXPECTED_SHA256_REQUIRED'
  );
});

test('audit rejects the runtime database path before reading it', () => {
  assert.throws(
    () => auditFile({
      inputPath: DEFAULT_JSON_DATABASE,
      expectedSha256: '0'.repeat(64)
    }),
    (error) => error.code === 'PUBLIC_QR_AUDIT_RUNTIME_DATABASE_FORBIDDEN'
  );
});

test('audit accepts UTF-8 BOM and preserves hash, size, and raw mtime', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'public-qr-audit-'));
  try {
    const fixture = writeFixture(directory, baseSource(), { bom: true });
    const before = fs.statSync(fixture.filePath, { bigint: true });
    const report = auditFile({
      inputPath: fixture.filePath,
      expectedSha256: fixture.sourceHash
    });
    const after = fs.statSync(fixture.filePath, { bigint: true });

    assert.equal(report.audit_execution_status, 'COMPLETED');
    assert.equal(report.input_integrity.source_sha256, fixture.sourceHash);
    assert.equal(report.input_integrity.sha256_unchanged, true);
    assert.equal(report.input_integrity.size_unchanged, true);
    assert.equal(report.input_integrity.mtime_ns_unchanged, true);
    assert.equal(before.size, after.size);
    assert.equal(before.mtimeNs, after.mtimeNs);
    assert.equal(sha256(fs.readFileSync(fixture.filePath)), fixture.sourceHash);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('audit rejects a hash mismatch, invalid JSON, and forbidden sensitive fields', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'public-qr-audit-'));
  try {
    const fixture = writeFixture(directory, baseSource());
    assert.throws(
      () => auditFile({
        inputPath: fixture.filePath,
        expectedSha256: 'f'.repeat(64)
      }),
      (error) => error.code === 'PUBLIC_QR_AUDIT_SOURCE_HASH_MISMATCH'
    );

    fs.writeFileSync(fixture.filePath, Buffer.from('{invalid', 'utf8'));
    const invalidHash = sha256(fs.readFileSync(fixture.filePath));
    assert.throws(
      () => auditFile({
        inputPath: fixture.filePath,
        expectedSha256: invalidHash
      }),
      (error) => error.code === 'PUBLIC_QR_AUDIT_INVALID_JSON'
    );

    const sensitive = writeFixture(directory, {
      qr_codes: [{
        activation_status: 'unactivated',
        phone: 'fixture-sensitive-phone'
      }]
    });
    assert.throws(
      () => auditFile({
        inputPath: sensitive.filePath,
        expectedSha256: sensitive.sourceHash
      }),
      (error) => error.code === 'PUBLIC_QR_AUDIT_SENSITIVE_FIELD_FORBIDDEN'
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('disclosure audit separates present, missing, true, false, and invalid values', () => {
  const report = analyzeAuditSource({
    qr_codes: [
      { activation_status: 'unactivated', show_brand_disclosure: true },
      { activation_status: 'unactivated', show_brand_disclosure: false },
      { activation_status: 'unactivated' },
      { activation_status: 'unactivated', show_brand_disclosure: 'false' },
      { activation_status: 'activated', show_brand_disclosure: true }
    ]
  });

  assert.deepEqual(report.show_brand_disclosure, {
    total_qr_codes: 5,
    field_present_count: 4,
    true_count: 2,
    false_count: 1,
    missing_count: 1,
    invalid_type_count: 1,
    unactivated_total: 4,
    unactivated_true_count: 1,
    unactivated_false_count: 1,
    unactivated_missing_count: 1,
    unactivated_invalid_type_count: 1
  });
  assert.equal(report.gap_1_data_evidence, 'INVALID_VALUES_FOUND');
});

test('comment audit groups equal instants, excludes deleted comments, and checks order evidence', () => {
  const report = analyzeAuditSource({
    qr_codes: [{
      activation_status: 'co_creating',
      co_creation_enabled: true,
      co_creation_comments: [
        {
          id: 1,
          created_at: '2026-07-01T10:00:00.000Z',
          status: 'kept',
          source_position: 10
        },
        {
          id: '2',
          created_at: '2026-07-01T18:00:00.000+08:00',
          status: 'kept',
          source_position: 20
        },
        {
          id: 3,
          created_at: '2026-07-01T10:00:00.000Z',
          status: 'deleted',
          source_position: 30
        }
      ]
    }]
  });

  const comments = report.comment_ordering;
  assert.equal(comments.total_comments, 3);
  assert.equal(comments.effective_comments, 2);
  assert.equal(comments.deleted_comments, 1);
  assert.equal(comments.same_timestamp_groups, 1);
  assert.equal(comments.affected_comments, 2);
  assert.equal(comments.same_timestamp_groups_with_stable_source_position, 1);
  assert.equal(comments.same_timestamp_groups_with_numeric_id_order, 1);
  assert.equal(report.gap_2_data_evidence, 'EQUAL_TIMESTAMPS_WITH_STABLE_POSITION');
});

test('comment audit does not treat numeric IDs as an explicit source position', () => {
  const report = analyzeAuditSource({
    qr_codes: [{
      activation_status: 'activated',
      co_creation_enabled: true,
      co_creation_comments: [
        { id: 1, created_at: '2026-07-01T10:00:00.000Z', status: 'kept' },
        { id: 2, created_at: '2026-07-01T10:00:00.000Z', status: 'kept' }
      ]
    }]
  });

  assert.equal(report.comment_ordering.same_timestamp_groups, 1);
  assert.equal(report.comment_ordering.same_timestamp_groups_with_numeric_id_order, 1);
  assert.equal(report.comment_ordering.same_timestamp_groups_without_stable_position, 1);
  assert.equal(
    report.gap_2_data_evidence,
    'EQUAL_TIMESTAMPS_WITHOUT_STABLE_POSITION'
  );
});

test('invalid effective comment timestamps block the ordering evidence classification', () => {
  const report = analyzeAuditSource({
    qr_codes: [{
      activation_status: 'co_creating',
      co_creation_comments: [
        { id: 'COMMENT_SECRET', created_at: 'not-a-time', status: 'kept' },
        { id: 2, created_at: 'not-a-time', status: 'deleted' }
      ]
    }]
  });

  assert.equal(report.comment_ordering.invalid_timestamp_count, 1);
  assert.equal(report.gap_2_data_evidence, 'INVALID_TIMESTAMPS_FOUND');
});

test('CLI report is count-only and never prints paths, comment IDs, or source values', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'public-qr-audit-'));
  try {
    const secretCommentId = 'COMMENT-PRIVATE-FIXTURE-ID';
    const fixture = writeFixture(directory, {
      qr_codes: [{
        activation_status: 'co_creating',
        show_brand_disclosure: false,
        co_creation_comments: [{
          id: secretCommentId,
          created_at: '2026-07-01T10:00:00.000Z',
          status: 'kept'
        }]
      }]
    });
    let stdout = '';
    let stderr = '';
    const exitCode = main([
      '--dry-run',
      `--input=${fixture.filePath}`,
      `--expected-source-sha256=${fixture.sourceHash}`
    ], {
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } }
    });

    assert.equal(exitCode, 0);
    assert.equal(stderr, '');
    assert.equal(stdout.includes(secretCommentId), false);
    assert.equal(stdout.includes(fixture.filePath), false);
    assert.equal(stdout.includes('2026-07-01T10:00:00.000Z'), false);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.input_integrity.input_path_hash_prefix.length, 12);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('audit implementation has no database, runtime service, or file-write dependency', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', 'scripts', 'database', 'audit-public-qr-gap.js'),
    'utf8'
  );
  [
    'dbService',
    "require('pg')",
    'writeFile',
    'appendFile',
    'renameSync',
    'createWriteStream',
    'process.env',
    'DATABASE_URL',
    'DB_FILE'
  ].forEach((forbidden) => {
    assert.equal(source.includes(forbidden), false, forbidden);
  });
});
