const fs = require('fs');
const path = require('path');

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

async function putObjectToOss({ objectKey, localPath }) {
  const client = getOssClient();
  await client.put(objectKey, localPath, {
    headers: {
      'Cache-Control': 'public, max-age=31536000'
    }
  });
}

<<<<<<< HEAD
=======

function getLocalObjectPath(value) {
  return path.join(localUploadDir, path.basename(String(value || '')));
}

>>>>>>> origin/codex/review-task-document-for-understanding-8ucc5q
function getSignedUrl(objectKey, expiresSeconds = Number(process.env.OSS_SIGNED_URL_EXPIRES || 3600)) {
  if (!objectKey) return null;
  if (getStorageMode() !== 'cloud') {
    return `/uploads/${path.basename(objectKey)}`;
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
      return {
        mode,
        url: getSignedUrl(objectKey),
        object_key: objectKey,
        buffer_path: bufferedPath
      };
    } catch (_error) {
      if (process.env.CLOUD_FALLBACK_TO_LOCAL === 'true') {
        saveBinaryFile(localUploadDir, fileName, file.buffer);
        return {
          mode: 'local',
          url: `/uploads/${fileName}`,
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
    object_key: fileName,
    buffer_path: bufferedPath
  };
}

module.exports = {
  getStorageMode,
  saveImage,
  getSignedUrl,
<<<<<<< HEAD
  getObjectPrefix
=======
  getObjectPrefix,
  getLocalObjectPath
>>>>>>> origin/codex/review-task-document-for-understanding-8ucc5q
};
