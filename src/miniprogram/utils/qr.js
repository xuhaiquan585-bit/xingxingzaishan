function parseTokenFromUrl(rawUrl) {
  const decoded = decodeURIComponent(rawUrl || '');
  const matched = decoded.match(/[?&]t=([^&#]+)/);
  return matched ? decodeURIComponent(matched[1]) : '';
}

function extractQrKey(options = {}) {
  if (options.t) return decodeURIComponent(options.t);
  if (options.key) return decodeURIComponent(options.key);
  if (options.q) {
    const fromUrl = parseTokenFromUrl(options.q);
    if (fromUrl) return fromUrl;
  }
  if (options.scene) {
    return decodeURIComponent(options.scene);
  }
  return '';
}

module.exports = {
  extractQrKey,
  parseTokenFromUrl
};
