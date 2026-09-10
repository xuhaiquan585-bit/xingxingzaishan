'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { PNG } = require('pngjs');
const sharp = require('sharp');

const {
  LabelTemplateValidationError,
  QR_ID_COMPONENT_LATEST_REVISION,
  analyzeTemplateSchema,
  defaultLabelTemplateSchema,
  qrIdComponentLayout,
  synchronizeQrIdComponent,
  validateTemplateSchema
} = require('../src/server/services/labelTemplateSchema');
const {
  mmToPixels,
  renderLabel,
  renderLabelDraftPreview,
  renderLabelPreview,
  renderQrCodeForLabel
} = require('../src/server/services/labelRenderer');
const {
  presentTemplatePreviewIssue,
  printProductionHttpError
} = require('../src/server/services/printProductionHttpError');

const QR_PAYLOAD = 'https://xingxingzaishan.top/q/fixture-token-not-secret';

test('formal renderer fonts are bundled with redistribution licenses', () => {
  const fontDirectory = path.join(__dirname, '..', 'src', 'server', 'assets', 'fonts');
  assert.ok(fs.statSync(path.join(fontDirectory, 'IBMPlexMono-Medium.ttf')).size > 100000);
  assert.ok(fs.statSync(path.join(fontDirectory, 'IBMPlexMono-Regular.ttf')).size > 100000);
  assert.ok(fs.statSync(path.join(fontDirectory, 'NotoSansSC-Variable.ttf')).size > 1000000);
  assert.match(
    fs.readFileSync(path.join(fontDirectory, 'IBM-Plex-LICENSE.txt'), 'utf8'),
    /SIL Open Font License, Version 1\.1/
  );
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
  const qr = schema.elements.find((element) => element.type === 'qr');
  const id = schema.elements.find((element) => element.type === 'id');
  assert.deepEqual(
    { xMm: qr.xMm, yMm: qr.yMm, widthMm: qr.widthMm, heightMm: qr.heightMm },
    { xMm: 1.5, yMm: 1.5, widthMm: 17, heightMm: 17 }
  );
  assert.deepEqual(
    {
      xMm: id.xMm, yMm: id.yMm, widthMm: id.widthMm,
      heightMm: id.heightMm, fontSizePt: id.fontSizePt,
      align: id.align, linkedToQr: id.linkedToQr,
      componentRevision: id.componentRevision, fontFamily: id.fontFamily,
      color: id.color
    },
    {
      xMm: 1.5, yMm: 18.85, widthMm: 17,
      heightMm: 2.4, fontSizePt: 5.5,
      align: 'center', linkedToQr: true,
      componentRevision: 3, fontFamily: 'ibm-plex-mono-regular',
      color: '#1F2937'
    }
  );
});

test('QR ID component upgrades the legacy 20 by 80 layout without mutating it', () => {
  const legacy = defaultLabelTemplateSchema();
  const legacyQr = legacy.elements.find((element) => element.type === 'qr');
  const legacyId = legacy.elements.find((element) => element.type === 'id');
  Object.assign(legacyQr, { xMm: 2, yMm: 2, widthMm: 16, heightMm: 16 });
  Object.assign(legacyId, {
    xMm: 1.5, yMm: 18.8, widthMm: 17, heightMm: 3.6,
    fontSizePt: 8, linkedToQr: false
  });

  const upgraded = synchronizeQrIdComponent(legacy, { upgradeStandardQr: true });
  assert.equal(legacyQr.widthMm, 16);
  assert.equal(legacyId.linkedToQr, false);
  assert.equal(upgraded.elements.find((element) => element.type === 'qr').widthMm, 17);
  assert.equal(upgraded.elements.find((element) => element.type === 'id').yMm, 18.85);
  assert.equal(upgraded.elements.find((element) => element.type === 'id').fontSizePt, 5.5);
  assert.equal(upgraded.elements.find((element) => element.type === 'id').componentRevision,
    QR_ID_COMPONENT_LATEST_REVISION);
  assert.equal(upgraded.elements.find((element) => element.type === 'id').linkedToQr, true);
  assert.doesNotThrow(() => validateTemplateSchema(upgraded));
});

test('legacy linked QR ID components remain valid until explicitly upgraded', () => {
  const legacy = defaultLabelTemplateSchema();
  const id = legacy.elements.find((element) => element.type === 'id');
  Object.assign(id, {
    xMm: 1.5, yMm: 19.1, widthMm: 17, heightMm: 2.8,
    fontSizePt: 6.5, fontFamily: 'ibm-plex-mono', color: '#111827'
  });
  delete id.componentRevision;
  const validated = validateTemplateSchema(legacy);
  const normalizedId = validated.elements.find((element) => element.type === 'id');
  assert.equal(normalizedId.componentRevision, 1);
  assert.equal(normalizedId.yMm, 19.1);
  const preserved = synchronizeQrIdComponent(legacy);
  assert.equal(preserved.elements.find((element) => element.type === 'id').componentRevision, 1);
  assert.equal(preserved.elements.find((element) => element.type === 'id').fontSizePt, 6.5);
});

test('v2 QR ID layout scales within production typography limits', () => {
  const expected = [
    [17, 18.85, 2.4, 5.5],
    [20, 21.9118, 2.8235, 6.4706],
    [25, 27.0147, 3.5294, 8.0882],
    [30, 32.1, 3.6, 9]
  ];
  for (const [size, yMm, heightMm, fontSizePt] of expected) {
    assert.deepEqual(
      qrIdComponentLayout({ xMm: 1.5, yMm: 1.5, widthMm: size, heightMm: size }, 2),
      { xMm: 1.5, yMm, widthMm: size, heightMm, fontSizePt }
    );
  }
});

test('v3 QR ID layout caps customer-facing typography at seven points', () => {
  const expected = [
    [17, 18.85, 2.4, 5.5],
    [20, 21.9118, 2.8235, 6.4706],
    [24, 25.9941, 3.2, 7],
    [30, 32.1, 3.2, 7]
  ];
  for (const [size, yMm, heightMm, fontSizePt] of expected) {
    assert.deepEqual(
      qrIdComponentLayout({ xMm: 1.5, yMm: 1.5, widthMm: size, heightMm: size }, 3),
      { xMm: 1.5, yMm, widthMm: size, heightMm, fontSizePt }
    );
  }
});

test('v3 QR ID component renders at 17, 20, 24 and 30 mm QR sizes', async () => {
  for (const size of [17, 20, 24, 30]) {
    const template = defaultLabelTemplateSchema();
    template.canvas.widthMm = 40;
    template.elements = template.elements.filter((element) => ['qr', 'qr-id'].includes(element.id));
    const qr = template.elements.find((element) => element.type === 'qr');
    Object.assign(qr, { xMm: 5, yMm: 2, widthMm: size, heightMm: size });
    const synchronized = synchronizeQrIdComponent(template, { targetRevision: 3 });
    const rendered = await renderLabel({
      template: synchronized, qrId: 'SSS00016', qrPayload: QR_PAYLOAD
    });
    assert.equal(rendered.width, mmToPixels(40));
    assert.equal(rendered.issues.length, 0);
  }
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

test('formal QR ID visible pixels share the QR component center line', async () => {
  const template = defaultLabelTemplateSchema();
  const rendered = await renderLabel({
    template, qrId: 'SSS00016', qrPayload: QR_PAYLOAD
  });
  const png = PNG.sync.read(rendered.buffer);
  const id = template.elements.find((element) => element.type === 'id');
  const left = mmToPixels(id.xMm);
  const right = left + mmToPixels(id.widthMm) - 1;
  const top = mmToPixels(id.yMm);
  const bottom = top + mmToPixels(id.heightMm) - 1;
  let firstDarkX = Infinity;
  let lastDarkX = -Infinity;
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const offset = ((y * png.width) + x) * 4;
      if (png.data[offset + 3] > 0 && png.data[offset] < 100
          && png.data[offset + 1] < 100 && png.data[offset + 2] < 100) {
        firstDarkX = Math.min(firstDarkX, x);
        lastDarkX = Math.max(lastDarkX, x);
      }
    }
  }
  assert.ok(Number.isFinite(firstDarkX));
  const visibleCenter = (firstDarkX + lastDarkX) / 2;
  const componentCenter = left + (mmToPixels(id.widthMm) - 1) / 2;
  assert.ok(Math.abs(visibleCenter - componentCenter) <= 1,
    `visible center ${visibleCenter}, component center ${componentCenter}`);
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

test('maximum business-format production IDs fit by bounded font reduction', async () => {
  const template = defaultLabelTemplateSchema();
  const rendered = await renderLabel({
    template,
    qrId: 'ABCDEFGHIJKL123456',
    qrPayload: QR_PAYLOAD
  });
  assert.equal(rendered.width, 472);
  const png = PNG.sync.read(rendered.buffer);
  const id = template.elements.find((element) => element.type === 'id');
  const left = mmToPixels(id.xMm);
  const right = left + mmToPixels(id.widthMm) - 1;
  const top = mmToPixels(id.yMm);
  const bottom = top + mmToPixels(id.heightMm) - 1;
  let firstDarkX = Infinity;
  let lastDarkX = -Infinity;
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const offset = ((y * png.width) + x) * 4;
      if (png.data[offset + 3] > 0 && png.data[offset] < 100
          && png.data[offset + 1] < 100 && png.data[offset + 2] < 100) {
        firstDarkX = Math.min(firstDarkX, x);
        lastDarkX = Math.max(lastDarkX, x);
      }
    }
  }
  const requiredInset = mmToPixels(0.35) - 1;
  assert.ok(firstDarkX - left >= requiredInset);
  assert.ok(right - lastDarkX >= requiredInset);
});

test('production IDs stay on one line instead of wrapping below the QR', async () => {
  await assert.rejects(
    renderLabel({
      template: defaultLabelTemplateSchema(),
      qrId: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
      qrPayload: QR_PAYLOAD
    }),
    (error) => {
      assert.equal(error.code, 'TEXT_OVERFLOW');
      assert.equal(error.elementId, 'qr-id');
      assert.equal(error.elementType, 'id');
      assert.equal(error.widthMm, 17);
      assert.equal(error.heightMm, 2.4);
      assert.equal(error.fontSizePt, 5.5);
      return true;
    }
  );
});

test('template production errors provide actionable Chinese details', () => {
  const overflow = printProductionHttpError({
    code: 'TEXT_OVERFLOW', elementId: 'title', elementType: 'text',
    widthMm: 26, heightMm: 4, fontSizePt: 8
  });
  assert.equal(overflow.statusCode, 400);
  assert.match(overflow.body.message, /文字内容超出文本框/u);
  assert.deepEqual(overflow.body.data, {
    element_id: 'title', element_type: 'text',
    width_mm: 26, height_mm: 4, font_size_pt: 8
  });

  const invalid = printProductionHttpError({
    code: 'LABEL_TEMPLATE_INVALID',
    issues: [{
      code: 'QR_OVERLAP_FORBIDDEN',
      path: 'elements.subtitle',
      message: 'Nothing may overlap the QR.'
    }]
  });
  assert.equal(invalid.statusCode, 400);
  assert.match(invalid.body.message, /1 处生产校验问题/u);
  assert.equal(invalid.body.data.issues[0].path, 'elements.subtitle');
  assert.match(invalid.body.data.issues[0].message, /遮挡二维码/u);
  assert.doesNotMatch(invalid.body.data.issues[0].message, /Nothing/u);
});

test('draft analysis preserves a renderable schema while reporting validation issues', () => {
  const template = defaultLabelTemplateSchema();
  template.elements.find((element) => element.id === 'prompt').xMm = 19;
  const analysis = analyzeTemplateSchema(template);
  assert.equal(analysis.schema.canvas.widthMm, 20);
  assert.equal(analysis.schema.elements.find((element) => element.id === 'prompt').xMm, 19);
  assert.ok(analysis.issues.some((issue) => issue.code === 'ELEMENT_OUT_OF_BOUNDS'));
  assert.throws(() => validateTemplateSchema(template), LabelTemplateValidationError);
});

test('draft preview clips overflow and reports exact formal typography requirements', async () => {
  const template = defaultLabelTemplateSchema();
  template.elements.push({
    id: 'title', type: 'text', xMm: 2, yMm: 36, widthMm: 16, heightMm: 0.5,
    zIndex: 9, locked: false, text: '记在星上', fontFamily: 'noto-sans-sc',
    fontSizePt: 10, minFontSizePt: 10, color: '#111827', align: 'center', letterSpacing: 0
  });
  const draft = await renderLabelDraftPreview({
    template, qrId: 'SSS00016', qrPayload: QR_PAYLOAD
  });
  const overflow = draft.issues.find((issue) => issue.code === 'TEXT_OVERFLOW');
  assert.ok(overflow);
  assert.equal(overflow.elementId, 'title');
  assert.equal(overflow.heightMm, 0.5);
  assert.ok(overflow.requiredHeightMm > overflow.heightMm);
  assert.equal((await sharp(draft.buffer).metadata()).width, 118);
  await assert.rejects(
    renderLabel({ template, qrId: 'SSS00016', qrPayload: QR_PAYLOAD }),
    (error) => error.code === 'TEXT_OVERFLOW'
      && error.elementId === 'title'
      && error.requiredHeightMm > error.heightMm
  );
  const presented = presentTemplatePreviewIssue(overflow);
  assert.equal(presented.element_id, 'title');
  assert.equal(presented.required_height_mm, overflow.requiredHeightMm);
  assert.match(presented.message, /文字内容超出文本框/u);
});

test('draft preview clips elements that extend beyond the canvas', async () => {
  const template = defaultLabelTemplateSchema();
  const divider = template.elements.find((element) => element.type === 'divider');
  Object.assign(divider, { xMm: 19, widthMm: 5, color: '#E11D48' });
  const draft = await renderLabelDraftPreview({
    template, qrId: 'SSS00016', qrPayload: QR_PAYLOAD
  });
  assert.ok(draft.issues.some((issue) => issue.code === 'ELEMENT_OUT_OF_BOUNDS'));
  assert.equal((await sharp(draft.buffer).metadata()).width, 118);
  await assert.rejects(
    renderLabel({ template, qrId: 'SSS00016', qrPayload: QR_PAYLOAD }),
    (error) => error instanceof LabelTemplateValidationError
      && error.issues.some((issue) => issue.code === 'ELEMENT_OUT_OF_BOUNDS')
  );
});

test('divider color is preserved in the formal production pixels', async () => {
  const template = defaultLabelTemplateSchema();
  const divider = template.elements.find((element) => element.type === 'divider');
  divider.color = '#E11D48';
  const rendered = await renderLabel({
    template, qrId: 'SSS00016', qrPayload: QR_PAYLOAD
  });
  const png = PNG.sync.read(rendered.buffer);
  const x = mmToPixels(divider.xMm + divider.widthMm / 2);
  const y = mmToPixels(divider.yMm + divider.heightMm / 2);
  const offset = ((y * png.width) + x) * 4;
  assert.deepEqual(Array.from(png.data.slice(offset, offset + 4)), [225, 29, 72, 255]);
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

test('preview pixels are the formal 600 DPI result downscaled for display', async () => {
  const input = {
    template: defaultLabelTemplateSchema(), qrId: 'SSS00016', qrPayload: QR_PAYLOAD
  };
  const formal = await renderLabel(input);
  const preview = await renderLabelPreview(input);
  const expected = await sharp(formal.buffer)
    .resize(preview.width, preview.height, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  assert.deepEqual(PNG.sync.read(preview.buffer).data, PNG.sync.read(expected).data);
});

test('schema rejects QR overlap, text overflow geometry and low-resolution assets', () => {
  const overlap = defaultLabelTemplateSchema();
  overlap.elements.find((element) => element.id === 'prompt').yMm = 10;
  assert.throws(
    () => validateTemplateSchema(overlap),
    (error) => error instanceof LabelTemplateValidationError
      && error.issues.some((entry) => entry.code === 'QR_OVERLAP_FORBIDDEN')
  );

  const idOverlap = defaultLabelTemplateSchema();
  idOverlap.elements.find((element) => element.id === 'divider').yMm = 20;
  assert.throws(
    () => validateTemplateSchema(idOverlap),
    (error) => error instanceof LabelTemplateValidationError
      && error.issues.some((entry) => entry.code === 'QR_ID_COMPONENT_OVERLAP')
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

  const detachedId = defaultLabelTemplateSchema();
  detachedId.elements.find((element) => element.type === 'id').xMm += 0.5;
  assert.throws(
    () => validateTemplateSchema(detachedId),
    (error) => error instanceof LabelTemplateValidationError
      && error.issues.some((entry) => entry.code === 'QR_ID_COMPONENT_GEOMETRY_INVALID')
  );
});
