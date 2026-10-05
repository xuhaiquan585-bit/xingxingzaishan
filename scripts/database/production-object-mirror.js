'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { withTransaction } = require('../../src/server/database/transaction');
const {
  downloadProtectedObjectFromOss
} = require('../../src/server/services/storageService');

const MIRROR_MANIFEST_PREFIX = 'backups/xingxingzaishan/object-mirror/manifests';

const OBJECT_KEY_QUERY = `WITH referenced_objects AS (
  SELECT image_object_key AS object_key FROM app.records
  UNION ALL
  SELECT regexp_replace(image_object_key, '-record-v2\\.jpg$', '-thumb-v2.jpg')
  FROM app.records
  WHERE image_object_key ~ '-record-v2\\.jpg$'
  UNION ALL SELECT cover_image_object_key FROM app.products
  UNION ALL SELECT image_object_key FROM app.product_images
  UNION ALL SELECT manifest_object_key FROM app.record_proofs
  UNION ALL SELECT certificate_object_key FROM app.record_proofs
  UNION ALL SELECT manifest_object_key FROM app.record_archives
  UNION ALL SELECT legacy_manifest_object_key FROM app.record_archives
  UNION ALL SELECT index_object_key FROM app.record_archives
  UNION ALL SELECT artifact_object_key FROM app.print_batches
)
SELECT DISTINCT btrim(object_key) AS object_key
FROM referenced_objects
WHERE object_key IS NOT NULL AND btrim(object_key) <> ''
ORDER BY object_key`;

class ProductionObjectMirrorError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ProductionObjectMirrorError';
    this.code = code;
  }
}

function mirrorError(code) {
  return new ProductionObjectMirrorError(code);
}

function safeErrorCode(error) {
  const code = String(error && error.code || '');
  return error instanceof ProductionObjectMirrorError || /^MIRROR_[A-Z0-9_]+$/.test(code)
    ? code
    : 'PRODUCTION_OBJECT_MIRROR_UNEXPECTED_FAILURE';
}

function normalizeText(value) {
  return String(value || '').trim();
}

function assertObjectKey(value) {
  const key = normalizeText(value);
  if (!key || key.startsWith('/') || key.includes('\\') || /[\x00-\x1f\x7f]/.test(key)) {
    throw mirrorError('MIRROR_OBJECT_KEY_INVALID');
  }
  const segments = key.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw mirrorError('MIRROR_OBJECT_KEY_INVALID');
  }
  return key;
}

async function listReferencedObjectKeys({ pool }) {
  return withTransaction(pool, async (context) => {
    const result = await context.query(OBJECT_KEY_QUERY);
    const keys = (result.rows || []).map((row) => assertObjectKey(row.object_key));
    if (new Set(keys).size !== keys.length) {
      throw mirrorError('MIRROR_OBJECT_KEY_DUPLICATE');
    }
    return Object.freeze(keys);
  }, { isolationLevel: 'repeatable read', readOnly: true });
}

function bucketIdentity(result, configuredBucket) {
  const bucket = result && (result.bucket || result.Bucket) || {};
  const owner = bucket.Owner || bucket.owner || result?.Owner || result?.owner || {};
  const acl = bucket.AccessControlList || bucket.accessControlList
    || result?.AccessControlList || result?.accessControlList || {};
  return Object.freeze({
    name: normalizeText(bucket.Name || bucket.name || configuredBucket),
    location: normalizeText(bucket.Location || bucket.location),
    ownerId: normalizeText(owner.ID || owner.Id || owner.id),
    acl: normalizeText(acl.Grant || acl.grant || result?.acl).toLowerCase()
  });
}

async function inspectBucket(client, configuredBucket) {
  if (!client || typeof client.getBucketInfo !== 'function') {
    throw mirrorError('MIRROR_BUCKET_INFO_UNAVAILABLE');
  }
  let result;
  try {
    result = await client.getBucketInfo(configuredBucket);
  } catch (_error) {
    throw mirrorError('MIRROR_BUCKET_INFO_FAILED');
  }
  const identity = bucketIdentity(result, configuredBucket);
  if (!identity.name || !identity.location || !identity.ownerId || !identity.acl) {
    throw mirrorError('MIRROR_BUCKET_INFO_INCOMPLETE');
  }
  return identity;
}

function assertIndependentBuckets(source, destination) {
  if (!source || !destination) throw mirrorError('MIRROR_BUCKET_INFO_INCOMPLETE');
  for (const identity of [source, destination]) {
    if (!identity.name || !identity.location || !identity.ownerId || !identity.acl) {
      throw mirrorError('MIRROR_BUCKET_INFO_INCOMPLETE');
    }
  }
  if (source.acl !== 'private') throw mirrorError('MIRROR_SOURCE_NOT_PRIVATE');
  if (source.name === destination.name) throw mirrorError('MIRROR_BUCKET_NOT_INDEPENDENT');
  if (source.location === destination.location) throw mirrorError('MIRROR_REGION_NOT_INDEPENDENT');
  if (source.ownerId === destination.ownerId) throw mirrorError('MIRROR_OWNER_NOT_INDEPENDENT');
  if (destination.acl !== 'private') throw mirrorError('MIRROR_DESTINATION_NOT_PRIVATE');
  return Object.freeze({ source, destination });
}

function responseHeaders(result) {
  const source = result?.res?.headers || result?.headers || {};
  return Object.fromEntries(
    Object.entries(source).map(([key, value]) => [String(key).toLowerCase(), value])
  );
}

async function getMirrorObjectMetadata({ objectKey, client }) {
  const safeKey = assertObjectKey(objectKey);
  if (!client || typeof client.head !== 'function') {
    throw mirrorError('MIRROR_METADATA_READER_UNAVAILABLE');
  }
  const result = await client.head(safeKey);
  const headers = responseHeaders(result);
  const userMetadata = result?.meta || {};
  const status = Number(result?.status || result?.res?.status || 0);
  return Object.freeze({
    status,
    metadata_status: status,
    size: Number(headers['content-length']),
    sha256: String(userMetadata.sha256 || headers['x-oss-meta-sha256'] || ''),
    declared_size: String(userMetadata.size || headers['x-oss-meta-size'] || ''),
    etag: String(headers.etag || '').replace(/^"|"$/g, '')
  });
}

function verifySourceMetadata(metadata) {
  if (!metadata
      || Number(metadata.status) !== 200
      || Number(metadata.metadata_status ?? metadata.status) !== 200
      || !Number.isSafeInteger(Number(metadata.size))
      || Number(metadata.size) <= 0
      || !normalizeText(metadata.etag)) {
    throw mirrorError('MIRROR_SOURCE_METADATA_INVALID');
  }
  return metadata;
}

function buildPreviousEntryMap(previousManifest, sourceIdentity, destinationIdentity) {
  if (!previousManifest) return new Map();
  validateMirrorManifest(previousManifest);
  if (!sameBucketIdentity(previousManifest.source, sourceIdentity)
      || !sameBucketIdentity(previousManifest.destination, destinationIdentity)) {
    return new Map();
  }
  return new Map(previousManifest.objects
    .filter((entry) => normalizeText(entry.source_etag))
    .map((entry) => [entry.object_key, entry]));
}

function writeJsonExclusive(filePath, value) {
  let descriptor;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      0o600
    );
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.fchmodSync(descriptor, 0o600);
  } catch (_error) {
    throw mirrorError('MIRROR_EVIDENCE_WRITE_FAILED');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(filePath)) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { path: filePath, sha256: hash.digest('hex'), size };
}

function buildMirrorManifestObjectKey(runId) {
  if (!/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(String(runId || ''))) {
    throw mirrorError('MIRROR_RUN_ID_INVALID');
  }
  return [
    MIRROR_MANIFEST_PREFIX,
    runId.slice(0, 4),
    runId.slice(4, 6),
    runId.slice(6, 8),
    `${runId}-object-mirror-manifest.json`
  ].join('/');
}

function sameBucketIdentity(left, right) {
  return ['name', 'location', 'ownerId', 'acl']
    .every((key) => normalizeText(left && left[key]).toLowerCase()
      === normalizeText(right && right[key]).toLowerCase());
}

function validateMirrorManifest(manifest) {
  const schemaVersion = Number(manifest && manifest.schema_version);
  const countedObjects = schemaVersion === 1
    ? Number(manifest && manifest.copied_count)
      + Number(manifest && manifest.verified_existing_count)
    : Number(manifest && manifest.copied_count)
      + Number(manifest && manifest.locally_reused_count);
  if (!manifest || typeof manifest !== 'object'
      || ![1, 2].includes(schemaVersion)
      || manifest.status !== 'COMPLETE'
      || !/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(String(manifest.run_id || ''))
      || !Array.isArray(manifest.objects)
      || manifest.object_count !== manifest.objects.length
      || countedObjects !== manifest.object_count
      || manifest.manifest_object_key !== buildMirrorManifestObjectKey(manifest.run_id)) {
    throw mirrorError('MIRROR_MANIFEST_INVALID');
  }
  if (schemaVersion === 2
      && (manifest.destination_object_read !== 'NONE'
        || manifest.restore_verification !== 'INDEPENDENT_AUDIT_REQUIRED')) {
    throw mirrorError('MIRROR_MANIFEST_INVALID');
  }
  const keys = new Set();
  for (const entry of manifest.objects) {
    const key = assertObjectKey(entry && entry.object_key);
    if (keys.has(key)
        || !/^[a-f0-9]{64}$/.test(String(entry.sha256 || ''))
        || !Number.isSafeInteger(Number(entry.size))
        || Number(entry.size) <= 0) {
      throw mirrorError('MIRROR_MANIFEST_INVALID');
    }
    keys.add(key);
  }
  return manifest;
}

async function uploadMirrorObjectWriteOnly({
  objectKey,
  localPath,
  contentType = 'application/octet-stream',
  sha256,
  size,
  client
}) {
  const safeKey = assertObjectKey(objectKey);
  if (!path.isAbsolute(String(localPath || ''))
      || !/^[a-f0-9]{64}$/.test(String(sha256 || ''))
      || !Number.isSafeInteger(Number(size))
      || Number(size) <= 0
      || !client
      || typeof client.put !== 'function') {
    throw mirrorError('MIRROR_DESTINATION_UPLOAD_ARGUMENT_INVALID');
  }
  const result = await client.put(safeKey, localPath, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'private, max-age=0, no-cache',
      'x-oss-forbid-overwrite': 'true'
    },
    meta: {
      sha256,
      size: String(size)
    }
  });
  const status = Number(result?.res?.status || result?.status || 0);
  const etag = normalizeText(responseHeaders(result).etag).replace(/^"|"$/g, '');
  if (status !== 200 || !etag) {
    throw mirrorError('MIRROR_DESTINATION_WRITE_RECEIPT_INVALID');
  }
  return Object.freeze({ status, etag, size: Number(size), sha256 });
}

function selectRestoreAuditEntries(manifest, { mode = 'all', sampleSize = 20 } = {}) {
  const entries = [...validateMirrorManifest(manifest).objects];
  if (mode === 'all') return entries;
  if (mode !== 'sample' || !Number.isSafeInteger(sampleSize) || sampleSize < 1) {
    throw mirrorError('MIRROR_RESTORE_AUDIT_MODE_INVALID');
  }
  return entries
    .sort((left, right) => crypto.createHash('sha256')
      .update(`${manifest.run_id}\0${left.object_key}`)
      .digest('hex')
      .localeCompare(crypto.createHash('sha256')
        .update(`${manifest.run_id}\0${right.object_key}`)
        .digest('hex')))
    .slice(0, Math.min(sampleSize, entries.length));
}

async function mirrorOneObject({
  objectKey,
  sourceClient,
  destinationClient,
  temporaryPath,
  previousEntry = null,
  downloader = downloadProtectedObjectFromOss,
  uploader = uploadMirrorObjectWriteOnly,
  sourceMetadataReader = getMirrorObjectMetadata
}) {
  const safeKey = assertObjectKey(objectKey);
  let sourceMetadata;
  try {
    sourceMetadata = verifySourceMetadata(await sourceMetadataReader({
      objectKey: safeKey,
      client: sourceClient
    }));
  } catch (error) {
    if (error instanceof ProductionObjectMirrorError) throw error;
    throw mirrorError('MIRROR_SOURCE_METADATA_FAILED');
  }

  if (previousEntry
      && previousEntry.object_key === safeKey
      && Number(previousEntry.size) === Number(sourceMetadata.size)
      && normalizeText(previousEntry.source_etag) === normalizeText(sourceMetadata.etag)
      && /^[a-f0-9]{64}$/.test(String(previousEntry.sha256 || ''))
      && normalizeText(previousEntry.destination_etag)) {
    return Object.freeze({
      object_key: safeKey,
      sha256: previousEntry.sha256,
      size: Number(previousEntry.size),
      source_etag: normalizeText(sourceMetadata.etag),
      destination_etag: normalizeText(previousEntry.destination_etag),
      copied: false,
      source_downloaded: false
    });
  }

  let source;
  try {
    source = await downloader({
      objectKey: safeKey,
      destinationPath: temporaryPath,
      client: sourceClient
    });
  } catch (_error) {
    throw mirrorError('MIRROR_SOURCE_DOWNLOAD_FAILED');
  }
  if (!source || Number(source.status) !== 200 || !/^[a-f0-9]{64}$/.test(String(source.sha256 || ''))
    || !Number.isSafeInteger(Number(source.size)) || Number(source.size) <= 0) {
    throw mirrorError('MIRROR_SOURCE_INTEGRITY_INVALID');
  }
  if (Number(source.size) !== Number(sourceMetadata.size)
      || (normalizeText(source.etag)
        && normalizeText(source.etag) !== normalizeText(sourceMetadata.etag))
      || (normalizeText(sourceMetadata.sha256)
        && normalizeText(source.sha256) !== normalizeText(sourceMetadata.sha256))) {
    throw mirrorError('MIRROR_SOURCE_CHANGED_DURING_COPY');
  }
  let destination;
  try {
    destination = await uploader({
      objectKey: safeKey,
      localPath: temporaryPath,
      contentType: source.contentType || 'application/octet-stream',
      sha256: source.sha256,
      size: Number(source.size),
      client: destinationClient
    });
  } catch (error) {
    if (['PreconditionFailed', 'FileAlreadyExists'].includes(error && error.code)
        || [409, 412].includes(error && (error.status || error.statusCode))) {
      throw mirrorError('MIRROR_DESTINATION_COLLISION_REQUIRES_AUDIT');
    }
    if (error instanceof ProductionObjectMirrorError) throw error;
    throw mirrorError('MIRROR_DESTINATION_UPLOAD_FAILED');
  }
  if (!destination || Number(destination.status) !== 200
      || !normalizeText(destination.etag)) {
    throw mirrorError('MIRROR_DESTINATION_WRITE_RECEIPT_INVALID');
  }
  return Object.freeze({
    object_key: safeKey,
    sha256: source.sha256,
    size: Number(source.size),
    source_etag: normalizeText(source.etag),
    destination_etag: normalizeText(destination.etag),
    copied: true,
    source_downloaded: true
  });
}

async function executeObjectMirror({
  objectKeys,
  sourceClient,
  destinationClient,
  sourceBucket,
  destinationBucket,
  runId,
  outputDirectory,
  previousManifest = null,
  concurrency = 8,
  downloader,
  uploader,
  sourceMetadataReader,
  now = new Date()
}) {
  if (!/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(String(runId || ''))) {
    throw mirrorError('MIRROR_RUN_ID_INVALID');
  }
  if (!path.isAbsolute(String(outputDirectory || ''))) {
    throw mirrorError('MIRROR_OUTPUT_DIRECTORY_INVALID');
  }
  let stat;
  try {
    stat = fs.lstatSync(outputDirectory);
  } catch (_error) {
    throw mirrorError('MIRROR_OUTPUT_DIRECTORY_INVALID');
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw mirrorError('MIRROR_OUTPUT_DIRECTORY_INVALID');
  }
  const sourceIdentity = await inspectBucket(sourceClient, sourceBucket);
  const destinationIdentity = await inspectBucket(destinationClient, destinationBucket);
  assertIndependentBuckets(sourceIdentity, destinationIdentity);
  const previousEntries = buildPreviousEntryMap(
    previousManifest,
    sourceIdentity,
    destinationIdentity
  );

  const keys = objectKeys.map(assertObjectKey);
  if (new Set(keys).size !== keys.length) throw mirrorError('MIRROR_OBJECT_KEY_DUPLICATE');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw mirrorError('MIRROR_CONCURRENCY_INVALID');
  }
  const temporaryDirectory = path.join(outputDirectory, 'objects');
  fs.mkdirSync(temporaryDirectory, { mode: 0o700 });
  const entries = new Array(keys.length);
  let nextIndex = 0;
  let firstError = null;
  try {
    async function worker() {
      while (!firstError) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= keys.length) return;
        const temporaryPath = path.join(
          temporaryDirectory,
          `${String(index).padStart(8, '0')}-${crypto.createHash('sha256').update(keys[index]).digest('hex')}.object`
        );
        try {
          entries[index] = await mirrorOneObject({
            objectKey: keys[index],
            sourceClient,
            destinationClient,
            temporaryPath,
            previousEntry: previousEntries.get(keys[index]) || null,
            downloader,
            uploader,
            sourceMetadataReader
          });
        } catch (error) {
          firstError = firstError || error;
        } finally {
          fs.rmSync(temporaryPath, { force: true });
        }
      }
    }
    await Promise.all(Array.from(
      { length: Math.min(concurrency, Math.max(1, keys.length)) },
      () => worker()
    ));
    if (firstError) throw firstError;
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  const manifest = {
    schema_version: 2,
    status: 'COMPLETE',
    run_id: runId,
    completed_at_utc: now.toISOString(),
    consistency: 'database reference snapshot followed by immutable object copy',
    source: sourceIdentity,
    destination: destinationIdentity,
    object_count: entries.length,
    copied_count: entries.filter((entry) => entry.copied).length,
    locally_reused_count: entries.filter((entry) => !entry.copied).length,
    source_downloaded_count: entries.filter((entry) => entry.source_downloaded).length,
    destination_object_read: 'NONE',
    restore_verification: 'INDEPENDENT_AUDIT_REQUIRED',
    incremental_base_run_id: entries.some((entry) => !entry.source_downloaded)
      ? previousManifest.run_id
      : null,
    manifest_object_key: buildMirrorManifestObjectKey(runId),
    objects: entries
  };
  const manifestPath = path.join(outputDirectory, `${runId}-object-mirror-manifest.json`);
  writeJsonExclusive(manifestPath, manifest);
  const manifestArtifact = await sha256File(manifestPath);
  let uploadedManifest;
  try {
    uploadedManifest = await (uploader || uploadMirrorObjectWriteOnly)({
      objectKey: manifest.manifest_object_key,
      localPath: manifestPath,
      contentType: 'application/json; charset=utf-8',
      sha256: manifestArtifact.sha256,
      size: manifestArtifact.size,
      client: destinationClient
    });
  } catch (error) {
    if (['PreconditionFailed', 'FileAlreadyExists'].includes(error && error.code)
        || [409, 412].includes(error && (error.status || error.statusCode))) {
      throw mirrorError('MIRROR_MANIFEST_COLLISION_REQUIRES_AUDIT');
    }
    if (error instanceof ProductionObjectMirrorError) throw error;
    throw mirrorError('MIRROR_MANIFEST_UPLOAD_FAILED');
  }
  if (!uploadedManifest || Number(uploadedManifest.status) !== 200
      || !normalizeText(uploadedManifest.etag)) {
    throw mirrorError('MIRROR_MANIFEST_WRITE_RECEIPT_INVALID');
  }
  return Object.freeze({
    manifest,
    manifestArtifact,
    manifestRemote: Object.freeze({
      object_key: manifest.manifest_object_key,
      etag: normalizeText(uploadedManifest.etag)
    }),
    manifestPath
  });
}

async function executeObjectRestoreAudit({
  manifest,
  destinationClient,
  destinationBucket,
  outputDirectory,
  mode = 'all',
  sampleSize = 20,
  downloader = downloadProtectedObjectFromOss,
  now = new Date()
}) {
  validateMirrorManifest(manifest);
  if (!path.isAbsolute(String(outputDirectory || ''))) {
    throw mirrorError('MIRROR_OUTPUT_DIRECTORY_INVALID');
  }
  let outputStat;
  try {
    outputStat = fs.lstatSync(outputDirectory);
  } catch (_error) {
    throw mirrorError('MIRROR_OUTPUT_DIRECTORY_INVALID');
  }
  if (outputStat.isSymbolicLink() || !outputStat.isDirectory()) {
    throw mirrorError('MIRROR_OUTPUT_DIRECTORY_INVALID');
  }
  const destinationIdentity = await inspectBucket(destinationClient, destinationBucket);
  if (!sameBucketIdentity(destinationIdentity, manifest.destination)) {
    throw mirrorError('MIRROR_RESTORE_BUCKET_MISMATCH');
  }
  const selected = selectRestoreAuditEntries(manifest, { mode, sampleSize });
  const temporaryDirectory = path.join(outputDirectory, 'restore-audit-objects');
  try {
    fs.mkdirSync(temporaryDirectory, { mode: 0o700 });
  } catch (_error) {
    throw mirrorError('MIRROR_RESTORE_DIRECTORY_FAILED');
  }
  const verified = [];
  try {
    for (let index = 0; index < selected.length; index += 1) {
      const entry = selected[index];
      const temporaryPath = path.join(
        temporaryDirectory,
        `${String(index).padStart(8, '0')}-${crypto.createHash('sha256')
          .update(entry.object_key).digest('hex')}.object`
      );
      try {
        let downloaded;
        try {
          downloaded = await downloader({
            objectKey: entry.object_key,
            destinationPath: temporaryPath,
            client: destinationClient
          });
        } catch (_error) {
          throw mirrorError('MIRROR_RESTORE_DOWNLOAD_FAILED');
        }
        if (!downloaded || Number(downloaded.status) !== 200
            || Number(downloaded.size) !== Number(entry.size)
            || normalizeText(downloaded.sha256) !== normalizeText(entry.sha256)) {
          throw mirrorError('MIRROR_RESTORE_INTEGRITY_MISMATCH');
        }
        verified.push({
          object_key: entry.object_key,
          sha256: entry.sha256,
          size: Number(entry.size)
        });
      } finally {
        fs.rmSync(temporaryPath, { force: true });
      }
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  const audit = {
    schema_version: 1,
    status: 'PASS',
    mirror_run_id: manifest.run_id,
    completed_at_utc: now.toISOString(),
    mode,
    manifest_object_count: manifest.object_count,
    verified_object_count: verified.length,
    destination: destinationIdentity,
    objects: verified
  };
  const auditPath = path.join(
    outputDirectory,
    `${manifest.run_id}-object-mirror-restore-audit.json`
  );
  writeJsonExclusive(auditPath, audit);
  return Object.freeze({ audit, auditArtifact: await sha256File(auditPath), auditPath });
}

module.exports = {
  OBJECT_KEY_QUERY,
  ProductionObjectMirrorError,
  assertIndependentBuckets,
  assertObjectKey,
  buildMirrorManifestObjectKey,
  buildPreviousEntryMap,
  bucketIdentity,
  executeObjectMirror,
  executeObjectRestoreAudit,
  inspectBucket,
  getMirrorObjectMetadata,
  listReferencedObjectKeys,
  mirrorOneObject,
  safeErrorCode,
  sameBucketIdentity,
  selectRestoreAuditEntries,
  validateMirrorManifest,
  uploadMirrorObjectWriteOnly,
  verifySourceMetadata
};
