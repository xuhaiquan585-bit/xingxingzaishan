'use strict';

const { ARCHIVE_FIELDS, mapArchive } = require('./mappers');
const { assertTransactionContext, executeQuery, oneOrNull } = require('./query');

const COLUMNS = ARCHIVE_FIELDS.join(', ');

class ArchiveRepository {
  constructor(transactionContext) {
    this.transactionContext = assertTransactionContext(transactionContext);
  }

  async findByRecordId(recordQrId) {
    return this.#findByRecordId(recordQrId, false);
  }

  async findByRecordIdForUpdate(recordQrId) {
    return this.#findByRecordId(recordQrId, true);
  }

  async upsertReady({
    record_qr_id: recordQrId,
    manifest_object_key: manifestObjectKey,
    legacy_manifest_object_key: legacyManifestObjectKey,
    index_object_key: indexObjectKey,
    created_at: createdAt,
    updated_at: updatedAt
  }) {
    const result = await executeQuery(
      this.transactionContext,
      `INSERT INTO app.record_archives
         (${COLUMNS})
       VALUES ($1, $2, $3, $4, 'ready', '', $5, $6)
       ON CONFLICT (record_qr_id) DO UPDATE
       SET manifest_object_key = EXCLUDED.manifest_object_key,
           legacy_manifest_object_key = COALESCE(
             EXCLUDED.legacy_manifest_object_key,
             app.record_archives.legacy_manifest_object_key
           ),
           index_object_key = COALESCE(
             EXCLUDED.index_object_key,
             app.record_archives.index_object_key
           ),
           status = 'ready',
           last_error = '',
           updated_at = EXCLUDED.updated_at
       RETURNING ${COLUMNS}`,
      [
        recordQrId,
        manifestObjectKey,
        legacyManifestObjectKey || null,
        indexObjectKey || null,
        createdAt,
        updatedAt
      ]
    );
    return oneOrNull(result, mapArchive, 'REPOSITORY_UPDATE_RESULT_INVALID');
  }

  async markFailed({ record_qr_id: recordQrId, last_error: lastError, updated_at: updatedAt }) {
    const result = await executeQuery(
      this.transactionContext,
      `INSERT INTO app.record_archives
         (${COLUMNS})
       VALUES ($1, NULL, NULL, NULL, 'failed', $2, $3, $3)
       ON CONFLICT (record_qr_id) DO UPDATE
       SET status = 'failed', last_error = EXCLUDED.last_error,
           updated_at = EXCLUDED.updated_at
       WHERE app.record_archives.status <> 'ready'
       RETURNING ${COLUMNS}`,
      [recordQrId, lastError, updatedAt]
    );
    return oneOrNull(result, mapArchive, 'REPOSITORY_UPDATE_RESULT_INVALID');
  }

  async #findByRecordId(recordQrId, forUpdate) {
    const result = await executeQuery(
      this.transactionContext,
      `SELECT ${COLUMNS} FROM app.record_archives
       WHERE record_qr_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [recordQrId]
    );
    return oneOrNull(result, mapArchive);
  }
}

module.exports = { ArchiveRepository };
