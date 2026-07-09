const crypto = require('crypto');

function sha256Hex(value) {
  return crypto
    .createHash('sha256')
    .update(Buffer.isBuffer(value) ? value : String(value || ''), Buffer.isBuffer(value) ? undefined : 'utf8')
    .digest('hex');
}

function generateMockBlockchainHash() {
  return `0x${sha256Hex(`${Date.now()}-${Math.random()}`).slice(0, 32)}`;
}

module.exports = {
  sha256Hex,
  generateMockBlockchainHash
};
