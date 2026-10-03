'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const runner = fs.readFileSync(path.join(
  __dirname,
  '..',
  'scripts',
  'database',
  'run-production-proof-failure-audit.sh'
), 'utf8').replace(/\r\n/g, '\n');

test('proof failure audit pins the deployed production revision', () => {
  assert.match(runner, /^EXPECTED_ACTIVE_COMMIT=f9b827cf6245e3780841239139dda0e3bf7d84aa$/m);
  assert.match(runner, /^EXPECTED_ACTIVE_TREE=8c3f5d2836a79f9fc22e6b21a9452512369fe5b9$/m);
  assert.match(runner, /^PRODUCTION_DATABASE=xingxing_clean_baseline_20260812_staging$/m);
  assert.match(runner, /git status --porcelain=v1 --untracked-files=normal/);
  assert.match(runner, /\?\? src\/frontend\/5QJLlAJPza\.txt/);
});

test('proof failure audit is read-only and bounded', () => {
  assert.match(runner, /BEGIN TRANSACTION READ ONLY;/);
  assert.match(runner, /SET LOCAL statement_timeout = '10000ms';/);
  assert.match(runner, /PRODUCTION_DATABASE_WRITE=NONE/);
  assert.match(runner, /APPLICATION_RESTART=NO/);
  assert.match(runner, /EXTERNAL_PROVIDER_CALLS=NONE/);
  assert.doesNotMatch(runner, /pm2 (?:restart|reload|start|delete)/);
  assert.doesNotMatch(runner, /systemctl (?:start|restart|enable|disable)/);
  assert.doesNotMatch(runner, /git (?:pull|merge|checkout|reset)/);
  assert.doesNotMatch(runner, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/);
});

test('proof failure audit emits only aggregate classified evidence', () => {
  assert.match(runner, /PROOF_FAILURE_SUMMARY/);
  assert.match(runner, /PROOF_FAILURE_CLASS/);
  assert.match(runner, /PROOF_FAILURE_OUTBOX/);
  assert.match(runner, /PROOF_FAILURE_ATTEMPTS/);
  assert.match(runner, /RECORD_IDENTIFIERS_PRINTED=NO/);
  assert.match(runner, /ERROR_TEXT_PRINTED=CLASSIFIED_ONLY/);
  assert.match(runner, /WHEN last_error ~ '\^\[A-Z0-9_\]\{1,80\}\$'/);
  assert.doesNotMatch(runner, /SELECT[^;]*record_qr_id[^;]*FROM app\.record_proofs\s+WHERE status = 'failed';/s);
});

test('proof failure audit contains no rich-text corruption or credentials', () => {
  for (const artifact of ['\\_', '\\:', '\\*', '\\--']) {
    assert.equal(runner.includes(artifact), false, `unexpected artifact ${artifact}`);
  }
  assert.doesNotMatch(runner, /\[https?:\/\/[^\]]+\]\(https?:\/\//);
  assert.doesNotMatch(runner, /AKID[A-Za-z0-9]|LTAI[A-Za-z0-9]/);
  assert.match(runner, /SECRET_VALUES_PRINTED=NO/);
});
