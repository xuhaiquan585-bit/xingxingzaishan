const crypto = require('crypto');

const sessions = new Map();
const SESSION_COOKIE_NAME = process.env.USER_SESSION_COOKIE_NAME || 'user_session_id';
const DEFAULT_TTL_SECONDS = Number(process.env.USER_SESSION_TTL_SECONDS || 7 * 24 * 60 * 60);

function now() {
  return Date.now();
}

function createSession({ userId, phone }) {
  const sid = crypto.randomBytes(24).toString('hex');
  const expiresAt = now() + DEFAULT_TTL_SECONDS * 1000;
  sessions.set(sid, {
    sid,
    user_id: userId,
    phone,
    created_at: new Date().toISOString(),
    expires_at: new Date(expiresAt).toISOString()
  });
  return {
    sid,
    expires_at: new Date(expiresAt).toISOString()
  };
}

function getSession(sid) {
  if (!sid) return null;
  const found = sessions.get(sid);
  if (!found) return null;
  if (new Date(found.expires_at).getTime() <= now()) {
    sessions.delete(sid);
    return null;
  }
  return found;
}

function destroySession(sid) {
  if (!sid) return;
  sessions.delete(sid);
}

function getCookieName() {
  return SESSION_COOKIE_NAME;
}

function getCookieMaxAge() {
  return DEFAULT_TTL_SECONDS;
}

module.exports = {
  createSession,
  getSession,
  destroySession,
  getCookieName,
  getCookieMaxAge
};

