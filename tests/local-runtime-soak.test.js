'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('local runtime soak uses disposable data and disables external authorities', () => {
  const source = fs.readFileSync(path.join(
    __dirname,
    '..',
    'scripts',
    'acceptance',
    'local-runtime-soak.js'
  ), 'utf8');

  assert.match(source, /mkdtempSync/);
  assert.match(source, /DB_FILE: path\.join\(temporaryRoot, 'db\.json'\)/);
  assert.match(source, /fs\.rmSync\(temporaryRoot, \{ recursive: true, force: true \}\)/);
  for (const name of [
    'PUBLIC_QR_POSTGRES_READ_ENABLED',
    'PERSONAL_RECORD_POSTGRES_READ_ENABLED',
    'IDENTITY_POSTGRES_AUTHORITY_ENABLED',
    'QR_LIFECYCLE_POSTGRES_WRITE_ENABLED',
    'QR_ISSUANCE_POSTGRES_AUTHORITY_ENABLED',
    'RECORD_PROOF_RUNTIME_ENABLED',
    'PUBLIC_QR_SHADOW_READ_ENABLED',
    'PERSONAL_RECORD_SHADOW_READ_ENABLED',
    'IDENTITY_SHADOW_READ_ENABLED'
  ]) {
    assert.match(source, new RegExp(`${name}: 'false'`));
  }
  assert.match(source, /CHAIN_ENABLED: 'false'/);
  assert.match(source, /delete process\.env\[name\]/);
  assert.match(source, /S2609A00014/);
  assert.doesNotMatch(source, /pm2|systemctl|git\s+(?:pull|push|checkout)|https:\/\//);
});
