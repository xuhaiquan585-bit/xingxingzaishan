'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  PRINT_BATCH_STATUSES,
  QR_PRINT_STATUSES,
  canTransitionPrintBatch,
  canTransitionQrPrint
} = require('../src/server/domain/printProductionStates');
const { loadMigrations } = require('../scripts/database/migrate');

test('print production states expose the fixed workflow and terminal states', () => {
  assert.deepEqual(PRINT_BATCH_STATUSES, [
    'reserved', 'generating', 'generation_failed', 'artifact_ready',
    'printing', 'completed', 'canceled', 'voided'
  ]);
  assert.deepEqual(QR_PRINT_STATUSES, [
    'legacy_unclassified', 'available', 'reserved',
    'artifact_generated', 'printed', 'voided'
  ]);

  assert.equal(canTransitionPrintBatch('reserved', 'generating'), true);
  assert.equal(canTransitionPrintBatch('reserved', 'canceled'), true);
  assert.equal(canTransitionPrintBatch('artifact_ready', 'reserved'), false);
  assert.equal(canTransitionPrintBatch('completed', 'printing'), false);
  assert.equal(canTransitionQrPrint('reserved', 'available'), true);
  assert.equal(canTransitionQrPrint('artifact_generated', 'voided'), true);
  assert.equal(canTransitionQrPrint('printed', 'reserved'), false);
  assert.equal(canTransitionQrPrint('voided', 'available'), false);
});

test('label print migration is additive and installs irreversible database guards', () => {
  const migrationsDirectory = path.join(__dirname, '..', 'database', 'migrations');
  const migrationPath = path.join(
    migrationsDirectory,
    '008_add_label_print_production.sql'
  );
  const migration = fs.readFileSync(migrationPath, 'utf8');

  assert.match(migration, /CREATE TABLE app\.label_templates/);
  assert.match(migration, /CREATE TABLE app\.label_template_versions/);
  assert.match(migration, /CREATE TABLE app\.label_template_assets/);
  assert.match(migration, /CREATE TABLE app\.print_batches/);
  assert.match(migration, /UPDATE app\.qr_codes[\s\S]*print_status = 'legacy_unclassified'/);
  assert.match(migration, /ALTER COLUMN print_status SET DEFAULT 'available'/);
  assert.match(migration, /CHECK \(dpi = 600\)/);
  assert.match(migration, /qr_count BETWEEN 1 AND 500/);
  assert.match(migration, /label_template_versions_published_immutable/);
  assert.match(migration, /print_batches_artifact_immutable/);
  assert.match(migration, /qr_codes_print_batch_assignment/);
  assert.match(migration, /FOREIGN KEY \(print_batch_id\)[\s\S]*NOT VALID/);
  assert.doesNotMatch(migration, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);

  const versions = loadMigrations({ migrationsDirectory }).map((item) => item.version);
  assert.equal(versions.at(-1), '008_add_label_print_production.sql');
});
