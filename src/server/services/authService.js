const crypto = require('crypto');

const tokenStore = new Map();

function generateToken(admin) {
  const token = crypto.randomBytes(24).toString('hex');
  tokenStore.set(token, {
    id: admin.id,
    username: admin.username,
    role: admin.role,
    name: admin.name,
    issued_at: new Date().toISOString()
  });
  return token;
}

function verifyToken(token) {
  if (!token) return null;
  return tokenStore.get(token) || null;
}

module.exports = {
  generateToken,
  verifyToken
};
