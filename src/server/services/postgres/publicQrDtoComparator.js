'use strict';

const DEFAULT_MISMATCH_LIMIT = 100;

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function comparePublicQrDtos({
  baseline,
  candidate,
  channel,
  mismatchLimit = DEFAULT_MISMATCH_LIMIT
} = {}) {
  const safeLimit = Number.isSafeInteger(mismatchLimit) && mismatchLimit > 0
    ? Math.min(mismatchLimit, 1000)
    : DEFAULT_MISMATCH_LIMIT;
  const mismatches = [];
  let totalMismatchCount = 0;

  function addMismatch(path, kind, left, right, counts = {}) {
    totalMismatchCount += 1;
    if (mismatches.length >= safeLimit) return;
    mismatches.push({
      path,
      kind,
      baseline_type: valueType(left),
      candidate_type: valueType(right),
      ...counts
    });
  }

  function compare(left, right, currentPath) {
    const leftType = valueType(left);
    const rightType = valueType(right);
    if (leftType !== rightType) {
      addMismatch(currentPath, 'type_mismatch', left, right);
      return;
    }
    if (leftType === 'array') {
      if (left.length !== right.length) {
        addMismatch(currentPath, 'array_length_mismatch', left, right, {
          baseline_count: left.length,
          candidate_count: right.length
        });
      }
      const commonLength = Math.min(left.length, right.length);
      for (let index = 0; index < commonLength; index += 1) {
        compare(left[index], right[index], `${currentPath}[${index}]`);
      }
      return;
    }
    if (leftType === 'object') {
      const leftKeys = Object.keys(left).sort();
      const rightKeys = Object.keys(right).sort();
      for (const key of leftKeys) {
        const path = currentPath ? `${currentPath}.${key}` : key;
        if (!Object.prototype.hasOwnProperty.call(right, key)) {
          addMismatch(path, 'missing_candidate_field', left[key], undefined);
        } else {
          compare(left[key], right[key], path);
        }
      }
      for (const key of rightKeys) {
        if (Object.prototype.hasOwnProperty.call(left, key)) continue;
        const path = currentPath ? `${currentPath}.${key}` : key;
        addMismatch(path, 'unexpected_candidate_field', undefined, right[key]);
      }
      return;
    }
    if (!Object.is(left, right)) {
      addMismatch(currentPath, 'value_mismatch', left, right);
    }
  }

  compare(baseline, candidate, '$');
  return {
    channel: channel === 'miniapp' ? 'miniapp' : 'h5',
    matches: totalMismatchCount === 0,
    mismatch_count: totalMismatchCount,
    truncated: totalMismatchCount > mismatches.length,
    mismatches
  };
}

module.exports = {
  DEFAULT_MISMATCH_LIMIT,
  comparePublicQrDtos
};
