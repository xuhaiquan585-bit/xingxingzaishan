#!/usr/bin/env node

require('dotenv').config();

const { auditBusinessAccounts } = require('../src/server/services/businessAccountAuditService');

function main() {
  try {
    const summary = auditBusinessAccounts();
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error && error.code ? error.code : 'BUSINESS_ACCOUNT_AUDIT_FAILED'}\n`);
    process.exitCode = 1;
  }
}

main();
