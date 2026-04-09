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

function getStorageMode() {
  return process.env.STORAGE_MODE === 'cloud' ? 'cloud' : 'local';
}

function saveBinaryFile(dir, fileName, buffer) {
  ensureDir(dir);
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

function makeCloudPublicUrl(fileName) {
  const baseUrl = process.env.CLOUD_PUBLIC_BASE_URL;
  if (baseUrl) {
    return `${baseUrl.replace(/\/$/, '')}/${fileName}`;
  }
  return `/cloud/${fileName}`;
}

function saveImage(file) {
  const fileName = buildFileName(file.originalname, file.mimetype);

  // 先写入缓冲区，便于后续扩展重试/异步上传策略
  const bufferedPath = saveBinaryFile(bufferDir, fileName, file.buffer);
  const mode = getStorageMode();

  if (mode === 'cloud') {
    // 当前提供本地 mock 云存储，后续可替换为真实 OSS/S3 SDK 实现
    saveBinaryFile(cloudMockDir, fileName, file.buffer);
    return {
      mode,
      url: makeCloudPublicUrl(fileName),
      buffer_path: bufferedPath,
      object_key: fileName
    };
  }

  saveBinaryFile(localUploadDir, fileName, file.buffer);
  return {
    mode,
    url: `/uploads/${fileName}`,
    buffer_path: bufferedPath,
    object_key: fileName
  };
}

module.exports = {
  getStorageMode,
  saveImage
};
