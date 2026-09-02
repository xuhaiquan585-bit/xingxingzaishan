'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { renderLabel } = require('../src/server/services/labelRenderer');
const { defaultLabelTemplateSchema } = require('../src/server/services/labelTemplateSchema');
const { writeFormalZip } = require('../src/server/services/postgres/printBatchService');

const ALLOWED_COUNTS = new Set([10, 100, 500]);

function megabytes(bytes) {
  return Number((bytes / 1024 / 1024).toFixed(2));
}

async function main() {
  const count = Number(process.argv[2]);
  if (!ALLOWED_COUNTS.has(count)) {
    throw new Error('COUNT_MUST_BE_10_100_OR_500');
  }

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `print-artifact-${count}-`));
  const outputPath = path.join(directory, `benchmark-${count}.zip`);
  const batch = {
    id: `BENCHMARK-${count}`,
    template_name: '默认 80x20 mm 标签',
    template_version_number: 1,
    created_at: '2026-09-02T00:00:00.000Z'
  };
  const qrCodes = Array.from({ length: count }, (_, index) => {
    const id = `BM${String(index + 1).padStart(6, '0')}`;
    return {
      id,
      batch_id: 'BENCHMARK-SOURCE',
      access_token: `benchmark-token-${String(index + 1).padStart(6, '0')}`
    };
  });
  const baselineRss = process.memoryUsage().rss;
  let peakRss = baselineRss;
  let maxPngBytes = 0;
  let renderedWidth = 0;
  let renderedHeight = 0;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 20);
  sampler.unref();
  const started = process.hrtime.bigint();

  try {
    const result = await writeFormalZip({
      batch,
      qrCodes,
      template: defaultLabelTemplateSchema(),
      assets: new Map(),
      outputPath,
      baseUrl: 'https://benchmark.invalid',
      render: async (input) => {
        const rendered = await renderLabel(input);
        maxPngBytes = Math.max(maxPngBytes, rendered.buffer.length);
        renderedWidth = rendered.width;
        renderedHeight = rendered.height;
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
        return rendered;
      },
      onProgress: ({ rss }) => {
        peakRss = Math.max(peakRss, rss);
      }
    });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    const stat = await fs.stat(outputPath);
    if (stat.size !== result.size) throw new Error('ZIP_SIZE_MISMATCH');
    process.stdout.write(`${JSON.stringify({
      count,
      elapsed_ms: Number(elapsedMs.toFixed(1)),
      labels_per_second: Number((count / (elapsedMs / 1000)).toFixed(2)),
      baseline_rss_mb: megabytes(baselineRss),
      peak_rss_mb: megabytes(peakRss),
      peak_rss_delta_mb: megabytes(Math.max(0, peakRss - baselineRss)),
      zip_size_bytes: result.size,
      zip_size_mb: megabytes(result.size),
      artifact_sha256: result.sha256,
      rendered_width_px: renderedWidth,
      rendered_height_px: renderedHeight,
      max_png_bytes: maxPngBytes,
      max_uncompressed_frame_bytes: renderedWidth * renderedHeight * 4
    })}\n`);
  } finally {
    clearInterval(sampler);
    await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
