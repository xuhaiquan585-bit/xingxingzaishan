const express = require('express');
const { applyAvataCallback } = require('../services/chainProofService');
const { verifyAvataCallback } = require('../services/avataService');
const {
  applyRecordProofCallback
} = require('../services/postgres/recordProofRuntime');

const SAFE_DISABLED_REASONS = new Set([
  'DISABLED_BY_DEFAULT',
  'DISABLED_BY_CONFIGURATION'
]);
const ACCEPTED_RUNTIME_OUTCOMES = new Set([
  'applied',
  'duplicate',
  'stale'
]);

function createAvataCallbackHandler({
  verifyCallback = verifyAvataCallback,
  applyLegacyCallback = applyAvataCallback,
  applyRuntimeCallback = applyRecordProofCallback
} = {}) {
  return async function avataCallback(req, res) {
    try {
      const verification = verifyCallback({
        path: req.originalUrl.split('?')[0],
        body: req.body || {},
        headers: req.headers
      });
      if (!verification.ok) {
        return res.status(401).send('FAILED');
      }

      const runtimeResult = await applyRuntimeCallback(req.body || {});
      if (runtimeResult.outcome === 'not_found') {
        return res.status(404).send('FAILED');
      }
      if (ACCEPTED_RUNTIME_OUTCOMES.has(runtimeResult.outcome)) {
        return res.type('text/plain').send('SUCCESS');
      }
      if (
        runtimeResult.outcome !== 'disabled'
        || !SAFE_DISABLED_REASONS.has(runtimeResult.reason)
      ) {
        return res.status(503).send('FAILED');
      }

      const legacyResult = await applyLegacyCallback(req.body || {});
      if (legacyResult.error === 'CHAIN_OPERATION_NOT_FOUND') {
        return res.status(404).send('FAILED');
      }

      return res.type('text/plain').send('SUCCESS');
    } catch (_error) {
      return res.status(500).send('FAILED');
    }
  };
}

const router = express.Router();

router.post('/avata/callback', createAvataCallbackHandler());

module.exports = router;
module.exports.createAvataCallbackHandler = createAvataCallbackHandler;
