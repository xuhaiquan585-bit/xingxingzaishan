#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { mapSourceToPlan } = require('./importer/mapping');
const {
  CONTENT_PRIVACY_POLICY,
  redactCrossAccountPhoneReferences
} = require('../../src/server/services/contentPrivacyService');

const DEFAULT_JSON_DATABASE = path.resolve(
  __dirname,
  '..',
  '..',
  'src',
  'server',
  'data',
  'db.json'
);

function auditError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function samePath(left, right) {
  const normalize = (value) => path.normalize(value).toLowerCase();
  return normalize(left) === normalize(right);
}

function parseArguments(argv) {
  const options = { dryRun: false, inputPath: '', expectedSha256: '' };
  argv.forEach((argument) => {
    if (argument === '--dry-run') {
      options.dryRun = true;
    } else if (argument.startsWith('--input=')) {
      options.inputPath = argument.slice('--input='.length);
    } else if (argument.startsWith('--expected-source-sha256=')) {
      options.expectedSha256 = argument.slice('--expected-source-sha256='.length);
    } else {
      throw auditError('CONTENT_PRIVACY_AUDIT_UNKNOWN_ARGUMENT', 'Unknown audit argument.');
    }
  });

  if (!options.dryRun) {
    throw auditError(
      'CONTENT_PRIVACY_AUDIT_DRY_RUN_REQUIRED',
      'Explicit --dry-run mode is required.'
    );
  }
  if (!options.inputPath) {
    throw auditError('CONTENT_PRIVACY_AUDIT_INPUT_REQUIRED', 'An explicit input is required.');
  }
  if (!path.isAbsolute(options.inputPath)) {
    throw auditError(
      'CONTENT_PRIVACY_AUDIT_ABSOLUTE_INPUT_REQUIRED',
      'The input path must be absolute.'
    );
  }
  const expected = String(options.expectedSha256 || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw auditError(
      'CONTENT_PRIVACY_AUDIT_EXPECTED_SHA256_REQUIRED',
      'A valid expected source SHA-256 is required.'
    );
  }
  options.expectedSha256 = expected;
  return options;
}

function resolveAuditInput(inputPath) {
  const resolved = path.resolve(inputPath);
  if (samePath(resolved, DEFAULT_JSON_DATABASE)) {
    throw auditError(
      'CONTENT_PRIVACY_AUDIT_RUNTIME_DATABASE_FORBIDDEN',
      'The live runtime database cannot be audited directly.'
    );
  }
  if (!fs.existsSync(resolved)) {
    throw auditError('CONTENT_PRIVACY_AUDIT_INPUT_NOT_FOUND', 'The input does not exist.');
  }
  const linkStat = fs.lstatSync(resolved);
  if (linkStat.isSymbolicLink()) {
    throw auditError('CONTENT_PRIVACY_AUDIT_SYMLINK_FORBIDDEN', 'Symlinks are not allowed.');
  }
  if (!linkStat.isFile()) {
    throw auditError('CONTENT_PRIVACY_AUDIT_INPUT_NOT_FILE', 'The input must be a file.');
  }
  const realPath = fs.realpathSync(resolved);
  if (samePath(realPath, DEFAULT_JSON_DATABASE)) {
    throw auditError(
      'CONTENT_PRIVACY_AUDIT_RUNTIME_DATABASE_FORBIDDEN',
      'The live runtime database cannot be audited directly.'
    );
  }
  return realPath;
}

function decodeUtf8(bytes) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch (_error) {
    throw auditError(
      'CONTENT_PRIVACY_AUDIT_INVALID_UTF8',
      'The input must contain valid UTF-8.'
    );
  }
}

function proofDependency(proof, archive) {
  if (!proof && !archive) {
    return Object.freeze({
      present: false,
      proof_status: null,
      proof_hash_kind: 'NONE',
      external_reference_present: false,
      archive_present: false,
      archive_status: null
    });
  }
  return Object.freeze({
    present: true,
    proof_status: proof ? String(proof.status || '') || null : null,
    proof_hash_kind: proof && proof.manifest_hash
      ? 'SHA256'
      : proof && proof.legacy_hash_snapshot ? 'LEGACY' : 'NONE',
    external_reference_present: Boolean(proof && (
      proof.operation_id
      || proof.transaction_hash
      || proof.provider_record_id
      || proof.provider_certificate_url
      || proof.certificate_object_key
      || proof.certificate_object_url_snapshot
      || proof.confirmed_at
      || proof.callback_received_at
    )),
    archive_present: Boolean(archive),
    archive_status: archive ? String(archive.status || '') || null : null
  });
}

function finding({
  collection,
  qrId,
  sourcePosition,
  ownerAccountId,
  content,
  identities,
  proof,
  archive
}) {
  const redaction = redactCrossAccountPhoneReferences({
    content,
    ownerAccountId,
    identities
  });
  if (!redaction.has_reference) return null;
  return Object.freeze({
    collection,
    qr_id: String(qrId || ''),
    source_position: sourcePosition ?? null,
    content_sha256: sha256(Buffer.from(String(content || ''), 'utf8')),
    proposed_content_sha256: sha256(Buffer.from(redaction.content, 'utf8')),
    match_count: redaction.match_count,
    matched_identity_count: redaction.matched_identity_count,
    evidence_dependency: proofDependency(proof, archive)
  });
}

function analyzeSource(source, sourceHash) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw auditError('CONTENT_PRIVACY_AUDIT_ROOT_INVALID', 'The input root must be an object.');
  }
  const { plan } = mapSourceToPlan(source);
  const identities = plan.users;
  const coCreationQrIds = new Map(
    plan.co_creations.map((row) => [row.id, row.qr_id])
  );
  const proofsByQrId = new Map(
    plan.record_proofs.map((row) => [row.record_qr_id, row])
  );
  const archivesByQrId = new Map(
    plan.record_archives.map((row) => [row.record_qr_id, row])
  );
  const findings = [];

  plan.records.forEach((record) => {
    const result = finding({
      collection: 'records',
      qrId: record.qr_id,
      sourcePosition: null,
      ownerAccountId: record.account_id,
      content: record.content,
      identities,
      proof: proofsByQrId.get(record.qr_id),
      archive: archivesByQrId.get(record.qr_id)
    });
    if (result) findings.push(result);
  });

  plan.co_creation_comments.forEach((comment) => {
    const qrId = coCreationQrIds.get(comment.co_creation_id);
    const result = finding({
      collection: 'co_creation_comments',
      qrId,
      sourcePosition: comment.source_position,
      ownerAccountId: comment.account_id,
      content: comment.content,
      identities,
      proof: proofsByQrId.get(qrId),
      archive: archivesByQrId.get(qrId)
    });
    if (result) findings.push(result);
  });

  findings.sort((left, right) => (
    left.qr_id.localeCompare(right.qr_id)
    || left.collection.localeCompare(right.collection)
    || Number(left.source_position ?? -1) - Number(right.source_position ?? -1)
  ));
  const affectedQrIds = [...new Set(findings.map((item) => item.qr_id))].sort();
  const evidenceDependencyQrIds = [...new Set(
    findings
      .filter((item) => item.evidence_dependency.present)
      .map((item) => item.qr_id)
  )].sort();
  const archiveDependencyQrIds = [...new Set(
    findings
      .filter((item) => item.evidence_dependency.archive_present)
      .map((item) => item.qr_id)
  )].sort();
  return Object.freeze({
    schema_version: 2,
    mode: 'dry-run',
    status: findings.length > 0 ? 'FINDINGS_CONFIRMED' : 'CLEAN',
    read_only: true,
    postgres_connected: false,
    source_sha256: sourceHash,
    policy: CONTENT_PRIVACY_POLICY,
    scanned_counts: {
      identities: identities.length,
      records: plan.records.length,
      co_creation_comments: plan.co_creation_comments.length
    },
    finding_count: findings.length,
    record_finding_count: findings.filter((item) => item.collection === 'records').length,
    comment_finding_count: findings.filter(
      (item) => item.collection === 'co_creation_comments'
    ).length,
    affected_qr_ids: affectedQrIds,
    evidence_dependency_count: evidenceDependencyQrIds.length,
    evidence_dependency_qr_ids: evidenceDependencyQrIds,
    archive_dependency_count: archiveDependencyQrIds.length,
    archive_dependency_qr_ids: archiveDependencyQrIds,
    findings,
    raw_identity_values_persisted: false,
    raw_business_content_persisted: false,
    production_database_access: 'NONE',
    production_database_write: 'NONE'
  });
}

function auditFile({ inputPath, expectedSha256 }) {
  const resolved = resolveAuditInput(inputPath);
  const before = fs.statSync(resolved, { bigint: true });
  const bytes = fs.readFileSync(resolved);
  const sourceHash = sha256(bytes);
  if (sourceHash !== expectedSha256) {
    throw auditError(
      'CONTENT_PRIVACY_AUDIT_SOURCE_HASH_MISMATCH',
      'The source SHA-256 does not match the approved value.'
    );
  }

  let source;
  try {
    source = JSON.parse(decodeUtf8(bytes));
  } catch (error) {
    if (error && error.code) throw error;
    throw auditError('CONTENT_PRIVACY_AUDIT_INVALID_JSON', 'The input must be valid JSON.');
  }
  const report = analyzeSource(source, sourceHash);
  const after = fs.statSync(resolved, { bigint: true });
  const afterHash = sha256(fs.readFileSync(resolved));
  if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || afterHash !== sourceHash) {
    throw auditError(
      'CONTENT_PRIVACY_AUDIT_SOURCE_CHANGED',
      'The source changed while the read-only audit was running.'
    );
  }
  return report;
}

function main(argv = process.argv.slice(2), io = process) {
  try {
    const options = parseArguments(argv);
    const report = auditFile(options);
    io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${JSON.stringify({
      status: 'BLOCKED',
      code: error && error.code ? error.code : 'CONTENT_PRIVACY_AUDIT_FAILED'
    })}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  DEFAULT_JSON_DATABASE,
  analyzeSource,
  auditFile,
  main,
  parseArguments,
  proofDependency,
  resolveAuditInput,
  sha256
};
