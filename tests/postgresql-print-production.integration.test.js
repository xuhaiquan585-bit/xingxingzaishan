'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const enabled = process.env.RUN_POSTGRES_PRINT_PRODUCTION_TEST === 'true';

test('real PostgreSQL migration, concurrent reservation and irreversible binding', {
  skip: enabled ? false : 'set RUN_POSTGRES_PRINT_PRODUCTION_TEST=true for a disposable PostgreSQL database'
}, async () => {
  const { createPostgresPool, closePostgresPool } = require('../src/server/database/connection');
  const { readPostgresConfig } = require('../src/server/database/config');
  const { withTransaction } = require('../src/server/database/transaction');
  const { PrintBatchRepository } = require('../src/server/repositories');
  const { createPrintBatchService } = require('../src/server/services/postgres/printBatchService');
  const { defaultLabelTemplateSchema } = require('../src/server/services/labelTemplateSchema');

  const pool = createPostgresPool({ config: readPostgresConfig(process.env) });
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
  const templateId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const qrId = `PG${suffix}`;
  const legacyQrId = `LG${suffix}`;
  const now = new Date().toISOString();

  try {
    const migrationResult = await pool.query(
      "SELECT version FROM app.schema_migrations WHERE version = '008_add_label_print_production.sql'"
    );
    assert.equal(migrationResult.rowCount, 1);

    await pool.query(
      `INSERT INTO app.label_templates
         (id, name, status, created_by_snapshot, created_at, updated_at)
       VALUES ($1, $2, 'published', 'integration-test', $3, $3)`,
      [templateId, `PG concurrency ${suffix}`, now]
    );
    await pool.query(
      `INSERT INTO app.label_template_versions
         (id, template_id, version_number, status, width_mm, height_mm, dpi,
          schema_version, template_schema, created_by_snapshot, created_at,
          updated_at, published_by_snapshot, published_at)
       VALUES ($1, $2, 1, 'published', 20, 80, 600, 1, $3::jsonb,
         'integration-test', $4, $4, 'integration-test', $4)`,
      [versionId, templateId, JSON.stringify(defaultLabelTemplateSchema()), now]
    );
    await pool.query(
      'UPDATE app.label_templates SET current_published_version_id = $2 WHERE id = $1',
      [templateId, versionId]
    );
    await pool.query(
      `INSERT INTO app.qr_codes
         (id, issue_status, lifecycle_status, access_token, created_at, updated_at)
       VALUES ($1, 'issued', 'unactivated', $2, $3, $3)`,
      [qrId, crypto.randomBytes(24).toString('base64url'), now]
    );
    await pool.query(
      `INSERT INTO app.qr_codes
         (id, issue_status, lifecycle_status, access_token, print_status,
          created_at, updated_at)
       VALUES ($1, 'issued', 'unactivated', $2, 'legacy_unclassified', $3, $3)`,
      [legacyQrId, crypto.randomBytes(24).toString('base64url'), now]
    );

    const service = createPrintBatchService({
      pool,
      transactionRunner: withTransaction,
      repositoryType: PrintBatchRepository,
      baseUrl: 'https://example.invalid'
    });
    const attempts = await Promise.allSettled([
      service.create({
        name: `concurrency-a-${suffix}`,
        templateVersionId: versionId,
        idempotencyKey: crypto.randomUUID(),
        qrIds: [qrId],
        actor: { username: 'integration-test' }
      }),
      service.create({
        name: `concurrency-b-${suffix}`,
        templateVersionId: versionId,
        idempotencyKey: crypto.randomUUID(),
        qrIds: [qrId],
        actor: { username: 'integration-test' }
      })
    ]);
    const fulfilled = attempts.filter((item) => item.status === 'fulfilled');
    const rejected = attempts.filter((item) => item.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason.code, /^PRINT_QR_(ALREADY_RESERVED|RESERVATION_CONFLICT)$/);

    const winningBatchId = fulfilled[0].value.id;
    const qrResult = await pool.query(
      'SELECT print_batch_id, print_status FROM app.qr_codes WHERE id = $1', [qrId]
    );
    assert.deepEqual(qrResult.rows[0], {
      print_batch_id: winningBatchId,
      print_status: 'reserved'
    });
    const batchCount = await pool.query(
      'SELECT count(*)::integer AS count FROM app.print_batches WHERE id IN ($1)',
      [winningBatchId]
    );
    assert.equal(batchCount.rows[0].count, 1);

    await pool.query("UPDATE app.print_batches SET status = 'generating', updated_at = now() WHERE id = $1", [winningBatchId]);
    await pool.query(
      `UPDATE app.print_batches
       SET status = 'artifact_ready', artifact_object_key = $2,
           artifact_sha256 = $3, artifact_size_bytes = 123,
           generated_at = now(), updated_at = now()
       WHERE id = $1`,
      [winningBatchId, `printing/production/${winningBatchId}/artifact.zip`, 'a'.repeat(64)]
    );
    await pool.query(
      "UPDATE app.qr_codes SET print_status = 'artifact_generated', updated_at = now() WHERE id = $1",
      [qrId]
    );

    await assert.rejects(
      pool.query(
        "UPDATE app.qr_codes SET print_batch_id = NULL, print_status = 'available', updated_at = now() WHERE id = $1",
        [qrId]
      ),
      (error) => error.constraint === 'qr_codes_print_status_transition'
        || error.constraint === 'qr_codes_print_batch_assignment'
    );
    const locked = await pool.query(
      'SELECT print_batch_id, print_status FROM app.qr_codes WHERE id = $1', [qrId]
    );
    assert.deepEqual(locked.rows[0], {
      print_batch_id: winningBatchId,
      print_status: 'artifact_generated'
    });

    const printing = await service.startPrinting({
      batchId: winningBatchId,
      actor: { username: 'integration-test' }
    });
    assert.equal(printing.status, 'printing');
    const completed = await service.complete({
      batchId: winningBatchId,
      voidQrIds: [],
      voidReason: '',
      actor: { username: 'integration-test' }
    });
    assert.equal(completed.status, 'completed');
    const printed = await pool.query(
      'SELECT print_batch_id, print_status FROM app.qr_codes WHERE id = $1', [qrId]
    );
    assert.deepEqual(printed.rows[0], {
      print_batch_id: winningBatchId,
      print_status: 'printed'
    });

    const classified = await service.classifyLegacyQrCodes({
      qrIds: [legacyQrId],
      targetStatus: 'available',
      actor: { username: 'integration-test' }
    });
    assert.deepEqual(classified.updated_ids, [legacyQrId]);
    const classifiedQr = await pool.query(
      'SELECT print_status, print_void_reason FROM app.qr_codes WHERE id = $1', [legacyQrId]
    );
    assert.deepEqual(classifiedQr.rows[0], {
      print_status: 'available',
      print_void_reason: ''
    });
  } finally {
    await closePostgresPool(pool);
  }
});
