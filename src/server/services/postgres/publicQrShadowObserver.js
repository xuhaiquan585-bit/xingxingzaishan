'use strict';

const OBSERVER_VERSION = 'phase-2d-2a-v1';
const INFRASTRUCTURE_CODES = new Set([
  'CANDIDATE_TIMEOUT',
  'POSTGRES_CONNECTION_FAILED',
  'POSTGRES_QUERY_FAILED',
  'PUBLIC_QR_IMAGE_RESOLVER_REQUIRED',
  'PUBLIC_QR_CERTIFICATE_RESOLVER_REQUIRED',
  'PUBLIC_QR_SHADOW_SINK_QUEUE_FULL'
]);

function isInfrastructureError(code) {
  return code === 'CANDIDATE_ERROR'
    || code.startsWith('POSTGRES_')
    || INFRASTRUCTURE_CODES.has(code);
}

function cloneDto(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function latencyBucket(durationMs) {
  if (durationMs <= 25) return '0-25ms';
  if (durationMs <= 50) return '26-50ms';
  if (durationMs <= 100) return '51-100ms';
  if (durationMs <= 250) return '101-250ms';
  return 'over-250ms';
}

function errorCode(error) {
  return error && typeof error.code === 'string' ? error.code : 'CANDIDATE_ERROR';
}

function createPublicQrShadowObserver({
  getConfig,
  readCandidate,
  compareDtos,
  sink = null,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  observerVersion = OBSERVER_VERSION
} = {}) {
  if (typeof getConfig !== 'function') throw new Error('PUBLIC_QR_SHADOW_CONFIG_PROVIDER_REQUIRED');
  if (typeof readCandidate !== 'function') throw new Error('PUBLIC_QR_SHADOW_CANDIDATE_REQUIRED');
  if (typeof compareDtos !== 'function') throw new Error('PUBLIC_QR_SHADOW_COMPARATOR_REQUIRED');

  let active = 0;
  let openUntil = 0;
  let halfOpenInFlight = false;
  let failureTimes = [];
  let closed = false;
  let closePromise = null;
  let resolveClose = null;

  function recordInfrastructureFailure(at) {
    failureTimes = failureTimes.filter((value) => at - value < 60_000);
    failureTimes.push(at);
    if (failureTimes.length >= 5) {
      openUntil = at + 300_000;
      halfOpenInFlight = false;
    }
  }

  function enterCircuit(at) {
    if (openUntil === 0) return { allowed: true, probe: false };
    if (at < openUntil) return { allowed: false, probe: false };
    if (halfOpenInFlight) return { allowed: false, probe: false };
    halfOpenInFlight = true;
    return { allowed: true, probe: true };
  }

  function completeCircuit({ at, probe, failed }) {
    if (probe) {
      halfOpenInFlight = false;
      if (failed) {
        openUntil = at + 300_000;
      } else {
        openUntil = 0;
        failureTimes = [];
      }
      return;
    }
    if (failed) recordInfrastructureFailure(at);
  }

  async function runWithTimeout(factory, timeoutMs) {
    const controller = new AbortController();
    let timeoutId;
    const work = Promise.resolve().then(() => factory(controller.signal));
    work.catch(() => {});
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimer(() => {
        controller.abort();
        const error = new Error('CANDIDATE_TIMEOUT');
        error.code = 'CANDIDATE_TIMEOUT';
        reject(error);
      }, timeoutMs);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimer(timeoutId);
    }
  }

  function queueSinkRecord(record) {
    if (!sink || typeof sink.enqueue !== 'function') return true;
    let queued;
    try {
      queued = sink.enqueue(record);
    } catch (_error) {
      return false;
    }
    if (queued && queued.accepted === true && queued.completion) {
      Promise.resolve(queued.completion).then(
        (written) => {
          if (written !== true) recordInfrastructureFailure(now());
        },
        () => recordInfrastructureFailure(now())
      );
    }
    return Boolean(queued && queued.accepted === true);
  }

  function emitOutcome({ event, candidate = null, outcome, durationMs, mismatchCount }) {
    return queueSinkRecord({
      endpoint_template: event.endpointTemplate,
      channel: event.channel,
      lifecycle: (candidate && candidate.lifecycle)
        || (event.baselineDto && event.baselineDto.activation_status)
        || '',
      outcome,
      latency_bucket: latencyBucket(durationMs),
      observer_version: observerVersion,
      mismatch_count: mismatchCount
    });
  }

  function emitMismatch({ event, candidate, report, durationMs }) {
    let accepted = true;
    for (const mismatch of report.mismatches || []) {
      const queued = queueSinkRecord({
        endpoint_template: event.endpointTemplate,
        channel: event.channel,
        lifecycle: candidate.lifecycle || event.baselineDto.activation_status || '',
        field_path: mismatch.path,
        difference_type: mismatch.kind,
        baseline_type: mismatch.baseline_type,
        candidate_type: mismatch.candidate_type,
        baseline_count: mismatch.baseline_count,
        candidate_count: mismatch.candidate_count,
        mismatch_count: report.mismatch_count,
        truncated: report.truncated,
        outcome: 'DTO_MISMATCH',
        latency_bucket: latencyBucket(durationMs),
        observer_version: observerVersion
      });
      if (!queued) accepted = false;
    }
    return accepted;
  }

  async function observe(event = {}) {
    if (closed) return { outcome: 'CLOSED' };
    const config = getConfig();
    if (!config || config.enabled !== true) return { outcome: 'DISABLED' };
    if (!config.allowlist || !config.allowlist.has(String(event.publicQrId || ''))) {
      return { outcome: 'SKIPPED_NOT_ALLOWLISTED' };
    }

    const startedAt = now();
    if (!event.sourceHash) {
      const outcome = 'INELIGIBLE_NO_VERSION';
      if (!emitOutcome({ event, outcome, durationMs: now() - startedAt })) {
        recordInfrastructureFailure(now());
      }
      return { outcome };
    }

    const circuit = enterCircuit(startedAt);
    if (!circuit.allowed) {
      const outcome = 'SKIPPED_CIRCUIT_OPEN';
      if (!emitOutcome({ event, outcome, durationMs: now() - startedAt })) {
        recordInfrastructureFailure(now());
      }
      return { outcome };
    }
    if (active >= config.maxConcurrency) {
      if (circuit.probe) halfOpenInFlight = false;
      const outcome = 'SKIPPED_CAPACITY';
      if (!emitOutcome({ event, outcome, durationMs: now() - startedAt })) {
        recordInfrastructureFailure(now());
      }
      return { outcome };
    }

    active += 1;
    const baselineDto = cloneDto(event.baselineDto);
    let failed = false;
    try {
      const candidate = await runWithTimeout((signal) => readCandidate({
        channel: event.channel,
        endpointTemplate: event.endpointTemplate,
        key: event.key,
        publicQrId: event.publicQrId,
        viewer: event.viewer,
        sourceHash: event.sourceHash,
        assetResolver: event.assetResolver,
        timeoutMs: config.timeoutMs,
        signal
      }), config.timeoutMs);

      if (!candidate || candidate.eligibility !== 'ELIGIBLE') {
        const outcome = candidate && candidate.eligibility
          ? candidate.eligibility
          : 'INELIGIBLE_NO_IMPORT';
        if (!emitOutcome({ event, candidate, outcome, durationMs: now() - startedAt })) {
          recordInfrastructureFailure(now());
        }
        return { outcome };
      }

      const report = compareDtos({
        baseline: baselineDto,
        candidate: candidate.dto,
        channel: event.channel
      });
      if (report && report.matches === true) {
        const outcome = 'MATCH';
        if (!emitOutcome({ event, candidate, outcome, durationMs: now() - startedAt, mismatchCount: 0 })) {
          recordInfrastructureFailure(now());
        }
        return { outcome };
      }

      const mismatchCount = report ? report.mismatch_count : 0;
      let accepted = emitOutcome({
        event,
        candidate,
        outcome: 'MISMATCH',
        durationMs: now() - startedAt,
        mismatchCount
      });

      accepted = emitMismatch({
        event: { ...event, baselineDto },
        candidate,
        report: report || { mismatches: [], mismatch_count: 0 },
        durationMs: now() - startedAt
      }) && accepted;
      if (!accepted) recordInfrastructureFailure(now());
      return { outcome: 'MISMATCH', mismatchCount };
    } catch (error) {
      const code = errorCode(error);
      failed = isInfrastructureError(code);
      if (!emitOutcome({ event, outcome: code, durationMs: now() - startedAt })) {
        recordInfrastructureFailure(now());
      }
      return { outcome: code };
    } finally {
      active -= 1;
      completeCircuit({ at: now(), probe: circuit.probe, failed });
      if (closed && active === 0 && resolveClose) resolveClose();
    }
  }

  function close() {
    closed = true;
    if (active === 0) return Promise.resolve();
    if (!closePromise) {
      closePromise = new Promise((resolve) => { resolveClose = resolve; });
    }
    return closePromise;
  }

  return Object.freeze({
    observe,
    close,
    getState: () => ({
      active,
      closed,
      circuitOpen: openUntil > now(),
      openUntil,
      recentInfrastructureFailures: failureTimes.length
    })
  });
}

module.exports = {
  INFRASTRUCTURE_CODES,
  OBSERVER_VERSION,
  cloneDto,
  createPublicQrShadowObserver,
  isInfrastructureError,
  latencyBucket
};
