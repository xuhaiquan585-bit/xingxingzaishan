'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sharp = require('sharp');

const {
  MAX_INPUT_DIMENSION,
  MAX_INPUT_PIXELS,
  MAX_UPLOAD_BYTES,
  assertSafeMetadata,
  hasAllowedImageSignature,
  normalizeUploadedImage
} = require('../src/server/services/imageUploadSecurityService');

async function fixture(format, options = {}) {
  const pipeline = sharp({
    create: {
      width: options.width || 32,
      height: options.height || 24,
      channels: 4,
      background: { r: 210, g: 30, b: 50, alpha: 0.7 }
    }
  });
  if (format === 'jpeg') return pipeline.jpeg().toBuffer();
  return pipeline.png().toBuffer();
}

function uploadFile(buffer, mimetype = 'application/octet-stream', originalname = 'payload.bin') {
  return { buffer, mimetype, originalname, size: buffer.length };
}

test('real JPEG and PNG are decoded and normalized independently of claimed MIME', async () => {
  for (const format of ['jpeg', 'png']) {
    const input = await fixture(format);
    const normalized = await normalizeUploadedImage(uploadFile(
      input,
      format === 'jpeg' ? 'text/plain' : 'image/jpeg',
      'spoofed.txt'
    ));
    assert.equal(normalized.mimetype, 'image/jpeg');
    assert.equal(normalized.size, normalized.buffer.length);
    const metadata = await sharp(normalized.buffer).metadata();
    assert.equal(metadata.format, 'jpeg');
    assert.equal(metadata.width, 32);
    assert.equal(metadata.height, 24);
  }
});

test('normalization auto-orients and strips source EXIF metadata', async () => {
  const input = await sharp({
    create: {
      width: 40,
      height: 20,
      channels: 3,
      background: { r: 20, g: 80, b: 160 }
    }
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const sourceMetadata = await sharp(input).metadata();
  assert.equal(sourceMetadata.orientation, 6);
  assert.ok(sourceMetadata.exif);

  const normalized = await normalizeUploadedImage(uploadFile(input));
  const outputMetadata = await sharp(normalized.buffer).metadata();
  assert.equal(outputMetadata.width, 20);
  assert.equal(outputMetadata.height, 40);
  assert.equal(outputMetadata.orientation, undefined);
  assert.equal(outputMetadata.exif, undefined);
});

test('non-images, spoofed payloads, truncated images, and forbidden formats fail closed', async () => {
  const forbidden = [
    Buffer.from('not an image'),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'),
    Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==', 'base64'),
    Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ];
  for (const buffer of forbidden) {
    await assert.rejects(
      normalizeUploadedImage(uploadFile(buffer, 'image/jpeg', 'image.jpg')),
      { code: 'UPLOAD_FAILED' }
    );
  }
});

test('byte, dimension, pixel, and page limits reject decompression-bomb shapes', async () => {
  await assert.rejects(
    normalizeUploadedImage(uploadFile(Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0xff))),
    { code: 'UPLOAD_FAILED' }
  );
  assert.throws(
    () => assertSafeMetadata({ format: 'jpeg', width: MAX_INPUT_DIMENSION + 1, height: 1 }),
    { code: 'UPLOAD_FAILED' }
  );
  assert.throws(
    () => assertSafeMetadata({ format: 'png', width: 10000, height: 5001 }),
    { code: 'UPLOAD_FAILED' }
  );
  assert.throws(
    () => assertSafeMetadata({ format: 'png', width: 100, height: 100, pages: 2 }),
    { code: 'UPLOAD_FAILED' }
  );
  assert.throws(
    () => assertSafeMetadata({ format: 'gif', width: 1, height: 1, pages: 1 }),
    { code: 'UPLOAD_FAILED' }
  );
  assert.equal(MAX_INPUT_PIXELS, 50_000_000);
});

test('signature gate recognizes only JPEG and PNG containers', async () => {
  assert.equal(hasAllowedImageSignature(await fixture('jpeg')), true);
  assert.equal(hasAllowedImageSignature(await fixture('png')), true);
  assert.equal(hasAllowedImageSignature(Buffer.from('GIF89a')), false);
  assert.equal(hasAllowedImageSignature(Buffer.from('<svg>')), false);
});
