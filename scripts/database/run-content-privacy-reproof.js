#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  closePostgresPool,
  createPostgresPool,
  sanitizePostgresError
} = require('../../src/server/database/connection');
const { readPostgresConfig } = require('../../src/server/database/config');
const { withTransaction } = require('../../src/server/database/transaction');
const { createOutboxWorker } = require('../../src/server/services/postgres/outboxWorkerService');
const {
  createRecordProofExternalAdapter
} = require('../../src/server/services/postgres/recordProofExternalAdapter');
const {
  createRecordProofJobHandler
} = require('../../src/server/services/postgres/recordProofJobHandler');
const {
  createRecordProofResultService
} = require('../../src/server/services/postgres/recordProofResultService');
const {
  readRecordProofRuntimeConfig
} = require('../../src/server/services/postgres/recordProofRuntimeConfig');
const { queryOperation } = require('../../src/server/services/avataService');
const { analyzeSource } = require('./audit-cross-account-phone-content');
const {
  PUBLIC_QR_DOMAIN_CHECKSUM_KEY,
  publicQrDomainSha256
} = require('./importer/domain-markers');
const { mapSourceToPlan } = require('./importer/mapping');
const { sha256 } = require('./importer/reader');
const {
  assertEvidenceComplete,
  buildFinalSource,
  finalizePostgresRevision,
  loadTargetEvidence,
  normalizedQrIds,
  replaceLiveDatabaseWithFinal,
  verifyCandidateTransitionBase,
  verifyPublicDomainParity
} = require('./content-privacy-reproof');

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function runnerError(code, message, details = {}) {
  const error = new Error(message || code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function argumentHash(value, code) {
  const hash = String(value || '').trim().toLowerCase();
  if (!SHA256_PATTERN.test(hash)) throw runnerError(code);
  return hash;
}

function positiveInteger(value, fallback, maximum, code) {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > maximum) {
    throw runnerError(code);
  }
  return candidate;
}

function parseArguments(argv) {
  const values = {};
  let mode = null;
  for (const argument of argv) {
    if (argument === '--preflight' || argument === '--execute-controlled') {
      if (mode) throw runnerError('CONTENT_PRIVACY_REPROOF_MODE_INVALID');
      mode = argument === '--preflight' ? 'preflight' : 'execute';
      continue;
    }
    const match = /^--([a-z0-9-]+)=(.*)$/i.exec(argument);
    const allowed = [
      'candidate', 'live-database', 'expected-candidate-sha256',
      'expected-candidate-domain-sha256', 'expected-qr-ids',
      'expected-database', 'max-seconds', 'poll-ms'
    ];
    if (!match || !allowed.includes(match[1]) || Object.hasOwn(values, match[1])) {
      throw runnerError('CONTENT_PRIVACY_REPROOF_ARGUMENT_INVALID');
    }
    values[match[1]] = match[2];
  }
  if (!mode) throw runnerError('CONTENT_PRIVACY_REPROOF_MODE_REQUIRED');
  for (const key of ['candidate', 'live-database']) {
    if (!values[key] || !path.isAbsolute(values[key])) {
      throw runnerError('CONTENT_PRIVACY_REPROOF_ABSOLUTE_PATH_REQUIRED');
    }
  }
  const expectedDatabase = String(values['expected-database'] || '').trim();
  if (!/^[A-Za-z0-9_]+$/.test(expectedDatabase)) {
    throw runnerError('CONTENT_PRIVACY_REPROOF_DATABASE_INVALID');
  }
  return Object.freeze({
    mode,
    candidatePath: path.resolve(values.candidate),
    liveDatabasePath: path.resolve(values['live-database']),
    candidateHash: argumentHash(
      values['expected-candidate-sha256'],
      'CONTENT_PRIVACY_REPROOF_CANDIDATE_SHA_INVALID'
    ),
    candidateDomainHash: argumentHash(
      values['expected-candidate-domain-sha256'],
      'CONTENT_PRIVACY_REPROOF_CANDIDATE_DOMAIN_INVALID'
    ),
    qrIds: normalizedQrIds(String(values['expected-qr-ids'] || '').split(',')),
    expectedDatabase,
    maxSeconds: positiveInteger(
      values['max-seconds'],
      15 * 60,
      60 * 60,
      'CONTENT_PRIVACY_REPROOF_TIMEOUT_INVALID'
    ),
    pollMs: positiveInteger(
      values['poll-ms'],
      3000,
      60 * 1000,
      'CONTENT_PRIVACY_REPROOF_POLL_INVALID'
    )
  });
}

function readCandidate(options) {
  if (!fs.existsSync(options.candidatePath)
      || fs.lstatSync(options.candidatePath).isSymbolicLink()) {
    throw runnerError('CONTENT_PRIVACY_REPROOF_CANDIDATE_INVALID');
  }
  const bytes = fs.readFileSync(options.candidatePath);
  if (sha256(bytes) !== options.candidateHash) {
    throw runnerError('CONTENT_PRIVACY_REPROOF_CANDIDATE_CHANGED');
  }
  let source;
  try {
    source = JSON.parse(bytes.toString('utf8'));
  } catch (_error) {
    throw runnerError('CONTENT_PRIVACY_REPROOF_CANDIDATE_INVALID');
  }
  const plan = mapSourceToPlan(source).plan;
  if (publicQrDomainSha256(plan) !== options.candidateDomainHash) {
    throw runnerError('CONTENT_PRIVACY_REPROOF_CANDIDATE_DOMAIN_MISMATCH');
  }
  const privacy = analyzeSource(source, options.candidateHash);
  if (privacy.status !== 'CLEAN' || privacy.finding_count !== 0) {
    throw runnerError('CONTENT_PRIVACY_REPROOF_CANDIDATE_NOT_CLEAN');
  }
  return Object.freeze({ source, plan });
}

function runtimeConfig(options, env) {
  const config = readRecordProofRuntimeConfig({
    ...env,
    RECORD_PROOF_RUNTIME_ENABLED: 'true',
    RECORD_PROOF_RUNTIME_SCOPE: 'allowlist',
    RECORD_PROOF_RUNTIME_ALLOWLIST: options.qrIds.join(','),
    RECORD_PROOF_RUNTIME_SOURCE_SHA256: options.candidateHash,
    RECORD_PROOF_RUNTIME_DOMAIN_SHA256: options.candidateDomainHash,
    RECORD_PROOF_WORKER_ID:
      `privacy-reproof-${options.candidateHash.slice(0, 12)}`,
    RECORD_PROOF_WORKER_BATCH_SIZE: String(options.qrIds.length),
    RECORD_PROOF_WORKER_INTERVAL_MS: '1000',
    RECORD_PROOF_WORKER_RETRY_BASE_MS: '1000'
  });
  if (!config || config.enabled !== true) {
    throw runnerError(
      'CONTENT_PRIVACY_REPROOF_RUNTIME_CONFIG_INVALID',
      null,
      { reason: String(config && config.reason || 'CONFIG_INVALID') }
    );
  }
  return config;
}

async function inspectCandidateMarker(transactionContext, options) {
  const result = await transactionContext.query(
    `SELECT status,
            checksum_summary ->> $2 AS public_qr_domain_sha256,
            checksum_summary ->> 'superseded_by_source_sha256'
              AS superseded_by_source_sha256
     FROM app.import_runs
     WHERE source_sha256 = $1`,
    [options.candidateHash, PUBLIC_QR_DOMAIN_CHECKSUM_KEY]
  );
  if (result.rows.length !== 1
      || result.rows[0].public_qr_domain_sha256 !== options.candidateDomainHash
      || !['passed', 'blocked'].includes(result.rows[0].status)) {
    throw runnerError('CONTENT_PRIVACY_REPROOF_CANDIDATE_MARKER_INVALID');
  }
  if (result.rows[0].status === 'blocked'
      && !SHA256_PATTERN.test(
        String(result.rows[0].superseded_by_source_sha256 || '')
      )) {
    throw runnerError('CONTENT_PRIVACY_REPROOF_CANDIDATE_MARKER_INVALID');
  }
  return result.rows[0];
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function proofStates(evidence) {
  return evidence.qrIds.map((qrId) => ({
    qrId,
    proof: evidence.proofs.get(qrId) || null,
    job: evidence.jobs.get(qrId)
  }));
}

async function preflightReproof({
  options,
  pool,
  candidate,
  env = process.env,
  transactionRunner = withTransaction
}) {
  runtimeConfig(options, env);
  return transactionRunner(pool, async (context) => {
    const marker = await inspectCandidateMarker(context, options);
    await verifyCandidateTransitionBase(context, {
      candidatePlan: candidate.plan,
      qrIds: options.qrIds
    });
    const evidence = await loadTargetEvidence(context, {
      candidateHash: options.candidateHash,
      qrIds: options.qrIds
    });
    const states = proofStates(evidence);
    if (states.some(({ job }) => job.status === 'failed')) {
      throw runnerError('CONTENT_PRIVACY_REPROOF_OUTBOX_FAILED');
    }
    const liveHash = sha256(fs.readFileSync(options.liveDatabasePath));
    if (marker.status === 'passed') {
      if (liveHash !== options.candidateHash) {
        throw runnerError('CONTENT_PRIVACY_REPROOF_LIVE_DATABASE_DRIFT');
      }
      const proofCount = states.filter(({ proof }) => Boolean(proof)).length;
      return Object.freeze({
        mode: 'preflight',
        status: proofCount === 0 ? 'READY' : 'RESUMABLE',
        phase: proofCount === 0 ? 'CANDIDATE_READY' : 'REPROOF_IN_PROGRESS',
        affected_qr_ids: options.qrIds,
        external_calls: 'NONE',
        production_write: 'NONE'
      });
    }
    assertEvidenceComplete(evidence);
    const final = buildFinalSource({
      candidateSource: candidate.source,
      evidence
    });
    await verifyPublicDomainParity(context, final.plan);
    const finalMarker = await context.query(
      `SELECT status, checksum_summary ->> $2 AS domain_sha256
       FROM app.import_runs
       WHERE source_sha256 = $1`,
      [final.sourceHash, PUBLIC_QR_DOMAIN_CHECKSUM_KEY]
    );
    if (finalMarker.rows.length !== 1
        || finalMarker.rows[0].status !== 'passed'
        || finalMarker.rows[0].domain_sha256 !== final.domainHash
        || marker.superseded_by_source_sha256 !== final.sourceHash
        || ![options.candidateHash, final.sourceHash].includes(liveHash)) {
      throw runnerError('CONTENT_PRIVACY_REPROOF_FINAL_STATE_INVALID');
    }
    return Object.freeze({
      mode: 'preflight',
      status: liveHash === final.sourceHash ? 'ALREADY_COMPLETED' : 'RESUMABLE',
      phase: liveHash === final.sourceHash
        ? 'FINAL_COMPLETE'
        : 'FINAL_JSON_PENDING',
      affected_qr_ids: options.qrIds,
      final_source_sha256: final.sourceHash,
      final_public_qr_domain_sha256: final.domainHash,
      external_calls: 'NONE',
      production_write: 'NONE'
    });
  }, { isolationLevel: 'repeatable read', readOnly: true });
}

async function executeReproof({
  options,
  pool,
  candidate,
  env = process.env,
  externalAdapterFactory = createRecordProofExternalAdapter,
  queryProviderOperation = queryOperation,
  transactionRunner = withTransaction,
  workerFactory = createOutboxWorker,
  jobHandlerFactory = createRecordProofJobHandler,
  resultServiceFactory = createRecordProofResultService,
  wait = sleep,
  clock = () => new Date()
}) {
  const config = runtimeConfig(options, env);
  const marker = await transactionRunner(pool, async (context) => {
    const current = await inspectCandidateMarker(context, options);
    await verifyCandidateTransitionBase(context, {
      candidatePlan: candidate.plan,
      qrIds: options.qrIds
    });
    await loadTargetEvidence(context, {
      candidateHash: options.candidateHash,
      qrIds: options.qrIds
    });
    return current;
  }, { isolationLevel: 'repeatable read', readOnly: true });

  const adapter = externalAdapterFactory();
  const handler = jobHandlerFactory({
    pool,
    prepareRecord: adapter.prepareRecord,
    submitRecord: adapter.submitRecord
  });
  const worker = workerFactory({
    pool,
    workerId: config.workerId,
    handlers: { record_proof_prepare_submit: handler },
    batchSize: config.batchSize,
    maxAttempts: config.maxAttempts,
    retryBaseMs: config.retryBaseMs,
    lockTimeoutMs: config.lockTimeoutMs,
    jobTypes: ['record_proof_prepare_submit'],
    aggregateIds: options.qrIds
  });
  const results = resultServiceFactory({
    pool,
    allowedRecordQrIds: options.qrIds,
    normalizeProviderResult: (value) => value
  });
  const deadline = Date.now() + options.maxSeconds * 1000;
  let workerRuns = 0;
  let providerQueries = 0;

  if (marker.status === 'passed') {
    while (Date.now() <= deadline) {
      let evidence = await transactionRunner(
        pool,
        (context) => loadTargetEvidence(context, {
          candidateHash: options.candidateHash,
          qrIds: options.qrIds
        }),
        { isolationLevel: 'repeatable read', readOnly: true }
      );
      const states = proofStates(evidence);
      if (states.some(({ job }) => job.status === 'failed')) {
        throw runnerError('CONTENT_PRIVACY_REPROOF_OUTBOX_FAILED');
      }
      if (states.every(({ proof, job }) => (
        proof && proof.status === 'confirmed' && job.status === 'succeeded'
      ))) break;

      await worker.runOnce();
      workerRuns += 1;
      evidence = await transactionRunner(
        pool,
        (context) => loadTargetEvidence(context, {
          candidateHash: options.candidateHash,
          qrIds: options.qrIds
        }),
        { isolationLevel: 'repeatable read', readOnly: true }
      );
      for (const { proof, job } of proofStates(evidence)) {
        if (!proof || proof.status !== 'submitted' || job.status !== 'succeeded') {
          continue;
        }
        const raw = await queryProviderOperation(proof.operation_id);
        const normalized = adapter.normalizeRecordResult(raw);
        await results.applyQueryResult({
          ...normalized,
          operation_id: normalized.operation_id || proof.operation_id
        });
        providerQueries += 1;
      }
      const afterPass = await transactionRunner(
        pool,
        (context) => loadTargetEvidence(context, {
          candidateHash: options.candidateHash,
          qrIds: options.qrIds
        }),
        { isolationLevel: 'repeatable read', readOnly: true }
      );
      const afterStates = proofStates(afterPass);
      if (afterStates.some(({ job, proof }) => (
        job.status === 'failed' || proof && proof.status === 'failed'
      ))) {
        throw runnerError('CONTENT_PRIVACY_REPROOF_PROVIDER_FAILED');
      }
      if (afterStates.every(({ proof, job }) => (
        proof && proof.status === 'confirmed' && job.status === 'succeeded'
      ))) break;
      await wait(options.pollMs);
    }
  }

  const final = await transactionRunner(pool, (context) => finalizePostgresRevision({
    transactionContext: context,
    candidateSource: candidate.source,
    candidateHash: options.candidateHash,
    candidateDomainHash: options.candidateDomainHash,
    qrIds: options.qrIds
  }), { isolationLevel: 'serializable' });
  const json = replaceLiveDatabaseWithFinal({
    liveDatabasePath: options.liveDatabasePath,
    candidateHash: options.candidateHash,
    final
  });
  return Object.freeze({
    status: final.markerApplied || json.applied ? 'COMPLETED' : 'ALREADY_COMPLETED',
    candidate_source_sha256: options.candidateHash,
    final_source_sha256: final.sourceHash,
    final_public_qr_domain_sha256: final.domainHash,
    affected_qr_ids: options.qrIds,
    worker_runs: workerRuns,
    provider_queries: providerQueries,
    final_marker_applied: final.markerApplied,
    final_json_applied: json.applied,
    operational_proof_attempts_preserved: true
  });
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArguments(argv);
  const candidate = readCandidate(options);
  const config = readPostgresConfig(env);
  if (String(config.database || '') !== options.expectedDatabase) {
    throw runnerError('CONTENT_PRIVACY_REPROOF_DATABASE_MISMATCH');
  }
  const pool = createPostgresPool({ config: {
    ...config,
    poolMax: Math.min(3, config.poolMax),
    applicationName: 'xingxingzaishan-content-privacy-reproof'
  } });
  try {
    const result = options.mode === 'preflight'
      ? await preflightReproof({ options, pool, candidate, env })
      : await executeReproof({ options, pool, candidate, env });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await closePostgresPool(pool);
  }
}

if (require.main === module) {
  main().catch((error) => {
    const safe = error && String(error.code || '').startsWith('CONTENT_PRIVACY_')
      ? error
      : sanitizePostgresError(error, 'CONTENT_PRIVACY_REPROOF_FAILED');
    process.stderr.write(`${JSON.stringify({
      status: 'BLOCKED',
      code: safe.code || 'CONTENT_PRIVACY_REPROOF_FAILED'
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  executeReproof,
  inspectCandidateMarker,
  main,
  parseArguments,
  preflightReproof,
  readCandidate,
  runtimeConfig
};
