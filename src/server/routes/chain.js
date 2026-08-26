const express = require('express');
const { verifyAvataCallback } = require('../services/avataService');
const {
  applyRecordProofCallback
} = require('../services/postgres/recordProofRuntime');

const ACCEPTED_RUNTIME_OUTCOMES = new Set([
  'applied',
  'duplicate',
  'stale'
]);

function createAvataCallbackHandler({
  verifyCallback = verifyAvataCallback,
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
      return res.status(503).send('FAILED');
    } catch (_error) {
      return res.status(500).send('FAILED');
    }
  };
}

const router = express.Router();

router.post('/avata/callback', createAvataCallbackHandler());

module.exports = router;
module.exports.createAvataCallbackHandler = createAvataCallbackHandler;
