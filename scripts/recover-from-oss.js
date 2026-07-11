const fs = require('fs');
const path = require('path');
require('dotenv').config();

const {
  readTextObjectAtKey,
  readObjectBuffer
} = require('../src/server/services/storageService');
const {
  hashManifest
} = require('../src/server/services/manifestService');
const {
  getDatabaseSnapshot,
  writeDatabaseSnapshot
} = require('../src/server/services/dbService');

const args = new Set(process.argv.slice(2));
const writeMode = args.has('--write');
const outputDir = path.join(process.cwd(), 'recovery-output');

function parseJsonLines(raw) {
  return String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function recordFromArchive(archiveDoc, indexEntry) {
  const manifest = archiveDoc.sealed_manifest || archiveDoc;
  const record = manifest.record || {};
  const chain = archiveDoc.archive && archiveDoc.archive.chain ? archiveDoc.archive.chain : {};
  return {
    id: record.star_id || indexEntry.star_id,
    issue_status: 'issued',
    activation_status: record.activation_status || 'activated',
    hidden: false,
    batch_id: record.brand ? record.brand.batch_id || null : null,
    print_batch_id: null,
    quality_check: {
      checked: false,
      checked_at: null,
      checked_by: null,
      result: null
    },
    content: record.content || '',
    image_url: record.image ? record.image.url || null : null,
    image_object_key: record.image ? record.image.object_key || null : null,
    image_sha256: record.image ? record.image.sha256 || indexEntry.image_sha256 || null : indexEntry.image_sha256 || null,
    phone: null,
    activated_at: record.sealed_at || indexEntry.sealed_at || null,
    blockchain_hash: archiveDoc.manifest_hash || indexEntry.manifest_hash || null,
    chain_provider: chain.provider || 'avata_wenchang',
    chain_status: chain.status || indexEntry.chain_status || 'not_started',
    chain_operation_id: chain.operation_id || null,
    manifest_object_key: indexEntry.manifest_object_key,
    manifest_hash: archiveDoc.manifest_hash || indexEntry.manifest_hash || null,
    chain_tx_hash: chain.tx_hash || indexEntry.chain_tx_hash || null,
    chain_block_height: chain.block_height || null,
    chain_record_id: chain.record_id || null,
    chain_certificate_url: chain.certificate_url || null,
    chain_certificate_object_key: chain.certificate_object_key || indexEntry.chain_certificate_object_key || null,
    chain_certificate_object_url: null,
    chain_confirmed_at: chain.confirmed_at || null,
    chain_callback_received_at: null,
    chain_last_error: '',
    chain_retry_count: 0,
    legacy_manifest_object_key: null,
    archive_index_object_key: `indexes/by-star/${indexEntry.star_id}.json`,
    archive_status: 'ready',
    archive_last_error: '',
    archive_updated_at: indexEntry.updated_at || null,
    co_creation_enabled: record.co_creation ? record.co_creation.enabled === true : false,
    co_creation_owner_phone: null,
    co_creation_comments: record.co_creation ? record.co_creation.comments || [] : [],
    co_creation_started_at: null,
    show_brand_disclosure: record.brand ? record.brand.show_brand_disclosure === true : false,
    brand_disclosure_text_snapshot: record.brand ? record.brand.disclosure_text || '' : '',
    qr_image_url: null,
    qr_access_token: null,
    created_at: record.sealed_at || new Date().toISOString()
  };
}

async function loadArchiveRecord(indexEntry) {
  const raw = await readTextObjectAtKey(indexEntry.manifest_object_key);
  if (!raw) throw new Error(`manifest not found: ${indexEntry.manifest_object_key}`);
  const archiveDoc = JSON.parse(raw);
  const manifest = archiveDoc.sealed_manifest || archiveDoc;
  const computedHash = hashManifest(manifest);
  if (archiveDoc.manifest_hash && archiveDoc.manifest_hash !== computedHash) {
    throw new Error(`manifest hash mismatch for ${indexEntry.star_id}`);
  }
  if (indexEntry.image_object_key && indexEntry.image_sha256) {
    const imageBuffer = await readObjectBuffer(indexEntry.image_object_key);
    if (!imageBuffer) throw new Error(`image not found: ${indexEntry.image_object_key}`);
    const { sha256Hex } = require('../src/server/services/hashService');
    const imageHash = sha256Hex(imageBuffer);
    if (imageHash !== indexEntry.image_sha256) {
      throw new Error(`image hash mismatch for ${indexEntry.star_id}`);
    }
  }
  return recordFromArchive(archiveDoc, indexEntry);
}

async function main() {
  const rawIndex = await readTextObjectAtKey('indexes/records.jsonl');
  const entries = parseJsonLines(rawIndex);
  const recoveredRecords = [];
  const errors = [];

  for (const entry of entries) {
    try {
      recoveredRecords.push(await loadArchiveRecord(entry));
    } catch (error) {
      errors.push({
        star_id: entry.star_id,
        message: error.message
      });
    }
  }

  const currentDb = getDatabaseSnapshot();
  const byId = new Map((currentDb.qr_codes || []).map((item) => [item.id, item]));
  recoveredRecords.forEach((record) => {
    byId.set(record.id, {
      ...(byId.get(record.id) || {}),
      ...record
    });
  });
  const nextDb = {
    ...currentDb,
    qr_codes: Array.from(byId.values())
  };

  if (writeMode) {
    writeDatabaseSnapshot(nextDb);
  } else {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'recovered-db.json'), JSON.stringify(nextDb, null, 2));
  }

  console.log(JSON.stringify({
    mode: writeMode ? 'write' : 'dry-run',
    recovered_count: recoveredRecords.length,
    error_count: errors.length,
    errors
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
