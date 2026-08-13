'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ScheduleStateError,
  serializeState,
  updateScheduleState
} = require('../scripts/database/production-backup-schedule-state');

function makeStateDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-schedule-state-'));
  fs.chmodSync(directory, 0o700);
  return directory;
}

function state(overrides = {}) {
  return {
    startedAt: '2026-08-13T13:00:00Z',
    finishedAt: '2026-08-13T13:00:08Z',
    status: 'PASS',
    exitCode: 0,
    runId: '20260813T130000Z-a1b2c3d4',
    logPath: path.resolve('/var/log/xingxingzaishan-production-backup/run.log'),
    ...overrides
  };
}

test('scheduled backup state is value-bounded and env-safe', () => {
  const content = serializeState(state());
  assert.equal(content, [
    'ATTEMPT_STARTED_AT_UTC=2026-08-13T13:00:00Z',
    'ATTEMPT_FINISHED_AT_UTC=2026-08-13T13:00:08Z',
    'STATUS=PASS',
    'EXIT_CODE=0',
    'RUN_ID=20260813T130000Z-a1b2c3d4',
    `LOG_PATH=${path.resolve('/var/log/xingxingzaishan-production-backup/run.log')}`,
    ''
  ].join('\n'));
  assert.throws(
    () => serializeState(state({ runId: 'bad\nOSS_ACCESS_KEY_SECRET=value' })),
    error => error instanceof ScheduleStateError && error.code === 'RUN_ID_INVALID'
  );
  assert.throws(
    () => serializeState(state({ status: 'PASS', exitCode: 1 })),
    error => error instanceof ScheduleStateError && error.code === 'STATUS_EXIT_CODE_MISMATCH'
  );
});

test('scheduled backup state atomically updates attempt and success', () => {
  const stateDir = makeStateDirectory();
  updateScheduleState({ stateDir, ...state() });

  const attempt = fs.readFileSync(path.join(stateDir, 'last-attempt.env'), 'utf8');
  const success = fs.readFileSync(path.join(stateDir, 'last-success.env'), 'utf8');
  assert.equal(attempt, success);
  assert.match(attempt, /^STATUS=PASS$/m);
  assert.equal(fs.existsSync(path.join(stateDir, 'last-failure.env')), false);
  assert.deepEqual(
    fs.readdirSync(stateDir).sort(),
    ['last-attempt.env', 'last-success.env']
  );
});

test('a later success preserves last failure while advancing last attempt', () => {
  const stateDir = makeStateDirectory();
  updateScheduleState({
    stateDir,
    ...state({ status: 'FAIL', exitCode: 23, runId: 'ABSENT' })
  });
  const failure = fs.readFileSync(path.join(stateDir, 'last-failure.env'), 'utf8');

  updateScheduleState({
    stateDir,
    ...state({
      startedAt: '2026-08-13T14:00:00Z',
      finishedAt: '2026-08-13T14:00:09Z',
      runId: '20260813T140000Z-b1c2d3e4'
    })
  });

  assert.equal(
    fs.readFileSync(path.join(stateDir, 'last-failure.env'), 'utf8'),
    failure
  );
  assert.match(
    fs.readFileSync(path.join(stateDir, 'last-attempt.env'), 'utf8'),
    /^RUN_ID=20260813T140000Z-b1c2d3e4$/m
  );
});

test('a later failure preserves last success while advancing failure state', () => {
  const stateDir = makeStateDirectory();
  updateScheduleState({ stateDir, ...state() });
  const success = fs.readFileSync(path.join(stateDir, 'last-success.env'), 'utf8');

  updateScheduleState({
    stateDir,
    ...state({
      startedAt: '2026-08-13T15:00:00Z',
      finishedAt: '2026-08-13T15:00:03Z',
      status: 'FAIL',
      exitCode: 75,
      runId: 'ABSENT'
    })
  });

  assert.equal(
    fs.readFileSync(path.join(stateDir, 'last-success.env'), 'utf8'),
    success
  );
  const attempt = fs.readFileSync(path.join(stateDir, 'last-attempt.env'), 'utf8');
  const failure = fs.readFileSync(path.join(stateDir, 'last-failure.env'), 'utf8');
  assert.equal(attempt, failure);
  assert.match(failure, /^STATUS=FAIL$/m);
  assert.match(failure, /^EXIT_CODE=75$/m);
});

test('invalid state directories and absent success run IDs fail closed', () => {
  const stateDir = makeStateDirectory();
  assert.throws(
    () => updateScheduleState({ stateDir: path.join(stateDir, 'missing'), ...state() }),
    /ENOENT/
  );
  assert.throws(
    () => serializeState(state({ runId: 'ABSENT' })),
    error => error instanceof ScheduleStateError
      && error.code === 'SUCCESS_RUN_ID_MISSING'
  );
});
