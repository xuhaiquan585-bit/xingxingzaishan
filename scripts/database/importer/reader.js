'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const DEFAULT_JSON_DATABASE = path.resolve(__dirname, '..', '..', '..', 'src', 'server', 'data', 'db.json');

function importerInputError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function assertExpectedHash(value) {
  const expected = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw importerInputError('IMPORT_EXPECTED_SHA256_REQUIRED', 'A valid expected source SHA-256 is required.');
  }
  return expected;
}

function resolveExplicitInput(inputPath) {
  if (!inputPath || !String(inputPath).trim()) {
    throw importerInputError('IMPORT_INPUT_REQUIRED', 'An explicit importer input path is required.');
  }

  const resolved = path.resolve(String(inputPath));
  if (!fs.existsSync(resolved)) {
    throw importerInputError('IMPORT_INPUT_NOT_FOUND', 'The importer input file does not exist.');
  }

  const inputRealPath = fs.realpathSync(resolved);
  const defaultRealPath = fs.existsSync(DEFAULT_JSON_DATABASE)
    ? fs.realpathSync(DEFAULT_JSON_DATABASE)
    : DEFAULT_JSON_DATABASE;
  if (path.normalize(inputRealPath) === path.normalize(defaultRealPath)) {
    throw importerInputError('IMPORT_LIVE_DATABASE_FORBIDDEN', 'The runtime JSON database cannot be used as importer input.');
  }

  return inputRealPath;
}

function decodeUtf8(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (_error) {
    throw importerInputError('IMPORT_INVALID_UTF8', 'The importer input must be valid UTF-8.');
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readSourceSnapshot({ inputPath, expectedSha256 }) {
  const sourcePath = resolveExplicitInput(inputPath);
  const expected = assertExpectedHash(expectedSha256);
  const before = fs.statSync(sourcePath, { bigint: true });
  if (!before.isFile()) {
    throw importerInputError('IMPORT_INPUT_NOT_FILE', 'The importer input must be a regular file.');
  }

  const bytes = fs.readFileSync(sourcePath);
  const sourceHash = sha256(bytes);
  if (sourceHash !== expected) {
    throw importerInputError('IMPORT_SOURCE_HASH_MISMATCH', 'The importer input SHA-256 does not match the expected value.');
  }

  let data;
  try {
    data = JSON.parse(decodeUtf8(bytes));
  } catch (error) {
    if (error && error.code === 'IMPORT_INVALID_UTF8') throw error;
    throw importerInputError('IMPORT_INVALID_JSON', 'The importer input is not valid JSON.');
  }

  return {
    data,
    sourcePath,
    sourceHash,
    sourceSize: Number(before.size),
    sourceMtimeNs: before.mtimeNs.toString()
  };
}

function assertSourceUnchanged(snapshot) {
  const stat = fs.statSync(snapshot.sourcePath, { bigint: true });
  const currentHash = sha256(fs.readFileSync(snapshot.sourcePath));
  if (
    currentHash !== snapshot.sourceHash
    || Number(stat.size) !== snapshot.sourceSize
    || stat.mtimeNs.toString() !== snapshot.sourceMtimeNs
  ) {
    throw importerInputError('IMPORT_SOURCE_CHANGED', 'The importer input changed during dry-run.');
  }
}

module.exports = {
  DEFAULT_JSON_DATABASE,
  assertSourceUnchanged,
  readSourceSnapshot,
  sha256
};
