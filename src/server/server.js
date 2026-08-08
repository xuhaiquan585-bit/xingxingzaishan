'use strict';

require('dotenv').config();

const { createApp } = require('./app');
const { closePublicQrShadowRuntime } = require('./services/postgres/publicQrShadowRuntime');
const {
  closePersonalRecordShadowRuntime
} = require('./services/postgres/personalRecordShadowRuntime');
const {
  closeIdentityShadowRuntime
} = require('./services/postgres/identityShadowRuntime');

const PORT = process.env.PORT || 3000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

function closeShadowRuntimes() {
  return Promise.all([
    closePublicQrShadowRuntime(),
    closePersonalRecordShadowRuntime(),
    closeIdentityShadowRuntime()
  ]);
}

function closeHttpServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function createShutdownHandler({
  server,
  closeShadowRuntime = closeShadowRuntimes,
  processObject = process,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
  onError = (error) => console.error(error)
} = {}) {
  if (!server || typeof server.close !== 'function') {
    throw new Error('HTTP_SERVER_REQUIRED');
  }

  let shutdownPromise = null;
  return function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      const timeout = setTimer(() => processObject.exit(1), timeoutMs);
      if (timeout && typeof timeout.unref === 'function') timeout.unref();
      let exitCode = 0;
      const results = await Promise.allSettled([
        closeHttpServer(server),
        Promise.resolve().then(() => closeShadowRuntime())
      ]);
      const failure = results.find((result) => result.status === 'rejected');
      if (failure) {
        exitCode = 1;
        onError(failure.reason);
      }
      clearTimer(timeout);
      processObject.exit(exitCode);
    })();
    return shutdownPromise;
  };
}

function startServer({
  app = createApp(),
  port = PORT,
  processObject = process,
  closeShadowRuntime = closeShadowRuntimes
} = {}) {
  const server = app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Server started: http://localhost:${port}`);
  });
  const shutdown = createShutdownHandler({ server, closeShadowRuntime, processObject });
  processObject.once('SIGTERM', shutdown);
  processObject.once('SIGINT', shutdown);
  return { server, shutdown };
}

if (require.main === module) startServer();

module.exports = {
  SHUTDOWN_TIMEOUT_MS,
  closeShadowRuntimes,
  createShutdownHandler,
  startServer
};
