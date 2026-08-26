const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const rootDir = path.join(__dirname, '..');
const storageRoot = process.env.STORAGE_ROOT ? path.resolve(process.env.STORAGE_ROOT) : rootDir;
const localUploadDir = path.join(storageRoot, 'public', 'uploads');
const bufferDir = path.join(storageRoot, 'buffer', 'uploads');
const cloudMockDir = path.join(storageRoot, 'public', 'cloud');

const IMAGE_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/heic': '.heic'
};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function buildFileName(originalname, mimetype) {
  const knownExt = IMAGE_TYPES[mimetype];
  const ext = knownExt || path.extname(originalname || '') || '.jpg';
  return `${Date.now()}-${Math.random().toString(16).slice(2)}${ext.toLowerCase()}`;
}

function sanitizePathSegment(value, fallback = 'unknown') {
  const text = String(value || '').trim();
  if (!text) return fallback;
  return text.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || fallback;
}

function getStorageMode() {
  return process.env.STORAGE_MODE === 'cloud' ? 'cloud' : 'local';
}

function saveBinaryFile(dir, fileName, buffer) {
  ensureDir(dir);
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

function makeCloudPublicUrl(objectKey) {
  const baseUrl = process.env.CLOUD_PUBLIC_BASE_URL;
  if (baseUrl) {
    return `${baseUrl.replace(/\/$/, '')}/${objectKey}`;
  }
  return `/cloud/${objectKey}`;
}

function getPublicObjectUrl(objectKey) {
  if (!objectKey) return null;
  if (getStorageMode() === 'cloud') {
    return makeCloudPublicUrl(objectKey);
  }
  const safeKey = String(objectKey).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
  return `/uploads/${safeKey}`;
}

function getOssConfig() {
  return {
    endpoint: process.env.OSS_ENDPOINT,
    region: process.env.OSS_REGION,
    bucket: process.env.OSS_BUCKET,
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    secure: process.env.OSS_SECURE !== 'false'
  };
}

function assertOssConfig() {
  const config = getOssConfig();
  const missing = Object.entries(config)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(`OSS配置不完整: ${missing.join(', ')}`);
  }

  return config;
}

let cachedClient = null;

function getOssClient() {
  if (cachedClient) return cachedClient;

  let OSS;
  try {
    // eslint-disable-next-line global-require
    OSS = require('ali-oss');
  } catch (_error) {
    throw new Error('缺少 ali-oss 依赖，请先安装后再启用 STORAGE_MODE=cloud');
  }

  const config = assertOssConfig();
  cachedClient = new OSS(config);
  return cachedClient;
}

function getObjectPrefix() {
  return sanitizePathSegment(process.env.OSS_OBJECT_PREFIX || 'stars', 'stars');
}

function buildObjectKey({ qrId, fileName }) {
  const prefix = getObjectPrefix();
  const group = sanitizePathSegment(qrId || 'unbound', 'unbound');
  return `${prefix}/${group}/${fileName}`;
}

function recordImageQrIdSha256(qrId) {
  const canonicalQrId = String(qrId || '').trim();
  if (!canonicalQrId) throw new Error('RECORD_IMAGE_QR_ID_INVALID');
  return crypto.createHash('sha256').update(canonicalQrId, 'utf8').digest('hex');
}

function buildRecordImageObjectKey({ qrId, fileName }) {
  const hash = recordImageQrIdSha256(qrId);
  const safeFileName = path.basename(String(fileName || ''));
  if (!/^[a-zA-Z0-9_.-]+\.jpg$/.test(safeFileName)) {
    throw new Error('RECORD_IMAGE_FILE_NAME_INVALID');
  }
  return `${getObjectPrefix()}/record-images/${hash}/${safeFileName}`;
}

function isCurrentRecordImageObjectKey(value) {
  const objectKey = String(value || '').trim();
  if (!objectKey || objectKey.includes('\\') || objectKey.includes('%')
      || objectKey.includes('//') || /^[a-z][a-z0-9+.-]*:/i.test(objectKey)
      || objectKey.startsWith('/')) {
    return false;
  }
  const segments = objectKey.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..'
      || !/^[a-zA-Z0-9_.-]+$/.test(segment))) {
    return false;
  }
  if (segments[0].toLowerCase() === 'backups') return false;
  const prefix = getObjectPrefix();
  return segments.length === 4
    && segments[0] === prefix
    && segments[1] === 'record-images'
    && /^[a-f0-9]{64}$/.test(segments[2])
    && /^[a-zA-Z0-9_.-]+\.jpg$/.test(segments[3]);
}

function isRecordImageObjectKeyForQrId(value, qrId) {
  if (!isCurrentRecordImageObjectKey(value)) return false;
  return String(value).split('/')[2] === recordImageQrIdSha256(qrId);
}

function parseStrictObjectKey(value) {
  const objectKey = String(value || '').trim();
  if (!objectKey || objectKey.includes('\\') || objectKey.includes('%')
      || objectKey.includes('//') || /^[a-z][a-z0-9+.-]*:/i.test(objectKey)
      || objectKey.startsWith('/') || /[?#\u0000-\u001f\u007f]/.test(objectKey)) return null;
  const segments = objectKey.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..'
      || !/^[a-zA-Z0-9_.-]+$/.test(segment))) return null;
  return { objectKey, segments };
}

function normalizeRecordMediaAuthority(authority) {
  const qrId = String(authority && (authority.qrId || authority.qr_id) || '').trim();
  const accessToken = String(
    authority && (authority.accessToken || authority.access_token || authority.qr_access_token) || ''
  ).trim();
  return { qrId, accessToken };
}

function isLegacyPrefixedRecordImageObjectKeyForAuthority(value, authority) {
  const parsed = parseStrictObjectKey(value);
  if (!parsed) return false;
  const { qrId, accessToken } = normalizeRecordMediaAuthority(authority);
  if (!qrId || !/^[a-f0-9]{32}$/.test(accessToken)) return false;
  if (sanitizePathSegment(accessToken, '') !== accessToken) return false;

  const { segments } = parsed;
  return segments.length === 3
    && segments[0] === getObjectPrefix()
    && segments[1] === accessToken
    && /^[a-zA-Z0-9_.-]+\.(?:jpg|png)$/.test(segments[2]);
}

function resolveLegacySingleFileRecordImageUrl({ objectKey, imageUrl } = {}) {
  const parsed = parseStrictObjectKey(objectKey);
  if (!parsed || parsed.segments.length !== 1) return null;
  const fileName = parsed.segments[0];
  if (!/^[a-zA-Z0-9_.-]+\.jpg$/.test(fileName)) return null;

  const exactUrl = `/uploads/${fileName}`;
  return String(imageUrl || '') === exactUrl ? exactUrl : null;
}

function isSafeRecordImageSnapshotUrl(value) {
  const imageUrl = String(value || '').trim();
  if (!imageUrl || imageUrl.includes('\\') || imageUrl.includes('%')
      || /[\u0000-\u001f\u007f]/.test(imageUrl)) return false;
  if (/^https:\/\/[^/?#]+\/[^?#]+$/i.test(imageUrl)) return true;
  return /^\/uploads\/[a-zA-Z0-9_.-]+\.jpg$/.test(imageUrl);
}

function classifyRecordImageReference({ record, authority } = {}) {
  const objectKey = String(record && record.image_object_key || '').trim();
  const imageUrl = String(
    record && (record.image_url_snapshot || record.image_url) || ''
  ).trim();
  const { qrId } = normalizeRecordMediaAuthority(authority);

  if (!objectKey) {
    return isSafeRecordImageSnapshotUrl(imageUrl)
      ? Object.freeze({ kind: 'snapshot', url: imageUrl })
      : Object.freeze({ kind: 'rejected' });
  }

  if (qrId && isRecordImageObjectKeyForQrId(objectKey, qrId)) {
    return Object.freeze({ kind: 'object', objectKey, namespace: 'current' });
  }
  if (isLegacyPrefixedRecordImageObjectKeyForAuthority(objectKey, authority)) {
    return Object.freeze({ kind: 'object', objectKey, namespace: 'legacy-prefixed' });
  }
  const localUrl = resolveLegacySingleFileRecordImageUrl({ objectKey, imageUrl });
  if (localUrl) {
    return Object.freeze({ kind: 'local', url: localUrl, namespace: 'legacy-single-file' });
  }

  return Object.freeze({ kind: 'rejected' });
}

function sanitizeObjectKey(value) {
  const text = String(value || '').trim().replace(/\\/g, '/');
  if (!text) return null;
  return text
    .split('/')
    .map((segment) => {
      const safe = String(segment || '').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 160);
      if (!safe || safe === '.' || safe === '..') return 'item';
      return safe;
    })
    .filter(Boolean)
    .join('/');
}

async function putObjectToOss({ objectKey, localPath }) {
  const client = getOssClient();
  await client.put(objectKey, localPath, {
    headers: {
      'Cache-Control': 'public, max-age=31536000'
    }
  });
}

async function putBufferToOss({ objectKey, buffer, contentType = 'application/octet-stream' }) {
  const client = getOssClient();
  await client.put(objectKey, buffer, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'private, max-age=0, no-cache'
    }
  });
}

function normalizeResponseHeaders(result) {
  const source = result?.res?.headers || result?.headers || {};
  return Object.fromEntries(
    Object.entries(source).map(([key, value]) => [String(key).toLowerCase(), value])
  );
}

async function getProtectedObjectMetadata({ objectKey, client = null }) {
  const safeObjectKey = sanitizeObjectKey(objectKey);
  if (!safeObjectKey) throw new Error('OBJECT_KEY_REQUIRED');
  const activeClient = client || getOssClient();
  const objectMetaResult = await activeClient.getObjectMeta(safeObjectKey);
  const headResult = await activeClient.head(safeObjectKey);
  const objectHeaders = normalizeResponseHeaders(objectMetaResult);
  const headHeaders = normalizeResponseHeaders(headResult);
  const userMetadata = headResult?.meta || {};

  return {
    status: Number(
      objectMetaResult?.status || objectMetaResult?.res?.status || 0
    ),
    metadata_status: Number(headResult?.status || headResult?.res?.status || 0),
    size: Number(objectHeaders['content-length']),
    sha256: String(
      userMetadata.sha256 || headHeaders['x-oss-meta-sha256'] || ''
    ),
    declared_size: String(
      userMetadata.size || headHeaders['x-oss-meta-size'] || ''
    ),
    etag: String(objectHeaders.etag || headHeaders.etag || '')
      .replace(/^"|"$/g, '')
  };
}

async function uploadProtectedFileToOss({
  objectKey,
  localPath,
  contentType = 'application/octet-stream',
  sha256,
  size,
  client = null
}) {
  const safeObjectKey = sanitizeObjectKey(objectKey);
  if (!safeObjectKey) throw new Error('OBJECT_KEY_REQUIRED');
  if (!/^[a-f0-9]{64}$/.test(String(sha256 || ''))) {
    throw new Error('OBJECT_SHA256_INVALID');
  }
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error('OBJECT_SIZE_INVALID');
  }

  const activeClient = client || getOssClient();
  await activeClient.put(safeObjectKey, localPath, {
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

  return getProtectedObjectMetadata({
    objectKey: safeObjectKey,
    client: activeClient
  });
}

async function downloadProtectedObjectFromOss({
  objectKey,
  destinationPath,
  client = null
}) {
  const safeObjectKey = sanitizeObjectKey(objectKey);
  if (!safeObjectKey) throw new Error('OBJECT_KEY_REQUIRED');
  if (!path.isAbsolute(String(destinationPath || ''))) {
    throw new Error('OBJECT_DESTINATION_INVALID');
  }

  const activeClient = client || getOssClient();
  let descriptor;
  let output;
  try {
    descriptor = fs.openSync(
      destinationPath,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      0o600
    );
    const result = await activeClient.getStream(safeObjectKey);
    const status = Number(result?.res?.status || result?.status || 0);
    if (status !== 200 || !result?.stream || typeof result.stream.pipe !== 'function') {
      throw new Error('OSS_DOWNLOAD_RESPONSE_INVALID');
    }

    const hash = crypto.createHash('sha256');
    let size = 0;
    const digestStream = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        hash.update(chunk);
        callback(null, chunk);
      }
    });
    output = fs.createWriteStream(destinationPath, {
      fd: descriptor,
      autoClose: false
    });
    await pipeline(result.stream, digestStream, output);
    fs.fsyncSync(descriptor);
    fs.fchmodSync(descriptor, 0o600);

    const headers = normalizeResponseHeaders(result);
    return {
      status,
      path: destinationPath,
      size,
      sha256: hash.digest('hex'),
      etag: String(headers.etag || '').replace(/^"|"$/g, '')
    };
  } catch (error) {
    if (error && ['EEXIST', 'ELOOP'].includes(error.code)) {
      throw new Error('OBJECT_DESTINATION_EXISTS');
    }
    if (error && String(error.message || '').startsWith('OBJECT_')) throw error;
    throw new Error('OSS_PROTECTED_DOWNLOAD_FAILED');
  } finally {
    if (output && !output.destroyed) output.destroy();
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch (_error) {
        // The protected file descriptor may already be closed by a stream failure.
      }
    }
  }
}


function getLocalObjectPath(value) {
  const text = String(value || '').replace(/\\/g, '/');
  if (!text) return path.join(localUploadDir, '');
  return path.join(localUploadDir, text);
}

function getLocalObjectFallbackPath(value) {
  return path.join(localUploadDir, path.basename(String(value || '')));
}

function getSignedUrl(objectKey, expiresSeconds = Number(process.env.OSS_SIGNED_URL_EXPIRES || 3600)) {
  if (!objectKey) return null;
  if (getStorageMode() !== 'cloud') {
    const safeKey = String(objectKey).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
    return `/uploads/${safeKey}`;
  }

  const client = getOssClient();
  return client.signatureUrl(objectKey, {
    expires: expiresSeconds,
    method: 'GET'
  });
}

async function saveImage({ file, qrId }) {
  const fileName = buildFileName(file.originalname, file.mimetype);

  // 先写入缓冲区，便于后续扩展重试/异步上传策略
  const bufferedPath = saveBinaryFile(bufferDir, fileName, file.buffer);
  const mode = getStorageMode();
  const objectKey = buildObjectKey({ qrId, fileName });

  if (mode === 'cloud') {
    try {
      await putObjectToOss({ objectKey, localPath: bufferedPath });
      const publicUrl = getPublicObjectUrl(objectKey);
      return {
        mode,
        url: publicUrl,
        preview_url: publicUrl,
        object_key: objectKey,
        buffer_path: bufferedPath
      };
    } catch (_error) {
      if (process.env.CLOUD_FALLBACK_TO_LOCAL === 'true') {
        saveBinaryFile(localUploadDir, fileName, file.buffer);
        return {
          mode: 'local',
          url: `/uploads/${fileName}`,
          preview_url: `/uploads/${fileName}`,
          object_key: fileName,
          buffer_path: bufferedPath,
          fallback: true
        };
      }
      throw new Error('OSS_UPLOAD_FAILED');
    }
  }

  saveBinaryFile(localUploadDir, fileName, file.buffer);
  return {
    mode,
    url: `/uploads/${fileName}`,
    preview_url: `/uploads/${fileName}`,
    object_key: fileName,
    buffer_path: bufferedPath
  };
}

async function saveRecordImage({ file, qrId }) {
  const fileName = buildFileName(file.originalname, 'image/jpeg').replace(/\.[^.]+$/, '.jpg');
  const bufferedPath = saveBinaryFile(bufferDir, fileName, file.buffer);
  const mode = getStorageMode();
  const objectKey = buildRecordImageObjectKey({ qrId, fileName });

  if (mode === 'cloud') {
    try {
      await putObjectToOss({ objectKey, localPath: bufferedPath });
    } catch (_error) {
      throw new Error('OSS_UPLOAD_FAILED');
    }
  } else {
    const localPath = path.join(localUploadDir, ...objectKey.split('/'));
    ensureDir(path.dirname(localPath));
    fs.writeFileSync(localPath, file.buffer);
  }

  const publicUrl = getPublicObjectUrl(objectKey);
  return {
    mode,
    url: publicUrl,
    preview_url: publicUrl,
    object_key: objectKey,
    buffer_path: bufferedPath
  };
}

async function saveJsonObject({ qrId, fileName = 'record_manifest.json', data }) {
  const buffer = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
  return saveBinaryObject({
    qrId,
    fileName,
    buffer,
    contentType: 'application/json; charset=utf-8'
  });
}

async function saveBinaryObject({ qrId, fileName, buffer, contentType = 'application/octet-stream' }) {
  const objectKey = buildObjectKey({ qrId, fileName });
  const mode = getStorageMode();

  if (mode === 'cloud') {
    try {
      await putBufferToOss({
        objectKey,
        buffer,
        contentType
      });
      return {
        mode,
        object_key: objectKey,
        preview_url: getSignedUrl(objectKey)
      };
    } catch (_error) {
      if (process.env.CLOUD_FALLBACK_TO_LOCAL !== 'true') {
        throw new Error('OSS_UPLOAD_FAILED');
      }
    }
  }

  const localName = path.basename(objectKey);
  const localPath = saveBinaryFile(localUploadDir, localName, buffer);
  return {
    mode: 'local',
    object_key: localName,
    preview_url: `/uploads/${localName}`,
    local_path: localPath,
    fallback: mode === 'cloud'
  };
}

async function saveBinaryObjectAtKey({
  objectKey,
  buffer,
  contentType = 'application/octet-stream',
  allowCloudFallback = true
}) {
  const safeObjectKey = sanitizeObjectKey(objectKey);
  if (!safeObjectKey) throw new Error('OBJECT_KEY_REQUIRED');
  const mode = getStorageMode();

  if (mode === 'cloud') {
    try {
      await putBufferToOss({
        objectKey: safeObjectKey,
        buffer,
        contentType
      });
      return {
        mode,
        object_key: safeObjectKey,
        preview_url: getSignedUrl(safeObjectKey)
      };
    } catch (_error) {
      if (!allowCloudFallback || process.env.CLOUD_FALLBACK_TO_LOCAL !== 'true') {
        throw new Error('OSS_UPLOAD_FAILED');
      }
    }
  }

  const localPath = path.join(localUploadDir, safeObjectKey);
  ensureDir(path.dirname(localPath));
  fs.writeFileSync(localPath, buffer);
  return {
    mode: 'local',
    object_key: safeObjectKey,
    preview_url: getSignedUrl(safeObjectKey),
    local_path: localPath,
    fallback: mode === 'cloud'
  };
}

async function saveJsonObjectAtKey({ objectKey, data }) {
  const buffer = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
  return saveBinaryObjectAtKey({
    objectKey,
    buffer,
    contentType: 'application/json; charset=utf-8'
  });
}

async function readObjectBuffer(objectKey) {
  const safeObjectKey = sanitizeObjectKey(objectKey);
  if (!safeObjectKey) return null;
  if (getStorageMode() === 'cloud') {
    const client = getOssClient();
    try {
      const result = await client.get(safeObjectKey);
      return Buffer.isBuffer(result.content) ? result.content : Buffer.from(result.content);
    } catch (error) {
      if (['NoSuchKey', 'NoSuchBucket', 'NotFound'].includes(error.code) || error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  const localPath = getLocalObjectPath(safeObjectKey);
  if (fs.existsSync(localPath)) {
    return fs.readFileSync(localPath);
  }
  const fallbackPath = getLocalObjectFallbackPath(safeObjectKey);
  if (fs.existsSync(fallbackPath)) {
    return fs.readFileSync(fallbackPath);
  }
  return null;
}

async function readTextObjectAtKey(objectKey) {
  const buffer = await readObjectBuffer(objectKey);
  return buffer ? buffer.toString('utf8') : '';
}

async function openRecordImageObjectStream(objectKey) {
  const parsed = parseStrictObjectKey(objectKey);
  if (!parsed || !/\.(?:jpg|png)$/.test(parsed.objectKey)) {
    throw new Error('RECORD_IMAGE_OBJECT_KEY_INVALID');
  }
  if (getStorageMode() === 'cloud') {
    const result = await getOssClient().getStream(parsed.objectKey);
    const status = Number(result?.res?.status || result?.status || 0);
    if (status !== 200 || !result?.stream || typeof result.stream.pipe !== 'function') {
      throw new Error('RECORD_IMAGE_OBJECT_READ_FAILED');
    }
    return Object.freeze({
      stream: result.stream,
      contentType: parsed.objectKey.endsWith('.png') ? 'image/png' : 'image/jpeg'
    });
  }

  const localPath = getLocalObjectPath(parsed.objectKey);
  const resolvedRoot = path.resolve(localUploadDir);
  const resolvedPath = path.resolve(localPath);
  if (!resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('RECORD_IMAGE_OBJECT_KEY_INVALID');
  }
  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) throw new Error('RECORD_IMAGE_OBJECT_READ_FAILED');
  return Object.freeze({
    stream: fs.createReadStream(resolvedPath),
    contentType: parsed.objectKey.endsWith('.png') ? 'image/png' : 'image/jpeg'
  });
}

module.exports = {
  getStorageMode,
  saveImage,
  saveRecordImage,
  saveJsonObject,
  saveBinaryObject,
  saveJsonObjectAtKey,
  saveBinaryObjectAtKey,
  readObjectBuffer,
  readTextObjectAtKey,
  openRecordImageObjectStream,
  getPublicObjectUrl,
  getSignedUrl,
  getObjectPrefix,
  buildRecordImageObjectKey,
  recordImageQrIdSha256,
  isCurrentRecordImageObjectKey,
  isRecordImageObjectKeyForQrId,
  isLegacyPrefixedRecordImageObjectKeyForAuthority,
  resolveLegacySingleFileRecordImageUrl,
  classifyRecordImageReference,
  getLocalObjectPath,
  getProtectedObjectMetadata,
  downloadProtectedObjectFromOss,
  uploadProtectedFileToOss
};
