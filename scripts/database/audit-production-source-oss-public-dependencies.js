#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const EXPECTED_PRODUCTION_DATABASE = 'xingxing_clean_baseline_20260812_staging';
const MAX_JSON_DATABASE_BYTES = 64 * 1024 * 1024;

function auditError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeErrorCode(error) {
  const code = String(error && error.code || '');
  return /^SOURCE_OSS_AUDIT_[A-Z0-9_]+$/.test(code)
    ? code
    : 'SOURCE_OSS_AUDIT_UNEXPECTED_FAILURE';
}

function normalizeText(value) {
  return String(value || '').trim();
}

function parseArguments(argv) {
  const options = {
    check: false,
    repository: '',
    appPid: '',
    processStartedAtMs: 0
  };
  for (const argument of argv) {
    if (argument === '--check') {
      options.check = true;
      continue;
    }
    const match = /^--([a-z-]+)=(.+)$/.exec(argument);
    if (!match) throw auditError('SOURCE_OSS_AUDIT_ARGUMENT_INVALID');
    const [, name, value] = match;
    if (name === 'repository') options.repository = path.resolve(value);
    else if (name === 'app-pid') options.appPid = value;
    else if (name === 'process-started-at-ms') options.processStartedAtMs = Number(value);
    else throw auditError('SOURCE_OSS_AUDIT_ARGUMENT_INVALID');
  }
  if (!options.check
      || !path.isAbsolute(options.repository)
      || !/^[1-9][0-9]*$/.test(options.appPid)
      || !Number.isSafeInteger(options.processStartedAtMs)
      || options.processStartedAtMs <= 0) {
    throw auditError('SOURCE_OSS_AUDIT_ARGUMENT_INVALID');
  }
  return Object.freeze(options);
}

function normalizeBaseUrl(value) {
  const text = normalizeText(value);
  if (!text) return null;
  try {
    const parsed = new URL(text);
    if (!['http:', 'https:'].includes(parsed.protocol)
        || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    const pathname = parsed.pathname.replace(/\/+$/, '');
    return Object.freeze({ origin: parsed.origin, pathname });
  } catch (_error) {
    return null;
  }
}

function sourceUrlMatchers(environment, sourceConfig) {
  const matchers = [];
  const publicBase = normalizeBaseUrl(environment.CLOUD_PUBLIC_BASE_URL);
  if (publicBase) {
    matchers.push({ ...publicBase, prefixBounded: true });
    const alternateProtocol = publicBase.origin.startsWith('https://') ? 'http://' : 'https://';
    matchers.push({
      ...publicBase,
      origin: publicBase.origin.replace(/^https?:\/\//, alternateProtocol),
      prefixBounded: true
    });
  }

  const endpointText = normalizeText(sourceConfig.endpoint)
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
  const bucket = normalizeText(sourceConfig.bucket);
  if (endpointText && bucket) {
    for (const protocol of ['https:', 'http:']) {
      matchers.push({
        origin: `${protocol}//${bucket}.${endpointText}`,
        pathname: '',
        prefixBounded: false
      });
    }
  }
  return Object.freeze(matchers);
}

function classifyUrlReference(value, matchers) {
  const text = normalizeText(value);
  if (!text) return 'empty';
  if (text.startsWith('/') && !text.startsWith('//')) return 'relative_local';
  let parsed;
  try {
    parsed = new URL(text);
  } catch (_error) {
    return 'invalid';
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    return 'invalid';
  }
  const source = matchers.some((matcher) => {
    if (parsed.origin !== matcher.origin) return false;
    if (!matcher.prefixBounded || !matcher.pathname) return true;
    return parsed.pathname === matcher.pathname
      || parsed.pathname.startsWith(`${matcher.pathname}/`);
  });
  return source ? 'source_public_direct' : 'external_absolute';
}

function strictObjectKey(value) {
  const objectKey = normalizeText(value);
  if (!objectKey || objectKey.startsWith('/') || objectKey.includes('\\')
      || objectKey.includes('%') || objectKey.includes('//')
      || /^[a-z][a-z0-9+.-]*:/i.test(objectKey)
      || /[?#\x00-\x1f\x7f]/.test(objectKey)) return null;
  const segments = objectKey.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..'
      || !/^[a-zA-Z0-9_.-]+$/.test(segment))) return null;
  return { objectKey, segments };
}

function classifyRecordReference(record, { objectPrefix, matchers }) {
  const objectKey = normalizeText(record && record.image_object_key);
  const imageUrl = normalizeText(record && (record.image_url_snapshot || record.image_url));
  if (!objectKey) return classifyUrlReference(imageUrl, matchers);

  const parsed = strictObjectKey(objectKey);
  if (!parsed) return 'unclassified_object';
  const { segments } = parsed;
  const qrId = normalizeText(record && (record.qr_id || record.id));
  const qrHash = qrId
    ? crypto.createHash('sha256').update(qrId, 'utf8').digest('hex')
    : '';
  if (segments.length === 4
      && segments[0] === objectPrefix
      && segments[1] === 'record-images'
      && segments[2] === qrHash
      && /^[a-zA-Z0-9_.-]+\.jpg$/.test(segments[3])) {
    return 'current_object_signed';
  }
  const accessToken = normalizeText(record && record.access_token);
  if (segments.length === 3
      && segments[0] === objectPrefix
      && /^[a-f0-9]{32}$/.test(accessToken)
      && segments[1] === accessToken
      && /^[a-zA-Z0-9_.-]+\.(?:jpg|png)$/.test(segments[2])) {
    return 'legacy_object_proxy';
  }
  if (segments.length === 1
      && /^[a-zA-Z0-9_.-]+\.jpg$/.test(segments[0])
      && imageUrl === `/uploads/${segments[0]}`) {
    return 'legacy_local_signed';
  }
  return 'unclassified_object';
}

function emptyCounts(keys) {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

const RECORD_KEYS = Object.freeze([
  'current_object_signed',
  'legacy_object_proxy',
  'legacy_local_signed',
  'source_public_direct',
  'external_absolute',
  'relative_local',
  'empty',
  'invalid',
  'unclassified_object'
]);

const URL_KEYS = Object.freeze([
  'source_public_direct',
  'external_absolute',
  'relative_local',
  'empty',
  'invalid'
]);

function countRecordReferences(rows, context) {
  const counts = emptyCounts(RECORD_KEYS);
  for (const row of Array.isArray(rows) ? rows : []) {
    counts[classifyRecordReference(row, context)] += 1;
  }
  return Object.freeze({ total: (rows || []).length, ...counts });
}

function countUrlReferences(values, matchers) {
  const counts = emptyCounts(URL_KEYS);
  for (const value of values) counts[classifyUrlReference(value, matchers)] += 1;
  return Object.freeze({ total: values.length, ...counts });
}

function miniappImageValues(content) {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return [];
  return [
    content.logo_image,
    content.home_banner_image,
    ...(Array.isArray(content.home_slides)
      ? content.home_slides.map((item) => item && item.image)
      : []),
    ...(Array.isArray(content.scene_cards)
      ? content.scene_cards.map((item) => item && item.image)
      : [])
  ];
}

function productImageValues(products) {
  const values = [];
  for (const product of Array.isArray(products) ? products : []) {
    values.push(product && (product.cover_image ?? product.cover_image_url));
    if (Array.isArray(product && product.images)) values.push(...product.images);
  }
  return values;
}

function orderSnapshotImageValues(orders) {
  return (Array.isArray(orders) ? orders : [])
    .map((order) => order && order.product_snapshot && order.product_snapshot.cover_image);
}

function analyzeSnapshot({ postgres, json, objectPrefix, matchers }) {
  const context = { objectPrefix, matchers };
  const postgresRecords = countRecordReferences(postgres.records, context);
  const postgresProducts = countUrlReferences([
    ...(postgres.products || []).map((item) => item.cover_image_url),
    ...(postgres.productImages || []).map((item) => item.image_url)
  ], matchers);
  const postgresMiniapp = countUrlReferences(
    (postgres.miniapp || []).flatMap(miniappImageValues),
    matchers
  );
  const jsonRecords = countRecordReferences(json.qr_codes, context);
  const jsonProducts = countUrlReferences(productImageValues(json.products), matchers);
  const jsonMiniapp = countUrlReferences(miniappImageValues(json.miniapp_content), matchers);
  const jsonOrderSnapshots = countUrlReferences(orderSnapshotImageValues(json.orders), matchers);

  const blockers = postgresRecords.source_public_direct
    + jsonProducts.source_public_direct
    + jsonMiniapp.source_public_direct
    + jsonOrderSnapshots.source_public_direct;
  const review = postgresRecords.invalid
    + postgresRecords.unclassified_object
    + jsonProducts.invalid
    + jsonMiniapp.invalid
    + jsonOrderSnapshots.invalid;
  return Object.freeze({
    postgresRecords,
    postgresProducts,
    postgresMiniapp,
    jsonRecords,
    jsonProducts,
    jsonMiniapp,
    jsonOrderSnapshots,
    blockers,
    review,
    ready: blockers === 0 && review === 0
  });
}

function readJsonDatabase(filePath, { openSync = fs.openSync, fstatSync = fs.fstatSync,
  readFileSync = fs.readFileSync, closeSync = fs.closeSync } = {}) {
  if (!path.isAbsolute(filePath)) throw auditError('SOURCE_OSS_AUDIT_JSON_PATH_INVALID');
  let descriptor;
  try {
    descriptor = openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_JSON_DATABASE_BYTES) {
      throw auditError('SOURCE_OSS_AUDIT_JSON_FILE_INVALID');
    }
    const parsed = JSON.parse(readFileSync(descriptor, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw auditError('SOURCE_OSS_AUDIT_JSON_SCHEMA_INVALID');
    }
    return parsed;
  } catch (error) {
    if (String(error && error.code || '').startsWith('SOURCE_OSS_AUDIT_')) throw error;
    throw auditError('SOURCE_OSS_AUDIT_JSON_READ_FAILED');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

async function readPostgresSnapshot({ pool, withTransaction }) {
  return withTransaction(pool, async (context) => {
    const records = await context.query(`/* source-oss-audit:records */
      SELECT r.qr_id, r.image_url_snapshot, r.image_object_key, q.access_token
      FROM app.records r
      JOIN app.qr_codes q ON q.id = r.qr_id`);
    const products = await context.query(`/* source-oss-audit:products */
      SELECT cover_image_url, cover_image_object_key FROM app.products`);
    const productImages = await context.query(`/* source-oss-audit:product-images */
      SELECT image_url, image_object_key FROM app.product_images`);
    const miniapp = await context.query(`/* source-oss-audit:miniapp */
      SELECT logo_image, home_banner_image, home_slides, scene_cards
      FROM app.miniapp_content WHERE id = 1`);
    return Object.freeze({
      records: records.rows || [],
      products: products.rows || [],
      productImages: productImages.rows || [],
      miniapp: miniapp.rows || []
    });
  }, { isolationLevel: 'repeatable read', readOnly: true });
}

function printCounts(prefix, counts, writeLine) {
  writeLine(`${prefix}_TOTAL=${counts.total}`);
  for (const key of Object.keys(counts).filter((key) => key !== 'total')) {
    writeLine(`${prefix}_${key.toUpperCase()}=${counts[key]}`);
  }
}

function aclClass(value) {
  const acl = normalizeText(value).toLowerCase();
  if (acl === 'private') return 'PRIVATE';
  if (acl === 'public-read') return 'PUBLIC_READ';
  if (acl === 'public-read-write') return 'PUBLIC_READ_WRITE';
  return 'UNKNOWN';
}

async function runAudit({
  argv = process.argv.slice(2),
  writeLine = (line) => process.stdout.write(`${line}\n`),
  dependencies = null
} = {}) {
  const options = parseArguments(argv);
  const repository = options.repository;
  const load = (relativePath) => require(path.join(repository, relativePath));
  const deps = dependencies || {
    OSS: require(path.join(repository, 'node_modules', 'ali-oss')),
    mirrorCli: load('scripts/database/production-object-mirror-cli.js'),
    mirror: load('scripts/database/production-object-mirror.js'),
    databaseConfig: load('src/server/database/config.js'),
    databaseConnection: load('src/server/database/connection.js'),
    transaction: load('src/server/database/transaction.js')
  };

  const sourceEnvPath = path.join(repository, '.env');
  const sourceSnapshot = deps.mirrorCli.readProtectedEnvironmentSnapshot(sourceEnvPath);
  const sourceEnvironment = deps.mirrorCli.loadEffectiveSourceEnvironment({
    options: {
      appPid: options.appPid,
      processStartedAtMs: options.processStartedAtMs,
      sourceOssEnv: sourceEnvPath
    },
    fallbackEnvironment: process.env,
    sourceSnapshot
  });
  deps.mirrorCli.assertProductionMirrorEnvironment(sourceEnvironment);
  if (normalizeText(sourceEnvironment.PGDATABASE) !== EXPECTED_PRODUCTION_DATABASE) {
    throw auditError('SOURCE_OSS_AUDIT_DATABASE_UNEXPECTED');
  }
  const sourceConfig = deps.mirrorCli.readOssConfig(sourceEnvironment);
  const matchers = sourceUrlMatchers(sourceEnvironment, sourceConfig);
  if (matchers.length === 0) throw auditError('SOURCE_OSS_AUDIT_SOURCE_URL_UNAVAILABLE');

  const sourceClient = new deps.OSS(sourceConfig);
  const sourceIdentity = await deps.mirror.inspectBucket(sourceClient, sourceConfig.bucket);
  const sourceAcl = aclClass(sourceIdentity.acl);
  if (sourceAcl === 'UNKNOWN') throw auditError('SOURCE_OSS_AUDIT_ACL_UNEXPECTED');
  const pool = deps.databaseConnection.createPostgresPool({
    config: deps.databaseConfig.readPostgresConfig({
      ...sourceEnvironment,
      PGAPPLICATION_NAME: 'xingxingzaishan-source-oss-public-dependency-audit',
      PGPOOL_MAX: '2',
      PGSTATEMENT_TIMEOUT_MS: '30000'
    })
  });
  let postgres;
  try {
    postgres = await readPostgresSnapshot({ pool, withTransaction: deps.transaction.withTransaction });
  } finally {
    await deps.databaseConnection.closePostgresPool(pool);
  }

  const configuredJsonPath = normalizeText(sourceEnvironment.DB_FILE);
  if (!configuredJsonPath) throw auditError('SOURCE_OSS_AUDIT_JSON_PATH_MISSING');
  const jsonPath = path.isAbsolute(configuredJsonPath)
    ? configuredJsonPath
    : path.resolve(repository, configuredJsonPath);
  const json = readJsonDatabase(jsonPath);
  const objectPrefix = normalizeText(sourceEnvironment.OSS_OBJECT_PREFIX) || 'stars';
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(objectPrefix)) {
    throw auditError('SOURCE_OSS_AUDIT_OBJECT_PREFIX_INVALID');
  }
  const result = analyzeSnapshot({ postgres, json, objectPrefix, matchers });

  writeLine(`SOURCE_OSS_CURRENT_ACL=${sourceAcl}`);
  writeLine('RECORD_AUTHORITY=POSTGRES');
  writeLine('CATALOG_CONTENT_AUTHORITY=JSON_RUNTIME');
  printCounts('POSTGRES_RECORD_REFERENCES', result.postgresRecords, writeLine);
  printCounts('JSON_RECORD_SHADOW_REFERENCES', result.jsonRecords, writeLine);
  printCounts('JSON_PRODUCT_IMAGE_REFERENCES', result.jsonProducts, writeLine);
  printCounts('JSON_MINIAPP_IMAGE_REFERENCES', result.jsonMiniapp, writeLine);
  printCounts('JSON_ORDER_SNAPSHOT_IMAGE_REFERENCES', result.jsonOrderSnapshots, writeLine);
  printCounts('POSTGRES_PRODUCT_IMAGE_SHADOW_REFERENCES', result.postgresProducts, writeLine);
  printCounts('POSTGRES_MINIAPP_IMAGE_SHADOW_REFERENCES', result.postgresMiniapp, writeLine);
  writeLine(`SOURCE_PRIVATE_SWITCH_BLOCKERS=${result.blockers}`);
  writeLine(`SOURCE_PRIVATE_SWITCH_REVIEW_REQUIRED=${result.review}`);
  writeLine(`SOURCE_PRIVATE_SWITCH_READY=${result.ready ? 'YES' : 'NO'}`);
  writeLine('POSTGRES_ACCESS=READ_ONLY_REPEATABLE_READ');
  writeLine('PRODUCTION_DATABASE_WRITE=NONE');
  writeLine('JSON_WRITE=NONE');
  writeLine('OSS_REQUESTS=SOURCE_GET_BUCKET_INFO_ONLY');
  writeLine('DESTINATION_OSS_REQUESTS=NONE');
  writeLine('APPLICATION_RESTART=NO');
  writeLine('CONFIGURATION_WRITE=NONE');
  writeLine('RECORD_IDENTIFIERS_PRINTED=NO');
  writeLine('OBJECT_KEYS_PRINTED=NO');
  writeLine('URLS_PRINTED=NO');
  writeLine('SECRET_VALUES_PRINTED=NO');
  writeLine('PRODUCTION_SOURCE_OSS_PUBLIC_DEPENDENCY_AUDIT=COLLECTED');
  return result;
}

if (require.main === module) {
  runAudit().catch((error) => {
    process.stderr.write('PRODUCTION_SOURCE_OSS_PUBLIC_DEPENDENCY_AUDIT=FAIL\n');
    process.stderr.write(`ERROR_CODE=${safeErrorCode(error)}\n`);
    process.stderr.write('SECRET_VALUES_PRINTED=NO\n');
    process.exitCode = 1;
  });
}

module.exports = {
  analyzeSnapshot,
  classifyRecordReference,
  classifyUrlReference,
  parseArguments,
  readJsonDatabase,
  readPostgresSnapshot,
  runAudit,
  safeErrorCode,
  sourceUrlMatchers
};
