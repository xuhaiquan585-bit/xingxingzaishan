#!/usr/bin/env node

require('dotenv').config();

const {
  auditAccountMigration,
  applyAccountMigration
} = require('../src/server/services/accountMigrationService');

function hasFlag(name) {
  return process.argv.includes(name);
}

function printSummary(summary) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

function main() {
  const apply = hasFlag('--apply');
  const dryRun = hasFlag('--dry-run') || !apply;

  if (apply && (!hasFlag('--backup-confirmed') || !hasFlag('--single-instance-confirmed'))) {
    process.stderr.write(
      [
        'Refusing to apply account migration without explicit production safety confirmations.',
        'Required flags: --apply --backup-confirmed --single-instance-confirmed'
      ].join('\n') + '\n'
    );
    process.exitCode = 1;
    return;
  }

  if (dryRun) {
    printSummary({
      ...auditAccountMigration(),
      dry_run: true,
      applied: false
    });
    return;
  }

  printSummary(applyAccountMigration());
}

main();
