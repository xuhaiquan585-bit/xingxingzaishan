'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const {
  assertIndependentBuckets,
  bucketIdentity,
  executeObjectMirror,
  executeObjectRestoreAudit,
  getMirrorObjectMetadata,
  listReferencedObjectKeys,
  mirrorOneObject,
  uploadMirrorObjectWriteOnly
} = require('../scripts/database/production-object-mirror');
const {
  parseArguments,
  runObjectMirrorCli
} = require('../scripts/database/production-object-mirror-cli');
const {
  parseArguments: parseRestoreAuditArguments,
  runRestoreAuditCli
} = require('../scripts/database/production-object-restore-audit-cli');
const {
  analyzeSnapshot,
  classifyRecordReference,
  classifyUrlReference,
  readPostgresSnapshot,
  resolveJsonDatabasePath,
  runAudit
} = require('../scripts/database/audit-production-source-oss-public-dependencies');
const {
  applyRemediation,
  parseArguments: parseLogoRemediationArguments,
  readJsonSnapshot: readLogoRemediationJsonSnapshot,
  validateLogoReferences
} = require('../scripts/database/remediate-production-source-oss-logo-reference');
const {
  changeBucketAcl,
  parseArguments: parsePrivateSwitchArguments,
  runSourceOssPrivateSwitch
} = require('../scripts/database/source-oss-private-switch');
const {
  auditSourceDownloads,
  classifySourceReadFailure,
  printAuditSummary
} = require('../scripts/database/audit-production-object-mirror-source-downloads');

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xingxing-object-mirror-'));
}

function fakePool(rows) {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (/^WITH referenced_objects/.test(sql)) return { rows };
      return { rows: [] };
    },
    release() {
      calls.push('RELEASE');
    }
  };
  return {
    calls,
    async connect() {
      calls.push('CONNECT');
      return client;
    }
  };
}

function bucketClient({ name, location, ownerId, acl = 'private' }) {
  return {
    async getBucketInfo() {
      return {
        bucket: {
          Name: name,
          Location: location,
          Owner: { ID: ownerId },
          AccessControlList: { Grant: acl }
        }
      };
    }
  };
}

test('object mirror inventory is a repeatable-read query over every durable object reference', async () => {
  const pool = fakePool([
    { object_key: 'stars/record-images/a/main.jpg' },
    { object_key: 'stars/records/a/manifest.json' }
  ]);
  const keys = await listReferencedObjectKeys({ pool });
  assert.deepEqual(keys, [
    'stars/record-images/a/main.jpg',
    'stars/records/a/manifest.json'
  ]);
  assert.equal(pool.calls.includes('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'), true);
  const inventorySql = pool.calls.find((value) => /^WITH referenced_objects/.test(value));
  for (const column of [
    'records', 'products', 'product_images', 'record_proofs', 'record_archives',
    'print_batches',
    'image_object_key', 'cover_image_object_key', 'manifest_object_key',
    'certificate_object_key', 'legacy_manifest_object_key', 'index_object_key',
    'artifact_object_key', '-thumb-v2.jpg'
  ]) {
    assert.equal(inventorySql.includes(column), true);
  }
});

test('mirror requires a private destination in another bucket, region, and owner account', () => {
  const source = { name: 'primary', location: 'oss-cn-beijing', ownerId: 'owner-a', acl: 'private' };
  assert.doesNotThrow(() => assertIndependentBuckets(source, {
    name: 'secondary', location: 'oss-cn-shanghai', ownerId: 'owner-b', acl: 'private'
  }));
  for (const destination of [
    { name: 'primary', location: 'oss-cn-shanghai', ownerId: 'owner-b', acl: 'private' },
    { name: 'secondary', location: 'oss-cn-beijing', ownerId: 'owner-b', acl: 'private' },
    { name: 'secondary', location: 'oss-cn-shanghai', ownerId: 'owner-a', acl: 'private' },
    { name: 'secondary', location: 'oss-cn-shanghai', ownerId: 'owner-b', acl: 'public-read' }
  ]) {
    assert.throws(() => assertIndependentBuckets(source, destination));
  }
  assert.deepEqual(bucketIdentity({
    bucket: { Name: 'secondary', Location: 'oss-cn-shanghai' },
    owner: { id: 'owner-b' },
    acl: 'private'
  }, 'unused'), {
    name: 'secondary',
    location: 'oss-cn-shanghai',
    ownerId: 'owner-b',
    acl: 'private'
  });
});

test('mirror metadata uses one HEAD request and preserves integrity fields', async () => {
  let headCalls = 0;
  const metadata = await getMirrorObjectMetadata({
    objectKey: 'stars/record-images/a/main.jpg',
    client: {
      async head() {
        headCalls += 1;
        return {
          status: 200,
          res: {
            headers: {
              'content-length': '14',
              etag: '"source-etag"',
              'x-oss-meta-sha256': 'a'.repeat(64),
              'x-oss-meta-size': '14'
            }
          }
        };
      }
    }
  });
  assert.equal(headCalls, 1);
  assert.equal(metadata.size, 14);
  assert.equal(metadata.etag, 'source-etag');
  assert.equal(metadata.sha256, 'a'.repeat(64));
  assert.equal(metadata.declared_size, '14');
});

test('write-only uploader accepts a PUT receipt without destination read permission', async () => {
  const directory = tempDirectory();
  const localPath = path.join(directory, 'object.bin');
  const bytes = Buffer.from('write-only-backup');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(localPath, bytes);
  let putCalls = 0;
  const client = {
    async put(objectKey, filePath, options) {
      putCalls += 1;
      assert.equal(objectKey, 'stars/record-images/a/main.jpg');
      assert.equal(filePath, localPath);
      assert.equal(options.headers['x-oss-forbid-overwrite'], 'true');
      assert.equal(options.meta.sha256, sha256);
      return { res: { status: 200, headers: { etag: '"write-receipt"' } } };
    },
    head() { assert.fail('write-only uploader must not call HEAD'); },
    get() { assert.fail('write-only uploader must not call GET'); },
    getStream() { assert.fail('write-only uploader must not call GET stream'); }
  };
  try {
    const receipt = await uploadMirrorObjectWriteOnly({
      objectKey: 'stars/record-images/a/main.jpg',
      localPath,
      contentType: 'image/jpeg',
      sha256,
      size: bytes.length,
      client
    });
    assert.equal(putCalls, 1);
    assert.equal(receipt.status, 200);
    assert.equal(receipt.etag, 'write-receipt');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('production CLI requires one explicit mode and preflight remains read-only', async () => {
  assert.throws(() => parseArguments([]), { code: 'MIRROR_MODE_REQUIRED' });
  assert.throws(
    () => parseArguments(['--preflight', '--authorize-mirror-write=YES']),
    { code: 'MIRROR_MODE_REQUIRED' }
  );
  assert.throws(
    () => parseArguments([
      '--authorize-mirror=YES',
      '--run-id=20261001T010203Z-abcdef12'
    ]),
    { code: 'MIRROR_ARGUMENT_INVALID' }
  );
  const authorized = parseArguments([
    '--authorize-mirror-write=YES',
    '--run-id=20261001T010203Z-abcdef12',
    `--output-directory=${path.resolve('mirror-output')}`
  ]);
  assert.equal(authorized.authorized, true);

  const directory = tempDirectory();
  const sourceEnv = path.join(directory, 'source.env');
  const destinationEnv = path.join(directory, 'destination.env');
  fs.writeFileSync(sourceEnv, [
    'OSS_ENDPOINT=https://oss-cn-beijing.aliyuncs.com',
    'OSS_REGION=oss-cn-beijing',
    'OSS_BUCKET=primary',
    'OSS_ACCESS_KEY_ID=source-key',
    'OSS_ACCESS_KEY_SECRET=source-secret'
  ].join('\n'), { mode: 0o600 });
  fs.writeFileSync(destinationEnv, [
    'MIRROR_OSS_ENDPOINT=https://oss-cn-shanghai.aliyuncs.com',
    'MIRROR_OSS_REGION=oss-cn-shanghai',
    'MIRROR_OSS_BUCKET=secondary',
    'MIRROR_OSS_ACCESS_KEY_ID=destination-key',
    'MIRROR_OSS_ACCESS_KEY_SECRET=destination-secret'
  ].join('\n'), { mode: 0o600 });
  const lines = [];
  let closed = false;
  let mutationCalls = 0;
  class FakeOssClient {
    constructor(config) {
      this.config = config;
    }

    async getBucketInfo() {
      const primary = this.config.bucket === 'primary';
      return {
        bucket: {
          Name: this.config.bucket,
          Location: this.config.region,
          Owner: { ID: primary ? 'owner-a' : 'owner-b' },
          AccessControlList: { Grant: 'private' }
        }
      };
    }

    async put() {
      mutationCalls += 1;
    }
  }

  try {
    await runObjectMirrorCli({
      argv: [
        '--preflight',
        `--source-oss-env=${sourceEnv}`,
        `--destination-oss-env=${destinationEnv}`
      ],
      environment: {
        PGHOST: '127.0.0.1',
        PGPORT: '5432',
        PGUSER: 'readonly',
        PGDATABASE: 'acceptance',
        PGSSL: 'false'
      },
      OssClient: FakeOssClient,
      createPool() {
        return fakePool([{ object_key: 'stars/record-images/a/main.jpg' }]);
      },
      async closePool() {
        closed = true;
      },
      writeLine(line) {
        lines.push(line);
      }
    });
    assert.equal(mutationCalls, 0);
    assert.equal(closed, true);
    assert.equal(lines.includes('MIRROR_OBJECT_INVENTORY_COUNT=1'), true);
    assert.equal(lines.at(-1), 'PRODUCTION_OBJECT_MIRROR_PREFLIGHT=PASS');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('production mirror reconstructs dotenv runtime and requires a bound process snapshot', async () => {
  const directory = tempDirectory();
  const sourceEnv = path.join(directory, 'source.env');
  const destinationEnv = path.join(directory, 'destination.env');
  fs.writeFileSync(sourceEnv, [
    'NODE_ENV=production',
    'PUBLIC_QR_POSTGRES_READ_ENABLED=true',
    'PUBLIC_QR_POSTGRES_READ_SCOPE=all',
    'PERSONAL_RECORD_POSTGRES_READ_ENABLED=true',
    'PERSONAL_RECORD_POSTGRES_READ_SCOPE=all',
    'PGHOST=127.0.0.1',
    'PGPORT=5432',
    'PGUSER=file-user',
    'PGDATABASE=xingxing_clean_baseline_20260812_staging',
    'PGSSL=false',
    'OSS_ENDPOINT=https://oss-cn-beijing.aliyuncs.com',
    'OSS_REGION=oss-cn-beijing',
    'OSS_BUCKET=primary',
    'OSS_ACCESS_KEY_ID=source-key',
    'OSS_ACCESS_KEY_SECRET=source-secret'
  ].join('\n'), { mode: 0o600 });
  fs.writeFileSync(destinationEnv, [
    'MIRROR_OSS_ENDPOINT=https://oss-cn-shanghai.aliyuncs.com',
    'MIRROR_OSS_REGION=oss-cn-shanghai',
    'MIRROR_OSS_BUCKET=secondary',
    'MIRROR_OSS_ACCESS_KEY_ID=destination-key',
    'MIRROR_OSS_ACCESS_KEY_SECRET=destination-secret'
  ].join('\n'), { mode: 0o600 });

  class FakeOssClient {
    constructor(config) {
      this.config = config;
    }

    async getBucketInfo() {
      const primary = this.config.bucket === 'primary';
      return {
        bucket: {
          Name: this.config.bucket,
          Location: this.config.region,
          Owner: { ID: primary ? 'owner-a' : 'owner-b' },
          AccessControlList: { Grant: 'private' }
        }
      };
    }
  }

  const processBytes = Buffer.from('PGUSER=process-user\0');
  let selectedConfig;
  try {
    await runObjectMirrorCli({
      argv: [
        '--preflight',
        '--app-pid=1234',
        `--process-started-at-ms=${Date.now() + 10_000}`,
        `--source-oss-env=${sourceEnv}`,
        `--destination-oss-env=${destinationEnv}`
      ],
      environment: { NODE_ENV: 'test', PGUSER: 'must-not-win' },
      readFileSync: () => processBytes,
      readlinkSync: () => directory,
      realpathSync: (value) => value,
      OssClient: FakeOssClient,
      createPool({ config }) {
        selectedConfig = config;
        return fakePool([]);
      },
      async closePool() {},
      writeLine() {}
    });
    assert.equal(selectedConfig.host, '127.0.0.1');
    assert.equal(selectedConfig.user, 'process-user');
    assert.equal(selectedConfig.database, 'xingxing_clean_baseline_20260812_staging');

    await assert.rejects(() => runObjectMirrorCli({
      argv: [
        '--preflight',
        `--source-oss-env=${sourceEnv}`,
        `--destination-oss-env=${destinationEnv}`
      ],
      environment: { NODE_ENV: 'production' },
      OssClient: FakeOssClient,
      createPool() {
        throw new Error('pool must not be created');
      }
    }), { code: 'MIRROR_RUNTIME_SNAPSHOT_REQUIRED' });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('production object mirror runner gates mutations and leaves the application unchanged', () => {
  const source = fs.readFileSync(path.join(
    __dirname,
    '..',
    'scripts',
    'database',
    'run-production-object-mirror.sh'
  ), 'utf8');
  assert.match(source, /--preflight/);
  assert.match(source, /--authorize-mirror-write=YES/);
  assert.match(source, /git status --porcelain=v1 --untracked-files=normal/);
  assert.match(source, /WORKTREE_NOT_CLEAN/);
  assert.match(source, /\?\? src\/frontend\/5QJLlAJPza\.txt/);
  assert.match(source, /PUBLIC_VERIFICATION_FILE_INVALID/);
  assert.doesNotMatch(source, /--untracked-files=no(?!rmal)/);
  assert.match(source, /assert_root_private_regular_file "\$SOURCE_OSS_ENV"/);
  assert.match(source, /assert_root_private_regular_file "\$DESTINATION_OSS_ENV"/);
  assert.match(source, /RUNTIME_CONFIG_CHECK/);
  assert.match(source, /--app-pid="\$APP_PID_BEFORE"/);
  assert.match(source, /--process-started-at-ms="\$PM2_STARTED_AT_MS"/);
  assert.match(source, /APP_PID_AFTER="\$\(pm2 pid/);
  assert.match(source, /\[ "\$APP_PID_AFTER" = "\$APP_PID_BEFORE" \]/);
  assert.match(source, /PRODUCTION_OBJECT_MIRROR_RUNNER_PREFLIGHT=PASS/);
  assert.match(source, /PRODUCTION_OBJECT_MIRROR_RUNNER=PASS/);
  assert.match(source, /DATABASE_WRITE=NONE/);
  assert.match(source, /APPLICATION_RESTART=NO/);
  assert.doesNotMatch(source, /pm2 (?:restart|reload|start|delete)/);
  assert.doesNotMatch(source, /systemctl (?:start|restart|enable)/);
  assert.doesNotMatch(source, /git (?:pull|merge|checkout|reset)/);
  assert.doesNotMatch(source, /source "?\$?(?:SOURCE|DESTINATION)_OSS_ENV/);
  assert.doesNotMatch(source, /runtime_value/);
  assert.match(source, /^LOCAL_RUN_RETENTION_COUNT=45$/m);
  assert.doesNotMatch(source, /--restore-audit=/);
  assert.match(source, /DESTINATION_OBJECT_READ=NONE/);
  assert.match(source, /INDEPENDENT_RESTORE_AUDIT=REQUIRED/);
  assert.match(source, /prune_local_run_directories "\$OUTPUT_DIRECTORY"/);
  assert.match(source, /printf '%s\\n' "\$current_name"/);
  assert.match(source, /awk '!seen\[\$0\]\+\+'/);
  assert.match(source, /\[ ! -L "\$candidate" \]/);
  assert.match(source, /\[ "\$candidate" = "\$current_directory" \]/);
  assert.match(source, /rm -rf -- "\$candidate"/);
  assert.match(source, /MIRROR_LOCAL_RUN_RETENTION_COUNT/);
});

test('source download audit classifies a bounded full sweep without exposing object keys', async () => {
  const objectKeys = [
    'stars/pass.jpg',
    'stars/missing.jpg',
    'stars/forbidden.jpg',
    'stars/reset.jpg'
  ];
  const bytes = Buffer.from('readable-source-object');
  const client = {
    async head(objectKey) {
      if (objectKey.endsWith('missing.jpg')) {
        const error = new Error('must stay private');
        error.status = 404;
        error.code = 'NoSuchKey';
        throw error;
      }
      return {
        res: { status: 200, headers: { 'content-length': String(bytes.length) } }
      };
    },
    async getStream(objectKey) {
      if (objectKey.endsWith('forbidden.jpg')) {
        const error = new Error('credentials must stay private');
        error.statusCode = 403;
        error.code = 'AccessDenied';
        throw error;
      }
      if (objectKey.endsWith('reset.jpg')) {
        const error = new Error('socket details must stay private');
        error.code = 'ECONNRESET';
        throw error;
      }
      return {
        stream: Readable.from([bytes.subarray(0, 5), bytes.subarray(5)]),
        res: { status: 200, headers: { 'content-length': String(bytes.length) } }
      };
    }
  };
  const result = await auditSourceDownloads({ objectKeys, client, concurrency: 2 });
  assert.equal(result.total, 4);
  assert.equal(result.success, 1);
  assert.equal(result.failure, 3);
  assert.equal(result.counts.HEAD_NOT_FOUND, 1);
  assert.equal(result.counts.GET_FORBIDDEN, 1);
  assert.equal(result.counts.GET_TRANSPORT, 1);

  const lines = [];
  printAuditSummary(result, (line) => lines.push(line));
  const output = lines.join('\n');
  assert.match(output, /SOURCE_DOWNLOAD_AUDIT_FAILURE=3/);
  assert.match(output, /SOURCE_DOWNLOAD_AUDIT_RESULT=FAILURES_CLASSIFIED/);
  for (const objectKey of objectKeys) assert.equal(output.includes(objectKey), false);
  assert.equal(output.includes('credentials must stay private'), false);
});

test('source download audit keeps provider errors in a fixed safe taxonomy', () => {
  assert.equal(classifySourceReadFailure({ status: 403 }, 'get'), 'GET_FORBIDDEN');
  assert.equal(classifySourceReadFailure({ statusCode: 404 }, 'head'), 'HEAD_NOT_FOUND');
  assert.equal(classifySourceReadFailure({ code: 'ETIMEDOUT' }, 'get'), 'GET_TIMEOUT');
  assert.equal(classifySourceReadFailure({ status: 503 }, 'head'), 'HEAD_UPSTREAM');
  assert.equal(classifySourceReadFailure(new Error('secret-bearing text'), 'get'), 'GET_UNKNOWN');
});

test('production source download audit runner is pinned and strictly read-only', () => {
  const source = fs.readFileSync(path.join(
    __dirname,
    '..',
    'scripts',
    'database',
    'run-production-object-mirror-source-download-audit.sh'
  ), 'utf8');
  assert.match(source, /^EXPECTED_COMMIT=7e7bbdd8714239f59dba50199ec2843e2a263ff6$/m);
  assert.match(source, /^EXPECTED_TREE=34d83ad54990827c5e30b8cd5849408cfe06e134$/m);
  assert.match(source, /--check/);
  assert.match(source, /RUNTIME_CONFIG_CHECK/);
  assert.match(source, /SOURCE_GET_BUCKET_INFO_HEAD_AND_GET_ONLY/);
  assert.match(source, /DESTINATION_OSS_REQUESTS=NONE/);
  assert.match(source, /OBJECT_KEYS_PRINTED=NO/);
  assert.match(source, /PRODUCTION_OBJECT_MIRROR_SOURCE_DOWNLOAD_AUDIT_RUNNER=PASS/);
  assert.doesNotMatch(source, /--authorize-mirror-write=YES/);
  assert.doesNotMatch(source, /systemctl (?:start|restart|enable)/);
  assert.doesNotMatch(source, /pm2 (?:restart|reload|start|delete)/);
  assert.doesNotMatch(source, /git (?:pull|merge|checkout|reset)/);
});

test('production object mirror destination config uses hidden input and rolls back failed preflight', () => {
  const source = fs.readFileSync(path.join(
    __dirname,
    '..',
    'scripts',
    'database',
    'configure-production-object-mirror-destination.sh'
  ), 'utf8');
  assert.match(source, /--preflight/);
  assert.match(source, /--authorize-configure=YES/);
  assert.match(source, /IFS= read -r ACCESS_KEY_ID/);
  assert.match(source, /IFS= read -r -s ACCESS_KEY_SECRET/);
  assert.match(source, /^EXPECTED_ENDPOINT=oss-cn-shanghai\.aliyuncs\.com$/m);
  assert.match(source, /^EXPECTED_REGION=oss-cn-shanghai$/m);
  assert.match(source, /^EXPECTED_BUCKET=xingxingzaishan-mirror-01beifen$/m);
  assert.match(source, /^EXPECTED_COMMIT=7e7bbdd8714239f59dba50199ec2843e2a263ff6$/m);
  assert.match(source, /^EXPECTED_TREE=34d83ad54990827c5e30b8cd5849408cfe06e134$/m);
  assert.match(source, /\[ -f "\$MIRROR_RUNNER" \]/);
  assert.match(source, /\[ ! -L "\$MIRROR_RUNNER" \]/);
  assert.doesNotMatch(source, /\[ -x "\$MIRROR_RUNNER" \]/);
  assert.match(source, /chmod 0600 "\$TEMPORARY_FILE"/);
  assert.match(source, /chown root:root "\$TEMPORARY_FILE"/);
  assert.match(source, /"\$MIRROR_RUNNER" --preflight/);
  assert.match(source, /DESTINATION_CONFIG_ROLLED_BACK=YES/);
  assert.match(source, /rm -f -- "\$CONFIG_FILE"/);
  assert.match(source, /PRODUCTION_OBJECT_MIRROR_DESTINATION_CONFIG_PREFLIGHT=PASS/);
  assert.match(source, /PRODUCTION_OBJECT_MIRROR_DESTINATION_CONFIG=PASS/);
  assert.match(source, /SECRET_VALUES_PRINTED=NO/);
  assert.doesNotMatch(source, /pm2 (?:restart|reload|start|delete)/);
  assert.doesNotMatch(source, /systemctl (?:start|restart|enable)/);
  assert.doesNotMatch(source, /MIRROR_OSS_ACCESS_KEY_(?:ID|SECRET)=\$\{?[12]/);
});

test('source OSS dependency audit separates signed records from public URL blockers', () => {
  const matchers = [{
    origin: 'https://primary.example.invalid',
    pathname: '/assets',
    prefixBounded: true
  }];
  const context = { objectPrefix: 'stars', matchers };
  assert.equal(classifyUrlReference(
    'https://primary.example.invalid/assets/products/one.jpg', matchers
  ), 'source_public_direct');
  assert.equal(classifyUrlReference(
    'https://primary.example.invalid/other/one.jpg', matchers
  ), 'external_absolute');
  assert.equal(classifyUrlReference('/uploads/one.jpg', matchers), 'relative_local');
  const qrId = 'S2609A00001';
  const qrHash = crypto.createHash('sha256').update(qrId).digest('hex');
  assert.equal(classifyRecordReference({
    qr_id: qrId,
    image_object_key: `stars/record-images/${qrHash}/one-record-v2.jpg`
  }, context), 'current_object_signed');
  assert.equal(classifyRecordReference({
    access_token: 'b'.repeat(32),
    image_object_key: `stars/${'b'.repeat(32)}/legacy.jpg`
  }, context), 'legacy_object_proxy');

  const result = analyzeSnapshot({
    objectPrefix: 'stars',
    matchers,
    postgres: {
      records: [
        { qr_id: qrId, image_object_key: `stars/record-images/${qrHash}/one.jpg` },
        { image_url_snapshot: 'https://primary.example.invalid/assets/records/two.jpg' }
      ],
      products: [{ cover_image_url: 'https://primary.example.invalid/assets/shadow.jpg' }],
      productImages: [],
      miniapp: []
    },
    json: {
      qr_codes: [],
      products: [{
        cover_image: 'https://primary.example.invalid/assets/product.jpg',
        images: ['https://external.example.invalid/detail.jpg']
      }],
      miniapp_content: {
        logo_image: '/uploads/logo.jpg',
        home_banner_image: 'https://primary.example.invalid/assets/banner.jpg',
        home_slides: [],
        scene_cards: []
      },
      orders: [{
        product_snapshot: {
          cover_image: 'https://primary.example.invalid/assets/order.jpg'
        }
      }]
    }
  });
  assert.equal(result.postgresRecords.current_object_signed, 1);
  assert.equal(result.postgresRecords.source_public_direct, 1);
  assert.equal(result.jsonProducts.source_public_direct, 1);
  assert.equal(result.jsonProducts.external_absolute, 1);
  assert.equal(result.jsonMiniapp.source_public_direct, 1);
  assert.equal(result.jsonMiniappGroups.logoImage.relative_local, 1);
  assert.equal(result.jsonMiniappGroups.homeBannerImage.source_public_direct, 1);
  assert.equal(result.jsonMiniappGroups.homeSlideImages.total, 0);
  assert.equal(result.jsonMiniappGroups.sceneCardImages.total, 0);
  assert.equal(result.jsonOrderSnapshots.source_public_direct, 1);
  assert.equal(result.postgresProducts.source_public_direct, 1);
  assert.equal(result.blockers, 4);
  assert.equal(result.ready, false);
});

test('source OSS dependency audit follows the application JSON database default', () => {
  const repository = path.resolve('fixture-repository');
  assert.deepEqual(resolveJsonDatabasePath(repository, {}), {
    filePath: path.join(repository, 'src', 'server', 'data', 'db.json'),
    source: 'RUNTIME_DEFAULT'
  });
  assert.deepEqual(resolveJsonDatabasePath(repository, { DB_FILE: 'runtime/db.json' }), {
    filePath: path.resolve(repository, 'runtime/db.json'),
    source: 'EXPLICIT_DB_FILE'
  });
});

test('source OSS dependency audit emits aggregate classifications without source values', async () => {
  const directory = tempDirectory();
  const jsonFile = path.join(directory, 'db.json');
  const secret = 'must-not-be-printed-source-secret';
  const sourceUrl = 'https://primary.example.invalid/assets/private-name.jpg';
  fs.writeFileSync(jsonFile, JSON.stringify({
    qr_codes: [],
    products: [{ cover_image: sourceUrl, images: [] }],
    miniapp_content: { home_slides: [], scene_cards: [] },
    orders: []
  }));
  const queryRows = {
    records: [{ qr_id: 'S1', image_url_snapshot: sourceUrl, image_object_key: null }],
    products: [],
    'product-images': [],
    miniapp: []
  };
  const calls = [];
  const pool = {
    async connect() {
      return {
        async query(sql) {
          calls.push(sql);
          const marker = /source-oss-audit:([a-z-]+)/.exec(String(sql));
          return { rows: marker ? queryRows[marker[1]] : [] };
        },
        release() {}
      };
    }
  };
  const lines = [];
  try {
    await runAudit({
      argv: [
        '--check',
        `--repository=${path.resolve('.')}`,
        '--app-pid=123',
        '--process-started-at-ms=1000'
      ],
      dependencies: {
        OSS: class {},
        mirrorCli: {
          readProtectedEnvironmentSnapshot() {
            return { environment: {}, modifiedAtMs: 1 };
          },
          loadEffectiveSourceEnvironment() {
            return {
              NODE_ENV: 'production',
              PGDATABASE: 'xingxing_clean_baseline_20260812_staging',
              DB_FILE: jsonFile,
              CLOUD_PUBLIC_BASE_URL: 'https://primary.example.invalid/assets',
              OSS_ENDPOINT: 'oss-cn-beijing.aliyuncs.com',
              OSS_REGION: 'oss-cn-beijing',
              OSS_BUCKET: 'primary',
              OSS_ACCESS_KEY_ID: 'source-key-id',
              OSS_ACCESS_KEY_SECRET: secret
            };
          },
          assertProductionMirrorEnvironment() {},
          readOssConfig(environment) {
            return {
              endpoint: environment.OSS_ENDPOINT,
              region: environment.OSS_REGION,
              bucket: environment.OSS_BUCKET,
              accessKeyId: environment.OSS_ACCESS_KEY_ID,
              accessKeySecret: environment.OSS_ACCESS_KEY_SECRET,
              secure: true
            };
          }
        },
        mirror: {
          async inspectBucket() {
            return { acl: 'public-read' };
          }
        },
        databaseConfig: { readPostgresConfig: () => ({}) },
        databaseConnection: {
          createPostgresPool: () => pool,
          closePostgresPool: async () => {}
        },
        transaction: {
          withTransaction: require('../src/server/database/transaction').withTransaction
        }
      },
      writeLine(line) {
        lines.push(line);
      }
    });
    const output = lines.join('\n');
    assert.match(output, /SOURCE_OSS_CURRENT_ACL=PUBLIC_READ/);
    assert.match(output, /SOURCE_PRIVATE_SWITCH_BLOCKERS=2/);
    assert.match(output, /SOURCE_PRIVATE_SWITCH_READY=NO/);
    assert.match(output, /JSON_MINIAPP_HOME_BANNER_IMAGE_REFERENCES_EMPTY=1/);
    assert.match(output, /PRODUCTION_SOURCE_OSS_PUBLIC_DEPENDENCY_AUDIT=COLLECTED/);
    assert.equal(output.includes(sourceUrl), false);
    assert.equal(output.includes('private-name.jpg'), false);
    assert.equal(output.includes(secret), false);
    assert.equal(calls.includes('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('source OSS dependency audit reads PostgreSQL in one repeatable-read transaction', async () => {
  const pool = fakePool([]);
  const snapshot = await readPostgresSnapshot({
    pool,
    withTransaction: require('../src/server/database/transaction').withTransaction
  });
  assert.deepEqual(snapshot, {
    records: [], products: [], productImages: [], miniapp: []
  });
  assert.equal(pool.calls.includes('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'), true);
  for (const marker of ['records', 'products', 'product-images', 'miniapp']) {
    assert.equal(pool.calls.some((sql) => String(sql).includes(`source-oss-audit:${marker}`)), true);
  }
});

test('source OSS public dependency audit runner is read-only and emits no sensitive values', () => {
  const scriptsRoot = path.join(__dirname, '..', 'scripts', 'database');
  const runner = fs.readFileSync(path.join(
    scriptsRoot, 'run-production-source-oss-public-dependency-audit.sh'
  ), 'utf8');
  const cli = fs.readFileSync(path.join(
    scriptsRoot, 'audit-production-source-oss-public-dependencies.js'
  ), 'utf8');
  assert.match(runner, /^EXPECTED_COMMIT=5970420f7b61c7551ceb07099f0aa93e613e05d3$/m);
  assert.match(runner, /^EXPECTED_TREE=dd5a574b4c78af7c162a3c5feb817b8f9b5703a6$/m);
  assert.match(runner, /--check/);
  assert.match(runner, /RUNTIME_CONFIG_CHECK/);
  assert.match(runner, /PRODUCTION_SOURCE_OSS_PUBLIC_DEPENDENCY_AUDIT_RUNNER=PASS/);
  assert.match(cli, /SOURCE_PRIVATE_SWITCH_BLOCKERS/);
  assert.match(cli, /OSS_REQUESTS=SOURCE_GET_BUCKET_INFO_ONLY/);
  assert.match(cli, /POSTGRES_ACCESS=READ_ONLY_REPEATABLE_READ/);
  assert.match(cli, /OBJECT_KEYS_PRINTED=NO/);
  assert.match(cli, /URLS_PRINTED=NO/);
  for (const source of [runner, cli]) {
    assert.doesNotMatch(source, /pm2 (?:restart|reload|start|delete)/);
    assert.doesNotMatch(source, /systemctl (?:start|restart|enable)/);
    assert.doesNotMatch(source, /\.(?:put|delete|copy)\s*\(/);
  }
  assert.doesNotMatch(runner, /object-mirror\.env/);
});

test('source OSS logo remediation accepts only one matching source-public reference', () => {
  const sourceUrl = 'https://primary.example.invalid/assets/logo.jpg';
  const matchers = [{
    origin: 'https://primary.example.invalid',
    pathname: '/assets',
    prefixBounded: true
  }];
  assert.equal(validateLogoReferences({
    jsonLogo: sourceUrl,
    postgresLogo: sourceUrl,
    matchers
  }), sourceUrl);
  assert.throws(() => validateLogoReferences({
    jsonLogo: sourceUrl,
    postgresLogo: 'https://primary.example.invalid/assets/other.jpg',
    matchers
  }), /SOURCE_OSS_LOGO_REMEDIATION_REFERENCE_MISMATCH/);
  assert.throws(() => validateLogoReferences({
    jsonLogo: 'https://external.example.invalid/logo.jpg',
    postgresLogo: 'https://external.example.invalid/logo.jpg',
    matchers
  }), /SOURCE_OSS_LOGO_REMEDIATION_REFERENCE_NOT_SOURCE_PUBLIC/);
  assert.deepEqual(parseLogoRemediationArguments([
    '--preflight',
    `--repository=${path.resolve('.')}`,
    '--app-pid=123',
    '--process-started-at-ms=1000'
  ]), {
    mode: 'preflight',
    repository: path.resolve('.'),
    appPid: '123',
    processStartedAtMs: 1000,
    backupDirectory: ''
  });
});

test('source OSS logo remediation clears JSON and PostgreSQL together', async () => {
  const directory = tempDirectory();
  const jsonFile = path.join(directory, 'db.json');
  const sourceUrl = 'https://primary.example.invalid/assets/logo.jpg';
  fs.writeFileSync(jsonFile, JSON.stringify({
    miniapp_content: { logo_image: sourceUrl },
    untouched: { value: 'preserve-me' }
  }, null, 2));
  let postgresLogo = sourceUrl;
  const withTransaction = async (_pool, callback) => {
    const original = postgresLogo;
    try {
      return await callback({
        async query(sql, values) {
          if (String(sql).includes(':lock')) {
            return { rows: [{ logo_image: postgresLogo }] };
          }
          if (String(sql).includes(':update')) {
            if (values[0] !== postgresLogo) return { rowCount: 0, rows: [] };
            postgresLogo = '';
            return { rowCount: 1, rows: [{ id: 1 }] };
          }
          throw new Error('unexpected query');
        }
      });
    } catch (error) {
      postgresLogo = original;
      throw error;
    }
  };
  try {
    const snapshot = readLogoRemediationJsonSnapshot(jsonFile);
    await applyRemediation({
      pool: {},
      withTransaction,
      jsonFile,
      jsonSnapshot: snapshot,
      expectedLogo: sourceUrl
    });
    const after = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    assert.equal(after.miniapp_content.logo_image, '');
    assert.equal(after.untouched.value, 'preserve-me');
    assert.equal(postgresLogo, '');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('source OSS logo remediation restores JSON if the database commit fails', async () => {
  const directory = tempDirectory();
  const jsonFile = path.join(directory, 'db.json');
  const sourceUrl = 'https://primary.example.invalid/assets/logo.jpg';
  const original = JSON.stringify({
    miniapp_content: { logo_image: sourceUrl },
    untouched: true
  }, null, 2);
  fs.writeFileSync(jsonFile, original);
  const withTransaction = async (_pool, callback) => {
    await callback({
      async query(sql) {
        if (String(sql).includes(':lock')) return { rows: [{ logo_image: sourceUrl }] };
        if (String(sql).includes(':update')) return { rowCount: 1, rows: [{ id: 1 }] };
        throw new Error('unexpected query');
      }
    });
    const error = new Error('commit failed');
    error.code = 'POSTGRES_TRANSACTION_COMMIT_FAILED';
    throw error;
  };
  try {
    const snapshot = readLogoRemediationJsonSnapshot(jsonFile);
    await assert.rejects(applyRemediation({
      pool: {},
      withTransaction,
      jsonFile,
      jsonSnapshot: snapshot,
      expectedLogo: sourceUrl
    }), /commit failed/);
    assert.equal(fs.readFileSync(jsonFile, 'utf8'), original);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('source OSS logo remediation runner is pinned, bounded, and does not change ACL', () => {
  const scriptsRoot = path.join(__dirname, '..', 'scripts', 'database');
  const runner = fs.readFileSync(path.join(
    scriptsRoot, 'run-production-source-oss-logo-remediation.sh'
  ), 'utf8');
  const cli = fs.readFileSync(path.join(
    scriptsRoot, 'remediate-production-source-oss-logo-reference.js'
  ), 'utf8');
  assert.match(runner, /^EXPECTED_COMMIT=5970420f7b61c7551ceb07099f0aa93e613e05d3$/m);
  assert.match(runner, /^EXPECTED_TREE=dd5a574b4c78af7c162a3c5feb817b8f9b5703a6$/m);
  assert.match(runner, /--authorize-remediate=YES/);
  assert.match(runner, /MINIAPP_LOGO_FALLBACK_CONTRACT=PASS/);
  assert.match(runner, /SOURCE_PRIVATE_SWITCH_BLOCKERS=0/);
  assert.match(runner, /SOURCE_BUCKET_ACL_CHANGED=NO/);
  assert.match(cli, /SET logo_image = ''/);
  assert.match(cli, /PRIVATE_ROLLBACK_BACKUP=PASS/);
  assert.match(cli, /SOURCE_OSS_LOGO_REMEDIATION_JSON_WRITE_CONFLICT/);
  for (const source of [runner, cli]) {
    assert.doesNotMatch(source, /pm2 (?:restart|reload|start|delete)/);
    assert.doesNotMatch(source, /setBucketACL|putBucketACL|deleteBucket/);
    assert.doesNotMatch(source, /\.delete\s*\(/);
  }
});

test('source OSS private switch arguments require one explicit bounded mode', () => {
  const repository = path.resolve('.');
  assert.deepEqual(parsePrivateSwitchArguments([
    '--preflight',
    `--repository=${repository}`,
    '--app-pid=123',
    '--process-started-at-ms=1000'
  ]), {
    mode: 'preflight',
    repository,
    appPid: '123',
    processStartedAtMs: 1000
  });
  assert.equal(parsePrivateSwitchArguments([
    '--authorize-private=YES',
    `--repository=${repository}`,
    '--app-pid=123',
    '--process-started-at-ms=1000'
  ]).mode, 'private');
  assert.equal(parsePrivateSwitchArguments([
    '--authorize-rollback-public-read=YES',
    `--repository=${repository}`,
    '--app-pid=123',
    '--process-started-at-ms=1000'
  ]).mode, 'public-read');
  assert.throws(() => parsePrivateSwitchArguments([
    '--preflight',
    '--authorize-private=YES',
    `--repository=${repository}`,
    '--app-pid=123',
    '--process-started-at-ms=1000'
  ]), /SOURCE_OSS_PRIVATE_SWITCH_ARGUMENT_INVALID/);
});

test('source OSS private switch preflight reads ACL without mutation', async () => {
  let writes = 0;
  const result = await changeBucketAcl({
    mode: 'preflight',
    bucket: 'primary',
    client: {
      async getBucketACL() {
        return { acl: 'public-read' };
      },
      async putBucketACL() {
        writes += 1;
      }
    }
  });
  assert.deepEqual(result, {
    before: 'public-read',
    after: 'public-read',
    changed: false
  });
  assert.equal(writes, 0);
});

test('source OSS private switch changes only the bucket ACL and verifies it', async () => {
  let acl = 'public-read';
  const calls = [];
  const result = await changeBucketAcl({
    mode: 'private',
    bucket: 'primary',
    client: {
      async getBucketACL(bucket) {
        calls.push(['get', bucket]);
        return { acl };
      },
      async putBucketACL(bucket, nextAcl) {
        calls.push(['put', bucket, nextAcl]);
        acl = nextAcl;
      }
    }
  });
  assert.deepEqual(result, { before: 'public-read', after: 'private', changed: true });
  assert.deepEqual(calls, [
    ['get', 'primary'],
    ['put', 'primary', 'private'],
    ['get', 'primary']
  ]);
});

test('source OSS ACL rollback is explicit and fail-closed', async () => {
  let acl = 'private';
  const result = await changeBucketAcl({
    mode: 'public-read',
    bucket: 'primary',
    client: {
      async getBucketACL() {
        return { acl };
      },
      async putBucketACL(_bucket, nextAcl) {
        acl = nextAcl;
      }
    }
  });
  assert.deepEqual(result, { before: 'private', after: 'public-read', changed: true });
  await assert.rejects(changeBucketAcl({
    mode: 'private',
    bucket: 'primary',
    client: {
      async getBucketACL() {
        return { acl: 'public-read-write' };
      }
    }
  }), /SOURCE_OSS_PRIVATE_SWITCH_ACL_UNEXPECTED/);
});

test('source OSS private switch CLI keeps credentials and bucket identity out of output', async () => {
  const lines = [];
  const repository = path.resolve('.');
  const secret = 'must-not-be-printed';
  await runSourceOssPrivateSwitch({
    argv: [
      '--authorize-private=YES',
      `--repository=${repository}`,
      '--app-pid=123',
      '--process-started-at-ms=1000'
    ],
    dependencies: {
      OSS: class {
        constructor(config) {
          assert.equal(config.accessKeySecret, secret);
          this.acl = 'public-read';
        }
        async getBucketACL() {
          return { acl: this.acl };
        }
        async putBucketACL(_bucket, acl) {
          this.acl = acl;
        }
      },
      mirrorCli: {
        readProtectedEnvironmentSnapshot() {
          return { environment: {}, modifiedAtMs: 1 };
        },
        loadEffectiveSourceEnvironment() {
          return {
            OSS_ENDPOINT: 'oss-cn-beijing.aliyuncs.com',
            OSS_REGION: 'oss-cn-beijing',
            OSS_BUCKET: 'private-source-name',
            OSS_ACCESS_KEY_ID: 'source-key-id',
            OSS_ACCESS_KEY_SECRET: secret
          };
        },
        assertProductionMirrorEnvironment() {},
        readOssConfig(environment) {
          return {
            endpoint: environment.OSS_ENDPOINT,
            region: environment.OSS_REGION,
            bucket: environment.OSS_BUCKET,
            accessKeyId: environment.OSS_ACCESS_KEY_ID,
            accessKeySecret: environment.OSS_ACCESS_KEY_SECRET,
            secure: true
          };
        }
      }
    },
    writeLine(line) {
      lines.push(line);
    }
  });
  const output = lines.join('\n');
  assert.match(output, /SOURCE_OSS_ACL_BEFORE=PUBLIC_READ/);
  assert.match(output, /SOURCE_OSS_ACL_AFTER=PRIVATE/);
  assert.match(output, /SOURCE_OSS_PRIVATE_SWITCH_CLI=PASS/);
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes('private-source-name'), false);
});

test('source OSS private switch runner is pinned, gated, and ACL-only', () => {
  const scriptsRoot = path.join(__dirname, '..', 'scripts', 'database');
  const runner = fs.readFileSync(path.join(
    scriptsRoot, 'run-production-source-oss-private-switch.sh'
  ), 'utf8');
  const cli = fs.readFileSync(path.join(
    scriptsRoot, 'source-oss-private-switch.js'
  ), 'utf8');
  assert.match(runner, /^EXPECTED_COMMIT=5970420f7b61c7551ceb07099f0aa93e613e05d3$/m);
  assert.match(runner, /^EXPECTED_TREE=dd5a574b4c78af7c162a3c5feb817b8f9b5703a6$/m);
  assert.match(runner, /--authorize-private=YES/);
  assert.match(runner, /--authorize-rollback-public-read=YES/);
  assert.match(runner, /--miniapp-release-confirmed=YES/);
  assert.match(runner, /--miniapp-release-pending-risk-accepted=YES/);
  assert.match(runner, /MINIAPP_RELEASE_STATE=PENDING_RISK_ACCEPTED/);
  assert.match(runner, /SOURCE_PRIVATE_SWITCH_BLOCKERS=0/);
  assert.match(runner, /SOURCE_PRIVATE_SWITCH_REVIEW_REQUIRED=0/);
  assert.match(runner, /SOURCE_PRIVATE_SWITCH_READY=YES/);
  assert.match(runner, /ROLLBACK_MODE=AVAILABLE_EXPLICIT_AUTHORIZATION_ONLY/);
  assert.match(cli, /putBucketACL\(bucket, target\)/);
  for (const source of [runner, cli]) {
    assert.doesNotMatch(source, /pm2 (?:restart|reload|start|delete)/);
    assert.doesNotMatch(source, /systemctl (?:start|restart|enable)/);
    assert.doesNotMatch(source, /\.delete(?:Bucket|Object|Multi|\s*\()/);
  }
});

test('object mirror systemd schedules only the write-only production job', () => {
  const scriptsRoot = path.join(__dirname, '..', 'scripts');
  const service = fs.readFileSync(path.join(
    scriptsRoot, 'systemd', 'xingxingzaishan-object-mirror.service'
  ), 'utf8');
  const timer = fs.readFileSync(path.join(
    scriptsRoot, 'systemd', 'xingxingzaishan-object-mirror.timer'
  ), 'utf8');
  const installer = fs.readFileSync(path.join(
    scriptsRoot, 'database', 'install-production-object-mirror-systemd.sh'
  ), 'utf8');
  assert.match(service, /^# Managed-By: xingxingzaishan-object-mirror$/m);
  assert.match(service, /--authorize-mirror-write=YES/);
  assert.doesNotMatch(service, /restore-audit/);
  assert.match(service, /^Type=oneshot$/m);
  assert.match(service, /^UMask=0077$/m);
  assert.match(service, /^NoNewPrivileges=true$/m);
  assert.match(timer, /^# Managed-By: xingxingzaishan-object-mirror$/m);
  assert.match(timer, /^OnCalendar=\*-\*-\* 03:20:00 Asia\/Shanghai$/m);
  assert.match(timer, /^Persistent=true$/m);
  assert.match(installer, /assert_root_private_regular_file "\$DESTINATION_OSS_ENV"/);
  assert.match(installer, /systemd-analyze verify/);
  assert.doesNotMatch(installer, /FULL_AUDIT/);
  assert.match(installer, /INDEPENDENT_HOST_NOT_INSTALLED_HERE/);
  assert.match(installer, /systemctl enable "\$timer"/);
  assert.match(installer, /systemctl start "\$timer"/);
  assert.doesNotMatch(installer, /cat .*object-mirror\.env/);
});

test('write-only mirror copies objects without reading destination bytes or metadata', async () => {
  const outputDirectory = tempDirectory();
  const payloads = new Map([
    ['stars/record-images/a/main.jpg', Buffer.from('customer-image')],
    ['stars/records/a/manifest.json', Buffer.from('{"sealed":true}')]
  ]);
  const destination = new Map();
  const uploadOrder = [];
  let destinationReads = 0;

  try {
    const result = await executeObjectMirror({
      objectKeys: [...payloads.keys()],
      sourceClient: bucketClient({
        name: 'primary', location: 'oss-cn-beijing', ownerId: 'owner-a'
      }),
      destinationClient: bucketClient({
        name: 'secondary', location: 'oss-cn-shanghai', ownerId: 'owner-b'
      }),
      sourceBucket: 'primary',
      destinationBucket: 'secondary',
      runId: '20261001T010203Z-abcdef12',
      outputDirectory,
      async sourceMetadataReader({ objectKey }) {
        const bytes = payloads.get(objectKey);
        return {
          status: 200,
          metadata_status: 200,
          size: bytes.length,
          etag: `source-${objectKey.length}`
        };
      },
      async downloader({ objectKey, destinationPath }) {
        const bytes = payloads.get(objectKey) || destination.get(objectKey);
        fs.writeFileSync(destinationPath, bytes, { flag: 'wx', mode: 0o600 });
        return {
          status: 200,
          path: destinationPath,
          size: bytes.length,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
          etag: `source-${objectKey.length}`,
          contentType: objectKey.endsWith('.jpg') ? 'image/jpeg' : 'application/json'
        };
      },
      async uploader({ objectKey, localPath, sha256, size }) {
        const bytes = fs.readFileSync(localPath);
        uploadOrder.push(objectKey);
        destination.set(objectKey, bytes);
        const remote = {
          status: 200,
          metadata_status: 200,
          size,
          declared_size: String(size),
          sha256,
          etag: `destination-${objectKey.length}`
        };
        return remote;
      }
    });

    assert.equal(result.manifest.object_count, 2);
    assert.equal(result.manifest.schema_version, 2);
    assert.equal(result.manifest.copied_count, 2);
    assert.equal(result.manifest.locally_reused_count, 0);
    assert.equal(result.manifest.source_downloaded_count, 2);
    assert.equal(result.manifest.destination_object_read, 'NONE');
    assert.equal(result.manifest.restore_verification, 'INDEPENDENT_AUDIT_REQUIRED');
    assert.equal(result.manifest.incremental_base_run_id, null);
    assert.equal(destination.has('stars/record-images/a/main.jpg'), true);
    assert.equal(destination.has('stars/records/a/manifest.json'), true);
    assert.equal(destination.has(result.manifest.manifest_object_key), true);
    assert.equal(destinationReads, 0);
    assert.equal(uploadOrder.at(-1), result.manifest.manifest_object_key);
    assert.deepEqual(
      JSON.parse(destination.get(result.manifest.manifest_object_key).toString('utf8')),
      result.manifest
    );
    assert.match(result.manifestArtifact.sha256, /^[a-f0-9]{64}$/);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(result.manifestPath).mode & 0o077, 0);
    }
    assert.equal(fs.existsSync(path.join(outputDirectory, 'objects')), false);
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('incremental write-only mirror reuses a prior local receipt and fails closed on collisions', async () => {
  const directory = tempDirectory();
  const objectKey = 'stars/record-images/a/main.jpg';
  const bytes = Buffer.from('customer-image');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  let downloads = 0;
  let uploads = 0;
  try {
    const result = await mirrorOneObject({
      objectKey,
      sourceClient: { side: 'source' },
      destinationClient: { side: 'destination' },
      temporaryPath: path.join(directory, 'object.bin'),
      previousEntry: {
        object_key: objectKey,
        sha256,
        size: bytes.length,
        source_etag: 'source-etag',
        destination_etag: 'destination-etag'
      },
      async sourceMetadataReader() {
        return {
          status: 200,
          metadata_status: 200,
          size: bytes.length,
          etag: 'source-etag'
        };
      },
      async downloader() {
        downloads += 1;
        throw new Error('download must not run');
      },
      async uploader() {
        uploads += 1;
        throw new Error('upload must not run');
      }
    });
    assert.equal(downloads, 0);
    assert.equal(uploads, 0);
    assert.equal(result.source_downloaded, false);
    assert.equal(result.copied, false);
    assert.equal(result.sha256, sha256);

    await assert.rejects(() => mirrorOneObject({
      objectKey,
      sourceClient: { side: 'source' },
      destinationClient: { side: 'destination' },
      temporaryPath: path.join(directory, 'changed-object.bin'),
      previousEntry: {
        object_key: objectKey,
        sha256,
        size: bytes.length,
        source_etag: 'old-source-etag',
        destination_etag: 'destination-etag'
      },
      async sourceMetadataReader() {
        return {
          status: 200,
          metadata_status: 200,
          size: bytes.length,
          etag: 'new-source-etag'
        };
      },
      async downloader({ destinationPath }) {
        downloads += 1;
        fs.writeFileSync(destinationPath, bytes, { flag: 'wx', mode: 0o600 });
        return {
          status: 200,
          size: bytes.length,
          sha256,
          etag: 'new-source-etag'
        };
      },
      async uploader() {
        const error = new Error('already exists');
        error.status = 412;
        throw error;
      }
    }), { code: 'MIRROR_DESTINATION_COLLISION_REQUIRES_AUDIT' });
    assert.equal(downloads, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('independent restore audit preflight uses a separate read-only credential contract', async () => {
  const directory = tempDirectory();
  const auditEnv = path.join(directory, 'audit.env');
  const manifestPath = path.join(directory, 'manifest.json');
  const outputDirectory = path.join(directory, 'output');
  fs.mkdirSync(outputDirectory);
  fs.writeFileSync(auditEnv, [
    'AUDIT_OSS_ENDPOINT=https://oss-cn-shanghai.aliyuncs.com',
    'AUDIT_OSS_REGION=oss-cn-shanghai',
    'AUDIT_OSS_BUCKET=secondary',
    'AUDIT_OSS_ACCESS_KEY_ID=read-key',
    'AUDIT_OSS_ACCESS_KEY_SECRET=read-secret'
  ].join('\n'), { mode: 0o600 });
  const runId = '20261001T040506Z-abcdef34';
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    schema_version: 2,
    status: 'COMPLETE',
    run_id: runId,
    source: {
      name: 'primary', location: 'oss-cn-beijing', ownerId: 'owner-a', acl: 'private'
    },
    destination: {
      name: 'secondary', location: 'oss-cn-shanghai', ownerId: 'owner-b', acl: 'private'
    },
    object_count: 0,
    copied_count: 0,
    locally_reused_count: 0,
    destination_object_read: 'NONE',
    restore_verification: 'INDEPENDENT_AUDIT_REQUIRED',
    manifest_object_key: [
      'backups/xingxingzaishan/object-mirror/manifests',
      '2026/10/01',
      `${runId}-object-mirror-manifest.json`
    ].join('/'),
    objects: []
  }, null, 2)}\n`, { mode: 0o600 });
  let objectReads = 0;
  const lines = [];
  class AuditOssClient {
    async getBucketInfo() {
      return bucketClient({
        name: 'secondary', location: 'oss-cn-shanghai', ownerId: 'owner-b'
      }).getBucketInfo();
    }

    async getStream() {
      objectReads += 1;
      throw new Error('preflight must not read objects');
    }
  }
  try {
    const options = parseRestoreAuditArguments([
      '--preflight',
      `--audit-oss-env=${auditEnv}`,
      `--manifest-path=${manifestPath}`,
      `--output-directory=${outputDirectory}`,
      '--restore-audit=sample'
    ]);
    assert.equal(options.preflight, true);
    await runRestoreAuditCli({
      argv: [
        '--preflight',
        `--audit-oss-env=${auditEnv}`,
        `--manifest-path=${manifestPath}`,
        `--output-directory=${outputDirectory}`,
        '--restore-audit=sample'
      ],
      OssClient: AuditOssClient,
      writeLine(line) { lines.push(line); }
    });
    assert.equal(objectReads, 0);
    assert.equal(lines.includes('MIRROR_AUDIT_CREDENTIAL_ROLE=READ_ONLY_INDEPENDENT'), true);
    assert.equal(lines.at(-1), 'INDEPENDENT_OBJECT_RESTORE_AUDIT_PREFLIGHT=PASS');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('restore audit downloads secondary bytes and rejects an integrity mismatch', async () => {
  const outputDirectory = tempDirectory();
  const auditDirectory = tempDirectory();
  const mismatchDirectory = tempDirectory();
  const payloads = new Map([
    ['stars/record-images/a/main.jpg', Buffer.from('customer-image')],
    ['stars/records/a/manifest.json', Buffer.from('{"sealed":true}')]
  ]);
  const destination = new Map();
  const metadata = new Map();
  const destinationClient = bucketClient({
    name: 'secondary', location: 'oss-cn-shanghai', ownerId: 'owner-b'
  });

  try {
    const mirror = await executeObjectMirror({
      objectKeys: [...payloads.keys()],
      sourceClient: bucketClient({
        name: 'primary', location: 'oss-cn-beijing', ownerId: 'owner-a'
      }),
      destinationClient,
      sourceBucket: 'primary',
      destinationBucket: 'secondary',
      runId: '20261001T020304Z-fedcba98',
      outputDirectory,
      async sourceMetadataReader({ objectKey }) {
        const bytes = payloads.get(objectKey);
        return {
          status: 200,
          metadata_status: 200,
          size: bytes.length,
          etag: `source-${objectKey.length}`
        };
      },
      async downloader({ objectKey, destinationPath }) {
        const bytes = payloads.get(objectKey) || destination.get(objectKey);
        fs.writeFileSync(destinationPath, bytes, { flag: 'wx', mode: 0o600 });
        return {
          status: 200,
          size: bytes.length,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
          etag: `source-${objectKey.length}`
        };
      },
      async metadataReader({ objectKey }) {
        if (!metadata.has(objectKey)) {
          const error = new Error('missing');
          error.code = 'NoSuchKey';
          error.status = 404;
          throw error;
        }
        return metadata.get(objectKey);
      },
      async uploader({ objectKey, localPath, sha256, size }) {
        destination.set(objectKey, fs.readFileSync(localPath));
        const remote = {
          status: 200,
          metadata_status: 200,
          size,
          declared_size: String(size),
          sha256,
          etag: `destination-${objectKey.length}`
        };
        metadata.set(objectKey, remote);
        return remote;
      }
    });
    for (const [key, bytes] of payloads) destination.set(key, bytes);

    const audit = await executeObjectRestoreAudit({
      manifest: mirror.manifest,
      destinationClient,
      destinationBucket: 'secondary',
      outputDirectory: auditDirectory,
      async downloader({ objectKey, destinationPath }) {
        const bytes = destination.get(objectKey);
        fs.writeFileSync(destinationPath, bytes, { flag: 'wx', mode: 0o600 });
        return {
          status: 200,
          size: bytes.length,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex')
        };
      }
    });
    assert.equal(audit.audit.status, 'PASS');
    assert.equal(audit.audit.mode, 'all');
    assert.equal(audit.audit.verified_object_count, 2);
    assert.equal(fs.existsSync(path.join(auditDirectory, 'restore-audit-objects')), false);

    destination.set('stars/record-images/a/main.jpg', Buffer.from('tampered'));
    await assert.rejects(
      executeObjectRestoreAudit({
        manifest: mirror.manifest,
        destinationClient,
        destinationBucket: 'secondary',
        outputDirectory: mismatchDirectory,
        async downloader({ objectKey, destinationPath }) {
          const bytes = destination.get(objectKey);
          fs.writeFileSync(destinationPath, bytes, { flag: 'wx', mode: 0o600 });
          return {
            status: 200,
            size: bytes.length,
            sha256: crypto.createHash('sha256').update(bytes).digest('hex')
          };
        }
      }),
      { code: 'MIRROR_RESTORE_INTEGRITY_MISMATCH' }
    );
    assert.equal(
      fs.existsSync(path.join(mismatchDirectory, 'restore-audit-objects')),
      false
    );

    const interruptedDirectory = tempDirectory();
    try {
      await assert.rejects(
        executeObjectRestoreAudit({
          manifest: mirror.manifest,
          destinationClient,
          destinationBucket: 'secondary',
          outputDirectory: interruptedDirectory,
          async downloader({ destinationPath }) {
            fs.writeFileSync(destinationPath, Buffer.from('partial-download'), {
              flag: 'wx',
              mode: 0o600
            });
            throw new Error('network interrupted');
          }
        }),
        { code: 'MIRROR_RESTORE_DOWNLOAD_FAILED' }
      );
      assert.equal(
        fs.existsSync(path.join(interruptedDirectory, 'restore-audit-objects')),
        false
      );
    } finally {
      fs.rmSync(interruptedDirectory, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
    fs.rmSync(auditDirectory, { recursive: true, force: true });
    fs.rmSync(mismatchDirectory, { recursive: true, force: true });
  }
});
