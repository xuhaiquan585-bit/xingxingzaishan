const fs = require('fs');
const path = require('path');

const logDir = process.env.AUDIT_LOG_DIR
  ? path.resolve(process.env.AUDIT_LOG_DIR)
  : path.join(__dirname, '..', 'logs');
const auditLogFile = path.join(logDir, 'audit.log');
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_BACKUP_COUNT = 7;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function rotateAuditLogIfNeeded({
  logFile,
  lineBytes,
  maxBytes,
  backupCount,
  fsImpl = fs
}) {
  let currentSize = 0;
  try {
    currentSize = fsImpl.statSync(logFile).size;
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  if (currentSize === 0 || currentSize + lineBytes <= maxBytes) return false;

  for (let index = backupCount; index >= 1; index -= 1) {
    const source = index === 1 ? logFile : `${logFile}.${index - 1}`;
    const destination = `${logFile}.${index}`;
    if (fsImpl.existsSync(destination)) fsImpl.rmSync(destination, { force: true });
    if (fsImpl.existsSync(source)) fsImpl.renameSync(source, destination);
  }
  return true;
}

function createAuditAppender({
  logFile = auditLogFile,
  maxBytes = positiveInteger(process.env.AUDIT_LOG_MAX_BYTES, DEFAULT_MAX_BYTES),
  backupCount = positiveInteger(process.env.AUDIT_LOG_BACKUP_COUNT, DEFAULT_BACKUP_COUNT),
  fsImpl = fs,
  onError = () => console.error('AUDIT_LOG_WRITE_FAILED')
} = {}) {
  const directory = path.dirname(logFile);
  return function writeAuditLog(payload) {
    try {
      fsImpl.mkdirSync(directory, { recursive: true });
      const record = {
        at: new Date().toISOString(),
        ...payload
      };
      const line = `${JSON.stringify(record)}\n`;
      rotateAuditLogIfNeeded({
        logFile,
        lineBytes: Buffer.byteLength(line),
        maxBytes,
        backupCount,
        fsImpl
      });
      fsImpl.appendFileSync(logFile, line, 'utf8');
      return true;
    } catch (error) {
      onError(error);
      return false;
    }
  };
}

const writeDefaultAuditLog = createAuditAppender();

function appendAuditLog(payload) {
  return writeDefaultAuditLog(payload);
}

module.exports = {
  DEFAULT_BACKUP_COUNT,
  DEFAULT_MAX_BYTES,
  appendAuditLog,
  createAuditAppender,
  rotateAuditLogIfNeeded
};
