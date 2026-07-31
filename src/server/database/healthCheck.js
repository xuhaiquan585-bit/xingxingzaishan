'use strict';

const { performance } = require('node:perf_hooks');
const { sanitizePostgresError } = require('./connection');

async function checkPostgresHealth(pool) {
  const startedAt = performance.now();
  let client;

  try {
    client = await pool.connect();
    await client.query('SELECT 1 AS connected');
    const versionResult = await client.query('SHOW server_version');
    const latencyMs = Math.max(0, performance.now() - startedAt);
    return {
      connected: true,
      latency_ms: Number(latencyMs.toFixed(2)),
      server_version: String(versionResult.rows[0] && versionResult.rows[0].server_version || '')
    };
  } catch (error) {
    const sanitized = sanitizePostgresError(error);
    return {
      connected: false,
      latency_ms: Number(Math.max(0, performance.now() - startedAt).toFixed(2)),
      server_version: '',
      error_code: sanitized.code
    };
  } finally {
    if (client && typeof client.release === 'function') {
      client.release();
    }
  }
}

module.exports = {
  checkPostgresHealth
};
