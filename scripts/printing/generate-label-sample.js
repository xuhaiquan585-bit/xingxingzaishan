'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  defaultLabelTemplateSchema
} = require('../../src/server/services/labelTemplateSchema');
const { renderLabel } = require('../../src/server/services/labelRenderer');

const OUTPUT_PATH = path.join(
  __dirname,
  '..',
  '..',
  'docs',
  'samples',
  'default-label-20x80mm-600dpi.png'
);

async function main() {
  const rendered = await renderLabel({
    template: defaultLabelTemplateSchema(),
    qrId: 'SSS00001',
    qrPayload: 'https://xingxingzaishan.top/q/sample-preview-not-a-live-token'
  });
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, rendered.buffer, { mode: 0o644 });
  process.stdout.write(`LABEL_SAMPLE=${OUTPUT_PATH}\n`);
  process.stdout.write(`LABEL_SAMPLE_WIDTH=${rendered.width}\n`);
  process.stdout.write(`LABEL_SAMPLE_HEIGHT=${rendered.height}\n`);
  process.stdout.write(`LABEL_SAMPLE_DPI=${rendered.density}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`LABEL_SAMPLE_ERROR=${error.code || 'RENDER_FAILED'}\n`);
    process.exitCode = 1;
  });
}

module.exports = { OUTPUT_PATH, main };
