'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RUN_ID_PATTERN = /^\d{8}T\d{6}Z-[a-f0-9]{8}$/;
const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

class ScheduleStateError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ScheduleStateError';
    this.code = code;
  }
}

function assertScalar(value, pattern, code) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new ScheduleStateError(code);
  }
  return value;
}

function validateState(input) {
  const status = assertScalar(input.status, /^(?:PASS|FAIL)$/, 'STATUS_INVALID');
  const exitCode = Number(input.exitCode);
  if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
    throw new ScheduleStateError('EXIT_CODE_INVALID');
  }
  if ((status === 'PASS') !== (exitCode === 0)) {
    throw new ScheduleStateError('STATUS_EXIT_CODE_MISMATCH');
  }

  const runId = input.runId === 'ABSENT'
    ? 'ABSENT'
    : assertScalar(input.runId, RUN_ID_PATTERN, 'RUN_ID_INVALID');
  if (status === 'PASS' && runId === 'ABSENT') {
    throw new ScheduleStateError('SUCCESS_RUN_ID_MISSING');
  }

  const logPath = String(input.logPath || '');
  if (!path.isAbsolute(logPath) || /[\r\n=]/.test(logPath)) {
    throw new ScheduleStateError('LOG_PATH_INVALID');
  }

  return {
    startedAt: assertScalar(input.startedAt, UTC_PATTERN, 'STARTED_AT_INVALID'),
    finishedAt: assertScalar(input.finishedAt, UTC_PATTERN, 'FINISHED_AT_INVALID'),
    status,
    exitCode,
    runId,
    logPath
  };
}

function serializeState(input) {
  const state = validateState(input);
  return [
    `ATTEMPT_STARTED_AT_UTC=${state.startedAt}`,
    `ATTEMPT_FINISHED_AT_UTC=${state.finishedAt}`,
    `STATUS=${state.status}`,
    `EXIT_CODE=${state.exitCode}`,
    `RUN_ID=${state.runId}`,
    `LOG_PATH=${state.logPath}`,
    ''
  ].join('\n');
}

function assertPrivateStateDirectory(stateDir) {
  if (!path.isAbsolute(stateDir)) {
    throw new ScheduleStateError('STATE_DIRECTORY_INVALID');
  }
  const stat = fs.lstatSync(stateDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ScheduleStateError('STATE_DIRECTORY_INVALID');
  }
  if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700) {
    throw new ScheduleStateError('STATE_DIRECTORY_MODE_INVALID');
  }
}

function writeAtomic(filePath, content) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );
  let descriptor;
  try {
    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      0o600
    );
    fs.writeFileSync(descriptor, content, { encoding: 'utf8' });
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.chmodSync(temporaryPath, 0o600);
    fs.renameSync(temporaryPath, filePath);
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch (_closeError) {}
    }
    try { fs.unlinkSync(temporaryPath); } catch (_unlinkError) {}
    throw error;
  }
}

function updateScheduleState({ stateDir, ...input }) {
  assertPrivateStateDirectory(stateDir);
  const content = serializeState(input);
  writeAtomic(path.join(stateDir, 'last-attempt.env'), content);
  writeAtomic(
    path.join(stateDir, input.status === 'PASS' ? 'last-success.env' : 'last-failure.env'),
    content
  );
}

function parseArguments(argv) {
  const values = {};
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(argument);
    if (!match || Object.hasOwn(values, match[1])) {
      throw new ScheduleStateError('ARGUMENT_INVALID');
    }
    values[match[1]] = match[2];
  }
  const expected = [
    'state-dir', 'started-at', 'finished-at', 'status',
    'exit-code', 'run-id', 'log-path'
  ];
  if (Object.keys(values).length !== expected.length
      || expected.some(key => !Object.hasOwn(values, key))) {
    throw new ScheduleStateError('ARGUMENT_INVALID');
  }
  return {
    stateDir: values['state-dir'],
    startedAt: values['started-at'],
    finishedAt: values['finished-at'],
    status: values.status,
    exitCode: values['exit-code'],
    runId: values['run-id'],
    logPath: values['log-path']
  };
}

if (require.main === module) {
  try {
    updateScheduleState(parseArguments(process.argv.slice(2)));
  } catch (_error) {
    process.stderr.write('SCHEDULE_STATE_UPDATE=FAIL\nERROR_CODE=SCHEDULE_STATE_UPDATE_FAILED\n');
    process.exitCode = 70;
  }
}

module.exports = {
  RUN_ID_PATTERN,
  ScheduleStateError,
  serializeState,
  updateScheduleState,
  validateState,
  writeAtomic
};
