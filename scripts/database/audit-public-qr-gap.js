#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const DEFAULT_JSON_DATABASE = path.resolve(
  __dirname,
  '..',
  '..',
  'src',
  'server',
  'data',
  'db.json'
);

const ROOT_FIELDS = new Set(['qr_codes']);
const QR_FIELDS = new Set([
  'activation_status',
  'show_brand_disclosure',
  'co_creation_enabled',
  'co_creation_comments'
]);
const COMMENT_FIELDS = new Set([
  'id',
  'created_at',
  'status',
  'source_position'
]);
const FORBIDDEN_FIELDS = new Set([
  'phone',
  'openid',
  'unionid',
  'account_id',
  'co_creation_owner_account_id',
  'content',
  'author_name',
  'image_url',
  'image_object_key',
  'address',
  'recipient_name',
  'recipient_phone',
  'token',
  'access_token',
  'qr_access_token',
  'payment_payload'
]);
const VALID_LIFECYCLES = new Set(['unactivated', 'co_creating', 'activated']);

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
  const options = {
    inputPath: '',
    expectedSha256: '',
    dryRun: false
  };

  argv.forEach((argument) => {
    if (argument === '--dry-run') {
      options.dryRun = true;
    } else if (argument.startsWith('--input=')) {
      options.inputPath = argument.slice('--input='.length);
    } else if (argument.startsWith('--expected-source-sha256=')) {
      options.expectedSha256 = argument.slice('--expected-source-sha256='.length);
    } else {
      throw auditError('PUBLIC_QR_AUDIT_UNKNOWN_ARGUMENT', 'Unknown audit argument.');
    }
  });

  if (!options.dryRun) {
    throw auditError('PUBLIC_QR_AUDIT_DRY_RUN_REQUIRED', 'Explicit --dry-run mode is required.');
  }
  if (!options.inputPath) {
    throw auditError('PUBLIC_QR_AUDIT_INPUT_REQUIRED', 'An explicit audit input is required.');
  }
  if (!path.isAbsolute(options.inputPath)) {
    throw auditError('PUBLIC_QR_AUDIT_ABSOLUTE_INPUT_REQUIRED', 'The audit input path must be absolute.');
  }

  const expected = String(options.expectedSha256 || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw auditError(
      'PUBLIC_QR_AUDIT_EXPECTED_SHA256_REQUIRED',
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
      'PUBLIC_QR_AUDIT_RUNTIME_DATABASE_FORBIDDEN',
      'The runtime JSON database cannot be audited directly.'
    );
  }
  if (!fs.existsSync(resolved)) {
    throw auditError('PUBLIC_QR_AUDIT_INPUT_NOT_FOUND', 'The audit input does not exist.');
  }

  const linkStat = fs.lstatSync(resolved);
  if (linkStat.isSymbolicLink()) {
    throw auditError('PUBLIC_QR_AUDIT_SYMLINK_FORBIDDEN', 'A symbolic-link input is not allowed.');
  }
  if (!linkStat.isFile()) {
    throw auditError('PUBLIC_QR_AUDIT_INPUT_NOT_FILE', 'The audit input must be a regular file.');
  }

  const realPath = fs.realpathSync(resolved);
  if (samePath(realPath, DEFAULT_JSON_DATABASE)) {
    throw auditError(
      'PUBLIC_QR_AUDIT_RUNTIME_DATABASE_FORBIDDEN',
      'The runtime JSON database cannot be audited directly.'
    );
  }
  return realPath;
}

function decodeUtf8(bytes) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch (_error) {
    throw auditError('PUBLIC_QR_AUDIT_INVALID_UTF8', 'The audit input must be valid UTF-8.');
  }
}

function findForbiddenField(value) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findForbiddenField(item);
      if (found) return found;
    }
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_FIELDS.has(key)) return key;
    const found = findForbiddenField(child);
    if (found) return found;
  }
  return null;
}

function assertAllowedFields(value, allowedFields, code) {
  const unknown = Object.keys(value).find((field) => !allowedFields.has(field));
  if (unknown) {
    throw auditError(code, 'The audit input contains a field outside the structural allowlist.');
  }
}

function validateAuditSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw auditError('PUBLIC_QR_AUDIT_ROOT_INVALID', 'The audit input root must be an object.');
  }

  const forbidden = findForbiddenField(source);
  if (forbidden) {
    throw auditError(
      'PUBLIC_QR_AUDIT_SENSITIVE_FIELD_FORBIDDEN',
      'The audit input contains a forbidden sensitive field.'
    );
  }

  assertAllowedFields(source, ROOT_FIELDS, 'PUBLIC_QR_AUDIT_ROOT_FIELD_INVALID');
  if (!Array.isArray(source.qr_codes)) {
    throw auditError('PUBLIC_QR_AUDIT_QR_CODES_REQUIRED', 'qr_codes must be an array.');
  }

  source.qr_codes.forEach((qr) => {
    if (!qr || typeof qr !== 'object' || Array.isArray(qr)) {
      throw auditError('PUBLIC_QR_AUDIT_QR_INVALID', 'Each QR audit row must be an object.');
    }
    assertAllowedFields(qr, QR_FIELDS, 'PUBLIC_QR_AUDIT_QR_FIELD_INVALID');
    if (!VALID_LIFECYCLES.has(qr.activation_status)) {
      throw auditError(
        'PUBLIC_QR_AUDIT_LIFECYCLE_INVALID',
        'Each QR audit row requires a supported activation_status.'
      );
    }
    if (
      Object.prototype.hasOwnProperty.call(qr, 'co_creation_comments')
      && !Array.isArray(qr.co_creation_comments)
    ) {
      throw auditError(
        'PUBLIC_QR_AUDIT_COMMENTS_INVALID',
        'co_creation_comments must be an array when present.'
      );
    }

    (qr.co_creation_comments || []).forEach((comment) => {
      if (!comment || typeof comment !== 'object' || Array.isArray(comment)) {
        throw auditError(
          'PUBLIC_QR_AUDIT_COMMENT_INVALID',
          'Each comment audit row must be an object.'
        );
      }
      assertAllowedFields(comment, COMMENT_FIELDS, 'PUBLIC_QR_AUDIT_COMMENT_FIELD_INVALID');
    });
  });
}

function numericId(value) {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) return null;
    return {
      value: BigInt(value),
      safe: Number.isSafeInteger(value)
    };
  }
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    const parsed = BigInt(value);
    return {
      value: parsed,
      safe: parsed <= BigInt(Number.MAX_SAFE_INTEGER)
    };
  }
  return null;
}

function strictlyIncreasing(values) {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] <= values[index - 1]) return false;
  }
  return true;
}

function analyzeDisclosure(qrCodes) {
  const result = {
    total_qr_codes: qrCodes.length,
    field_present_count: 0,
    true_count: 0,
    false_count: 0,
    missing_count: 0,
    invalid_type_count: 0,
    unactivated_total: 0,
    unactivated_true_count: 0,
    unactivated_false_count: 0,
    unactivated_missing_count: 0,
    unactivated_invalid_type_count: 0
  };

  qrCodes.forEach((qr) => {
    const present = Object.prototype.hasOwnProperty.call(qr, 'show_brand_disclosure');
    const value = qr.show_brand_disclosure;
    const unactivated = qr.activation_status === 'unactivated';
    if (unactivated) result.unactivated_total += 1;

    if (!present) {
      result.missing_count += 1;
      if (unactivated) result.unactivated_missing_count += 1;
      return;
    }

    result.field_present_count += 1;
    if (value === true) {
      result.true_count += 1;
      if (unactivated) result.unactivated_true_count += 1;
    } else if (value === false) {
      result.false_count += 1;
      if (unactivated) result.unactivated_false_count += 1;
    } else {
      result.invalid_type_count += 1;
      if (unactivated) result.unactivated_invalid_type_count += 1;
    }
  });

  return result;
}

function analyzeCommentOrdering(qrCodes) {
  const result = {
    co_creation_count: 0,
    comment_sets_with_comments: 0,
    total_comments: 0,
    effective_comments: 0,
    deleted_comments: 0,
    invalid_status_count: 0,
    invalid_timestamp_count: 0,
    parsed_timestamp_group_count: 0,
    same_timestamp_groups: 0,
    affected_comments: 0,
    missing_id_count: 0,
    duplicate_id_count: 0,
    non_numeric_id_count: 0,
    non_safe_integer_id_count: 0,
    comment_sets_with_monotonic_numeric_ids: 0,
    missing_source_position_count: 0,
    invalid_source_position_count: 0,
    duplicate_source_position_count: 0,
    comment_sets_with_stable_source_position: 0,
    same_timestamp_groups_with_stable_source_position: 0,
    same_timestamp_groups_with_numeric_id_order: 0,
    same_timestamp_groups_without_stable_position: 0
  };

  qrCodes.forEach((qr) => {
    const commentsPresent = Object.prototype.hasOwnProperty.call(qr, 'co_creation_comments');
    const comments = qr.co_creation_comments || [];
    if (qr.co_creation_enabled === true || commentsPresent) result.co_creation_count += 1;
    if (comments.length > 0) result.comment_sets_with_comments += 1;

    const seenIds = new Set();
    const seenPositions = new Set();
    const numericIds = [];
    const positions = [];
    let allIdsNumeric = comments.length > 0;
    let allPositionsValid = comments.length > 0;
    const effective = [];

    comments.forEach((comment, sourceIndex) => {
      result.total_comments += 1;
      const hasId = Object.prototype.hasOwnProperty.call(comment, 'id')
        && comment.id !== null
        && comment.id !== '';
      if (!hasId) {
        result.missing_id_count += 1;
        allIdsNumeric = false;
      } else {
        const idKey = String(comment.id);
        if (seenIds.has(idKey)) result.duplicate_id_count += 1;
        seenIds.add(idKey);
        const parsedId = numericId(comment.id);
        if (!parsedId) {
          result.non_numeric_id_count += 1;
          allIdsNumeric = false;
        } else {
          numericIds.push(parsedId.value);
          if (!parsedId.safe) result.non_safe_integer_id_count += 1;
        }
      }

      const position = comment.source_position;
      if (!Object.prototype.hasOwnProperty.call(comment, 'source_position')) {
        result.missing_source_position_count += 1;
        allPositionsValid = false;
      } else if (!Number.isSafeInteger(position) || position < 0) {
        result.invalid_source_position_count += 1;
        allPositionsValid = false;
      } else {
        if (seenPositions.has(position)) {
          result.duplicate_source_position_count += 1;
          allPositionsValid = false;
        }
        seenPositions.add(position);
        positions.push(position);
      }

      const status = Object.prototype.hasOwnProperty.call(comment, 'status')
        ? comment.status
        : 'kept';
      if (typeof status !== 'string') result.invalid_status_count += 1;
      if (status === 'deleted') {
        result.deleted_comments += 1;
        return;
      }

      result.effective_comments += 1;
      const timestamp = typeof comment.created_at === 'string'
        ? Date.parse(comment.created_at)
        : Number.NaN;
      if (!Number.isFinite(timestamp)) {
        result.invalid_timestamp_count += 1;
        return;
      }
      effective.push({
        sourceIndex,
        timestamp,
        numericId: numericId(comment.id),
        sourcePosition: position
      });
    });

    if (
      allIdsNumeric
      && numericIds.length === comments.length
      && seenIds.size === comments.length
      && strictlyIncreasing(numericIds)
    ) {
      result.comment_sets_with_monotonic_numeric_ids += 1;
    }
    if (
      allPositionsValid
      && positions.length === comments.length
      && strictlyIncreasing(positions)
    ) {
      result.comment_sets_with_stable_source_position += 1;
    }

    const groups = new Map();
    effective.forEach((comment) => {
      const group = groups.get(comment.timestamp) || [];
      group.push(comment);
      groups.set(comment.timestamp, group);
    });
    result.parsed_timestamp_group_count += groups.size;

    groups.forEach((group) => {
      if (group.length < 2) return;
      result.same_timestamp_groups += 1;
      result.affected_comments += group.length;

      const groupPositions = group.map((comment) => comment.sourcePosition);
      const hasStablePosition = groupPositions.every((position) => (
        Number.isSafeInteger(position) && position >= 0
      )) && new Set(groupPositions).size === group.length && strictlyIncreasing(groupPositions);

      const groupIds = group.map((comment) => comment.numericId);
      const hasNumericIdOrder = groupIds.every(Boolean)
        && strictlyIncreasing(groupIds.map((item) => item.value));

      if (hasStablePosition) {
        result.same_timestamp_groups_with_stable_source_position += 1;
      } else {
        result.same_timestamp_groups_without_stable_position += 1;
      }
      if (hasNumericIdOrder) {
        result.same_timestamp_groups_with_numeric_id_order += 1;
      }
    });
  });

  return result;
}

function disclosureClassification(disclosure) {
  if (disclosure.unactivated_invalid_type_count > 0) return 'INVALID_VALUES_FOUND';
  if (disclosure.unactivated_true_count > 0) return 'HISTORICAL_TRUE_FOUND';
  return 'NO_HISTORICAL_TRUE_FOUND';
}

function commentOrderClassification(commentOrdering) {
  if (commentOrdering.invalid_timestamp_count > 0) return 'INVALID_TIMESTAMPS_FOUND';
  if (commentOrdering.same_timestamp_groups === 0) return 'NO_EQUAL_TIMESTAMPS_FOUND';
  if (
    commentOrdering.same_timestamp_groups_with_stable_source_position
    === commentOrdering.same_timestamp_groups
  ) {
    return 'EQUAL_TIMESTAMPS_WITH_STABLE_POSITION';
  }
  return 'EQUAL_TIMESTAMPS_WITHOUT_STABLE_POSITION';
}

function analyzeAuditSource(source) {
  validateAuditSource(source);
  const disclosure = analyzeDisclosure(source.qr_codes);
  const commentOrdering = analyzeCommentOrdering(source.qr_codes);
  return {
    phase: 'Phase 2C-2B-4',
    tool_status: 'COMPLETED',
    audit_input: 'AVAILABLE',
    audit_execution_status: 'COMPLETED',
    gap_1_data_evidence: disclosureClassification(disclosure),
    gap_2_data_evidence: commentOrderClassification(commentOrdering),
    shadow_read_design_ready: true,
    shadow_read_execution_ready: false,
    runtime_readiness: 'NOT_READY',
    show_brand_disclosure: disclosure,
    comment_ordering: commentOrdering
  };
}

function auditFile({ inputPath, expectedSha256 }) {
  const sourcePath = resolveAuditInput(inputPath);
  const before = fs.statSync(sourcePath, { bigint: true });
  const bytes = fs.readFileSync(sourcePath);
  const sourceHash = sha256(bytes);
  if (sourceHash !== expectedSha256) {
    throw auditError(
      'PUBLIC_QR_AUDIT_SOURCE_HASH_MISMATCH',
      'The audit input SHA-256 does not match the expected value.'
    );
  }

  let source;
  try {
    source = JSON.parse(decodeUtf8(bytes));
  } catch (error) {
    if (error && error.code === 'PUBLIC_QR_AUDIT_INVALID_UTF8') throw error;
    throw auditError('PUBLIC_QR_AUDIT_INVALID_JSON', 'The audit input is not valid JSON.');
  }

  const report = analyzeAuditSource(source);
  const after = fs.statSync(sourcePath, { bigint: true });
  const finalHash = sha256(fs.readFileSync(sourcePath));
  if (
    finalHash !== sourceHash
    || after.size !== before.size
    || after.mtimeNs !== before.mtimeNs
  ) {
    throw auditError(
      'PUBLIC_QR_AUDIT_SOURCE_CHANGED',
      'The audit input changed during analysis.'
    );
  }

  return {
    ...report,
    input_integrity: {
      input_path_hash_prefix: sha256(Buffer.from(sourcePath, 'utf8')).slice(0, 12),
      source_sha256: sourceHash,
      size_bytes: Number(before.size),
      sha256_unchanged: true,
      size_unchanged: true,
      mtime_ns_unchanged: true
    }
  };
}

function main(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }) {
  try {
    const options = parseArguments(argv);
    const report = auditFile(options);
    io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${JSON.stringify({
      code: error.code || 'PUBLIC_QR_AUDIT_FAILED',
      message: 'Public QR gap audit failed.'
    })}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  DEFAULT_JSON_DATABASE,
  analyzeAuditSource,
  auditFile,
  commentOrderClassification,
  disclosureClassification,
  main,
  parseArguments,
  sha256,
  validateAuditSource
};
