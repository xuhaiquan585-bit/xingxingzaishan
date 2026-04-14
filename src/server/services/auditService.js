const fs = require('fs');
const path = require('path');

const logDir = process.env.AUDIT_LOG_DIR
  ? path.resolve(process.env.AUDIT_LOG_DIR)
  : path.join(__dirname, '..', 'logs');
const auditLogFile = path.join(logDir, 'audit.log');

function appendAuditLog(payload) {
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const record = {
    at: new Date().toISOString(),
    ...payload
  };

  fs.appendFileSync(auditLogFile, `${JSON.stringify(record)}\n`, 'utf8');
}

module.exports = {
  appendAuditLog
};
