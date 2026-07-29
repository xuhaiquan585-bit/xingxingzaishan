function safeDecode(value) {
  try {
    return decodeURIComponent(value || '');
  } catch (error) {
    return String(value || '');
  }
}

const QR_ACCESS_TOKEN_PATTERN = /^[a-f0-9]{32}$/i;
const QR_ID_PATTERN = /^[A-Za-z0-9]{2,12}\d{4,6}$/;

function parseTokenFromUrl(rawUrl) {
  const decoded = safeDecode(rawUrl);
  if (!/(^|\/)record\.html([?#]|$)/.test(decoded)) return '';
  const matched = decoded.match(/[?&](?:t|key)=([^&#]+)/);
  return matched ? normalizeDirectKey(matched[1]) : '';
}

function parseKeyFromMiniappPath(rawPath) {
  const decoded = safeDecode(rawPath).trim();
  if (!/(^|\/)pages\/record\/record([?#]|$)/.test(decoded)) return '';
  const matched = decoded.match(/[?&](?:key|t)=([^&#]+)/);
  return matched ? parseQrKeyValue(matched[1]) : '';
}

function normalizeDirectKey(value) {
  const decoded = safeDecode(value).trim();
  if (!decoded) return '';
  return QR_ACCESS_TOKEN_PATTERN.test(decoded) || QR_ID_PATTERN.test(decoded) ? decoded : '';
}

function parseQrKeyValue(value) {
  const decoded = safeDecode(value).trim();
  if (!decoded) return '';
  const fromUrl = parseTokenFromUrl(decoded);
  if (fromUrl) return fromUrl;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(decoded) || decoded.includes('/')) return '';
  const matched = decoded.match(/^\??(?:t|key)=([^&#]+)(?:[&#].*)?$/);
  if (matched) return normalizeDirectKey(matched[1]);
  return normalizeDirectKey(decoded);
}

function extractQrKey(options = {}) {
  if (options.key) return parseQrKeyValue(options.key);
  if (options.t) return parseQrKeyValue(options.t);
  if (options.path) {
    const fromPath = parseKeyFromMiniappPath(options.path);
    if (fromPath) return fromPath;
  }
  if (options.q) {
    const fromUrl = parseTokenFromUrl(options.q);
    if (fromUrl) return fromUrl;
  }
  if (options.scene) {
    return parseQrKeyValue(options.scene);
  }
  return '';
}

module.exports = {
  extractQrKey,
  parseTokenFromUrl
};
