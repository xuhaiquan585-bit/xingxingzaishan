'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createSession,
  getSession,
  pruneExpiredSessions,
  resetUserSessionStore
} = require('../src/server/services/userSessionService');
const {
  pruneExpiredSmsCodes,
  resetSmsCodeStore,
  sendCode,
  verifyCode
} = require('../src/server/services/smsCodeService');
const { generateToken, verifyToken } = require('../src/server/services/authService');
const {
  generateMiniappToken,
  verifyMiniappToken
} = require('../src/server/services/miniappAuthService');

test('session store removes expired entries even when their cookie is never seen again', () => {
  resetUserSessionStore();
  const session = createSession({
    userId: 'USR-SESSION-CLEANUP',
    accountId: 'ACC-SESSION-CLEANUP',
    phone: '13900000001'
  });

  assert.ok(getSession(session.sid));
  assert.equal(pruneExpiredSessions(Date.now() + (8 * 24 * 60 * 60 * 1_000), { force: true }), 1);
  assert.equal(getSession(session.sid), null);
  resetUserSessionStore();
});

test('SMS store removes expired codes even when that phone never verifies again', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousProvider = process.env.SMS_PROVIDER;
  process.env.NODE_ENV = 'test';
  process.env.SMS_PROVIDER = 'mock';
  resetSmsCodeStore();

  try {
    const result = await sendCode('13900000002');
    assert.equal(typeof result.plainCode, 'string');
    assert.equal(pruneExpiredSmsCodes(Date.now() + (10 * 60 * 1_000), { force: true }), 1);
    assert.deepEqual(verifyCode('13900000002', result.plainCode), { ok: false });
  } finally {
    resetSmsCodeStore();
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousProvider === undefined) delete process.env.SMS_PROVIDER;
    else process.env.SMS_PROVIDER = previousProvider;
  }
});

test('SMS cooldown can be explicitly disabled with a zero configuration value', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousProvider = process.env.SMS_PROVIDER;
  const previousCooldown = process.env.SMS_SEND_COOLDOWN_MS;
  process.env.NODE_ENV = 'test';
  process.env.SMS_PROVIDER = 'mock';
  process.env.SMS_SEND_COOLDOWN_MS = '0';
  resetSmsCodeStore();

  try {
    await sendCode('13900000003');
    const second = await sendCode('13900000003');
    assert.equal(typeof second.plainCode, 'string');
    assert.equal(second.cooldownInSeconds, 0);
  } finally {
    resetSmsCodeStore();
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousProvider === undefined) delete process.env.SMS_PROVIDER;
    else process.env.SMS_PROVIDER = previousProvider;
    if (previousCooldown === undefined) delete process.env.SMS_SEND_COOLDOWN_MS;
    else process.env.SMS_SEND_COOLDOWN_MS = previousCooldown;
  }
});

test('signed tokens accept exactly three compact serialization segments', () => {
  const adminToken = generateToken({
    id: 1,
    username: 'admin',
    role: 'admin',
    name: 'Admin',
    auth_version: 0
  });
  assert.ok(verifyToken(adminToken));
  assert.equal(verifyToken(`${adminToken}.ignored`), null);

  const miniappToken = generateMiniappToken({
    id: 'USER-1',
    openid: 'openid-1',
    account_id: 'ACCOUNT-1',
    phone: '13900000004'
  });
  assert.ok(verifyMiniappToken(miniappToken));
  assert.equal(verifyMiniappToken(`${miniappToken}.ignored`), null);
});
