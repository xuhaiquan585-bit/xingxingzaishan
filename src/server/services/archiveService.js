const path = require('path');
const { sha256Hex } = require('./hashService');
const {
  getObjectPrefix,
  getStorageMode,
  saveJsonObjectAtKey,
  readObjectBuffer,
  readTextObjectAtKey
} = require('./storageService');
const {
  buildRecordManifest,
  hashManifest
} = require('./manifestService');

function getDbService() {
  // Lazy require avoids dbService <-> archiveService initialization loops in tests.
  // eslint-disable-next-line global-require
  return require('./dbService');
}

function safeStarId(value) {
  return String(value || 'unknown').trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
}

function archivePaths(starId) {
  const safeId = safeStarId(starId);
  const prefix = getObjectPrefix();
  return {
    manifest: `${prefix}/${safeId}/record_manifest.json`,
    byStar: `indexes/by-star/${safeId}.json`,
    recordsIndex: 'indexes/records.jsonl',
    latestBackup: 'backups/db/latest.json',
    dailyBackup: `backups/db/daily/${new Date().toISOString().slice(0, 10)}.json`
  };
}

async function hashImageForRecord(record = {}) {
  if (record.image_sha256) return record.image_sha256;
  if (!record.image_object_key) return null;
  const buffer = await readObjectBuffer(record.image_object_key);
  return buffer ? sha256Hex(buffer) : null;
}

async function loadStoredSealedManifest(record = {}) {
  const objectKeys = [
    record.manifest_object_key,
    record.legacy_manifest_object_key
  ].filter(Boolean);
  for (const objectKey of objectKeys) {
    try {
      const raw = await readTextObjectAtKey(objectKey);
      if (!raw) continue;
      const doc = JSON.parse(raw);
      const manifest = doc.sealed_manifest || doc;
      if (record.manifest_hash && hashManifest(manifest) !== record.manifest_hash) {
        continue;
      }
      return manifest;
    } catch (_error) {
      // Ignore stale or unreadable archived copies and rebuild from the record below.
    }
  }
  return null;
}

function buildArchiveDocument({ record, manifest, manifestHash, imageSha256 }) {
  return {
    version: 'record_archive_v1',
    manifest_hash: manifestHash,
    sealed_manifest: manifest,
    archive: {
      star_id: record.id,
      stored_at: new Date().toISOString(),
      image_object_key: record.image_object_key || null,
      image_sha256: imageSha256 || null,
      chain: {
        provider: record.chain_provider || 'avata_wenchang',
        status: record.chain_status || 'not_started',
        operation_id: record.chain_operation_id || null,
        tx_hash: record.chain_tx_hash || null,
        block_height: record.chain_block_height || null,
        record_id: record.chain_record_id || null,
        certificate_url: record.chain_certificate_url || null,
        certificate_object_key: record.chain_certificate_object_key || null,
        confirmed_at: record.chain_confirmed_at || null
      }
    }
  };
}

function buildIndexEntry({ record, manifestHash, manifestObjectKey, imageSha256 }) {
  return {
    star_id: record.id,
    activation_status: record.activation_status,
    sealed_at: record.activated_at || null,
    content_preview: String(record.content || '').slice(0, 80),
    image_object_key: record.image_object_key || null,
    image_sha256: imageSha256 || null,
    manifest_object_key: manifestObjectKey,
    manifest_hash: manifestHash,
    chain_status: record.chain_status || 'not_started',
    chain_tx_hash: record.chain_tx_hash || null,
    chain_certificate_object_key: record.chain_certificate_object_key || null,
    updated_at: new Date().toISOString()
  };
}

async function upsertRecordsIndex(entry) {
  const paths = archivePaths(entry.star_id);
  const raw = await readTextObjectAtKey(paths.recordsIndex);
  const existing = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_error) {
        return null;
      }
    })
    .filter(Boolean)
    .filter((item) => item.star_id !== entry.star_id);
  existing.push(entry);
  const body = `${existing.map((item) => JSON.stringify(item)).join('\n')}\n`;
  await saveJsonlObject(paths.recordsIndex, body);
}

async function saveJsonlObject(objectKey, body) {
  const { saveBinaryObjectAtKey } = require('./storageService');
  return saveBinaryObjectAtKey({
    objectKey,
    buffer: Buffer.from(body, 'utf8'),
    contentType: 'application/x-ndjson; charset=utf-8'
  });
}

async function backupDatabaseToArchive(snapshot = null) {
  const db = snapshot || getDbService().getDatabaseSnapshot();
  const paths = archivePaths('db');
  const payload = {
    version: 'db_backup_v1',
    backed_up_at: new Date().toISOString(),
    db
  };
  const [latest, daily] = await Promise.all([
    saveJsonObjectAtKey({ objectKey: paths.latestBackup, data: payload }),
    saveJsonObjectAtKey({ objectKey: paths.dailyBackup, data: payload })
  ]);
  return {
    latest_object_key: latest.object_key,
    daily_object_key: daily.object_key
  };
}

async function writeRecordArchive({ record, manifest, manifestHash, imageSha256 }) {
  const paths = archivePaths(record.id);
  const archiveDocument = buildArchiveDocument({
    record,
    manifest,
    manifestHash,
    imageSha256
  });
  const storedManifest = await saveJsonObjectAtKey({
    objectKey: paths.manifest,
    data: archiveDocument
  });
  const indexEntry = buildIndexEntry({
    record,
    manifestHash,
    manifestObjectKey: storedManifest.object_key,
    imageSha256
  });
  const storedIndex = await saveJsonObjectAtKey({
    objectKey: paths.byStar,
    data: indexEntry
  });
  await upsertRecordsIndex(indexEntry);
  return {
    manifest_object_key: storedManifest.object_key,
    archive_index_object_key: storedIndex.object_key,
    archive_status: 'ready',
    archive_last_error: '',
    archive_updated_at: new Date().toISOString()
  };
}

async function buildManifestForArchive(record) {
  const imageSha256 = await hashImageForRecord(record);
  const storedManifest = await loadStoredSealedManifest(record);
  const manifest = storedManifest || buildRecordManifest({
    ...record,
    image_sha256: imageSha256
  });
  return {
    manifest,
    manifestHash: record.manifest_hash || hashManifest(manifest),
    imageSha256: imageSha256 || (manifest.record && manifest.record.image ? manifest.record.image.sha256 : null)
  };
}

async function rebuildRecordArchive(qrId) {
  const { getQRCode, updateRecordChainProof } = getDbService();
  const record = getQRCode(qrId);
  if (!record) return { error: 'QR_NOT_FOUND' };
  if (!['activated', 'co_creating'].includes(record.activation_status)) {
    return { error: 'RECORD_NOT_ARCHIVABLE' };
  }
  try {
    const { manifest, manifestHash, imageSha256 } = await buildManifestForArchive(record);
    const archivePatch = await writeRecordArchive({
      record: {
        ...record,
        image_sha256: imageSha256
      },
      manifest,
      manifestHash: record.manifest_hash || manifestHash,
      imageSha256
    });
    const updated = updateRecordChainProof(record.id, {
      ...archivePatch,
      image_sha256: imageSha256,
      manifest_object_key: archivePatch.manifest_object_key
    });
    await backupDatabaseToArchive();
    return { data: updated };
  } catch (error) {
    const updated = updateRecordChainProof(record.id, {
      archive_status: 'failed',
      archive_last_error: error.message || 'archive rebuild failed'
    });
    return { data: updated };
  }
}

async function refreshRecordArchive(record) {
  if (!record || !record.id || !['activated', 'co_creating'].includes(record.activation_status)) {
    return record;
  }
  const result = await rebuildRecordArchive(record.id);
  return result.data || record;
}

function getArchiveSystemStatus() {
  return {
    mode: getStorageMode(),
    object_prefix: getObjectPrefix(),
    manifest_path: path.posix.join(getObjectPrefix(), '{star_id}', 'record_manifest.json'),
    by_star_index_path: 'indexes/by-star/{star_id}.json',
    records_index_path: 'indexes/records.jsonl',
    db_backup_latest_path: 'backups/db/latest.json',
    configured: getStorageMode() !== 'cloud' || !!process.env.OSS_BUCKET
  };
}

module.exports = {
  archivePaths,
  hashImageForRecord,
  writeRecordArchive,
  buildManifestForArchive,
  rebuildRecordArchive,
  refreshRecordArchive,
  backupDatabaseToArchive,
  getArchiveSystemStatus
};
