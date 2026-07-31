'use strict';

const { RepositoryError } = require('./errors');
const { assertTransactionContext, executeQuery, oneOrNull } = require('./query');

function assertSourceHash(sourceHash) {
  const normalized = String(sourceHash || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new RepositoryError('PUBLIC_QR_SOURCE_HASH_INVALID', 'A valid source hash is required.');
  }
  return normalized;
}

function mapImportRun(row) {
  if (!row) return null;
  return Object.freeze({
    source_sha256: String(row.source_sha256 || '').trim(),
    status: row.status,
    completed_at: row.completed_at
  });
}

function mapMigration(row) {
  return Object.freeze({
    version: row.version,
    checksum: String(row.checksum || '').trim()
  });
}

class PublicQrProvenanceRepository {
  constructor(transactionContext) {
    this.transactionContext = assertTransactionContext(transactionContext);
  }

  async findPassedImportBySourceHash(sourceHash) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT trim(source_sha256) AS source_sha256, status, completed_at
       FROM app.import_runs
       WHERE source_sha256 = $1 AND status = 'passed'
       LIMIT 2`,
      [assertSourceHash(sourceHash)]
    );
    return oneOrNull(result, mapImportRun, 'PUBLIC_QR_IMPORT_SOURCE_DUPLICATE');
  }

  async findLatestPassedImport() {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT trim(source_sha256) AS source_sha256, status, completed_at
       FROM app.import_runs
       WHERE status = 'passed'
       ORDER BY completed_at DESC NULLS LAST, source_sha256 ASC
       LIMIT 1`,
      []
    );
    return oneOrNull(result, mapImportRun);
  }

  async listAppliedMigrations() {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT version, trim(checksum) AS checksum
       FROM app.schema_migrations
       ORDER BY version ASC`,
      []
    );
    return (result.rows || []).map(mapMigration);
  }
}

module.exports = {
  PublicQrProvenanceRepository,
  assertSourceHash
};
