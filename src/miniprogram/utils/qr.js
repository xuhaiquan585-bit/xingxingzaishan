function safeDecode(value) {
  try {
    return decodeURIComponent(value || '');
  } catch (error) {
    return String(value || '');
  }
}

function parseTokenFromUrl(rawUrl) {
  const decoded = safeDecode(rawUrl);
  if (!/(^|\/)record\.html([?#]|$)/.test(decoded)) return '';
  const matched = decoded.match(/[?&](?:t|key)=([^&#]+)/);
  return matched ? normalizeDirectKey(matched[1]) : '';
}

function normalizeDirectKey(value) {
  const decoded = safeDecode(value).trim();
  if (!decoded) return '';
  return /^[A-Za-z0-9_-]+$/.test(decoded) ? decoded : '';
}

function parseQrKeyValue(value) {
  const decoded = safeDecode(value).trim();
  if (!decoded) return '';
  const fromUrl = parseTokenFromUrl(decoded);
  if (fromUrl) return fromUrl;
  const matched = decoded.match(/^(?:t|key)=([^&#]+)/);
  if (matched) return normalizeDirectKey(matched[1]);
  return normalizeDirectKey(decoded);
}

function extractQrKey(options = {}) {
  if (options.t) return parseQrKeyValue(options.t);
  if (options.key) return parseQrKeyValue(options.key);
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
