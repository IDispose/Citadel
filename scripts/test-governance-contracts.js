#!/usr/bin/env bun

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const governance = require('../core/governance');

const SUBJECT = Object.freeze({ kind: 'campaign-phase', id: 'phase-1' });
const SUBJECT_DIGEST = governance.sha256Digest({ objective: 'verify governed phase' });
const PRODUCER_DIGEST = governance.sha256Digest({ contract: 'test-producer-v1' });
const START = '2026-07-30T12:00:00.000Z';

function coverage(status = 'passed', overrides = {}) {
  return {
    required: 1,
    observed: 1,
    passed: status === 'passed' ? 1 : 0,
    complete: true,
    ...overrides,
  };
}

function observation(options = {}) {
  const status = options.status || 'passed';
  return governance.createEvidenceObservation({
    contract_version: 1,
    observation_id: options.id || `observation-${options.producerId || 'tests'}-1`,
    subject: options.subject || SUBJECT,
    subject_digest: options.subjectDigest || SUBJECT_DIGEST,
    subject_generation: options.generation || 1,
    attempt_id: options.attemptId || `attempt-${options.producerId || 'tests'}-1`,
    producer: {
      kind: options.producerKind || 'deterministic',
      id: options.producerId || 'tests',
    },
    producer_contract_digest: PRODUCER_DIGEST,
    truth_status: status,
    coverage: options.coverage || coverage(status),
    reason_code: options.reason || (status === 'passed' ? 'VERIFIED' : 'VERIFICATION_FAILED'),
    artifact_digests: options.artifacts || (status === 'passed'
      ? [governance.sha256Digest({ result: options.id || 'passed' })]
      : []),
    observed_at: options.observedAt || START,
    expires_at: options.expiresAt ?? null,
  });
}

function policy(options = {}) {
  const required = (options.required || ['tests']).map((entry) => (
    typeof entry === 'string'
      ? {
        observation_id: entry,
        producer_kind: entry === 'human-approval'
          ? 'human'
          : entry === 'validator' ? 'mechanical-validator' : 'deterministic',
        producer_contract_digest: PRODUCER_DIGEST,
      }
      : entry
  ));
  return governance.createGatePolicy({
    contract_version: 1,
    policy_id: options.id || 'strict-supervised',
    subject_kind: options.subjectKind || SUBJECT.kind,
    required_observations: required,
    retry_policy: {
      max_attempts: options.maxAttempts || 2,
      initial_delay_ms: 100,
      backoff_multiplier: 2,
      max_delay_ms: 250,
    },
    deadline_policy: {
      attempt_timeout_ms: 1000,
      overall_deadline_ms: 10000,
    },
    checkpoint_requirement: options.checkpointRequirement || 'none',
    human_gate: options.humanGate || { required: false, observation_id: null },
    allowed_dispositions: options.allowedDispositions || [
      'retry', 'hold', 'escalate', 'advance', 'merge', 'terminate',
    ],
  });
}

function evaluate(gatePolicy, observations, options = {}) {
  return governance.evaluateGate({
    policy: gatePolicy,
    observations,
    subject: SUBJECT,
    subjectDigest: options.subjectDigest || SUBJECT_DIGEST,
    subjectGeneration: options.generation || 1,
    decidedAt: options.decidedAt || '2026-07-30T12:00:05.000Z',
    startedAt: options.startedAt || START,
    requestedDisposition: options.requestedDisposition || 'advance',
  });
}

const stableA = governance.sha256Digest({ z: 1, a: ['x', 2] });
const stableB = governance.sha256Digest({ a: ['x', 2], z: 1 });
assert.equal(stableA, stableB, 'canonical digest must ignore object key order');

const passedObservation = observation();
assert.equal(governance.validateEvidenceObservation(passedObservation).length, 0);
assert(Object.isFrozen(passedObservation));
assert.equal(
  passedObservation.observation_digest,
  governance.digestWithout(passedObservation, 'observation_digest')
);

const extraField = { ...passedObservation, surprise: true };
assert(governance.validateEvidenceObservation(extraField).some((error) => error.includes('fields must exactly match')));

const aliasedStatus = {
  ...passedObservation,
  truth_status: 'pass',
  observation_digest: passedObservation.observation_digest,
};
assert(governance.validateEvidenceObservation(aliasedStatus).some((error) => error.includes('truth_status')));

assert.throws(() => observation({
  coverage: { required: 2, observed: 1, passed: 1, complete: false },
}), /passed observations require complete passed coverage/);

assert.throws(() => policy({
  required: ['tests'],
  checkpointRequirement: 'required',
}), /required checkpoint must appear/);

assert.throws(() => policy({
  allowedDispositions: ['proceed'],
}), /allowed_dispositions/);

assert.throws(() => policy({
  allowedDispositions: ['advance', 'merge'],
}), /non-acceptance fallback/);

const twoCheckPolicy = policy({ required: ['tests', 'review'] });
const reviewObservation = observation({
  id: 'observation-review-1',
  producerId: 'review',
  attemptId: 'attempt-review-1',
  observedAt: '2026-07-30T12:00:01.000Z',
});
const passedDecision = evaluate(twoCheckPolicy, [passedObservation, reviewObservation]);
assert.equal(passedDecision.truth_status, 'passed');
assert.equal(passedDecision.disposition, 'advance');
assert.equal(passedDecision.coverage.complete, true);
assert.equal(passedDecision.current, true);

const mergeDecision = evaluate(twoCheckPolicy, [passedObservation, reviewObservation], {
  requestedDisposition: 'merge',
});
assert.equal(mergeDecision.disposition, 'merge');
assert.deepEqual(
  evaluate(twoCheckPolicy, [passedObservation, reviewObservation]),
  passedDecision,
  'identical evidence and time must produce an identical decision'
);

const missingDecision = evaluate(twoCheckPolicy, [passedObservation]);
assert.equal(missingDecision.truth_status, 'unknown');
assert.equal(missingDecision.reason_code, 'MISSING_EVIDENCE');
assert.equal(missingDecision.disposition, 'retry');
assert.equal(missingDecision.coverage.complete, false);

const incompleteObservation = observation({
  id: 'observation-tests-incomplete',
  attemptId: 'attempt-tests-incomplete',
  status: 'unknown',
  reason: 'MISSING_EVIDENCE',
  coverage: { required: 2, observed: 1, passed: 1, complete: false },
});
const incompleteDecision = evaluate(policy(), [incompleteObservation]);
assert.equal(incompleteDecision.truth_status, 'unknown');
assert.equal(incompleteDecision.coverage.complete, false);
assert.notEqual(incompleteDecision.disposition, 'advance');

const staleObservation = observation({
  id: 'observation-tests-stale',
  subjectDigest: governance.sha256Digest({ objective: 'old phase' }),
});
const staleDecision = evaluate(policy(), [staleObservation]);
assert.equal(staleDecision.truth_status, 'unknown');
assert.equal(staleDecision.reason_code, 'STALE_EVIDENCE');
assert.equal(staleDecision.current, false);
assert.notEqual(staleDecision.disposition, 'advance');

const timeoutOne = observation({
  id: 'observation-validator-1',
  producerId: 'validator',
  producerKind: 'mechanical-validator',
  attemptId: 'attempt-validator-1',
  status: 'unknown',
  reason: 'VALIDATOR_TIMEOUT',
});
const timeoutTwo = observation({
  id: 'observation-validator-2',
  producerId: 'validator',
  producerKind: 'mechanical-validator',
  attemptId: 'attempt-validator-2',
  status: 'unknown',
  reason: 'VALIDATOR_TIMEOUT',
  observedAt: '2026-07-30T12:00:02.000Z',
});
const validatorPolicy = policy({ required: ['validator'], maxAttempts: 2 });
const firstTimeout = evaluate(validatorPolicy, [timeoutOne]);
assert.equal(firstTimeout.truth_status, 'unknown');
assert.equal(firstTimeout.reason_code, 'VALIDATOR_TIMEOUT');
assert.equal(firstTimeout.disposition, 'retry');
const exhaustedTimeout = evaluate(validatorPolicy, [timeoutOne, timeoutTwo]);
assert.equal(exhaustedTimeout.truth_status, 'unknown');
assert.equal(exhaustedTimeout.disposition, 'escalate');
assert.equal(exhaustedTimeout.observation_digests.length, 2, 'retry attempts must remain referenced');

const malformed = observation({
  id: 'observation-validator-malformed',
  producerId: 'validator',
  producerKind: 'mechanical-validator',
  attemptId: 'attempt-validator-malformed',
  status: 'unknown',
  reason: 'OUTPUT_UNPARSEABLE',
});
const malformedDecision = evaluate(validatorPolicy, [malformed]);
assert.equal(malformedDecision.truth_status, 'unknown');
assert.equal(malformedDecision.reason_code, 'OUTPUT_UNPARSEABLE');
assert.equal(malformedDecision.disposition, 'retry');

const humanPolicy = policy({
  required: ['human-approval'],
  humanGate: { required: true, observation_id: 'human-approval' },
});
const humanPending = evaluate(humanPolicy, []);
assert.equal(humanPending.truth_status, 'blocked');
assert.equal(humanPending.reason_code, 'HUMAN_INPUT_REQUIRED');
assert.equal(humanPending.disposition, 'escalate');

const checkpointPending = evaluate(policy({
  required: ['checkpoint'],
  checkpointRequirement: 'required',
}), []);
assert.equal(checkpointPending.truth_status, 'blocked');
assert.equal(checkpointPending.reason_code, 'CHECKPOINT_REQUIRED');
assert.equal(checkpointPending.disposition, 'hold');

const failed = observation({
  id: 'observation-tests-failed',
  attemptId: 'attempt-tests-failed',
  status: 'failed',
  reason: 'TEST_FAILED',
});
const failedDecision = evaluate(policy(), [failed]);
assert.equal(failedDecision.truth_status, 'failed');
assert.equal(failedDecision.disposition, 'retry');
assert.notEqual(failedDecision.disposition, 'advance');
assert.notEqual(failedDecision.disposition, 'merge');

for (const [reasonCode, definition] of Object.entries(governance.REASON_DEFINITIONS)) {
  if (reasonCode === 'VERIFIED') continue;
  const producerId = `case-${reasonCode.toLowerCase().replaceAll('_', '-')}`;
  const caseObservation = observation({
    id: `observation-${producerId}`,
    producerId,
    attemptId: `attempt-${producerId}`,
    status: definition.truth[0],
    reason: reasonCode,
  });
  const caseDecision = evaluate(policy({ required: [producerId] }), [caseObservation]);
  assert.equal(caseDecision.truth_status, definition.truth[0], `${reasonCode} must preserve truth`);
  assert(!['advance', 'merge'].includes(caseDecision.disposition), `${reasonCode} must never accept`);
}

const mismatchedProducer = observation({
  id: 'observation-validator-impostor',
  producerId: 'validator',
  attemptId: 'attempt-validator-impostor',
});
const producerMismatch = evaluate(validatorPolicy, [mismatchedProducer]);
assert.equal(producerMismatch.truth_status, 'unknown');
assert.equal(producerMismatch.reason_code, 'PRODUCER_MISMATCH');
assert.equal(producerMismatch.disposition, 'escalate');

assert.throws(() => governance.createControlDecision({
  ...failedDecision,
  truth_status: 'unknown',
  reason_code: 'VALIDATOR_TIMEOUT',
  disposition: 'advance',
}), /advance and merge require passed, complete, current evidence/);

assert.throws(() => governance.createControlDecision({
  ...passedDecision,
  observation_digests: [],
}), /observation digests for required coverage/);

assert.equal(governance.retryDelayMs(policy(), 1), 100);
assert.equal(governance.retryDelayMs(policy(), 2), 200);
assert.equal(governance.retryDelayMs(policy(), 3), 250);

const memory = governance.createMemoryJournal();
memory.append(twoCheckPolicy, START);
memory.append(passedObservation, '2026-07-30T12:00:01.000Z');
memory.append(passedDecision, '2026-07-30T12:00:05.000Z');
const snapshot = memory.snapshot();
assert.equal(snapshot.length, 3);
assert.equal(snapshot[2].previous_hash, snapshot[1].entry_hash);
assert(Object.isFrozen(snapshot));
assert.equal(memory.verify(), true);
assert.throws(
  () => memory.append(passedObservation, '2026-07-30T12:00:06.000Z'),
  /duplicate observation_id/
);
assert.equal(memory.snapshot().length, 3, 'rejected append must not mutate journal');

const tampered = JSON.parse(JSON.stringify(snapshot));
tampered[1].payload.truth_status = 'unknown';
assert.throws(
  () => governance.verifyJournal(tampered),
  (error) => error.code === 'JOURNAL_CORRUPT'
);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-governance-'));
try {
  const filePath = path.join(tempRoot, 'governance.jsonl');
  governance.appendJournalFile(filePath, twoCheckPolicy, START);
  governance.appendJournalFile(filePath, passedObservation, '2026-07-30T12:00:01.000Z');
  assert.equal(governance.readJournalFile(filePath).length, 2);
  const changed = fs.readFileSync(filePath, 'utf8').replace('"truth_status":"passed"', '"truth_status":"unknown"');
  fs.writeFileSync(filePath, changed, 'utf8');
  assert.throws(
    () => governance.readJournalFile(filePath),
    (error) => error.code === 'JOURNAL_CORRUPT'
  );
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log('governance contract tests passed');
