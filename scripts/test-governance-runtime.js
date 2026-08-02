#!/usr/bin/env bun

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const governance = require('../core/governance');

const PRODUCER_DIGEST = governance.sha256Digest({ contract: 'fleet-validator-v1' });
const POLICY = governance.createGatePolicy({
  contract_version: 1,
  policy_id: 'fleet-merge-gate',
  subject_kind: 'fleet-task',
  required_observations: [{
    observation_id: 'validator',
    producer_kind: 'mechanical-validator',
    producer_contract_digest: PRODUCER_DIGEST,
  }],
  retry_policy: {
    max_attempts: 2,
    initial_delay_ms: 10,
    backoff_multiplier: 2,
    max_delay_ms: 100,
  },
  deadline_policy: {
    attempt_timeout_ms: 1000,
    overall_deadline_ms: 300000,
  },
  checkpoint_requirement: 'none',
  human_gate: { required: false, observation_id: null },
  allowed_dispositions: ['retry', 'hold', 'escalate', 'advance', 'merge', 'terminate'],
});

function subject(id) {
  return Object.freeze({ kind: 'fleet-task', id });
}

function subjectDigest(id) {
  return governance.sha256Digest({ fleet_task: id, source_generation: 1 });
}

function authority(id, overrides = {}) {
  return {
    ...subject(id),
    digest: overrides.digest || subjectDigest(id),
    generation: overrides.generation || 1,
  };
}

function passedObservation(id, recordId, observedAt) {
  return governance.createEvidenceObservation({
    contract_version: 1,
    observation_id: recordId,
    subject: subject(id),
    subject_digest: subjectDigest(id),
    subject_generation: 1,
    attempt_id: `attempt-${recordId}`,
    producer: { kind: 'mechanical-validator', id: 'validator' },
    producer_contract_digest: PRODUCER_DIGEST,
    truth_status: 'passed',
    coverage: { required: 1, observed: 1, passed: 1, complete: true },
    reason_code: 'VERIFIED',
    artifact_digests: [governance.sha256Digest({ proof: recordId })],
    observed_at: observedAt,
    expires_at: null,
  });
}

function timeoutObservation(id, recordId, observedAt) {
  return governance.createFailureObservation({
    failureKind: 'timeout',
    observationId: recordId,
    attemptId: `attempt-${recordId}`,
    producer: { kind: 'mechanical-validator', id: 'validator' },
    producerContractDigest: PRODUCER_DIGEST,
    subject: subject(id),
    subjectDigest: subjectDigest(id),
    subjectGeneration: 1,
    observedAt,
    expiresAt: null,
  });
}

function evaluate(projectRoot, id, observations, decidedAt) {
  return governance.evaluateAndRecord({
    projectRoot,
    policy: POLICY,
    observations,
    subject: subject(id),
    subjectDigest: subjectDigest(id),
    subjectGeneration: 1,
    startedAt: '2026-07-30T12:00:00.000Z',
    decidedAt,
    requestedDisposition: 'merge',
  });
}

function runCli(args, expectedStatus) {
  const cli = path.join(__dirname, 'governance-gate.js');
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  assert.strictEqual(
    result.status,
    expectedStatus,
    `CLI status mismatch\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  assert.strictEqual(result.stderr, '');
  return JSON.parse(result.stdout);
}

function writeInput(projectRoot, name, value) {
  const target = path.join(projectRoot, name);
  fs.writeFileSync(target, `${JSON.stringify(value)}\n`, 'utf8');
  return target;
}

function cliEnvelope(id, observations = [], failures = []) {
  return {
    input_version: 1,
    policy: POLICY,
    observations,
    failures,
    subject: subject(id),
    subject_digest: subjectDigest(id),
    subject_generation: 1,
    started_at: '2026-07-30T12:00:00.000Z',
    requested_disposition: 'merge',
  };
}

function main() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-governance-runtime-'));
  try {
    assert.deepStrictEqual(
      governance.checkGovernanceStore(path.join(projectRoot, 'empty-project')),
      {
        status: 'unknown',
        check_code: 'STORE_MISSING',
        entries: 0,
        receipts: 0,
      },
    );
    const timeoutA = timeoutObservation(
      'branch-a',
      'branch-a-validation-1',
      '2026-07-30T12:00:30.000Z',
    );
    const heldA = evaluate(
      projectRoot,
      'branch-a',
      [timeoutA],
      '2026-07-30T12:01:00.000Z',
    );
    assert.strictEqual(heldA.decision.truth_status, 'unknown');
    assert.strictEqual(heldA.decision.reason_code, 'VALIDATOR_TIMEOUT');
    assert.strictEqual(heldA.decision.disposition, 'retry');
    const deniedA = governance.authorizeDecision(projectRoot, authority('branch-a'), 'merge');
    assert.strictEqual(deniedA.authorized, false);
    assert.strictEqual(deniedA.authorization_code, 'DECISION_NOT_PASSING');

    const passB = passedObservation(
      'branch-b',
      'branch-b-validation-1',
      '2026-07-30T12:01:30.000Z',
    );
    const completedB = evaluate(
      projectRoot,
      'branch-b',
      [passB],
      '2026-07-30T12:02:00.000Z',
    );
    assert.strictEqual(completedB.decision.disposition, 'merge');
    assert.strictEqual(
      governance.authorizeDecision(projectRoot, authority('branch-b'), 'merge').authorized,
      true,
      'independent branch B must pass while branch A is held',
    );

    const passA = passedObservation(
      'branch-a',
      'branch-a-validation-2',
      '2026-07-30T12:02:30.000Z',
    );
    const completedA = evaluate(
      projectRoot,
      'branch-a',
      [passA],
      '2026-07-30T12:03:00.000Z',
    );
    assert.strictEqual(completedA.decision.truth_status, 'passed');
    assert.strictEqual(completedA.decision.observation_digests.length, 2);
    assert.strictEqual(
      governance.authorizeDecision(projectRoot, authority('branch-a'), 'merge').authorized,
      true,
      'retry evidence must unlock branch A',
    );
    assert.strictEqual(
      governance.authorizeDecision(projectRoot, authority('branch-b'), 'merge').authorized,
      true,
      'branch A retry must not invalidate independent branch B',
    );

    const paths = governance.governanceStorePaths(projectRoot);
    const journal = governance.readJournalFile(paths.journal);
    const branchAAttempts = journal.filter((entry) => entry.record_type === 'observation'
      && entry.payload.subject.id === 'branch-a');
    assert.deepStrictEqual(
      branchAAttempts.map((entry) => entry.payload.observation_id),
      ['branch-a-validation-1', 'branch-a-validation-2'],
      'append-only journal must preserve both retry attempts',
    );

    const staleA = governance.authorizeDecision(
      projectRoot,
      authority('branch-a', { generation: 2 }),
      'merge',
    );
    assert.strictEqual(staleA.authorized, false);
    assert.strictEqual(staleA.authorization_code, 'SUBJECT_STALE');

    const originalReceipt = completedA.receipt;
    const receiptPath = governance.decisionReceiptPath(projectRoot, subject('branch-a'));
    const tampered = JSON.parse(JSON.stringify(originalReceipt));
    tampered.decision.current = false;
    fs.writeFileSync(receiptPath, `${JSON.stringify(tampered)}\n`, 'utf8');
    const tamperedResult = governance.authorizeDecision(
      projectRoot,
      authority('branch-a'),
      'merge',
    );
    assert.strictEqual(tamperedResult.authorized, false);
    assert.strictEqual(tamperedResult.authorization_code, 'RECEIPT_INVALID');
    governance.atomicWriteDecisionReceipt(projectRoot, originalReceipt);

    const cliCObservation = passedObservation(
      'branch-c',
      'branch-c-validation-1',
      '2026-07-30T12:03:30.000Z',
    );
    const cliCInput = writeInput(
      projectRoot,
      'branch-c-input.json',
      cliEnvelope('branch-c', [cliCObservation]),
    );
    const cliC = runCli([
      'evaluate',
      '--project-root', projectRoot,
      '--input', cliCInput,
      '--at', '2026-07-30T12:04:00.000Z',
    ], 0);
    assert.strictEqual(cliC.status, 'passed');
    const journalBeforeAuthorize = fs.readFileSync(paths.journal, 'utf8');
    const cliAuthorization = runCli([
      'authorize',
      '--project-root', projectRoot,
      '--subject-kind', 'fleet-task',
      '--subject-id', 'branch-c',
      '--subject-digest', subjectDigest('branch-c'),
      '--subject-generation', '1',
      '--disposition', 'merge',
    ], 0);
    assert.strictEqual(cliAuthorization.authorized, true);
    assert.strictEqual(fs.readFileSync(paths.journal, 'utf8'), journalBeforeAuthorize);

    const cliDInput = writeInput(projectRoot, 'branch-d-input.json', cliEnvelope('branch-d', [], [{
      failure_kind: 'timeout',
      observation_id: 'branch-d-validation-1',
      attempt_id: 'attempt-branch-d-validation-1',
      producer: { kind: 'mechanical-validator', id: 'validator' },
      producer_contract_digest: PRODUCER_DIGEST,
      observed_at: '2026-07-30T12:04:30.000Z',
      expires_at: null,
    }]));
    const cliD = runCli([
      'evaluate',
      '--project-root', projectRoot,
      '--input', cliDInput,
      '--at', '2026-07-30T12:05:00.000Z',
    ], 1);
    assert.strictEqual(cliD.status, 'unknown');
    assert.strictEqual(cliD.decision.reason_code, 'VALIDATOR_TIMEOUT');
    assert.strictEqual(
      governance.authorizeDecision(projectRoot, authority('branch-d'), 'merge').authorized,
      false,
    );

    const check = runCli(['check', '--project-root', projectRoot], 0);
    assert.strictEqual(check.check_code, 'STORE_VERIFIED');
    const malformed = path.join(projectRoot, 'malformed.json');
    fs.writeFileSync(malformed, '{"broken":\n', 'utf8');
    const malformedResult = runCli([
      'evaluate',
      '--project-root', projectRoot,
      '--input', malformed,
    ], 1);
    assert.strictEqual(malformedResult.status, 'unknown');
    assert.strictEqual(malformedResult.error_code, 'INPUT_UNPARSEABLE');

    const staleRoot = path.join(projectRoot, 'stale-project');
    const passE = passedObservation(
      'branch-e',
      'branch-e-validation-1',
      '2026-07-30T12:05:30.000Z',
    );
    evaluate(staleRoot, 'branch-e', [passE], '2026-07-30T12:06:00.000Z');
    const laterE = timeoutObservation(
      'branch-e',
      'branch-e-validation-2',
      '2026-07-30T12:06:30.000Z',
    );
    governance.appendJournalFile(
      governance.governanceStorePaths(staleRoot).journal,
      laterE,
      '2026-07-30T12:07:00.000Z',
    );
    const superseded = governance.authorizeDecision(staleRoot, authority('branch-e'), 'merge');
    assert.strictEqual(superseded.authorized, false);
    assert.strictEqual(superseded.authorization_code, 'DECISION_NOT_LATEST');

    const corruptRoot = path.join(projectRoot, 'corrupt-project');
    const passF = passedObservation(
      'branch-f',
      'branch-f-validation-1',
      '2026-07-30T12:07:30.000Z',
    );
    evaluate(corruptRoot, 'branch-f', [passF], '2026-07-30T12:08:00.000Z');
    const corruptJournalPath = governance.governanceStorePaths(corruptRoot).journal;
    const corruptLines = fs.readFileSync(corruptJournalPath, 'utf8').trimEnd().split('\n');
    const corruptEntry = JSON.parse(corruptLines[0]);
    corruptEntry.entry_hash = `sha256:${'0'.repeat(64)}`;
    corruptLines[0] = JSON.stringify(corruptEntry);
    fs.writeFileSync(corruptJournalPath, `${corruptLines.join('\n')}\n`, 'utf8');
    const corruptAuthorization = governance.authorizeDecision(
      corruptRoot,
      authority('branch-f'),
      'merge',
    );
    assert.strictEqual(corruptAuthorization.authorized, false);
    assert.strictEqual(corruptAuthorization.authorization_code, 'JOURNAL_INVALID');
    assert.strictEqual(governance.checkGovernanceStore(corruptRoot).status, 'unknown');

    process.stdout.write('governance runtime tests passed\n');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

main();
