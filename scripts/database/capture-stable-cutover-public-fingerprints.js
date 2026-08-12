'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function fail(code) {
  throw failure(code);
}

function parseArgs(argv) {
  const args = {};
  for (const entry of argv) {
    if (!entry.startsWith('--') || !entry.includes('=')) {
      fail('CUTOVER_FINGERPRINT_ARGUMENT_INVALID');
    }
    const [key, ...parts] = entry.slice(2).split('=');
    if (!key || Object.hasOwn(args, key)) {
      fail('CUTOVER_FINGERPRINT_ARGUMENT_INVALID');
    }
    args[key] = parts.join('=');
  }
  return args;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeUrl(value) {
  try {
    const parsed = new URL(value);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch (_error) {
    return value;
  }
}

function normalizeDto(value, key = '') {
  if (Array.isArray(value)) {
    return value.map(item => normalizeDto(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(currentKey => [
        currentKey,
        normalizeDto(value[currentKey], currentKey)
      ])
    );
  }
  if (typeof value === 'string' && /(?:^|_)(?:url|uri)$/iu.test(key)) {
    return normalizeUrl(value);
  }
  return value;
}

function requestJson(url, channel) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, {
      headers: { Accept: 'application/json' }
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) {
          request.destroy(failure('CUTOVER_FINGERPRINT_RESPONSE_TOO_LARGE'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(failure(
            `CUTOVER_FINGERPRINT_HTTP_INVALID_${channel.toUpperCase()}_${response.statusCode}`
          ));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (_error) {
          reject(failure('CUTOVER_FINGERPRINT_JSON_INVALID'));
        }
      });
    });
    request.setTimeout(10_000, () => {
      request.destroy(failure('CUTOVER_FINGERPRINT_TIMEOUT'));
    });
    request.on('error', reject);
  });
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const baseUrl = String(args['base-url'] || '').trim();
  const qrId = String(args['qr-id'] || '').trim();
  const output = String(args.output || '').trim();
  if (!baseUrl || !qrId || !output) {
    fail('CUTOVER_FINGERPRINT_ARGUMENT_REQUIRED');
  }
  const parsedBase = new URL(baseUrl);
  if (parsedBase.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost'].includes(parsedBase.hostname) ||
      parsedBase.pathname !== '/') {
    fail('CUTOVER_FINGERPRINT_BASE_URL_INVALID');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(qrId)) {
    fail('CUTOVER_FINGERPRINT_QR_ID_INVALID');
  }

  const routes = {
    h5: `/api/qr/${encodeURIComponent(qrId)}`,
    miniapp: `/api/miniapp/qr/${encodeURIComponent(qrId)}`
  };
  const hashes = {};
  for (const [channel, route] of Object.entries(routes)) {
    const body = await requestJson(new URL(route, parsedBase), channel);
    if (!body || body.status !== 'success' || body.data?.id !== qrId) {
      fail('CUTOVER_FINGERPRINT_RESPONSE_CONTRACT_INVALID');
    }
    hashes[channel] = stableHash(JSON.stringify(normalizeDto(body.data)));
  }

  const report = {
    status: 'PASS',
    qr_id: qrId,
    route_count: Object.keys(routes).length,
    normalized_url_queries: true,
    raw_dto_persisted: false,
    route_sha256: hashes,
    combined_sha256: stableHash(JSON.stringify(hashes))
  };
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600
  });
  process.stdout.write(`CUTOVER_PUBLIC_FINGERPRINT_STATUS=${report.status}\n`);
  process.stdout.write(`CUTOVER_PUBLIC_FINGERPRINT_ROUTE_COUNT=${report.route_count}\n`);
  process.stdout.write(`CUTOVER_PUBLIC_FINGERPRINT_SHA256=${report.combined_sha256}\n`);
  return report;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.code || error.message || 'CUTOVER_FINGERPRINT_FAILED'}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  normalizeDto,
  normalizeUrl,
  parseArgs
};
