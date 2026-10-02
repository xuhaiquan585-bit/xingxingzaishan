'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createAuditAppender,
  rotateAuditLogIfNeeded
} = require('../src/server/services/auditService');

test('audit log rotation keeps only the configured generations', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-rotation-'));
  const logFile = path.join(directory, 'audit.log');
  fs.writeFileSync(logFile, 'current');
  fs.writeFileSync(`${logFile}.1`, 'previous');
  fs.writeFileSync(`${logFile}.2`, 'expired');

  assert.equal(rotateAuditLogIfNeeded({
    logFile,
    lineBytes: 8,
    maxBytes: 10,
    backupCount: 2
  }), true);
  assert.equal(fs.existsSync(logFile), false);
  assert.equal(fs.readFileSync(`${logFile}.1`, 'utf8'), 'current');
  assert.equal(fs.readFileSync(`${logFile}.2`, 'utf8'), 'previous');

  fs.rmSync(directory, { recursive: true, force: true });
});

test('audit appender survives an unavailable log directory without throwing', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-failure-'));
  const blocker = path.join(directory, 'not-a-directory');
  fs.writeFileSync(blocker, 'blocker');
  const errors = [];
  const append = createAuditAppender({
    logFile: path.join(blocker, 'audit.log'),
    onError(error) { errors.push(error); }
  });

  assert.equal(append({ method: 'POST', path: '/api/example' }), false);
  assert.equal(errors.length, 1);

  fs.rmSync(directory, { recursive: true, force: true });
});

test('audit appender writes valid JSON lines in the normal path', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-write-'));
  const logFile = path.join(directory, 'audit.log');
  const append = createAuditAppender({ logFile, maxBytes: 1024, backupCount: 2 });

  assert.equal(append({ method: 'PATCH', path: '/api/example', status: 200 }), true);
  const record = JSON.parse(fs.readFileSync(logFile, 'utf8').trim());
  assert.equal(record.method, 'PATCH');
  assert.equal(record.path, '/api/example');
  assert.equal(record.status, 200);
  assert.match(record.at, /^\d{4}-\d{2}-\d{2}T/);

  fs.rmSync(directory, { recursive: true, force: true });
});
