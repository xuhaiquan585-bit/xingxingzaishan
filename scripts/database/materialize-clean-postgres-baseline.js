#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  loadCleanBaselineArtifact,
  parseArguments: parsePlannerArguments
} = require('./plan-clean-postgres-baseline');
const { sha256 } = require('./importer/reader');

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MATERIALIZE_KEYS = Object.freeze([
  'source',
  'candidate',
  'preparation-report',
  'approved-plan-report',
  'output',
  'expected-source-sha256',
  'expected-candidate-sha256',
  'expected-candidate-domain-sha256',
  'expected-approved-plan-report-sha256',
  'expected-target-source-sha256',
  'expected-target-plan-sha256',
  'expected-target-domain-sha256',
  'exclude-qr-ids',
  'retained-privacy-qr-ids'
]);

function materializeError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function normalizedHash(value, code) {
  const hash = String(value || '').trim().toLowerCase();
  if (!SHA256_PATTERN.test(hash)) throw materializeError(code);
  return hash;
}

function parseArguments(argv) {
  const values = {};
  let materialize = false;
  for (const argument of argv) {
    if (argument === '--materialize') {
      if (materialize) throw materializeError('CLEAN_BASELINE_MATERIALIZE_ARGUMENT_INVALID');
      materialize = true;
      continue;
    }
    const match = /^--([a-z0-9-]+)=(.*)$/i.exec(argument);
    if (!match || !MATERIALIZE_KEYS.includes(match[1])
        || Object.hasOwn(values, match[1])) {
      throw materializeError('CLEAN_BASELINE_MATERIALIZE_ARGUMENT_INVALID');
    }
    values[match[1]] = match[2];
  }
  if (!materialize) {
    throw materializeError('CLEAN_BASELINE_MATERIALIZE_CONFIRMATION_REQUIRED');
  }
  for (const key of [
    'source', 'candidate', 'preparation-report', 'approved-plan-report', 'output'
  ]) {
    if (!values[key] || !path.isAbsolute(values[key])) {
      throw materializeError('CLEAN_BASELINE_MATERIALIZE_ABSOLUTE_PATH_REQUIRED');
    }
  }

  const plannerOptions = parsePlannerArguments([
    '--plan-only',
    `--source=${values.source}`,
    `--candidate=${values.candidate}`,
    `--preparation-report=${values['preparation-report']}`,
    `--expected-source-sha256=${values['expected-source-sha256'] || ''}`,
    `--expected-candidate-sha256=${values['expected-candidate-sha256'] || ''}`,
    `--expected-candidate-domain-sha256=${values['expected-candidate-domain-sha256'] || ''}`,
    `--exclude-qr-ids=${values['exclude-qr-ids'] || ''}`,
    `--retained-privacy-qr-ids=${values['retained-privacy-qr-ids'] || ''}`
  ]);
  const approvedPlanReportPath = path.resolve(values['approved-plan-report']);
  const outputPath = path.resolve(values.output);
  const protectedInputs = new Set([
    plannerOptions.sourcePath,
    plannerOptions.candidatePath,
    plannerOptions.preparationReportPath,
    approvedPlanReportPath,
    path.resolve(__dirname, '../../src/server/data/db.json')
  ]);
  if (protectedInputs.has(outputPath)) {
    throw materializeError('CLEAN_BASELINE_MATERIALIZE_OUTPUT_FORBIDDEN');
  }

  return Object.freeze({
    plannerOptions,
    approvedPlanReportPath,
    outputPath,
    expectedApprovedPlanReportSha256: normalizedHash(
      values['expected-approved-plan-report-sha256'],
      'CLEAN_BASELINE_APPROVED_REPORT_SHA256_INVALID'
    ),
    expectedTargetSourceSha256: normalizedHash(
      values['expected-target-source-sha256'],
      'CLEAN_BASELINE_TARGET_SOURCE_SHA256_INVALID'
    ),
    expectedTargetPlanSha256: normalizedHash(
      values['expected-target-plan-sha256'],
      'CLEAN_BASELINE_TARGET_PLAN_SHA256_INVALID'
    ),
    expectedTargetDomainSha256: normalizedHash(
      values['expected-target-domain-sha256'],
      'CLEAN_BASELINE_TARGET_DOMAIN_SHA256_INVALID'
    )
  });
}

function readApprovedReport(options) {
  const reportPath = options.approvedPlanReportPath;
  if (!fs.existsSync(reportPath) || fs.lstatSync(reportPath).isSymbolicLink()) {
    throw materializeError('CLEAN_BASELINE_APPROVED_REPORT_INVALID');
  }
  const bytes = fs.readFileSync(reportPath);
  if (sha256(bytes) !== options.expectedApprovedPlanReportSha256) {
    throw materializeError('CLEAN_BASELINE_APPROVED_REPORT_SHA256_MISMATCH');
  }
  try {
    return { bytes, report: JSON.parse(bytes.toString('utf8')) };
  } catch (_error) {
    throw materializeError('CLEAN_BASELINE_APPROVED_REPORT_INVALID');
  }
}

function writeExclusiveProtected(filePath, serialized) {
  const parent = path.dirname(filePath);
  if (!fs.existsSync(parent) || fs.lstatSync(parent).isSymbolicLink()
      || !fs.statSync(parent).isDirectory() || fs.existsSync(filePath)) {
    throw materializeError('CLEAN_BASELINE_MATERIALIZE_OUTPUT_INVALID');
  }
  let descriptor = null;
  try {
    descriptor = fs.openSync(filePath, 'wx', 0o600);
    fs.writeFileSync(descriptor, serialized, { encoding: 'utf8' });
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch (_closeError) {
        // Preserve the original materialization failure.
      }
    }
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_cleanupError) {
      // The caller treats a failed materialization as blocked.
    }
    throw error;
  }
}

function materializeFiles(options) {
  const approved = readApprovedReport(options);
  const artifact = loadCleanBaselineArtifact(options.plannerOptions);
  const report = artifact.report;
  if (JSON.stringify(report) !== JSON.stringify(approved.report)) {
    throw materializeError('CLEAN_BASELINE_APPROVED_REPORT_CONTENT_MISMATCH');
  }
  if (report.target_source_sha256 !== options.expectedTargetSourceSha256
      || report.target_plan_sha256 !== options.expectedTargetPlanSha256
      || report.target_public_qr_domain_sha256 !== options.expectedTargetDomainSha256
      || sha256(Buffer.from(artifact.serialized, 'utf8'))
        !== options.expectedTargetSourceSha256) {
    throw materializeError('CLEAN_BASELINE_APPROVED_TARGET_MISMATCH');
  }

  writeExclusiveProtected(options.outputPath, artifact.serialized);
  if (sha256(fs.readFileSync(options.outputPath)) !== options.expectedTargetSourceSha256
      || sha256(fs.readFileSync(options.approvedPlanReportPath))
        !== options.expectedApprovedPlanReportSha256) {
    try {
      fs.unlinkSync(options.outputPath);
    } catch (_cleanupError) {
      // A hash mismatch remains a hard failure even if cleanup is blocked.
    }
    throw materializeError('CLEAN_BASELINE_MATERIALIZED_HASH_MISMATCH');
  }

  return Object.freeze({
    status: 'MATERIALIZED',
    strategy: report.strategy,
    approved_plan_report_sha256: options.expectedApprovedPlanReportSha256,
    target_source_sha256: report.target_source_sha256,
    target_plan_sha256: report.target_plan_sha256,
    target_public_qr_domain_sha256: report.target_public_qr_domain_sha256,
    target_qr_count: report.target_counts.qr_codes,
    target_record_count: report.target_counts.records,
    excluded_qr_ids: report.excluded_qr_ids,
    retained_privacy_remediation_qr_ids:
      report.retained_privacy_remediation_qr_ids,
    production_database_access: 'NONE',
    production_database_write: 'NONE',
    production_json_write: 'NONE',
    oss_access: 'NONE',
    external_provider_calls: 'NONE'
  });
}

function main(argv = process.argv.slice(2), io = process) {
  try {
    const result = materializeFiles(parseArguments(argv));
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${JSON.stringify({
      status: 'BLOCKED',
      code: error && String(error.code || '').startsWith('CLEAN_BASELINE_')
        ? error.code
        : 'CLEAN_BASELINE_MATERIALIZATION_FAILED'
    })}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  main,
  materializeFiles,
  parseArguments,
  writeExclusiveProtected
};
