'use strict';

require('dotenv').config();

const { createApp } = require('./app');
const { closePublicQrShadowRuntime } = require('./services/postgres/publicQrShadowRuntime');
const {
  closePublicQrPrimaryReadRuntime
} = require('./services/postgres/publicQrPrimaryReadRuntime');
const {
  closeQrLifecycleWriteRuntime
} = require('./services/postgres/qrLifecycleWriteRuntime');
const {
  closePersonalRecordShadowRuntime
} = require('./services/postgres/personalRecordShadowRuntime');
const {
  closePersonalRecordPrimaryReadRuntime
} = require('./services/postgres/personalRecordPrimaryReadRuntime');
const {
  closeIdentityShadowRuntime
} = require('./services/postgres/identityShadowRuntime');
const {
  closeRecordProofRuntime,
  startRecordProofRuntime
} = require('./services/postgres/recordProofRuntime');

const PORT = process.env.PORT || 3000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

function closeShadowRuntimes() {
  return Promise.all([
    closePublicQrShadowRuntime(),
    closePublicQrPrimaryReadRuntime(),
    closeQrLifecycleWriteRuntime(),
    closePersonalRecordShadowRuntime(),
    closePersonalRecordPrimaryReadRuntime(),
    closeIdentityShadowRuntime(),
    closeRecordProofRuntime()
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
  return function shutdown(requestedExitCode = 0) {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      const timeout = setTimer(() => processObject.exit(1), timeoutMs);
      if (timeout && typeof timeout.unref === 'function') timeout.unref();
      let exitCode = requestedExitCode === 1 ? 1 : 0;
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
  closeShadowRuntime = closeShadowRuntimes,
  startProofRuntime = startRecordProofRuntime,
  onError = (error) => console.error(error)
} = {}) {
  const server = app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Server started: http://localhost:${port}`);
  });
  const shutdown = createShutdownHandler({
    server,
    closeShadowRuntime,
    processObject,
    onError
  });
  processObject.once('SIGTERM', shutdown);
  processObject.once('SIGINT', shutdown);
  const startup = Promise.resolve()
    .then(() => startProofRuntime())
    .catch((error) => {
      onError(error);
      return shutdown(1);
    });
  return { server, shutdown, startup };
}

if (require.main === module) startServer();

module.exports = {
  SHUTDOWN_TIMEOUT_MS,
  closeShadowRuntimes,
  createShutdownHandler,
  startServer
};
