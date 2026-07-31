'use strict';

const { mapSourceToPlan } = require('./mapping');
const { buildReport } = require('./report');
const { assertSourceUnchanged, readSourceSnapshot } = require('./reader');
const { validateImportSource } = require('./validator');

function analyzeSourceSnapshot(snapshot) {
  const source = snapshot.data;
  const { plan, qrSplits } = mapSourceToPlan(
    source && typeof source === 'object' && !Array.isArray(source) ? source : {}
  );
  const { anomalies, conservation } = validateImportSource(source, { plan, qrSplits });
  const report = buildReport({ snapshot, source, plan, anomalies, conservation });
  return { report, plan };
}

function runDryRun({ inputPath, expectedSha256 }) {
  const snapshot = readSourceSnapshot({ inputPath, expectedSha256 });
  const result = analyzeSourceSnapshot(snapshot);
  assertSourceUnchanged(snapshot);
  return result;
}

module.exports = {
  analyzeSourceSnapshot,
  runDryRun
};
