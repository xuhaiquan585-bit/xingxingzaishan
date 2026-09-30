const { appendAuditLog } = require('../services/auditService');

function sanitizeAuditPath(value) {
  const pathname = String(value || '').split('?')[0];
  if (/^\/api\/nft\//.test(pathname)) {
    return pathname.replace(/^(\/api\/nft\/)[^/]+(?=\/|$)/, '$1[credential]');
  }
  if (/^\/api\/qr\/image\//.test(pathname)) {
    return pathname.replace(/^(\/api\/qr\/image\/)[^/]+(?=\/|$)/, '$1[credential]');
  }
  if (/^\/api\/qr\/media\//.test(pathname)) {
    return pathname.replace(/^(\/api\/qr\/media\/)[^/]+(?=\/|$)/, '$1[resource]');
  }
  return pathname.replace(/^(\/api\/(?:miniapp\/)?qr\/)[^/]+(?=\/|$)/, '$1[credential]');
}

function auditLogger() {
  return (req, res, next) => {
    const startAt = Date.now();
    const requestPath = req.path;

    res.on('finish', () => {
      if (!requestPath.startsWith('/api/')) {
        return;
      }

      if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        return;
      }

      appendAuditLog({
        method: req.method,
        path: sanitizeAuditPath(requestPath),
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
  auditLogger,
  sanitizeAuditPath
};
