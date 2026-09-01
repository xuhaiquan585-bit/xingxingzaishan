'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { PNG } = require('pngjs');
const sharp = require('sharp');

const {
  LabelTemplateValidationError,
  defaultLabelTemplateSchema,
  validateTemplateSchema
} = require('../src/server/services/labelTemplateSchema');
const {
  mmToPixels,
  renderLabel,
  renderLabelPreview,
  renderQrCodeForLabel
} = require('../src/server/services/labelRenderer');

const QR_PAYLOAD = 'https://xingxingzaishan.top/q/fixture-token-not-secret';

test('formal renderer fonts are bundled with redistribution licenses', () => {
  const fontDirectory = path.join(__dirname, '..', 'src', 'server', 'assets', 'fonts');
  assert.ok(fs.statSync(path.join(fontDirectory, 'IBMPlexMono-Medium.ttf')).size > 100000);
  assert.ok(fs.statSync(path.join(fontDirectory, 'NotoSansSC-Variable.ttf')).size > 1000000);
  assert.match(
    fs.readFileSync(path.join(fontDirectory, 'NotoSansSC-LICENSE.txt'), 'utf8'),
    /SIL OPEN FONT LICENSE Version 1\.1/
  );
});

test('default label template freezes the confirmed 20 by 80 mm contract', () => {
  const schema = validateTemplateSchema(defaultLabelTemplateSchema());
  assert.equal(schema.canvas.widthMm, 20);
  assert.equal(schema.canvas.heightMm, 80);
  assert.equal(schema.canvas.dpi, 600);
  assert.deepEqual(schema.canvas.cornerRadiiMm, {
    topLeft: 3, topRight: 3, bottomRight: 1, bottomLeft: 1
  });
  assert.equal(schema.elements.find((element) => element.id === 'prompt').text,
    '写下此刻，提交后仅可查看');
});

test('formal label renders exact dimensions, density, rounded alpha and editable text', async () => {
  const template = defaultLabelTemplateSchema();
  template.elements.find((element) => element.id === 'prompt').text = '这一刻，已经写进星光里';
  const rendered = await renderLabel({
    template,
    qrId: 'SSS00016',
    qrPayload: QR_PAYLOAD
  });
  assert.equal(rendered.width, 472);
  assert.equal(rendered.height, 1890);
  const metadata = await sharp(rendered.buffer).metadata();
  assert.equal(metadata.width, mmToPixels(20));
  assert.equal(metadata.height, mmToPixels(80));
  assert.equal(Math.round(metadata.density), 600);
  const png = PNG.sync.read(rendered.buffer);
  assert.equal(png.data[3], 0);
  const center = ((Math.floor(png.height / 2) * png.width) + Math.floor(png.width / 2)) * 4;
  assert.equal(png.data[center + 3], 255);
});

test('QR rendering reserves four modules and uses an integer production scale', async () => {
  const rendered = await renderQrCodeForLabel(QR_PAYLOAD, mmToPixels(16));
  assert.ok(rendered.scale >= 4);
  assert.equal(rendered.size, rendered.totalModules * rendered.scale);
  const png = PNG.sync.read(rendered.buffer);
  const quietZone = rendered.scale * 4;
  for (let y = 0; y < quietZone; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const offset = ((y * png.width) + x) * 4;
      assert.equal(png.data[offset], 255);
      assert.equal(png.data[offset + 1], 255);
      assert.equal(png.data[offset + 2], 255);
    }
  }
});

test('long production IDs fit by bounded font reduction', async () => {
  const rendered = await renderLabel({
    template: defaultLabelTemplateSchema(),
    qrId: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
    qrPayload: QR_PAYLOAD
  });
  assert.equal(rendered.width, 472);
});

test('preview is low resolution and cannot be confused with a formal output', async () => {
  const preview = await renderLabelPreview({
    template: defaultLabelTemplateSchema(),
    qrId: 'SSS00016',
    qrPayload: QR_PAYLOAD
  });
  const metadata = await sharp(preview.buffer).metadata();
  assert.equal(metadata.width, 118);
  assert.equal(metadata.height, 472);
  assert.equal(Math.round(metadata.density), 150);
});

test('schema rejects QR overlap, text overflow geometry and low-resolution assets', () => {
  const overlap = defaultLabelTemplateSchema();
  overlap.elements.find((element) => element.id === 'prompt').yMm = 10;
  assert.throws(
    () => validateTemplateSchema(overlap),
    (error) => error instanceof LabelTemplateValidationError
      && error.issues.some((entry) => entry.code === 'QR_OVERLAP_FORBIDDEN')
  );

  const withImage = defaultLabelTemplateSchema();
  withImage.elements.push({
    id: 'logo', type: 'image', assetId: 'asset-1', fit: 'contain',
    xMm: 3, yMm: 36, widthMm: 14, heightMm: 10, zIndex: 8
  });
  assert.throws(
    () => validateTemplateSchema(withImage, {
      requireAssets: true,
      assets: new Map([['asset-1', { pixelWidth: 100, pixelHeight: 100 }]])
    }),
    (error) => error instanceof LabelTemplateValidationError
      && error.issues.some((entry) => entry.code === 'IMAGE_RESOLUTION_TOO_LOW')
  );
});
