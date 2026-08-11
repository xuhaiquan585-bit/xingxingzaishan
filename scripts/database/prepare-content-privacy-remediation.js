#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { analyzeSource } = require('./audit-cross-account-phone-content');
const { mapSourceToPlan } = require('./importer/mapping');
const { publicQrDomainSha256 } = require('./importer/domain-markers');
const {
  assertSourceUnchanged,
  readSourceSnapshot
} = require('./importer/reader');
const {
  CONTENT_PRIVACY_POLICY,
  redactCrossAccountPhoneReferences
} = require('../../src/server/services/contentPrivacyService');

const EVIDENCE_FIELDS = Object.freeze({
  blockchain_hash: null,
  chain_status: 'not_started',
  chain_operation_id: null,
  chain_tx_hash: null,
  chain_block_height: null,
  chain_record_id: null,
  chain_certificate_url: null,
  chain_certificate_object_key: null,
  chain_certificate_object_url: null,
  chain_confirmed_at: null,
  chain_callback_received_at: null,
  chain_retry_count: 0,
  chain_last_error: '',
  manifest_object_key: null,
  manifest_hash: null,
  legacy_manifest_object_key: null,
  archive_index_object_key: null,
  archive_status: 'not_started',
  archive_last_error: '',
  archive_updated_at: null
});
const MAX_REDACTION_ROUNDS = 8;

function preparationError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeQrIds(value) {
  const ids = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (ids.length === 0
      || ids.some((id) => !/^[A-Za-z0-9_-]+$/.test(id))
      || new Set(ids).size !== ids.length) {
    throw preparationError(
      'CONTENT_PRIVACY_REMEDIATION_QR_IDS_INVALID',
      'Expected QR IDs must be unique canonical identifiers.'
    );
  }
  return ids.sort();
}

function normalizeTimestamp(value) {
  const date = new Date(String(value || ''));
  if (Number.isNaN(date.getTime())) {
    throw preparationError(
      'CONTENT_PRIVACY_REMEDIATION_TIMESTAMP_INVALID',
      'An explicit remediation timestamp is required.'
    );
  }
  return date.toISOString();
}

function parseArguments(argv) {
  const values = {};
  let prepare = false;
  for (const argument of argv) {
    if (argument === '--prepare') {
      prepare = true;
      continue;
    }
    const match = /^--([a-z0-9-]+)=(.*)$/i.exec(argument);
    if (!match || ![
      'input',
      'expected-source-sha256',
      'expected-qr-ids',
      'remediated-at',
      'candidate-output',
      'report-output'
    ].includes(match[1]) || Object.hasOwn(values, match[1])) {
      throw preparationError(
        'CONTENT_PRIVACY_REMEDIATION_ARGUMENT_INVALID',
        'Use the explicit privacy remediation preparation arguments.'
      );
    }
    values[match[1]] = match[2];
  }
  if (!prepare) {
    throw preparationError(
      'CONTENT_PRIVACY_REMEDIATION_PREPARE_REQUIRED',
      'Explicit --prepare mode is required.'
    );
  }
  const expectedSourceSha256 = String(
    values['expected-source-sha256'] || ''
  ).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedSourceSha256)) {
    throw preparationError(
      'CONTENT_PRIVACY_REMEDIATION_SOURCE_SHA256_INVALID',
      'A canonical expected source SHA-256 is required.'
    );
  }
  for (const key of ['input', 'candidate-output', 'report-output']) {
    if (!values[key] || !path.isAbsolute(values[key])) {
      throw preparationError(
        'CONTENT_PRIVACY_REMEDIATION_ABSOLUTE_PATH_REQUIRED',
        'Input and output paths must be absolute.'
      );
    }
  }
  return Object.freeze({
    inputPath: values.input,
    expectedSourceSha256,
    expectedQrIds: normalizeQrIds(values['expected-qr-ids']),
    remediatedAt: normalizeTimestamp(values['remediated-at']),
    candidateOutput: path.resolve(values['candidate-output']),
    reportOutput: path.resolve(values['report-output'])
  });
}

function assertOutputPath(outputPath, forbiddenPaths) {
  if (forbiddenPaths.some((item) => path.resolve(item) === outputPath)) {
    throw preparationError(
      'CONTENT_PRIVACY_REMEDIATION_OUTPUT_CONFLICT',
      'An output path conflicts with a protected input.'
    );
  }
  if (fs.existsSync(outputPath)) {
    throw preparationError(
      'CONTENT_PRIVACY_REMEDIATION_OUTPUT_EXISTS',
      'Remediation output files must not already exist.'
    );
  }
  const parent = path.dirname(outputPath);
  const stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw preparationError(
      'CONTENT_PRIVACY_REMEDIATION_OUTPUT_DIRECTORY_INVALID',
      'The output directory must be a real directory.'
    );
  }
}

function evidenceFingerprint(proof, archive) {
  return sha256(Buffer.from(JSON.stringify({ proof, archive }), 'utf8'));
}

function assertResidualFindingScope(audit, expectedQrIds) {
  const expected = new Set(expectedQrIds);
  const findings = Array.isArray(audit && audit.findings) ? audit.findings : [];
  const findingIds = findings.map((item) => String(item.qr_id || ''));
  const uniqueFindingIds = new Set(findingIds);
  const clean = audit && audit.status === 'CLEAN'
    && audit.finding_count === 0
    && findings.length === 0;

  if (clean) return;
  if (!audit
      || audit.status !== 'FINDINGS_CONFIRMED'
      || audit.finding_count !== findings.length
      || findings.length === 0
      || uniqueFindingIds.size !== findings.length
      || findingIds.some((id) => !expected.has(id))
      || findings.some((item) => item.collection !== 'records')) {
    throw preparationError(
      'CONTENT_PRIVACY_REMEDIATION_SCOPE_EXPANDED',
      'A residual finding escaped the approved record scope.'
    );
  }
}

function runBoundedRedactionRounds({
  initialAudit,
  expectedQrIds,
  applyRound,
  analyzeAfterRound,
  maxRounds = MAX_REDACTION_ROUNDS
}) {
  let audit = initialAudit;
  let roundCount = 0;

  while (audit.status !== 'CLEAN' && roundCount < maxRounds) {
    assertResidualFindingScope(audit, expectedQrIds);
    roundCount += 1;
    applyRound({ audit, round: roundCount });
    audit = analyzeAfterRound({ round: roundCount });
  }

  assertResidualFindingScope(audit, expectedQrIds);
  if (audit.status !== 'CLEAN' || audit.finding_count !== 0) {
    throw preparationError(
      'CONTENT_PRIVACY_REMEDIATION_NOT_CONVERGED',
      'The prepared candidate did not converge to a clean privacy state.'
    );
  }
  return Object.freeze({ afterAudit: audit, roundCount });
}

function prepareSource({ source, sourceHash, expectedQrIds, remediatedAt }) {
  const before = mapSourceToPlan(source).plan;
  const audit = analyzeSource(source, sourceHash);
  if (audit.status !== 'FINDINGS_CONFIRMED'
      || audit.finding_count !== expectedQrIds.length
      || JSON.stringify(audit.affected_qr_ids) !== JSON.stringify(expectedQrIds)
      || audit.findings.some((item) => item.collection !== 'records')) {
    throw preparationError(
      'CONTENT_PRIVACY_REMEDIATION_FINDING_SET_MISMATCH',
      'The source finding set does not exactly match the approved QR IDs.'
    );
  }

  const candidate = JSON.parse(JSON.stringify(source));
  const sourceRows = new Map(candidate.qr_codes.map((row) => [String(row.id), row]));
  const records = new Map(before.records.map((row) => [String(row.qr_id), row]));
  const proofs = new Map(before.record_proofs.map((row) => [String(row.record_qr_id), row]));
  const archives = new Map(before.record_archives.map((row) => [String(row.record_qr_id), row]));
  const approvedSourceRows = candidate.qr_codes.filter(
    (row) => expectedQrIds.includes(String(row.id))
  );
  if (approvedSourceRows.length !== expectedQrIds.length
      || sourceRows.size !== candidate.qr_codes.length) {
    throw preparationError(
      'CONTENT_PRIVACY_REMEDIATION_SOURCE_ROWS_INVALID',
      'Approved QR IDs must each resolve to one unique source row.'
    );
  }
  const revisions = new Map();

  for (const finding of audit.findings) {
    const row = sourceRows.get(finding.qr_id);
    const record = records.get(finding.qr_id);
    const proof = proofs.get(finding.qr_id) || null;
    const archive = archives.get(finding.qr_id) || null;
    if (!row || !record || !proof || proof.status !== 'confirmed') {
      throw preparationError(
        'CONTENT_PRIVACY_REMEDIATION_EVIDENCE_STATE_INVALID',
        'Every approved record must have one confirmed proof dependency.'
      );
    }
    Object.assign(row, EVIDENCE_FIELDS);
    revisions.set(finding.qr_id, {
      qr_id: finding.qr_id,
      previous_content_sha256: finding.content_sha256,
      previous_evidence_sha256: evidenceFingerprint(proof, archive),
      previous_proof_status: proof.status,
      previous_archive_status: archive ? archive.status : null,
      redaction_rounds: []
    });
  }

  const redactionResult = runBoundedRedactionRounds({
    initialAudit: audit,
    expectedQrIds,
    applyRound({ audit: roundAudit, round }) {
      const current = mapSourceToPlan(candidate).plan;
      const currentRecords = new Map(
        current.records.map((record) => [String(record.qr_id), record])
      );
      for (const finding of roundAudit.findings) {
        const row = sourceRows.get(finding.qr_id);
        const record = currentRecords.get(finding.qr_id);
        const revision = revisions.get(finding.qr_id);
        if (!row || !record || !revision
            || sha256(Buffer.from(record.content, 'utf8'))
              !== finding.content_sha256) {
          throw preparationError(
            'CONTENT_PRIVACY_REMEDIATION_REDACTION_DRIFT',
            'The approved source content changed during preparation.'
          );
        }
        const redaction = redactCrossAccountPhoneReferences({
          content: record.content,
          ownerAccountId: record.account_id,
          identities: current.users
        });
        const revisedContentSha256 = sha256(
          Buffer.from(redaction.content, 'utf8')
        );
        if (!redaction.has_reference
            || revisedContentSha256 !== finding.proposed_content_sha256
            || revisedContentSha256 === finding.content_sha256) {
          throw preparationError(
            'CONTENT_PRIVACY_REMEDIATION_REDACTION_DRIFT',
            'The deterministic redaction no longer matches the approved finding.'
          );
        }
        row.content = redaction.content;
        row.updated_at = remediatedAt;
        revision.redaction_rounds.push(Object.freeze({
          round,
          previous_content_sha256: finding.content_sha256,
          revised_content_sha256: revisedContentSha256,
          match_count: redaction.match_count,
          matched_identity_count: redaction.matched_identity_count
        }));
      }
    },
    analyzeAfterRound() {
      const candidateBytes = Buffer.from(JSON.stringify(candidate, null, 2), 'utf8');
      return analyzeSource(candidate, sha256(candidateBytes));
    }
  });

  const revisionReport = [...revisions.values()]
    .sort((left, right) => left.qr_id.localeCompare(right.qr_id))
    .map((revision) => {
      const rounds = revision.redaction_rounds;
      if (rounds.length === 0) {
        throw preparationError(
          'CONTENT_PRIVACY_REMEDIATION_REVISION_MISSING',
          'Every approved QR ID must have a completed redaction revision.'
        );
      }
      return Object.freeze({
        qr_id: revision.qr_id,
        previous_content_sha256: revision.previous_content_sha256,
        revised_content_sha256: rounds.at(-1).revised_content_sha256,
        previous_evidence_sha256: revision.previous_evidence_sha256,
        previous_proof_status: revision.previous_proof_status,
        previous_archive_status: revision.previous_archive_status,
        match_count: rounds.reduce((sum, item) => sum + item.match_count, 0),
        matched_identity_count: rounds.reduce(
          (sum, item) => sum + item.matched_identity_count,
          0
        ),
        redaction_round_count: rounds.length,
        redaction_rounds: Object.freeze([...rounds])
      });
    });

  const serialized = JSON.stringify(candidate, null, 2);
  const candidateSourceSha256 = sha256(Buffer.from(serialized, 'utf8'));
  const after = mapSourceToPlan(candidate).plan;
  const afterAudit = redactionResult.afterAudit;
  const sourceDomainSha256 = publicQrDomainSha256(before);
  const candidateDomainSha256 = publicQrDomainSha256(after);
  if (sourceDomainSha256 === candidateDomainSha256) {
    throw preparationError(
      'CONTENT_PRIVACY_REMEDIATION_DOMAIN_UNCHANGED',
      'The public QR domain marker must change after remediation.'
    );
  }

  return Object.freeze({
    serialized,
    report: Object.freeze({
      schema_version: 2,
      mode: 'prepare',
      status: 'READY',
      apply_performed: false,
      policy: CONTENT_PRIVACY_POLICY,
      strategy: 'PRELAUNCH_TEST_DATA_REDACT_AND_REPROOF',
      source_sha256: sourceHash,
      candidate_source_sha256: candidateSourceSha256,
      source_public_qr_domain_sha256: sourceDomainSha256,
      candidate_public_qr_domain_sha256: candidateDomainSha256,
      remediated_at: remediatedAt,
      affected_qr_ids: expectedQrIds,
      finding_count: audit.finding_count,
      evidence_dependency_count: audit.evidence_dependency_count,
      archive_dependency_count: audit.archive_dependency_count,
      proof_rows_removed_from_candidate:
        before.record_proofs.length - after.record_proofs.length,
      archive_rows_removed_from_candidate:
        before.record_archives.length - after.record_archives.length,
      record_count_before: before.records.length,
      record_count_after: after.records.length,
      redaction_round_count: redactionResult.roundCount,
      revisions: revisionReport,
      candidate_privacy_finding_count: afterAudit.finding_count,
      raw_identity_values_persisted_in_report: false,
      raw_business_content_persisted_in_report: false,
      production_database_access: 'NONE',
      production_database_write: 'NONE',
      production_json_write: 'NONE',
      oss_access: 'NONE',
      oss_write: 'NONE'
    })
  });
}

function writeExclusive(filePath, bytes) {
  const descriptor = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function prepareFiles(options) {
  const snapshot = readSourceSnapshot({
    inputPath: options.inputPath,
    expectedSha256: options.expectedSourceSha256
  });
  assertOutputPath(options.candidateOutput, [snapshot.sourcePath, options.reportOutput]);
  assertOutputPath(options.reportOutput, [snapshot.sourcePath, options.candidateOutput]);
  const prepared = prepareSource({
    source: snapshot.data,
    sourceHash: snapshot.sourceHash,
    expectedQrIds: options.expectedQrIds,
    remediatedAt: options.remediatedAt
  });
  assertSourceUnchanged(snapshot);
  let candidateWritten = false;
  try {
    writeExclusive(options.candidateOutput, prepared.serialized);
    candidateWritten = true;
    writeExclusive(
      options.reportOutput,
      `${JSON.stringify(prepared.report, null, 2)}\n`
    );
  } catch (error) {
    if (candidateWritten && !fs.existsSync(options.reportOutput)) {
      try {
        fs.unlinkSync(options.candidateOutput);
      } catch (_cleanupError) {
        // Preserve the preparation failure.
      }
    }
    throw error;
  }
  assertSourceUnchanged(snapshot);
  return prepared.report;
}

function main(argv = process.argv.slice(2), io = process) {
  try {
    const report = prepareFiles(parseArguments(argv));
    io.stdout.write(`${JSON.stringify({
      status: report.status,
      strategy: report.strategy,
      source_sha256: report.source_sha256,
      candidate_source_sha256: report.candidate_source_sha256,
      candidate_public_qr_domain_sha256:
        report.candidate_public_qr_domain_sha256,
      affected_qr_ids: report.affected_qr_ids,
      candidate_privacy_finding_count:
        report.candidate_privacy_finding_count,
      apply_performed: report.apply_performed
    }, null, 2)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${JSON.stringify({
      status: 'BLOCKED',
      code: error && error.code
        ? error.code
        : 'CONTENT_PRIVACY_REMEDIATION_PREPARATION_FAILED'
    })}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  EVIDENCE_FIELDS,
  MAX_REDACTION_ROUNDS,
  main,
  normalizeQrIds,
  parseArguments,
  prepareFiles,
  prepareSource,
  runBoundedRedactionRounds,
  sha256
};
