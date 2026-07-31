#!/usr/bin/env node
'use strict';

const { runDryRun } = require('./importer');
const { serializeReport } = require('./importer/report');

function cliError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseArguments(argv) {
  const result = { inputPath: '', expectedSha256: '', dryRun: false, format: 'json' };
  argv.forEach((argument) => {
    if (argument === '--dry-run') result.dryRun = true;
    else if (argument.startsWith('--input=')) result.inputPath = argument.slice('--input='.length);
    else if (argument.startsWith('--expected-source-sha256=')) {
      result.expectedSha256 = argument.slice('--expected-source-sha256='.length);
    } else if (argument.startsWith('--format=')) result.format = argument.slice('--format='.length);
    else throw cliError('IMPORT_UNKNOWN_ARGUMENT', 'Unknown importer argument.');
  });
  if (!result.dryRun) throw cliError('IMPORT_DRY_RUN_REQUIRED', 'The importer only supports explicit --dry-run mode.');
  if (!result.inputPath) throw cliError('IMPORT_INPUT_REQUIRED', 'An explicit --input path is required.');
  if (!result.expectedSha256) throw cliError('IMPORT_EXPECTED_SHA256_REQUIRED', 'An expected source SHA-256 is required.');
  if (!['json', 'markdown'].includes(result.format)) throw cliError('IMPORT_FORMAT_INVALID', 'Format must be json or markdown.');
  return result;
}

function main(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }) {
  try {
    const options = parseArguments(argv);
    const { report } = runDryRun(options);
    io.stdout.write(serializeReport(report, options.format));
    return report.can_import ? 0 : 2;
  } catch (error) {
    io.stderr.write(`${JSON.stringify({ code: error.code || 'IMPORT_FAILED', message: 'Importer dry-run failed.' })}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  main,
  parseArguments
};
