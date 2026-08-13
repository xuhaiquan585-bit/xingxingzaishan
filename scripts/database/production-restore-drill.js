'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  downloadProtectedObjectFromOss,
  getProtectedObjectMetadata
} = require('../../src/server/services/storageService');
const {
  AccountRepository,
  CoCreationRepository,
  IdentityRepository,
  QrRepository,
  RecordRepository
} = require('../../src/server/repositories');
const {
  closePostgresPool,
  createPostgresPool
} = require('../../src/server/database/connection');
const { readPostgresConfig } = require('../../src/server/database/config');
const { withTransaction } = require('../../src/server/database/transaction');
const { loadMigrations } = require('./migrate');
const {
  assertPm2DumpSecretSafe,
  loadProtectedOssEnvironment
} = require('./production-backup');

const BACKUP_RUN_ID = '20260813T110535Z-6586d9b1';
const PRODUCTION_DATABASE = 'xingxing_clean_baseline_20260812_staging';
const RESTORE_ROOT = '/root/xingxingzaishan-production-restore-drill';
const OSS_ENV_FILE = '/www/wwwroot/xingxingzaishan/.env';
const PM2_DUMP_FILE = '/root/.pm2/dump.pm2';
const PG_RESTORE_BIN = '/usr/pgsql-15/bin/pg_restore';
const MANIFEST_KEY = 'backups/xingxingzaishan/production/manifests/2026/08/13/'
  + `${BACKUP_RUN_ID}-manifest.json`;

const EXPECTED = Object.freeze({
  manifest: Object.freeze({
    object_key: MANIFEST_KEY,
    sha256: 'ea84e2fe7ff2e26e6c3fd85cdbeab4eb94aae6eeac356253db755a21175cc5f8',
    size: 1503,
    etag: '473873CDD15259E6D4FD75F0D1CDAA72'
  }),
  postgresql: Object.freeze({
    object_key: 'backups/xingxingzaishan/production/postgresql/2026/08/13/'
      + `${BACKUP_RUN_ID}-${PRODUCTION_DATABASE}.dump`,
    sha256: '93324cbe855fb811f2ec523e95cc041e2ccc2035c4089aa870979cc4347c5785',
    size: 101208,
    etag: '79F0BC911C83B7E700D1336E536AF2D5'
  }),
  json: Object.freeze({
    object_key: 'backups/xingxingzaishan/production/json/2026/08/13/'
      + `${BACKUP_RUN_ID}-db.json`,
    sha256: 'f263df13b5c19f91b0f86d93960f6b26896f3ed605318c73dd8546d110b06cfd',
    size: 211311,
    etag: '2070892B3C585A4DE2609CF06DB4213A'
  })
});

const REQUIRED_TABLES = Object.freeze([
  'schema_migrations',
  'accounts',
  'users',
  'qr_batches',
  'qr_codes',
  'records',
  'co_creations',
  'co_creation_comments',
  'record_proofs',
  'record_archives',
  'products',
  'product_images',
  'outbox_jobs'
]);

const REQUIRED_RELATIONS = Object.freeze([
  'app.users_phone_uq',
  'app.users_openid_uq',
  'app.qr_codes_access_token_uq',
  'app.records_image_object_key_idx',
  'app.co_creation_comments_creation_source_position_uq',
  'app.co_creation_comments_public_source_order_idx'
]);

const REQUIRED_CONSTRAINTS = Object.freeze([
  'accounts_pkey',
  'users_pkey',
  'qr_batches_pkey',
  'qr_codes_pkey',
  'records_pkey',
  'co_creations_pkey',
  'co_creation_comments_pkey',
  'record_proofs_pkey',
  'record_archives_pkey',
  'products_pkey',
  'product_images_pkey',
  'outbox_jobs_pkey',
  'users_account_fk',
  'records_qr_fk',
  'records_account_fk',
  'co_creations_qr_uq',
  'co_creations_qr_fk',
  'co_creations_owner_account_fk',
  'co_creation_comments_creation_fk',
  'co_creation_comments_account_fk',
  'co_creation_comments_creation_source_position_uq',
  'qr_codes_issue_status_chk',
  'qr_codes_lifecycle_status_chk',
  'qr_codes_issued_lifecycle_chk'
]);

class ProductionRestoreDrillError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ProductionRestoreDrillError';
    this.code = code;
  }
}

function drillError(code) {
  return new ProductionRestoreDrillError(code);
}

function safeErrorCode(error) {
  if (error instanceof ProductionRestoreDrillError) return error.code;
  return 'PRODUCTION_RESTORE_DRILL_UNEXPECTED_FAILURE';
}

function normalizeEtag(value) {
  return String(value || '').replace(/^"|"$/g, '').toUpperCase();
}

function assertRestoreDatabaseName(database) {
  if (!/^xingxing_restore_drill_\d{8}_[a-f0-9]{8}$/.test(String(database || ''))
    || database === PRODUCTION_DATABASE) {
    throw drillError('RESTORE_DATABASE_NAME_INVALID');
  }
  return database;
}

function buildPgRestoreArguments({ host, port, user, database, dumpPath }) {
  const targetDatabase = assertRestoreDatabaseName(database);
  if (!String(host || '').trim()
    || !/^\d{1,5}$/.test(String(port || ''))
    || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(String(user || ''))
    || !path.isAbsolute(String(dumpPath || ''))) {
    throw drillError('RESTORE_POSTGRES_ARGUMENT_INVALID');
  }
  return [
    `--host=${host}`,
    `--port=${port}`,
    `--username=${user}`,
    `--dbname=${targetDatabase}`,
    '--single-transaction',
    '--exit-on-error',
    '--no-owner',
    '--no-privileges',
    dumpPath
  ];
}

function restorePostgresDump({
  connection,
  database,
  dumpPath,
  binary = PG_RESTORE_BIN,
  spawn = spawnSync,
  env = process.env
}) {
  const args = buildPgRestoreArguments({
    ...connection,
    database,
    dumpPath
  });
  const result = spawn(binary, args, {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error || result.status !== 0) {
    throw drillError('POSTGRES_RESTORE_FAILED');
  }
  return { database, status: 'RESTORED' };
}

function writeFileExclusive(filePath, bytes) {
  let descriptor;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      0o600
    );
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.fchmodSync(descriptor, 0o600);
  } catch (_error) {
    throw drillError('RESTORE_EVIDENCE_WRITE_FAILED');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function writeJsonExclusive(filePath, value) {
  writeFileExclusive(filePath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
}

function assertOutputDirectory(outputDirectory) {
  if (!path.isAbsolute(String(outputDirectory || ''))) {
    throw drillError('RESTORE_OUTPUT_DIRECTORY_INVALID');
  }
  let stat;
  try {
    stat = fs.lstatSync(outputDirectory);
  } catch (_error) {
    throw drillError('RESTORE_OUTPUT_DIRECTORY_INVALID');
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw drillError('RESTORE_OUTPUT_DIRECTORY_INVALID');
  }
  if (process.platform !== 'win32'
    && (stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o077) !== 0)) {
    throw drillError('RESTORE_OUTPUT_DIRECTORY_UNSAFE');
  }
}

function verifyRemoteArtifact(expected, remote) {
  if (Number(remote?.status) !== 200
    || Number(remote?.metadata_status ?? remote?.status) !== 200
    || Number(remote?.size) !== expected.size
    || String(remote?.declared_size || '') !== String(expected.size)
    || String(remote?.sha256 || '') !== expected.sha256
    || normalizeEtag(remote?.etag) !== expected.etag) {
    throw drillError('RESTORE_OSS_METADATA_MISMATCH');
  }
}

function verifyDownloadedArtifact(expected, downloaded) {
  if (Number(downloaded?.status) !== 200
    || Number(downloaded?.size) !== expected.size
    || String(downloaded?.sha256 || '') !== expected.sha256
    || normalizeEtag(downloaded?.etag) !== expected.etag) {
    throw drillError('RESTORE_DOWNLOAD_INTEGRITY_MISMATCH');
  }
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object'
    || manifest.schema_version !== 1
    || manifest.status !== 'COMPLETE'
    || manifest.run_id !== BACKUP_RUN_ID
    || manifest.database !== PRODUCTION_DATABASE
    || manifest.consistency?.cross_store_transactional_snapshot !== false) {
    throw drillError('RESTORE_MANIFEST_INVALID');
  }
  for (const name of ['postgresql', 'json']) {
    const actual = manifest.snapshots?.[name];
    const expected = EXPECTED[name];
    if (!actual
      || actual.object_key !== expected.object_key
      || actual.sha256 !== expected.sha256
      || actual.size !== expected.size
      || normalizeEtag(actual.etag) !== expected.etag
      || actual.verified !== true) {
      throw drillError('RESTORE_MANIFEST_ARTIFACT_MISMATCH');
    }
  }
  return manifest;
}

function validateJsonSnapshot(bytes) {
  let source;
  try {
    source = JSON.parse(bytes.toString('utf8'));
  } catch (_error) {
    throw drillError('RESTORE_JSON_INVALID');
  }
  const requiredCollections = ['users', 'qr_codes', 'accounts'];
  if (requiredCollections.some((key) => !Array.isArray(source[key]))) {
    throw drillError('RESTORE_JSON_STRUCTURE_INVALID');
  }
  return Object.fromEntries(requiredCollections.map((key) => [key, source[key].length]));
}

async function downloadArtifact({
  expected,
  destinationPath,
  client,
  metadataReader,
  downloader
}) {
  let remote;
  let downloaded;
  try {
    remote = await metadataReader({ objectKey: expected.object_key, client });
    verifyRemoteArtifact(expected, remote);
    downloaded = await downloader({
      objectKey: expected.object_key,
      destinationPath,
      client
    });
    verifyDownloadedArtifact(expected, downloaded);
  } catch (error) {
    if (error instanceof ProductionRestoreDrillError) throw error;
    throw drillError('RESTORE_OSS_DOWNLOAD_FAILED');
  }
  return { ...downloaded, object_key: expected.object_key };
}

async function downloadBackupArtifacts({
  outputDirectory,
  client = null,
  metadataReader = getProtectedObjectMetadata,
  downloader = downloadProtectedObjectFromOss,
  loadOssEnvironment = true,
  ossEnvPath = OSS_ENV_FILE,
  pm2DumpPath = PM2_DUMP_FILE
}) {
  assertOutputDirectory(outputDirectory);
  assertPm2DumpSecretSafe(pm2DumpPath);
  if (loadOssEnvironment) loadProtectedOssEnvironment(ossEnvPath);

  const manifestPath = path.join(outputDirectory, `${BACKUP_RUN_ID}-manifest.json`);
  const dumpPath = path.join(outputDirectory, `${BACKUP_RUN_ID}-${PRODUCTION_DATABASE}.dump`);
  const jsonPath = path.join(outputDirectory, `${BACKUP_RUN_ID}-db.json`);

  const manifestArtifact = await downloadArtifact({
    expected: EXPECTED.manifest,
    destinationPath: manifestPath,
    client,
    metadataReader,
    downloader
  });
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (_error) {
    throw drillError('RESTORE_MANIFEST_INVALID');
  }
  validateManifest(manifest);

  const postgresql = await downloadArtifact({
    expected: EXPECTED.postgresql,
    destinationPath: dumpPath,
    client,
    metadataReader,
    downloader
  });
  const json = await downloadArtifact({
    expected: EXPECTED.json,
    destinationPath: jsonPath,
    client,
    metadataReader,
    downloader
  });
  const jsonCollections = validateJsonSnapshot(fs.readFileSync(jsonPath));

  const result = {
    schema_version: 1,
    status: 'DOWNLOADED_AND_VERIFIED',
    backup_run_id: BACKUP_RUN_ID,
    manifest: manifestArtifact,
    postgresql,
    json,
    json_collections: jsonCollections
  };
  const resultPath = path.join(outputDirectory, 'download-result.json');
  writeJsonExclusive(resultPath, result);
  return { ...result, resultPath };
}

function validateMigrationRows(rows, migrations = loadMigrations()) {
  if (!Array.isArray(rows) || rows.length !== migrations.length) {
    throw drillError('RESTORE_MIGRATION_SET_MISMATCH');
  }
  for (let index = 0; index < migrations.length; index += 1) {
    const actual = rows[index];
    const expected = migrations[index];
    if (actual.version !== expected.version
      || String(actual.checksum || '').trim() !== expected.checksum) {
      throw drillError('RESTORE_MIGRATION_SET_MISMATCH');
    }
  }
  return migrations.map(({ version, checksum }) => ({ version, checksum }));
}

async function queryRows(context, sql, values = []) {
  const result = await context.query(sql, values);
  return result.rows || [];
}

async function validateRestoredDatabase({ database, pool, resultPath }) {
  const targetDatabase = assertRestoreDatabaseName(database);
  const validation = await withTransaction(pool, async (context) => {
    const identityRows = await queryRows(
      context,
      'SELECT current_database() AS database, current_setting(\'transaction_read_only\') AS read_only'
    );
    if (identityRows[0]?.database !== targetDatabase || identityRows[0]?.read_only !== 'on') {
      throw drillError('RESTORE_DATABASE_IDENTITY_INVALID');
    }

    const migrationRows = await queryRows(
      context,
      'SELECT version, trim(checksum) AS checksum FROM app.schema_migrations ORDER BY version'
    );
    const migrations = validateMigrationRows(migrationRows);

    const tableRows = await queryRows(
      context,
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'app' AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [REQUIRED_TABLES]
    );
    if (tableRows.length !== REQUIRED_TABLES.length) {
      throw drillError('RESTORE_REQUIRED_SCHEMA_MISSING');
    }
    const relationRows = await queryRows(
      context,
      `SELECT relation_name
       FROM unnest($1::text[]) AS relations(relation_name)
       WHERE to_regclass(relation_name) IS NOT NULL`,
      [REQUIRED_RELATIONS]
    );
    if (relationRows.length !== REQUIRED_RELATIONS.length) {
      throw drillError('RESTORE_REQUIRED_SCHEMA_MISSING');
    }
    const constraintRows = await queryRows(
      context,
      `SELECT conname FROM pg_constraint
       WHERE connamespace = 'app'::regnamespace
         AND conname = ANY($1::text[])
       ORDER BY conname`,
      [REQUIRED_CONSTRAINTS]
    );
    if (constraintRows.length !== REQUIRED_CONSTRAINTS.length) {
      throw drillError('RESTORE_REQUIRED_SCHEMA_MISSING');
    }

    const countRows = await queryRows(context, `SELECT
      (SELECT count(*)::integer FROM app.qr_codes) AS qr_codes,
      (SELECT count(*)::integer FROM app.records) AS records,
      (SELECT count(*)::integer FROM app.accounts) AS accounts,
      (SELECT count(*)::integer FROM app.users) AS users,
      (SELECT count(*)::integer FROM app.users) AS identities,
      (SELECT count(*)::integer FROM app.co_creations) AS co_creations,
      (SELECT count(*)::integer FROM app.co_creation_comments) AS co_creation_comments`);
    const counts = countRows[0];

    const issueStatus = await queryRows(
      context,
      'SELECT issue_status AS status, count(*)::integer AS count FROM app.qr_codes GROUP BY issue_status ORDER BY issue_status'
    );
    const lifecycleStatus = await queryRows(
      context,
      'SELECT lifecycle_status AS status, count(*)::integer AS count FROM app.qr_codes GROUP BY lifecycle_status ORDER BY lifecycle_status'
    );
    const sum = (rows) => rows.reduce((total, row) => total + Number(row.count), 0);
    if (sum(issueStatus) !== counts.qr_codes || sum(lifecycleStatus) !== counts.qr_codes) {
      throw drillError('RESTORE_QR_STATUS_DISTRIBUTION_INVALID');
    }

    const integrityRows = await queryRows(context, `SELECT
      (SELECT count(*)::integer FROM app.users u LEFT JOIN app.accounts a ON a.id = u.account_id WHERE a.id IS NULL) AS users_without_accounts,
      (SELECT count(*)::integer FROM app.records r LEFT JOIN app.qr_codes q ON q.id = r.qr_id WHERE q.id IS NULL) AS records_without_qr,
      (SELECT count(*)::integer FROM app.records r LEFT JOIN app.accounts a ON a.id = r.account_id WHERE a.id IS NULL) AS records_without_accounts,
      (SELECT count(*)::integer FROM app.co_creations c LEFT JOIN app.qr_codes q ON q.id = c.qr_id WHERE q.id IS NULL) AS co_creations_without_qr,
      (SELECT count(*)::integer FROM app.co_creation_comments c LEFT JOIN app.co_creations p ON p.id = c.co_creation_id WHERE p.id IS NULL) AS comments_without_co_creation,
      (SELECT count(*)::integer FROM app.record_proofs p LEFT JOIN app.records r ON r.qr_id = p.record_qr_id WHERE r.qr_id IS NULL) AS proofs_without_records,
      (SELECT count(*)::integer FROM app.record_archives a LEFT JOIN app.records r ON r.qr_id = a.record_qr_id WHERE r.qr_id IS NULL) AS archives_without_records`);
    const integrity = integrityRows[0];
    if (Object.values(integrity).some((value) => Number(value) !== 0)) {
      throw drillError('RESTORE_RELATIONAL_INTEGRITY_INVALID');
    }

    const commentRows = await queryRows(context, `SELECT count(*)::integer AS invalid_sets
      FROM (
        SELECT co_creation_id
        FROM app.co_creation_comments
        GROUP BY co_creation_id
        HAVING min(source_position) <> 0
          OR max(source_position) <> count(*) - 1
          OR count(DISTINCT source_position) <> count(*)
      ) invalid`);
    if (Number(commentRows[0]?.invalid_sets) !== 0) {
      throw drillError('RESTORE_COMMENT_ORDER_INVALID');
    }

    const objectKeyRows = await queryRows(context, `WITH object_keys AS (
      SELECT 'records.image_object_key' AS source, image_object_key AS object_key FROM app.records
      UNION ALL SELECT 'products.cover_image_object_key', cover_image_object_key FROM app.products
      UNION ALL SELECT 'product_images.image_object_key', image_object_key FROM app.product_images
      UNION ALL SELECT 'record_proofs.manifest_object_key', manifest_object_key FROM app.record_proofs
      UNION ALL SELECT 'record_proofs.certificate_object_key', certificate_object_key FROM app.record_proofs
      UNION ALL SELECT 'record_archives.manifest_object_key', manifest_object_key FROM app.record_archives
      UNION ALL SELECT 'record_archives.legacy_manifest_object_key', legacy_manifest_object_key FROM app.record_archives
      UNION ALL SELECT 'record_archives.index_object_key', index_object_key FROM app.record_archives
    )
    SELECT source,
           count(*) FILTER (WHERE object_key IS NOT NULL)::integer AS reference_count,
           count(*) FILTER (
             WHERE object_key IS NOT NULL AND (
               btrim(object_key) = '' OR object_key LIKE '/%'
               OR position(chr(92) IN object_key) > 0
               OR object_key ~ '(^|/)\\.{1,2}(/|$)' OR object_key ~ '[[:cntrl:]]'
             )
           )::integer AS invalid_count
    FROM object_keys GROUP BY source ORDER BY source`);
    if (objectKeyRows.some((row) => Number(row.invalid_count) !== 0)) {
      throw drillError('RESTORE_OBJECT_KEY_REFERENCE_INVALID');
    }

    const sampleRows = await queryRows(context, `SELECT q.id AS qr_id, r.account_id
      FROM app.qr_codes q
      JOIN app.records r ON r.qr_id = q.id
      LEFT JOIN app.co_creations c ON c.qr_id = q.id
      ORDER BY (c.id IS NOT NULL) DESC, q.id ASC
      LIMIT 3`);
    if (sampleRows.length < 3) throw drillError('RESTORE_REPOSITORY_SAMPLE_INSUFFICIENT');

    const qrRepository = new QrRepository(context);
    const recordRepository = new RecordRepository(context);
    const accountRepository = new AccountRepository(context);
    const identityRepository = new IdentityRepository(context);
    const coCreationRepository = new CoCreationRepository(context);
    const samples = [];
    for (const sample of sampleRows) {
      const qr = await qrRepository.findById(sample.qr_id);
      const record = await recordRepository.findByQrId(sample.qr_id);
      const account = await accountRepository.findById(sample.account_id);
      const identities = await identityRepository.listByAccountId(sample.account_id);
      const coCreation = await coCreationRepository.findByQrId(sample.qr_id);
      const comments = coCreation
        ? await coCreationRepository.listEffectiveComments(coCreation.id)
        : [];
      if (!qr || !record || !account) throw drillError('RESTORE_REPOSITORY_SAMPLE_FAILED');
      for (let index = 1; index < comments.length; index += 1) {
        if (comments[index - 1].source_position >= comments[index].source_position) {
          throw drillError('RESTORE_COMMENT_ORDER_INVALID');
        }
      }
      samples.push({
        qr_id: sample.qr_id,
        qr_found: true,
        record_found: true,
        account_found: true,
        identity_count: identities.length,
        co_creation_found: Boolean(coCreation),
        effective_comment_count: comments.length
      });
    }

    return {
      schema_version: 1,
      status: 'RESTORED_AND_VALIDATED',
      database: targetDatabase,
      migrations,
      counts,
      issue_status: issueStatus,
      lifecycle_status: lifecycleStatus,
      integrity,
      object_key_references: objectKeyRows,
      samples
    };
  }, { isolationLevel: 'repeatable read', readOnly: true });

  writeJsonExclusive(resultPath, validation);
  return validation;
}

function parseMode(argv) {
  if (argv.length !== 1 || !['--download', '--restore', '--validate'].includes(argv[0])) {
    throw drillError('RESTORE_ARGUMENT_INVALID');
  }
  return argv[0].slice(2);
}

async function main(argv = process.argv.slice(2)) {
  let pool;
  try {
    const mode = parseMode(argv);
    const outputDirectory = process.env.RESTORE_DRILL_OUTPUT_DIRECTORY;
    if (mode === 'download') {
      const result = await downloadBackupArtifacts({ outputDirectory });
      process.stdout.write([
        `BACKUP_RUN_ID=${BACKUP_RUN_ID}`,
        `MANIFEST_SHA256=${result.manifest.sha256}`,
        `POSTGRESQL_DUMP_SHA256=${result.postgresql.sha256}`,
        `JSON_SHA256=${result.json.sha256}`,
        'RESTORE_DRILL_DOWNLOAD=PASS',
        ''
      ].join('\n'));
      return result;
    }

    const database = assertRestoreDatabaseName(process.env.RESTORE_DRILL_DATABASE);
    if (mode === 'restore') {
      const result = restorePostgresDump({
        connection: {
          host: process.env.PGHOST,
          port: process.env.PGPORT,
          user: process.env.PGUSER
        },
        database,
        dumpPath: process.env.RESTORE_DRILL_DUMP_PATH
      });
      process.stdout.write([
        `RESTORE_DATABASE=${database}`,
        'POSTGRESQL_RESTORE=PASS',
        ''
      ].join('\n'));
      return result;
    }

    const resultPath = process.env.RESTORE_DRILL_RESULT_PATH;
    if (!path.isAbsolute(String(resultPath || ''))) {
      throw drillError('RESTORE_RESULT_PATH_INVALID');
    }
    const config = readPostgresConfig({
      ...process.env,
      PGDATABASE: database,
      PGAPPLICATION_NAME: process.env.RESTORE_DRILL_APPLICATION_NAME,
      PGPOOL_MAX: '1',
      PGSTATEMENT_TIMEOUT_MS: '15000'
    });
    pool = createPostgresPool({ config });
    const result = await validateRestoredDatabase({ database, pool, resultPath });
    process.stdout.write([
      `RESTORE_DATABASE=${database}`,
      `RESTORE_COUNTS=${JSON.stringify(result.counts)}`,
      `RESTORE_ISSUE_STATUS=${JSON.stringify(result.issue_status)}`,
      `RESTORE_LIFECYCLE_STATUS=${JSON.stringify(result.lifecycle_status)}`,
      `RESTORE_REPOSITORY_SAMPLE_COUNT=${result.samples.length}`,
      'RESTORE_DATABASE_VALIDATION=PASS',
      ''
    ].join('\n'));
    return result;
  } catch (error) {
    process.stderr.write(`PRODUCTION_BACKUP_RESTORE_DRILL=FAIL\nERROR_CODE=${safeErrorCode(error)}\n`);
    process.exitCode = 1;
    return null;
  } finally {
    if (pool) await closePostgresPool(pool);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  BACKUP_RUN_ID,
  EXPECTED,
  MANIFEST_KEY,
  PRODUCTION_DATABASE,
  ProductionRestoreDrillError,
  RESTORE_ROOT,
  assertRestoreDatabaseName,
  buildPgRestoreArguments,
  downloadArtifact,
  downloadBackupArtifacts,
  main,
  restorePostgresDump,
  safeErrorCode,
  validateJsonSnapshot,
  validateManifest,
  validateMigrationRows,
  validateRestoredDatabase,
  verifyDownloadedArtifact,
  verifyRemoteArtifact
};
