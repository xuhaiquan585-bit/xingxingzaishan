'use strict';

const {
  PUBLIC_QR_DOMAIN_CHECKSUM_KEY,
  publicQrDomainSha256
} = require('./domain-markers');

function countBy(items, key) {
  return items.reduce((counts, item) => {
    const value = item[key];
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

function collectionCounts(source) {
  const result = {};
  Object.entries(source && typeof source === 'object' && !Array.isArray(source) ? source : {}).forEach(([key, value]) => {
    if (Array.isArray(value)) result[key] = value.length;
    else if (key === 'miniapp_content' && value && typeof value === 'object') result[key] = 1;
  });
  return result;
}

function targetCounts(plan) {
  const result = {};
  Object.entries(plan).forEach(([key, value]) => {
    if (Array.isArray(value)) result[key] = value.length;
  });
  return result;
}

function sourceDisposition(source) {
  const disposition = {};
  Object.entries(source && typeof source === 'object' && !Array.isArray(source) ? source : {}).forEach(([key, value]) => {
    const sourceCount = Array.isArray(value) ? value.length : (key === 'miniapp_content' && value && typeof value === 'object' ? 1 : 0);
    if (key === 'meta') {
      disposition[key] = { source_count: 1, migrate: 0, archive: 0, metadata: 1, total_classified: 1 };
      return;
    }
    const archiveCount = ['content_pages', 'banners'].includes(key) ? sourceCount : 0;
    const migrateCount = archiveCount === 0 ? sourceCount : 0;
    disposition[key] = {
      source_count: sourceCount,
      migrate: migrateCount,
      archive: archiveCount,
      metadata: 0,
      total_classified: sourceCount
    };
  });
  return disposition;
}

function buildReport({ snapshot, source, plan, anomalies, conservation }) {
  const blocking = anomalies.filter((item) => item.blocking);
  const disposition = sourceDisposition(source);
  return {
    import_run_id: `dryrun-${snapshot.sourceHash.slice(0, 16)}`,
    mode: 'dry-run',
    status: blocking.length === 0 ? 'READY' : 'BLOCKED',
    can_import: blocking.length === 0,
    read_only: true,
    postgres_connected: false,
    source_path: snapshot.sourcePath,
    source_sha256: snapshot.sourceHash,
    source_size: snapshot.sourceSize,
    domain_checksums: {
      [PUBLIC_QR_DOMAIN_CHECKSUM_KEY]: publicQrDomainSha256(plan)
    },
    schema_version: source && source.meta && source.meta.schema_version
      ? source.meta.schema_version
      : 'legacy-current',
    source_counts: collectionCounts(source),
    planned_counts: targetCounts(plan),
    source_disposition: disposition,
    disposition_conservation: {
      passed: Object.values(disposition).every((item) => item.source_count === item.total_classified)
    },
    anomaly_counts: countBy(anomalies, 'category'),
    blocked_reasons: [...new Set(blocking.map((item) => item.category))].sort(),
    count_conservation: conservation,
    anomalies
  };
}

function reportAsMarkdown(report) {
  const lines = [
    '# PostgreSQL Import Dry Run',
    '',
    `- Status: ${report.status}`,
    `- Read only: ${report.read_only}`,
    `- PostgreSQL connected: ${report.postgres_connected}`,
    `- Source SHA-256: ${report.source_sha256}`,
    `- Source size: ${report.source_size}`,
    `- Schema version: ${report.schema_version}`,
    '',
    '## Source Counts',
    ''
  ];
  Object.entries(report.source_counts).forEach(([key, value]) => lines.push(`- ${key}: ${value}`));
  lines.push('', '## Planned Counts', '');
  Object.entries(report.planned_counts).forEach(([key, value]) => lines.push(`- ${key}: ${value}`));
  lines.push('', '## Anomalies', '');
  if (report.anomalies.length === 0) lines.push('- None');
  report.anomalies.forEach((item) => {
    lines.push(`- ${item.category}: ${item.entity_type}.${item.field || '(entity)'} [${item.entity_reference_hash}] (${item.count})`);
  });
  return `${lines.join('\n')}\n`;
}

function serializeReport(report, format = 'json') {
  if (format === 'markdown') return reportAsMarkdown(report);
  return `${JSON.stringify(report, null, 2)}\n`;
}

module.exports = {
  buildReport,
  serializeReport
};
