'use strict';

const path = require('node:path');
const sharp = require('sharp');

const LABEL_FONT_FILE = path.join(
  __dirname,
  '..',
  'assets',
  'fonts',
  'IBMPlexMono-Medium.ttf'
);

function escapePangoText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function renderLabel(label, maxWidth, options) {
  const minFontSize = options.minFontSize;
  let fontSize = options.fontSize;

  while (fontSize >= minFontSize) {
    const markup = `<span foreground="${options.foreground}" letter_spacing="${Math.round(options.letterSpacing * 1024)}">${escapePangoText(label)}</span>`;
    const rendered = await sharp({
      text: {
        text: markup,
        font: `IBM Plex Mono Medium ${fontSize}`,
        fontfile: LABEL_FONT_FILE,
        rgba: true,
        dpi: 72
      }
    }).png().toBuffer({ resolveWithObject: true });

    if (rendered.info.width <= maxWidth || fontSize === minFontSize) {
      return rendered;
    }
    fontSize -= 1;
  }

  throw new Error('QR_LABEL_RENDER_FAILED');
}

/**
 * Append a centered product ID beneath a QR PNG.
 * The bundled font keeps output identical across development and production.
 */
async function addLabelToQR(qrPngBuffer, label, opts = {}) {
  const normalizedLabel = String(label || '').trim().toUpperCase();
  if (!normalizedLabel) {
    const error = new Error('QR_LABEL_INVALID');
    error.code = 'QR_LABEL_INVALID';
    throw error;
  }

  const metadata = await sharp(qrPngBuffer).metadata();
  const qrWidth = metadata.width;
  const qrHeight = metadata.height;
  if (!Number.isInteger(qrWidth) || !Number.isInteger(qrHeight)) {
    const error = new Error('QR_IMAGE_INVALID');
    error.code = 'QR_IMAGE_INVALID';
    throw error;
  }

  const horizontalPadding = opts.horizontalPadding ?? 20;
  const gapTop = opts.gapTop ?? 14;
  const paddingBottom = opts.paddingBottom ?? 16;
  const renderedLabel = await renderLabel(
    normalizedLabel,
    qrWidth - (horizontalPadding * 2),
    {
      fontSize: opts.fontSize ?? 21,
      minFontSize: opts.minFontSize ?? 12,
      letterSpacing: opts.letterSpacing ?? 1,
      foreground: opts.foreground ?? '#111111'
    }
  );
  const labelHeight = gapTop + renderedLabel.info.height + paddingBottom;

  return sharp(qrPngBuffer)
    .extend({
      bottom: labelHeight,
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    })
    .composite([{
      input: renderedLabel.data,
      left: Math.floor((qrWidth - renderedLabel.info.width) / 2),
      top: qrHeight + gapTop
    }])
    .png()
    .toBuffer();
}

module.exports = { addLabelToQR };
