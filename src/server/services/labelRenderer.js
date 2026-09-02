'use strict';

const path = require('node:path');
const QRCode = require('qrcode');
const sharp = require('sharp');
const {
  FORMAL_DPI,
  validateTemplateSchema
} = require('./labelTemplateSchema');

const FONT_DIRECTORY = path.join(__dirname, '..', 'assets', 'fonts');
const FONT_FILES = Object.freeze({
  'ibm-plex-mono': {
    family: 'IBM Plex Mono Medium',
    file: path.join(FONT_DIRECTORY, 'IBMPlexMono-Medium.ttf')
  },
  'noto-sans-sc': {
    family: 'Noto Sans SC',
    file: path.join(FONT_DIRECTORY, 'NotoSansSC-Variable.ttf')
  }
});
const PREVIEW_DPI = 150;

class LabelRenderError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'LabelRenderError';
    this.code = code;
    Object.assign(this, details);
  }
}

function mmToPixels(value, dpi = FORMAL_DPI) {
  return Math.round(Number(value) / 25.4 * dpi);
}

function escapePango(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function resolveAsset(assets, assetId) {
  if (!assets) return null;
  if (assets instanceof Map) return assets.get(assetId) || null;
  return assets[assetId] || null;
}

function assetBuffer(asset) {
  if (Buffer.isBuffer(asset)) return asset;
  return asset && Buffer.isBuffer(asset.buffer) ? asset.buffer : null;
}

function compositePosition(element, dpi) {
  return {
    left: mmToPixels(element.xMm, dpi),
    top: mmToPixels(element.yMm, dpi),
    width: Math.max(1, mmToPixels(element.widthMm, dpi)),
    height: Math.max(1, mmToPixels(element.heightMm, dpi))
  };
}

async function renderQrCodeForLabel(payload, sizePx, colors = {}, { minScale = 4 } = {}) {
  const value = String(payload || '').trim();
  if (!value) throw new LabelRenderError('QR_PAYLOAD_REQUIRED');
  const qr = QRCode.create(value, { errorCorrectionLevel: 'M' });
  const dataModules = Number(qr.modules.size);
  const totalModules = dataModules + 8;
  const scale = Math.floor(Number(sizePx) / totalModules);
  if (!Number.isInteger(scale) || scale < minScale) {
    throw new LabelRenderError('QR_PHYSICAL_SIZE_TOO_SMALL', { dataModules, totalModules, scale });
  }
  const buffer = await QRCode.toBuffer(value, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 4,
    scale,
    color: {
      dark: `${colors.foregroundColor || '#000000'}FF`,
      light: `${colors.backgroundColor || '#FFFFFF'}FF`
    }
  });
  return Object.freeze({ buffer, dataModules, totalModules, scale, size: totalModules * scale });
}

async function renderTextBox(
  value,
  element,
  box,
  dpi,
  { shrink = false, allowWrap = true } = {}
) {
  const font = FONT_FILES[element.fontFamily];
  if (!font) throw new LabelRenderError('FONT_NOT_BUNDLED');
  let fontSize = Number(element.fontSizePt);
  const minimum = Number(element.minFontSizePt || element.fontSizePt);

  async function attempt(textValue, size) {
    const markup = `<span foreground="${element.color}" letter_spacing="${Math.round(
      Number(element.letterSpacing || 0) * 1024
    )}">${escapePango(textValue)}</span>`;
    const rendered = await sharp({
      text: {
        text: markup,
        font: `${font.family} ${size}`,
        fontfile: font.file,
        width: box.width,
        align: element.align,
        rgba: true,
        dpi
      }
    }).png().toBuffer({ resolveWithObject: true });
    if (rendered.info.width <= box.width && rendered.info.height <= box.height) {
      return rendered;
    }
    return null;
  }

  async function attemptLines(lines, size) {
    const renderedLines = [];
    for (const line of lines) {
      const markup = `<span foreground="${element.color}" letter_spacing="${Math.round(
        Number(element.letterSpacing || 0) * 1024
      )}">${escapePango(line)}</span>`;
      const rendered = await sharp({
        text: {
          text: markup,
          font: `${font.family} ${size}`,
          fontfile: font.file,
          rgba: true,
          dpi
        }
      }).png().toBuffer({ resolveWithObject: true });
      if (rendered.info.width > box.width) return null;
      renderedLines.push(rendered);
    }
    const height = renderedLines.reduce((sum, rendered) => sum + rendered.info.height, 0);
    if (height > box.height) return null;
    const composites = renderedLines.map((rendered, index) => {
      const consumedHeight = renderedLines.slice(0, index)
        .reduce((sum, item) => sum + item.info.height, 0);
      const left = element.align === 'right'
        ? box.width - rendered.info.width
        : element.align === 'center'
          ? Math.floor((box.width - rendered.info.width) / 2)
          : 0;
      return { input: rendered.data, left, top: consumedHeight };
    });
    return sharp({
      create: {
        width: box.width,
        height,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    }).composite(composites).png().toBuffer({ resolveWithObject: true });
  }

  while (fontSize + 0.001 >= minimum) {
    const rendered = await attempt(value, fontSize);
    if (rendered) return rendered;
    if (!shrink || fontSize <= minimum) break;
    fontSize = Math.max(minimum, fontSize - 0.5);
  }
  if (shrink && allowWrap) {
    const characters = Array.from(String(value));
    for (const lineCount of [2, 3]) {
      const lineLength = Math.ceil(characters.length / lineCount);
      const lines = Array.from({ length: lineCount }, (_unused, index) => (
        characters.slice(index * lineLength, (index + 1) * lineLength).join('')
      )).filter(Boolean);
      const wrapped = await attemptLines(lines, minimum);
      if (wrapped) return wrapped;
    }
  }
  throw new LabelRenderError('TEXT_OVERFLOW', { elementId: element.id });
}

function roundedRectSvg(width, height, radius, fill, stroke, strokeWidth) {
  const safeRadius = Math.max(0, Math.min(radius, width / 2, height / 2));
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
      + `<rect x="${strokeWidth / 2}" y="${strokeWidth / 2}" `
      + `width="${Math.max(0, width - strokeWidth)}" height="${Math.max(0, height - strokeWidth)}" `
      + `rx="${safeRadius}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`
      + '</svg>',
    'utf8'
  );
}

function canvasMaskSvg(width, height, radii) {
  const topLeft = Math.max(0, Math.min(radii.topLeft, width / 2, height / 2));
  const topRight = Math.max(0, Math.min(radii.topRight, width / 2, height / 2));
  const bottomRight = Math.max(0, Math.min(radii.bottomRight, width / 2, height / 2));
  const bottomLeft = Math.max(0, Math.min(radii.bottomLeft, width / 2, height / 2));
  const pathData = [
    `M ${topLeft} 0`,
    `H ${width - topRight}`,
    `Q ${width} 0 ${width} ${topRight}`,
    `V ${height - bottomRight}`,
    `Q ${width} ${height} ${width - bottomRight} ${height}`,
    `H ${bottomLeft}`,
    `Q 0 ${height} 0 ${height - bottomLeft}`,
    `V ${topLeft}`,
    `Q 0 0 ${topLeft} 0`,
    'Z'
  ].join(' ');
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
      + `<path d="${pathData}" fill="#FFFFFF"/></svg>`,
    'utf8'
  );
}

async function renderElement(element, context) {
  const box = compositePosition(element, context.dpi);
  if (element.type === 'qr') {
    const qr = await renderQrCodeForLabel(
      context.qrPayload,
      Math.min(box.width, box.height),
      element,
      { minScale: context.dpi === FORMAL_DPI ? 4 : 1 }
    );
    return {
      input: qr.buffer,
      left: box.left + Math.floor((box.width - qr.size) / 2),
      top: box.top + Math.floor((box.height - qr.size) / 2)
    };
  }
  if (element.type === 'id') {
    const rendered = await renderTextBox(context.qrId, element, box, context.dpi, {
      shrink: true,
      allowWrap: false
    });
    return {
      input: rendered.data,
      left: box.left,
      top: box.top + Math.max(0, Math.floor((box.height - rendered.info.height) / 2))
    };
  }
  if (element.type === 'text') {
    const rendered = await renderTextBox(element.text, element, box, context.dpi);
    return { input: rendered.data, left: box.left, top: box.top };
  }
  if (element.type === 'divider') {
    return {
      input: {
        create: {
          width: box.width,
          height: box.height,
          channels: 4,
          background: element.color
        }
      },
      left: box.left,
      top: box.top
    };
  }
  if (element.type === 'handwriting') {
    return {
      input: roundedRectSvg(
        box.width,
        box.height,
        mmToPixels(element.radiusMm, context.dpi),
        element.fillColor,
        element.borderColor,
        Math.max(1, mmToPixels(element.borderWidthMm, context.dpi))
      ),
      left: box.left,
      top: box.top
    };
  }
  if (element.type === 'image' || element.type === 'background') {
    const buffer = assetBuffer(resolveAsset(context.assets, element.assetId));
    if (!buffer) throw new LabelRenderError('IMAGE_ASSET_MISSING', { assetId: element.assetId });
    const resized = await sharp(buffer, { failOn: 'error', sequentialRead: true })
      .resize(box.width, box.height, { fit: element.fit, position: 'centre' })
      .ensureAlpha(element.opacity)
      .png()
      .toBuffer();
    return { input: resized, left: box.left, top: box.top };
  }
  return null;
}

async function renderLabel({
  template,
  qrId,
  qrPayload,
  assets = new Map(),
  renderDpi = FORMAL_DPI,
  requireAssets = true
}) {
  if (![FORMAL_DPI, PREVIEW_DPI].includes(renderDpi)) {
    throw new LabelRenderError('RENDER_DPI_INVALID');
  }
  const schema = validateTemplateSchema(template, { assets, requireAssets });
  const normalizedQrId = String(qrId || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,64}$/.test(normalizedQrId)) {
    throw new LabelRenderError('QR_ID_INVALID');
  }
  const width = mmToPixels(schema.canvas.widthMm, renderDpi);
  const height = mmToPixels(schema.canvas.heightMm, renderDpi);
  const composites = [];
  const context = {
    assets,
    dpi: renderDpi,
    qrId: normalizedQrId,
    qrPayload: String(qrPayload || '').trim()
  };
  for (const element of schema.elements) {
    const rendered = await renderElement(element, context);
    if (rendered) composites.push(rendered);
  }
  const radii = Object.fromEntries(Object.entries(schema.canvas.cornerRadiiMm)
    .map(([key, value]) => [key, mmToPixels(value, renderDpi)]));
  composites.push({
    input: canvasMaskSvg(width, height, radii),
    left: 0,
    top: 0,
    blend: 'dest-in'
  });

  const result = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: schema.canvas.backgroundColor
    }
  })
    .composite(composites)
    .withMetadata({ density: renderDpi })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer({ resolveWithObject: true });
  return Object.freeze({
    buffer: result.data,
    width: result.info.width,
    height: result.info.height,
    density: renderDpi,
    schema
  });
}

function renderLabelPreview(input) {
  return renderLabel({ ...input, renderDpi: PREVIEW_DPI });
}

module.exports = {
  FONT_FILES,
  LabelRenderError,
  PREVIEW_DPI,
  mmToPixels,
  renderLabel,
  renderLabelPreview,
  renderQrCodeForLabel
};
