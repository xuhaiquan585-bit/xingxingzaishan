'use strict';

const SCHEMA_VERSION = 1;
const FORMAL_DPI = 600;
const MIN_CANVAS_MM = 10;
const MAX_CANVAS_WIDTH_MM = 300;
const MAX_CANVAS_HEIGHT_MM = 600;
const MAX_ELEMENTS = 64;
const ELEMENT_TYPES = Object.freeze([
  'background', 'handwriting', 'image', 'divider', 'qr', 'id', 'text'
]);
const COLOR_PATTERN = /^#[0-9A-F]{6}$/i;
const ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const QR_ID_COMPONENT = Object.freeze({
  referenceQrSizeMm: 17,
  gapMm: 0.6,
  heightMm: 2.8,
  fontSizePt: 6.5,
  minimumFontSizePt: 4
});

class LabelTemplateValidationError extends Error {
  constructor(issues) {
    super('LABEL_TEMPLATE_INVALID');
    this.name = 'LabelTemplateValidationError';
    this.code = 'LABEL_TEMPLATE_INVALID';
    this.issues = Object.freeze(issues.map((issue) => Object.freeze({ ...issue })));
  }
}

function defaultLabelTemplateSchema() {
  return {
    schemaVersion: SCHEMA_VERSION,
    canvas: {
      widthMm: 20,
      heightMm: 80,
      dpi: FORMAL_DPI,
      backgroundColor: '#FFFFFF',
      cornerRadiiMm: {
        topLeft: 3,
        topRight: 3,
        bottomRight: 1,
        bottomLeft: 1
      }
    },
    elements: [
      {
        id: 'handwriting-area', type: 'handwriting', xMm: 1.5, yMm: 24.5,
        widthMm: 17, heightMm: 53.5, zIndex: 1, locked: true,
        fillColor: '#FFFFFF', borderColor: '#D8DDE4', borderWidthMm: 0.2,
        radiusMm: 1
      },
      {
        id: 'divider', type: 'divider', xMm: 2, yMm: 23.2,
        widthMm: 16, heightMm: 0.2, zIndex: 2, locked: false,
        color: '#D7B467'
      },
      {
        id: 'qr', type: 'qr', xMm: 1.5, yMm: 1.5,
        widthMm: 17, heightMm: 17, zIndex: 3, locked: true,
        foregroundColor: '#000000', backgroundColor: '#FFFFFF'
      },
      {
        id: 'qr-id', type: 'id', xMm: 1.5, yMm: 19.1,
        widthMm: 17, heightMm: 2.8, zIndex: 4, locked: true,
        linkedToQr: true, fontFamily: 'ibm-plex-mono',
        fontSizePt: 6.5, minFontSizePt: 4,
        color: '#111827', align: 'center', letterSpacing: 0
      },
      {
        id: 'prompt', type: 'text', xMm: 2.5, yMm: 26.5,
        widthMm: 15, heightMm: 8, zIndex: 5, locked: false,
        text: '写下此刻，提交后仅可查看',
        fontFamily: 'noto-sans-sc', fontSizePt: 5.5,
        color: '#6B7280', align: 'left', letterSpacing: 0
      }
    ]
  };
}

function issue(issues, code, path, message) {
  issues.push({ code, path, message });
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rounded(value) {
  return Number(Number(value).toFixed(4));
}

function qrIdComponentLayout(qrElement) {
  const scale = Number(qrElement.widthMm) / QR_ID_COMPONENT.referenceQrSizeMm;
  return Object.freeze({
    xMm: rounded(qrElement.xMm),
    yMm: rounded(
      Number(qrElement.yMm) + Number(qrElement.heightMm) + QR_ID_COMPONENT.gapMm * scale
    ),
    widthMm: rounded(qrElement.widthMm),
    heightMm: rounded(QR_ID_COMPONENT.heightMm * scale),
    fontSizePt: rounded(Math.max(
      QR_ID_COMPONENT.minimumFontSizePt,
      Math.min(48, QR_ID_COMPONENT.fontSizePt * scale)
    ))
  });
}

function synchronizeQrIdComponent(input, { upgradeStandardQr = false } = {}) {
  const schema = JSON.parse(JSON.stringify(input || {}));
  const elements = Array.isArray(schema.elements) ? schema.elements : [];
  const qr = elements.find((element) => element && element.type === 'qr');
  const id = elements.find((element) => element && element.type === 'id');
  if (!qr || !id) return schema;
  if (id.linkedToQr !== true && !upgradeStandardQr) return schema;
  const canvas = schema.canvas || {};
  const isLegacyStandard = upgradeStandardQr
    && Number(canvas.widthMm) === 20
    && Number(canvas.heightMm) === 80
    && Number(qr.xMm) === 2
    && Number(qr.yMm) === 2
    && Number(qr.widthMm) === 16
    && Number(qr.heightMm) === 16;
  if (isLegacyStandard) {
    Object.assign(qr, { xMm: 1.5, yMm: 1.5, widthMm: 17, heightMm: 17 });
  }
  const layout = qrIdComponentLayout(qr);
  Object.assign(id, layout, {
    linkedToQr: true,
    locked: true,
    fontFamily: 'ibm-plex-mono',
    minFontSizePt: QR_ID_COMPONENT.minimumFontSizePt,
    align: 'center',
    letterSpacing: 0
  });
  return schema;
}

function numeric(input, path, issues, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = finiteNumber(input);
  if (value === null || value < min || value > max) {
    issue(issues, 'NUMBER_OUT_OF_RANGE', path, `${path} must be between ${min} and ${max}.`);
    return min;
  }
  return value;
}

function color(input, path, issues, fallback = '#000000') {
  const value = String(input || '').trim().toUpperCase();
  if (!COLOR_PATTERN.test(value)) {
    issue(issues, 'COLOR_INVALID', path, `${path} must use #RRGGBB.`);
    return fallback;
  }
  return value;
}

function text(input, path, issues, { required = false, max = 160 } = {}) {
  const value = String(input ?? '').trim();
  if ((required && !value) || value.length > max) {
    issue(issues, 'TEXT_INVALID', path, `${path} is invalid.`);
  }
  return value.slice(0, max);
}

function normalizeGeometry(element, index, canvas, issues) {
  const path = `elements[${index}]`;
  const xMm = numeric(element.xMm, `${path}.xMm`, issues, { min: 0, max: canvas.widthMm });
  const yMm = numeric(element.yMm, `${path}.yMm`, issues, { min: 0, max: canvas.heightMm });
  const widthMm = numeric(element.widthMm, `${path}.widthMm`, issues, {
    min: 0.1, max: canvas.widthMm
  });
  const heightMm = numeric(element.heightMm, `${path}.heightMm`, issues, {
    min: 0.1, max: canvas.heightMm
  });
  if (xMm + widthMm > canvas.widthMm + 0.0001
      || yMm + heightMm > canvas.heightMm + 0.0001) {
    issue(issues, 'ELEMENT_OUT_OF_BOUNDS', path, `${path} exceeds the canvas.`);
  }
  return { xMm, yMm, widthMm, heightMm };
}

function normalizeFont(element, path, issues) {
  const fontFamily = String(element.fontFamily || '').trim();
  if (!['ibm-plex-mono', 'noto-sans-sc'].includes(fontFamily)) {
    issue(issues, 'FONT_FAMILY_INVALID', `${path}.fontFamily`, 'Only bundled fonts are allowed.');
  }
  const align = String(element.align || 'left').trim();
  if (!['left', 'center', 'right'].includes(align)) {
    issue(issues, 'TEXT_ALIGN_INVALID', `${path}.align`, 'Text alignment is invalid.');
  }
  return {
    fontFamily: ['ibm-plex-mono', 'noto-sans-sc'].includes(fontFamily)
      ? fontFamily : 'noto-sans-sc',
    fontSizePt: numeric(element.fontSizePt, `${path}.fontSizePt`, issues, { min: 4, max: 48 }),
    minFontSizePt: numeric(
      element.minFontSizePt ?? element.fontSizePt,
      `${path}.minFontSizePt`,
      issues,
      { min: 4, max: 48 }
    ),
    color: color(element.color, `${path}.color`, issues, '#111827'),
    align: ['left', 'center', 'right'].includes(align) ? align : 'left',
    letterSpacing: numeric(
      element.letterSpacing ?? 0,
      `${path}.letterSpacing`,
      issues,
      { min: 0, max: 4 }
    )
  };
}

function assetMetadata(assets, assetId) {
  if (!assets) return null;
  if (assets instanceof Map) return assets.get(assetId) || null;
  return assets[assetId] || null;
}

function normalizeElement(element, index, canvas, issues, options) {
  const path = `elements[${index}]`;
  if (!element || typeof element !== 'object' || Array.isArray(element)) {
    issue(issues, 'ELEMENT_INVALID', path, `${path} must be an object.`);
    return null;
  }
  const type = String(element.type || '').trim();
  if (!ELEMENT_TYPES.includes(type)) {
    issue(issues, 'ELEMENT_TYPE_INVALID', `${path}.type`, 'Element type is not supported.');
  }
  const id = String(element.id || '').trim();
  if (!ID_PATTERN.test(id)) {
    issue(issues, 'ELEMENT_ID_INVALID', `${path}.id`, 'Element ID is invalid.');
  }
  const geometry = normalizeGeometry(element, index, canvas, issues);
  const base = {
    id: ID_PATTERN.test(id) ? id : `element-${index + 1}`,
    type,
    ...geometry,
    zIndex: Math.round(numeric(element.zIndex ?? index, `${path}.zIndex`, issues, {
      min: 0, max: 1000
    })),
    locked: element.locked === true,
    opacity: numeric(element.opacity ?? 1, `${path}.opacity`, issues, { min: 0.05, max: 1 })
  };

  if (type === 'qr') {
    if (Math.abs(base.widthMm - base.heightMm) > 0.0001 || base.widthMm < 10) {
      issue(issues, 'QR_GEOMETRY_INVALID', path, 'QR must be square and at least 10 mm.');
    }
    return {
      ...base,
      foregroundColor: color(element.foregroundColor, `${path}.foregroundColor`, issues),
      backgroundColor: color(
        element.backgroundColor,
        `${path}.backgroundColor`,
        issues,
        '#FFFFFF'
      )
    };
  }

  if (type === 'id') {
    return {
      ...base,
      linkedToQr: element.linkedToQr === true,
      ...normalizeFont(element, path, issues)
    };
  }
  if (type === 'text') {
    return {
      ...base,
      text: text(element.text, `${path}.text`, issues, { required: true, max: 160 }),
      ...normalizeFont(element, path, issues)
    };
  }
  if (type === 'divider') {
    return { ...base, color: color(element.color, `${path}.color`, issues, '#D1D5DB') };
  }
  if (type === 'handwriting') {
    return {
      ...base,
      fillColor: color(element.fillColor, `${path}.fillColor`, issues, '#FFFFFF'),
      borderColor: color(element.borderColor, `${path}.borderColor`, issues, '#D1D5DB'),
      borderWidthMm: numeric(
        element.borderWidthMm ?? 0.2,
        `${path}.borderWidthMm`,
        issues,
        { min: 0, max: 2 }
      ),
      radiusMm: numeric(element.radiusMm ?? 0, `${path}.radiusMm`, issues, {
        min: 0, max: Math.min(base.widthMm, base.heightMm) / 2
      })
    };
  }
  if (type === 'image' || type === 'background') {
    const assetId = text(element.assetId, `${path}.assetId`, issues, { required: true, max: 64 });
    const fit = String(element.fit || 'contain').trim();
    if (!['contain', 'cover'].includes(fit)) {
      issue(issues, 'IMAGE_FIT_INVALID', `${path}.fit`, 'Image fit is invalid.');
    }
    const metadata = assetMetadata(options.assets, assetId);
    if (options.requireAssets && !metadata) {
      issue(issues, 'IMAGE_ASSET_MISSING', `${path}.assetId`, 'Image asset is missing.');
    }
    if (metadata) {
      const requiredWidth = Math.ceil(base.widthMm / 25.4 * FORMAL_DPI);
      const requiredHeight = Math.ceil(base.heightMm / 25.4 * FORMAL_DPI);
      if (Number(metadata.pixelWidth) < requiredWidth
          || Number(metadata.pixelHeight) < requiredHeight) {
        issue(
          issues,
          'IMAGE_RESOLUTION_TOO_LOW',
          `${path}.assetId`,
          'Image resolution is too low for its 600 DPI placement.'
        );
      }
    }
    return {
      ...base,
      assetId,
      fit: ['contain', 'cover'].includes(fit) ? fit : 'contain'
    };
  }
  return base;
}

function boxesOverlap(left, right) {
  return left.xMm < right.xMm + right.widthMm
    && left.xMm + left.widthMm > right.xMm
    && left.yMm < right.yMm + right.heightMm
    && left.yMm + left.heightMm > right.yMm;
}

function validateTemplateSchema(input, options = {}) {
  const issues = [];
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const schemaVersion = numeric(source.schemaVersion, 'schemaVersion', issues, {
    min: SCHEMA_VERSION, max: SCHEMA_VERSION
  });
  const canvasInput = source.canvas && typeof source.canvas === 'object'
    && !Array.isArray(source.canvas) ? source.canvas : {};
  const canvas = {
    widthMm: numeric(canvasInput.widthMm, 'canvas.widthMm', issues, {
      min: MIN_CANVAS_MM, max: MAX_CANVAS_WIDTH_MM
    }),
    heightMm: numeric(canvasInput.heightMm, 'canvas.heightMm', issues, {
      min: MIN_CANVAS_MM, max: MAX_CANVAS_HEIGHT_MM
    }),
    dpi: numeric(canvasInput.dpi, 'canvas.dpi', issues, { min: FORMAL_DPI, max: FORMAL_DPI }),
    backgroundColor: color(
      canvasInput.backgroundColor,
      'canvas.backgroundColor',
      issues,
      '#FFFFFF'
    )
  };
  const radiusInput = canvasInput.cornerRadiiMm && typeof canvasInput.cornerRadiiMm === 'object'
    ? canvasInput.cornerRadiiMm : {};
  const maxRadius = Math.min(canvas.widthMm, canvas.heightMm) / 2;
  canvas.cornerRadiiMm = {
    topLeft: numeric(radiusInput.topLeft ?? 0, 'canvas.cornerRadiiMm.topLeft', issues, {
      min: 0, max: maxRadius
    }),
    topRight: numeric(radiusInput.topRight ?? 0, 'canvas.cornerRadiiMm.topRight', issues, {
      min: 0, max: maxRadius
    }),
    bottomRight: numeric(
      radiusInput.bottomRight ?? 0,
      'canvas.cornerRadiiMm.bottomRight',
      issues,
      { min: 0, max: maxRadius }
    ),
    bottomLeft: numeric(
      radiusInput.bottomLeft ?? 0,
      'canvas.cornerRadiiMm.bottomLeft',
      issues,
      { min: 0, max: maxRadius }
    )
  };

  const elementsInput = Array.isArray(source.elements) ? source.elements : [];
  if (elementsInput.length < 1 || elementsInput.length > MAX_ELEMENTS) {
    issue(issues, 'ELEMENT_COUNT_INVALID', 'elements', `Template must contain 1 to ${MAX_ELEMENTS} elements.`);
  }
  const elements = elementsInput.slice(0, MAX_ELEMENTS)
    .map((element, index) => normalizeElement(element, index, canvas, issues, options))
    .filter(Boolean);
  const ids = new Set();
  for (const element of elements) {
    if (ids.has(element.id)) issue(issues, 'ELEMENT_ID_DUPLICATE', 'elements', 'Element IDs must be unique.');
    ids.add(element.id);
  }
  const qrElements = elements.filter((element) => element.type === 'qr');
  const idElements = elements.filter((element) => element.type === 'id');
  if (qrElements.length !== 1) issue(issues, 'QR_ELEMENT_REQUIRED', 'elements', 'Exactly one QR element is required.');
  if (idElements.length !== 1) issue(issues, 'ID_ELEMENT_REQUIRED', 'elements', 'Exactly one ID element is required.');
  if (qrElements.length === 1 && idElements.length === 1 && idElements[0].linkedToQr) {
    const expected = qrIdComponentLayout(qrElements[0]);
    for (const property of ['xMm', 'yMm', 'widthMm', 'heightMm', 'fontSizePt']) {
      if (Math.abs(Number(idElements[0][property]) - Number(expected[property])) > 0.0001) {
        issue(
          issues,
          'QR_ID_COMPONENT_GEOMETRY_INVALID',
          `elements.${idElements[0].id}.${property}`,
          'The QR ID must retain its production position relative to the QR.'
        );
      }
    }
    if (idElements[0].align !== 'center') {
      issue(
        issues,
        'QR_ID_COMPONENT_ALIGNMENT_INVALID',
        `elements.${idElements[0].id}.align`,
        'The QR ID must stay centered beneath the QR.'
      );
    }
  }
  if (qrElements.length === 1) {
    for (const element of elements) {
      if (!['background', 'handwriting', 'qr'].includes(element.type)
          && boxesOverlap(qrElements[0], element)) {
        issue(issues, 'QR_OVERLAP_FORBIDDEN', `elements.${element.id}`, 'Nothing may overlap the QR.');
      }
    }
  }

  if (issues.length) throw new LabelTemplateValidationError(issues);
  return Object.freeze({
    schemaVersion,
    canvas: Object.freeze({
      ...canvas,
      cornerRadiiMm: Object.freeze({ ...canvas.cornerRadiiMm })
    }),
    elements: Object.freeze(elements
      .sort((left, right) => left.zIndex - right.zIndex || left.id.localeCompare(right.id))
      .map((element) => Object.freeze({ ...element })))
  });
}

module.exports = {
  ELEMENT_TYPES,
  FORMAL_DPI,
  LabelTemplateValidationError,
  QR_ID_COMPONENT,
  SCHEMA_VERSION,
  defaultLabelTemplateSchema,
  qrIdComponentLayout,
  synchronizeQrIdComponent,
  validateTemplateSchema
};
