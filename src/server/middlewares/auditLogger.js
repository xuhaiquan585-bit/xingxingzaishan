const { appendAuditLog } = require('../services/auditService');

function auditLogger() {
  return (req, res, next) => {
    const startAt = Date.now();

    res.on('finish', () => {
      if (!req.path.startsWith('/api/')) {
        return;
      }

      if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        return;
      }

      appendAuditLog({
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        ip: req.ip,
        ua: req.headers['user-agent'] || '',
        duration_ms: Date.now() - startAt
      });
    });

    next();
  };
}

module.exports = {
  auditLogger
};
