const crypto = require('crypto');

const sessions = new Map();
const SESSION_COOKIE_NAME = process.env.USER_SESSION_COOKIE_NAME || 'user_session_id';
const DEFAULT_TTL_SECONDS = Number(process.env.USER_SESSION_TTL_SECONDS || 7 * 24 * 60 * 60);
const MAX_CLEANUP_INTERVAL_MS = 60_000;
let nextCleanupAt = 0;

function now() {
  return Date.now();
}

function cleanupIntervalMs() {
  return Math.max(1_000, Math.min(DEFAULT_TTL_SECONDS * 1_000, MAX_CLEANUP_INTERVAL_MS));
}

function pruneExpiredSessions(currentTime = now(), { force = false } = {}) {
  if (!force && currentTime < nextCleanupAt) return 0;
  let removed = 0;
  for (const [sid, session] of sessions.entries()) {
    const expiresAt = Date.parse(session && session.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= currentTime) {
      sessions.delete(sid);
      removed += 1;
    }
  }
  nextCleanupAt = currentTime + cleanupIntervalMs();
  return removed;
}

function createSession({ userId, phone, accountId = null }) {
  pruneExpiredSessions();
  const sid = crypto.randomBytes(24).toString('hex');
  const expiresAt = now() + DEFAULT_TTL_SECONDS * 1000;
  sessions.set(sid, {
    sid,
    user_id: userId,
    account_id: accountId || null,
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
  pruneExpiredSessions();
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

function resetUserSessionStore() {
  sessions.clear();
  nextCleanupAt = 0;
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
  getCookieMaxAge,
  pruneExpiredSessions,
  resetUserSessionStore
};

