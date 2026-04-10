#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { getObjectPrefix } = require('../src/server/services/storageService');

function loadDB() {
  const dbFile = process.env.DB_FILE
    ? path.resolve(process.env.DB_FILE)
    : path.join(__dirname, '..', 'src', 'server', 'data', 'db.json');
  if (!fs.existsSync(dbFile)) {
    throw new Error(`DB文件不存在: ${dbFile}`);
  }
  return { dbFile, db: JSON.parse(fs.readFileSync(dbFile, 'utf8')) };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const uploadsDir = path.join(__dirname, '..', 'src', 'server', 'public', 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    console.log('uploads目录不存在，无需迁移');
    return;
  }

  const { dbFile, db } = loadDB();
  const prefix = getObjectPrefix();

  let client = null;
  if (!dryRun) {
    try {
      // eslint-disable-next-line global-require
      const OSS = require('ali-oss');
      client = new OSS({
        endpoint: process.env.OSS_ENDPOINT,
        region: process.env.OSS_REGION,
        bucket: process.env.OSS_BUCKET,
        accessKeyId: process.env.OSS_ACCESS_KEY_ID,
        accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
        secure: process.env.OSS_SECURE !== 'false'
      });
    } catch (error) {
      throw new Error(`初始化OSS失败: ${error.message}`);
    }
  }

  const records = db.qr_codes.filter((item) => item.activation_status === 'activated' && item.image_url);
  let success = 0;
  let skipped = 0;

  for (const record of records) {
    const filename = path.basename(record.image_url);
    const localPath = path.join(uploadsDir, filename);
    if (!fs.existsSync(localPath)) {
      skipped += 1;
      continue;
    }

    const objectKey = `${prefix}/${record.id}/${filename}`;
    process.stdout.write(`[${dryRun ? 'DRY-RUN' : 'UPLOAD'}] ${record.id} -> ${objectKey}\n`);

    if (!dryRun) {
      // eslint-disable-next-line no-await-in-loop
      await client.put(objectKey, localPath);
      record.image_object_key = objectKey;
    }

    success += 1;
  }

  if (!dryRun) {
    fs.writeFileSync(dbFile, JSON.stringify(db, null, 2), 'utf8');
  }

  console.log(`完成：success=${success}, skipped=${skipped}, dryRun=${dryRun}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
