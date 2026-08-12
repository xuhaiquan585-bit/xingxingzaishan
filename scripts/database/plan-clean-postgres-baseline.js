#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { analyzeSource } = require('./audit-cross-account-phone-content');
const { analyzeSourceSnapshot } = require('./importer');
const { publicQrDomainSha256 } = require('./importer/domain-markers');
const { mapSourceToPlan } = require('./importer/mapping');
const {
  assertSourceUnchanged,
  readSourceSnapshot,
  sha256
} = require('./importer/reader');
const { planSha256 } = require('./importer/writer');

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DEFAULT_EXCLUDED_QR_IDS = Object.freeze(['STAR0001']);
const DEFAULT_RETAINED_PRIVACY_QR_IDS = Object.freeze([
  'SSS00003',
  'SSS00008',
  'SSS00009'
]);

function baselineError(code, message, details = {}) {
  const error = new Error(message || code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function normalizedHash(value, code) {
  const hash = String(value || '').trim().toLowerCase();
  if (!SHA256_PATTERN.test(hash)) throw baselineError(code);
  return hash;
}

function normalizedIds(value, code) {
  const ids = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .sort();
  if (ids.length === 0
      || ids.some((id) => !/^[A-Za-z0-9_-]+$/.test(id))
      || new Set(ids).size !== ids.length) {
    throw baselineError(code);
  }
  return Object.freeze(ids);
}

function parseArguments(argv) {
  const values = {};
  let planOnly = false;
  for (const argument of argv) {
    if (argument === '--plan-only') {
      if (planOnly) throw baselineError('CLEAN_BASELINE_ARGUMENT_INVALID');
      planOnly = true;
      continue;
    }
    const match = /^--([a-z0-9-]+)=(.*)$/i.exec(argument);
    const allowed = [
      'source',
      'candidate',
      'preparation-report',
      'expected-source-sha256',
      'expected-candidate-sha256',
      'expected-candidate-domain-sha256',
      'exclude-qr-ids',
      'retained-privacy-qr-ids'
    ];
    if (!match || !allowed.includes(match[1]) || Object.hasOwn(values, match[1])) {
      throw baselineError('CLEAN_BASELINE_ARGUMENT_INVALID');
    }
    values[match[1]] = match[2];
  }
  if (!planOnly) throw baselineError('CLEAN_BASELINE_PLAN_ONLY_REQUIRED');
  for (const key of ['source', 'candidate', 'preparation-report']) {
    if (!values[key] || !path.isAbsolute(values[key])) {
      throw baselineError('CLEAN_BASELINE_ABSOLUTE_PATH_REQUIRED');
    }
  }
  return Object.freeze({
    planOnly: true,
    sourcePath: path.resolve(values.source),
    candidatePath: path.resolve(values.candidate),
    preparationReportPath: path.resolve(values['preparation-report']),
    expectedSourceSha256: normalizedHash(
      values['expected-source-sha256'],
      'CLEAN_BASELINE_SOURCE_SHA256_INVALID'
    ),
    expectedCandidateSha256: normalizedHash(
      values['expected-candidate-sha256'],
      'CLEAN_BASELINE_CANDIDATE_SHA256_INVALID'
    ),
    expectedCandidateDomainSha256: normalizedHash(
      values['expected-candidate-domain-sha256'],
      'CLEAN_BASELINE_CANDIDATE_DOMAIN_SHA256_INVALID'
    ),
    excludedQrIds: normalizedIds(
      values['exclude-qr-ids'],
      'CLEAN_BASELINE_EXCLUDED_QR_IDS_INVALID'
    ),
    retainedPrivacyQrIds: normalizedIds(
      values['retained-privacy-qr-ids'],
      'CLEAN_BASELINE_PRIVACY_QR_IDS_INVALID'
    )
  });
}

function readJsonFile(filePath, code) {
  if (!fs.existsSync(filePath) || fs.lstatSync(filePath).isSymbolicLink()) {
    throw baselineError(code);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    throw baselineError(code);
  }
}

function countByCollection(plan) {
  return Object.fromEntries(
    Object.entries(plan)
      .filter(([, rows]) => Array.isArray(rows))
      .map(([collection, rows]) => [collection, rows.length])
  );
}

function countAssetLocators(source) {
  const keys = new Set();
  let referenceCount = 0;
  for (const row of Array.isArray(source.qr_codes) ? source.qr_codes : []) {
    for (const field of [
      'image_object_key',
      'manifest_object_key',
      'legacy_manifest_object_key',
      'archive_index_object_key',
      'chain_certificate_object_key'
    ]) {
      const value = String(row && row[field] || '').trim();
      if (value) {
        referenceCount += 1;
        keys.add(value);
      }
    }
  }
  return Object.freeze({
    reference_count: referenceCount,
    unique_object_key_count: keys.size
  });
}

function buildCleanBaseline({
  source,
  candidate,
  preparationReport,
  expectedSourceSha256,
  expectedCandidateSha256,
  expectedCandidateDomainSha256,
  excludedQrIds = DEFAULT_EXCLUDED_QR_IDS,
  retainedPrivacyQrIds = DEFAULT_RETAINED_PRIVACY_QR_IDS
}) {
  const excluded = new Set(excludedQrIds);
  const retainedPrivacy = new Set(retainedPrivacyQrIds);
  if (excludedQrIds.some((id) => retainedPrivacy.has(id))) {
    throw baselineError('CLEAN_BASELINE_SCOPE_OVERLAP');
  }
  if (!preparationReport
      || preparationReport.status !== 'READY'
      || preparationReport.mode !== 'prepare'
      || preparationReport.apply_performed !== false
      || preparationReport.source_sha256 !== expectedSourceSha256
      || preparationReport.candidate_source_sha256 !== expectedCandidateSha256
      || preparationReport.candidate_public_qr_domain_sha256
        !== expectedCandidateDomainSha256
      || preparationReport.candidate_privacy_finding_count !== 0
      || JSON.stringify(preparationReport.affected_qr_ids)
        !== JSON.stringify([...retainedPrivacy].sort())) {
    throw baselineError('CLEAN_BASELINE_PREPARATION_REPORT_INVALID');
  }
  if (!source || !Array.isArray(source.qr_codes)
      || !candidate || !Array.isArray(candidate.qr_codes)) {
    throw baselineError('CLEAN_BASELINE_QR_COLLECTION_INVALID');
  }
  const candidatePlan = mapSourceToPlan(candidate).plan;
  if (publicQrDomainSha256(candidatePlan) !== expectedCandidateDomainSha256) {
    throw baselineError('CLEAN_BASELINE_CANDIDATE_DOMAIN_MISMATCH');
  }
  const privacy = analyzeSource(candidate, expectedCandidateSha256);
  if (privacy.status !== 'CLEAN' || privacy.finding_count !== 0) {
    throw baselineError('CLEAN_BASELINE_CANDIDATE_NOT_PRIVATE');
  }

  const sourceRows = new Map(
    (Array.isArray(source.qr_codes) ? source.qr_codes : [])
      .map((row) => [String(row && row.id || ''), row])
  );
  const candidateRows = new Map(
    (Array.isArray(candidate.qr_codes) ? candidate.qr_codes : [])
      .map((row) => [String(row && row.id || ''), row])
  );
  if (sourceRows.size !== source.qr_codes.length
      || candidateRows.size !== candidate.qr_codes.length
      || excludedQrIds.some((id) => !sourceRows.has(id) || !candidateRows.has(id))
      || retainedPrivacyQrIds.some((id) => !candidateRows.has(id))) {
    throw baselineError('CLEAN_BASELINE_QR_SCOPE_INVALID');
  }

  const clean = JSON.parse(JSON.stringify(candidate));
  clean.qr_codes = clean.qr_codes.filter((row) => !excluded.has(String(row.id)));
  if (Array.isArray(clean.quality_check_logs)) {
    clean.quality_check_logs = clean.quality_check_logs.filter(
      (row) => !excluded.has(String(row && row.qr_id || ''))
    );
  }
  const serialized = `${JSON.stringify(clean, null, 2)}\n`;
  const targetSourceSha256 = sha256(Buffer.from(serialized, 'utf8'));
  const targetPlan = mapSourceToPlan(clean).plan;
  const syntheticSnapshot = {
    sourcePath: '/planned/clean-postgres-baseline.json',
    sourceHash: targetSourceSha256,
    sourceSize: Buffer.byteLength(serialized),
    data: clean
  };
  const targetAudit = analyzeSourceSnapshot(syntheticSnapshot).report;
  if (targetAudit.status !== 'READY'
      || targetAudit.can_import !== true
      || targetAudit.blocked_reasons.length !== 0
      || targetAudit.disposition_conservation.passed !== true) {
    throw baselineError('CLEAN_BASELINE_TARGET_NOT_IMPORTABLE', null, {
      blockedReasons: targetAudit.blocked_reasons,
      anomalyCounts: targetAudit.anomaly_counts
    });
  }
  const targetPrivacy = analyzeSource(clean, targetSourceSha256);
  if (targetPrivacy.status !== 'CLEAN' || targetPrivacy.finding_count !== 0) {
    throw baselineError('CLEAN_BASELINE_TARGET_NOT_PRIVATE');
  }

  const candidateCounts = countByCollection(candidatePlan);
  const targetCounts = countByCollection(targetPlan);
  const removedCounts = Object.fromEntries(
    Object.keys(candidateCounts).map((collection) => [
      collection,
      candidateCounts[collection] - targetCounts[collection]
    ])
  );
  const removedSourceRows = excludedQrIds.map((id) => sourceRows.get(id));
  const removedCandidateRows = excludedQrIds.map((id) => candidateRows.get(id));
  return Object.freeze({
    schema_version: 1,
    mode: 'plan-only',
    status: 'READY',
    strategy: 'CLEAN_POSTGRES_BASELINE_FROM_PRIVACY_CANDIDATE',
    source_sha256: expectedSourceSha256,
    candidate_source_sha256: expectedCandidateSha256,
    candidate_public_qr_domain_sha256: expectedCandidateDomainSha256,
    target_source_sha256: targetSourceSha256,
    target_plan_sha256: planSha256(targetPlan),
    target_public_qr_domain_sha256: publicQrDomainSha256(targetPlan),
    excluded_qr_ids: excludedQrIds,
    retained_privacy_remediation_qr_ids: retainedPrivacyQrIds,
    removal_reasons: excludedQrIds.map((qrId) => ({
      qr_id: qrId,
      reason: 'INVALID_UNISSUED_QR_LIFECYCLE_TEST_DATA',
      source_issue_status: String(sourceRows.get(qrId).issue_status || ''),
      source_lifecycle_status: String(sourceRows.get(qrId).activation_status || '')
    })),
    candidate_counts: candidateCounts,
    target_counts: targetCounts,
    removed_counts: removedCounts,
    removed_source_record_count: removedSourceRows.filter((row) => (
      row.activation_status !== 'unactivated'
      || ['content', 'image_url', 'image_object_key', 'image_sha256', 'phone',
        'account_id', 'activated_at'].some((field) => row[field])
    )).length,
    removed_candidate_proof_reference_count: removedCandidateRows.filter((row) => (
      row.chain_status && row.chain_status !== 'not_started'
      || row.manifest_hash || row.blockchain_hash
    )).length,
    retained_asset_locators: countAssetLocators(clean),
    target_import_status: targetAudit.status,
    target_blocked_reasons: targetAudit.blocked_reasons,
    target_anomaly_counts: targetAudit.anomaly_counts,
    target_privacy_finding_count: targetPrivacy.finding_count,
    rollback_requirements: Object.freeze({
      immutable_source_snapshot_sha256: expectedSourceSha256,
      current_postgres_backup_required_before_apply: true,
      live_json_backup_required_before_apply: true,
      object_storage_write_planned: false,
      provider_reproof_planned: false
    }),
    production_database_access: 'NONE',
    production_database_write: 'NONE',
    production_json_write: 'NONE',
    oss_access: 'NONE',
    external_provider_calls: 'NONE',
    target_baseline_persisted: false
  });
}

function planFiles(options) {
  const source = readSourceSnapshot({
    inputPath: options.sourcePath,
    expectedSha256: options.expectedSourceSha256
  });
  const candidate = readSourceSnapshot({
    inputPath: options.candidatePath,
    expectedSha256: options.expectedCandidateSha256
  });
  const preparationReport = readJsonFile(
    options.preparationReportPath,
    'CLEAN_BASELINE_PREPARATION_REPORT_INVALID'
  );
  const preparationReportSha256 = sha256(
    fs.readFileSync(options.preparationReportPath)
  );
  const result = buildCleanBaseline({
    source: source.data,
    candidate: candidate.data,
    preparationReport,
    expectedSourceSha256: options.expectedSourceSha256,
    expectedCandidateSha256: options.expectedCandidateSha256,
    expectedCandidateDomainSha256: options.expectedCandidateDomainSha256,
    excludedQrIds: options.excludedQrIds,
    retainedPrivacyQrIds: options.retainedPrivacyQrIds
  });
  assertSourceUnchanged(source);
  assertSourceUnchanged(candidate);
  if (sha256(fs.readFileSync(options.preparationReportPath))
      !== preparationReportSha256) {
    throw baselineError('CLEAN_BASELINE_PREPARATION_REPORT_CHANGED');
  }
  return result;
}

function main(argv = process.argv.slice(2), io = process) {
  try {
    const options = parseArguments(argv);
    io.stdout.write(`${JSON.stringify(planFiles(options), null, 2)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${JSON.stringify({
      status: 'BLOCKED',
      code: error && String(error.code || '').startsWith('CLEAN_BASELINE_')
        ? error.code
        : 'CLEAN_BASELINE_PLANNING_FAILED'
    })}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  DEFAULT_EXCLUDED_QR_IDS,
  DEFAULT_RETAINED_PRIVACY_QR_IDS,
  buildCleanBaseline,
  main,
  parseArguments,
  planFiles
};
