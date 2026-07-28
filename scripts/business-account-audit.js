#!/usr/bin/env node

require('dotenv').config();

const {
  auditBusinessAccounts,
  applyBusinessAccountBackfill
} = require('../src/server/services/businessAccountAuditService');

function hasFlag(name) {
  return process.argv.includes(name);
}

function valueForFlag(prefix) {
  const found = process.argv.find((item) => item.startsWith(`${prefix}=`));
  return found ? found.slice(prefix.length + 1) : '';
}

function main() {
  try {
    const apply = hasFlag('--apply');
    const summary = apply
      ? applyBusinessAccountBackfill({
        dbFile: process.env.DB_FILE || '',
        backupConfirmed: hasFlag('--backup-confirmed'),
        singleInstanceConfirmed: hasFlag('--single-instance-confirmed'),
        expectedSourceSha256: valueForFlag('--expected-source-sha256')
      })
      : auditBusinessAccounts();
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error && error.code ? error.code : 'BUSINESS_ACCOUNT_AUDIT_FAILED'}\n`);
    process.exitCode = 1;
  }
}

main();
