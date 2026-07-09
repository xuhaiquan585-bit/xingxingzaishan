const express = require('express');
const { applyAvataCallback } = require('../services/chainProofService');
const { verifyAvataCallback } = require('../services/avataService');

const router = express.Router();

router.post('/avata/callback', async (req, res) => {
  try {
    const verification = verifyAvataCallback({
      path: req.originalUrl.split('?')[0],
      body: req.body || {},
      headers: req.headers
    });
    if (!verification.ok) {
      return res.status(401).send('FAILED');
    }

    const result = await applyAvataCallback(req.body || {});
    if (result.error === 'CHAIN_OPERATION_NOT_FOUND') {
      return res.status(404).send('FAILED');
    }

    return res.type('text/plain').send('SUCCESS');
  } catch (_error) {
    return res.status(500).send('FAILED');
  }
});

module.exports = router;
