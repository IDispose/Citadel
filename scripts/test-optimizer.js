#!/usr/bin/env bun
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  digest,
  executorSetIdentity,
  loadExecutors,
  loadFreeze,
  loadScenarios,
  metricSetIdentity,
  scenarioSetIdentity,
  unknownCost,
  validateBenchmarkShape,
  validateCost,
  validateDecision,
  validateExecutorProfile,
  validateFreeze,
  validateRun,
  validateScenario,
} = require('../core/optimizer/contracts');
const {
  learnCapabilityProfiles,
  planningProfile,
} = require('../core/optimizer/capability-profiles');
const {
  FIXTURE_PRICING_DIGEST,
  generateFixtureRuns,
  validateFixtureTruth,
} = require('../core/optimizer/fixture');
const { fixtureProbe, probeWorkspace } = require('../core/optimizer/probe');
const {
  deriveTokenCost,
  pricingSnapshotDigest,
  validatePricingSnapshot,
  validateUsage,
} = require('../core/optimizer/pricing');
const { nextAdaptiveAction, route } = require('../core/optimizer/policy');
const {
  attestRun,
  buildReport,
  verifyRunAttestation,
} = require('../core/optimizer/report');
const {
  FAILURE_CODES,
  adapterSourceDigest,
  changedArtifacts,
  redactDiagnosticText,
  runScenario,
  sumAttemptCosts,
  validateAdapterOutput,
  verificationReceipt,
} = require('../core/optimizer/runner');
const { buildBundle, verifyBundle } = require('../core/optimizer/bundle');
const runtimeAdapter = require('./optimizer-runtime-adapter');
const {
  boundExecutorProfileDigest,
  validateExecutorBindings,
} = require('../core/optimizer/executor-binding');
const {
  calibrationAuthorizationDigest,
  calibrationCases,
  calibrationObservation,
  validateCalibrationPlan,
  validateCalibrationRecord,
} = require('../core/optimizer/calibration');
const { validateCalibrationForensics } = require('../core/optimizer/calibration-forensics');
const {
  diagnosticPilotAuthorizationDigest,
  diagnosticPilotCases,
  diagnosticPilotObservation,
  validateDiagnosticPilotPlan,
  validateDiagnosticPilotRecord,
} = require('../core/optimizer/diagnostic-pilot');
const {
  validateDiagnosticPilotForensics,
} = require('../core/optimizer/diagnostic-pilot-forensics');
const {
  externalReproductionDigest,
  validateExternalReproduction,
} = require('../core/optimizer/external-reproduction');
const {
  buildBeaconSelectionRecord,
  buildExternalSelectionRequest,
  frozenSelectionFromRecord,
  validateBeaconSelectionRecord,
  validateExternalSelectionRequest,
} = require('../core/optimizer/external-selection');
const {
  assertMatrixAuthorized,
  expectedQuota,
  matrixAuthorizationDigest,
  validateMatrixAuthorization,
} = require('../core/optimizer/matrix-authorization');
const { validateAttestationRotation } = require('../core/optimizer/attestation-rotation');
const {
  args: matrixRunArgs,
  contained: matrixOutputContained,
  runFileName,
} = require('./optimizer-matrix-run');

const ROOT = path.resolve(__dirname, '..');
const BENCHMARK = path.join(ROOT, 'benchmarks', 'optimizer-proof');
const CLI = path.join(__dirname, 'optimizer-benchmark.js');

function invoke(argv) {
  return spawnSync(process.execPath, [CLI, ...argv], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30000,
  });
}

function knownCost(amount, source = 'test') {
  return validateCost({
    status: 'known',
    amount_usd: amount,
    provenance: 'vendor_reported',
    source,
    source_ref: 'test-record',
    pricing_snapshot_digest: null,
    components: [{ kind: 'model', amount_usd: amount, source }],
  });
}

function main() {
  const scenarios = loadScenarios(path.join(BENCHMARK, 'scenarios'));
  const calibrationScenarios = loadScenarios(path.join(BENCHMARK, 'calibration-scenarios'));
  const diagnosticPilotScenarios = loadScenarios(path.join(
    BENCHMARK,
    'diagnostic-pilot-scenarios',
  ));
  const executors = loadExecutors(path.join(BENCHMARK, 'executors.json'));
  validateBenchmarkShape(scenarios, executors);
  const freeze = loadFreeze(path.join(BENCHMARK, 'freeze.json'), scenarios, executors);
  const matrixAuthorization = validateMatrixAuthorization(
    JSON.parse(fs.readFileSync(path.join(BENCHMARK, 'matrix-authorization.json'), 'utf8')),
    freeze,
    scenarios,
  );
  const attestationRotation = validateAttestationRotation(
    JSON.parse(fs.readFileSync(path.join(BENCHMARK, 'attestation-key-rotation.json'), 'utf8')),
    freeze,
  );
  const calibrationPlan = validateCalibrationPlan(
    JSON.parse(fs.readFileSync(path.join(BENCHMARK, 'calibration-plan.json'), 'utf8')),
    calibrationScenarios,
    executors,
  );
  const calibrationForensics = validateCalibrationForensics(
    JSON.parse(fs.readFileSync(path.join(BENCHMARK, 'calibration-forensics.json'), 'utf8')),
    calibrationScenarios,
    scenarios,
  );
  const diagnosticPilotPlan = validateDiagnosticPilotPlan(
    JSON.parse(fs.readFileSync(path.join(BENCHMARK, 'diagnostic-pilot-plan.json'), 'utf8')),
    diagnosticPilotScenarios,
    executors,
  );
  const diagnosticPilotRecord = validateDiagnosticPilotRecord(
    JSON.parse(fs.readFileSync(path.join(BENCHMARK, 'diagnostic-pilot-record.json'), 'utf8')),
    diagnosticPilotPlan,
    diagnosticPilotScenarios,
    executors,
  );
  const diagnosticPilotForensics = validateDiagnosticPilotForensics(
    JSON.parse(fs.readFileSync(path.join(BENCHMARK, 'diagnostic-pilot-forensics.json'), 'utf8')),
    diagnosticPilotPlan,
    diagnosticPilotRecord,
    diagnosticPilotScenarios,
    scenarios,
  );
  const truth = validateFixtureTruth(
    JSON.parse(fs.readFileSync(path.join(BENCHMARK, 'fixtures', 'truth.json'), 'utf8')),
    scenarios,
  );
  const publicIndex = fs.readFileSync(path.join(ROOT, 'docs', 'index.html'), 'utf8');
  const optimizerPage = fs.readFileSync(path.join(ROOT, 'docs', 'optimizer.html'), 'utf8');
  const selectionRequest = buildExternalSelectionRequest(freeze, scenarios);
  const publishedSelectionRequest = JSON.parse(fs.readFileSync(
    path.join(BENCHMARK, 'holdout', 'external-selection-request.json'),
    'utf8',
  ));
  const publishedSelection = JSON.parse(fs.readFileSync(
    path.join(BENCHMARK, 'external-selection.json'),
    'utf8',
  ));
  validateExternalSelectionRequest(selectionRequest, freeze, scenarios);
  validateExternalSelectionRequest(publishedSelectionRequest, freeze, scenarios);
  validateBeaconSelectionRecord(publishedSelection, selectionRequest, freeze, scenarios);
  assert.deepStrictEqual(publishedSelectionRequest, selectionRequest);
  assert.deepStrictEqual(
    freeze.external_scenario,
    frozenSelectionFromRecord(publishedSelection, selectionRequest, freeze, scenarios),
  );
  assert.strictEqual(selectionRequest.scenario_set_id, freeze.scenario_set_id);
  assert.deepStrictEqual(selectionRequest.holdout_scenario_ids, freeze.holdout_scenario_ids);
  assert.strictEqual(selectionRequest.beacon.round, 6333716);
  assert.strictEqual(selectionRequest.beacon.round_time, '2026-07-30T20:15:00.000Z');
  assert.strictEqual(matrixAuthorization.approval_status, 'approved');
  assert.strictEqual(matrixAuthorization.quota_acknowledged, true);
  assert.strictEqual(matrixAuthorization.approved_by, 'Seth Gammon');
  assert.strictEqual(attestationRotation.matrix_runs_before_rotation, 0);
  assert.strictEqual(attestationRotation.selection_record_digest, publishedSelection.selection_digest);
  assert.deepStrictEqual(matrixAuthorization.quota_budget, {
    max_cli_runs: 120,
    max_model_calls: 162,
    max_model_runtime_minutes: 7230,
  });
  assert.deepStrictEqual(expectedQuota(freeze, scenarios), matrixAuthorization.quota_budget);
  assert.match(
    matrixAuthorizationDigest(matrixAuthorization, freeze, scenarios),
    /^sha256:[0-9a-f]{64}$/,
  );
  const pendingMatrixAuthorization = validateMatrixAuthorization({
    ...matrixAuthorization,
    approval_status: 'pending',
    quota_acknowledged: false,
    approved_by: null,
    approved_at: null,
  }, freeze, scenarios);
  assert.throws(
    () => assertMatrixAuthorized(pendingMatrixAuthorization, freeze, scenarios),
    /explicitly approved subscription quota/,
  );
  assert.doesNotThrow(() => assertMatrixAuthorized(matrixAuthorization, freeze, scenarios));
  assert.deepStrictEqual(matrixRunArgs([
    '--output-dir', 'runs',
    '--signing-key', 'key.pem',
    '--dry-run',
  ]), {
    'output-dir': 'runs',
    'signing-key': 'key.pem',
    'dry-run': true,
  });
  assert.strictEqual(matrixOutputContained(BENCHMARK, path.join(BENCHMARK, 'actual-runs')), true);
  assert.strictEqual(matrixOutputContained(BENCHMARK, path.dirname(BENCHMARK)), false);
  assert.strictEqual(runFileName({
    scenario_id: 'citadel-short-executor-proof',
    policy_id: 'adaptive',
    repetition: 1,
  }, 1), '001-citadel-short-executor-proof-adaptive-1.json');
  const beaconSignature = 'ab'.repeat(96);
  const beacon = {
    round: selectionRequest.beacon.round,
    randomness: crypto.createHash('sha256')
      .update(Buffer.from(beaconSignature, 'hex'))
      .digest('hex'),
    signature: beaconSignature,
    previous_signature: 'cd'.repeat(96),
  };
  const relayResponses = selectionRequest.beacon.source_urls.map((sourceUrl) => ({
    source_url: sourceUrl,
    beacon,
  }));
  const selectionRecord = buildBeaconSelectionRecord(
    selectionRequest,
    freeze,
    scenarios,
    relayResponses,
    selectionRequest.beacon.round_time,
  );
  validateBeaconSelectionRecord(selectionRecord, selectionRequest, freeze, scenarios);
  const selectedExternalScenario = frozenSelectionFromRecord(
    selectionRecord,
    selectionRequest,
    freeze,
    scenarios,
  );
  assert.deepStrictEqual(
    selectedExternalScenario,
    {
      scenario_id: selectionRecord.scenario_id,
      selection_method: 'drand-public-beacon',
      selection_record_digest: selectionRecord.selection_digest,
      selected_at: '2026-07-30',
      selection_source: selectionRequest.beacon.source_urls[0],
    },
  );
  assert.throws(() => validateExternalSelectionRequest({
    ...selectionRequest,
    request_id: `sha256:${'0'.repeat(64)}`,
  }, freeze, scenarios), /does not bind/);
  assert.throws(() => validateBeaconSelectionRecord({
    ...selectionRecord,
    scenario_id: scenarios.find((scenario) => !scenario.holdout).id,
  }, selectionRequest, freeze, scenarios), /choice is invalid/);
  assert.throws(() => validateFreeze({
    ...freeze,
    external_scenario: {
      scenario_id: scenarios.find((scenario) => !scenario.holdout).id,
      selection_method: 'drand-public-beacon',
      selection_record_digest: selectionRecord.selection_digest,
      selected_at: '2026-07-30',
      selection_source: selectionRequest.beacon.source_urls[0],
    },
  }, scenarios, executors), /not a frozen holdout/);

  assert.strictEqual(scenarios.length, 10);
  assert.strictEqual(new Set(scenarios.map((scenario) => scenario.repository)).size, 3);
  assert.strictEqual(new Set(executors.map((executor) => executor.runtime)).size, 2);
  assert.deepStrictEqual([...validateExecutorBindings(executors)], []);
  assert.strictEqual(calibrationPlan.total_runs, 4);
  assert.strictEqual(calibrationPlan.access_basis, 'subscription');
  assert.deepStrictEqual(calibrationPlan.quota_budget, {
    max_cli_runs: 4,
    max_model_runtime_minutes: 160,
  });
  assert.strictEqual(calibrationPlan.approval_status, 'completed');
  assert.strictEqual(calibrationPlan.quota_acknowledged, true);
  assert.strictEqual(calibrationPlan.record_digest, freeze.calibration_record_digest);
  assert.strictEqual(digest(calibrationForensics), freeze.calibration_forensics_digest);
  assert(['approved', 'completed'].includes(diagnosticPilotPlan.approval_status));
  assert.strictEqual(diagnosticPilotPlan.quota_acknowledged, true);
  assert.strictEqual(diagnosticPilotPlan.approved_by, 'Seth Gammon');
  assert(Number.isFinite(Date.parse(diagnosticPilotPlan.approved_at)));
  assert.strictEqual(diagnosticPilotPlan.total_runs, 2);
  assert.deepStrictEqual(diagnosticPilotPlan.quota_budget, {
    max_cli_runs: 2,
    max_model_runtime_minutes: 80,
  });
  assert.strictEqual(diagnosticPilotPlan.approval_status, 'completed');
  assert.strictEqual(digest(diagnosticPilotRecord), diagnosticPilotPlan.record_digest);
  assert.strictEqual(
    digest(diagnosticPilotForensics),
    freeze.diagnostic_pilot_forensics_digest,
  );
  assert.strictEqual(diagnosticPilotForensics.model_calls_made, 0);
  assert.strictEqual(diagnosticPilotForensics.claude_observation.replay_task_verified, true);
  assert.strictEqual(diagnosticPilotForensics.codex_observation.replay_task_verified, false);
  assert.notStrictEqual(
    scenarioSetIdentity(diagnosticPilotScenarios),
    scenarioSetIdentity(scenarios),
  );
  assert.notStrictEqual(scenarioSetIdentity(calibrationScenarios), scenarioSetIdentity(scenarios));
  assert.strictEqual(
    scenarioSetIdentity(calibrationScenarios),
    JSON.parse(fs.readFileSync(path.join(BENCHMARK, 'calibration-record.json'), 'utf8')).scenario_set_id,
  );
  assert.throws(() => validateCalibrationForensics({
    ...calibrationForensics,
    model_calls_made: 1,
  }, calibrationScenarios, scenarios), /observation boundary/);
  assert.strictEqual(Object.hasOwn(calibrationPlan, 'approved_spend_usd'), false);
  assert.throws(() => validateCalibrationPlan({
    ...calibrationPlan,
    quota_budget: { ...calibrationPlan.quota_budget, max_cli_runs: 13 },
  }, calibrationScenarios, executors), /quota_budget/);
  assert.throws(() => validateCalibrationPlan({
    ...calibrationPlan,
    approval_status: 'approved',
    quota_acknowledged: false,
    approved_by: 'Seth Gammon',
    approved_at: '2026-07-30T00:00:00.000Z',
  }, calibrationScenarios, executors), /quota acknowledgement/);
  const pendingCalibrationPlan = {
    ...calibrationPlan,
    approval_status: 'pending',
    quota_acknowledged: false,
    approved_by: null,
    approved_at: null,
    record_digest: null,
  };
  assert.doesNotThrow(() => validateCalibrationPlan(pendingCalibrationPlan, calibrationScenarios, executors));
  const approvedCalibrationPlan = {
    ...calibrationPlan,
    approval_status: 'approved',
    quota_acknowledged: true,
    approved_by: 'Seth Gammon',
    approved_at: '2026-07-30T00:00:00.000Z',
    record_digest: null,
  };
  assert.doesNotThrow(() => validateCalibrationPlan(approvedCalibrationPlan, calibrationScenarios, executors));
  const calibrationCaseList = calibrationCases(calibrationPlan, calibrationScenarios, executors);
  assert.strictEqual(calibrationCaseList.length, 4);
  assert.strictEqual(calibrationCaseList[0].scenario.id, calibrationPlan.scenario_ids[0]);
  assert.strictEqual(calibrationCaseList[0].profile.profile_id, calibrationPlan.profile_ids[0]);
  const calibrationRun = {
    ...generateFixtureRuns(scenarios, executors, truth, 3)[0],
    evidence_kind: 'actual-run',
    scenario_id: calibrationCaseList[0].scenario.id,
    selected_profile_id: calibrationCaseList[0].profile.profile_id,
    observed_profile_id: calibrationCaseList[0].profile.profile_id,
    requested_model: calibrationCaseList[0].profile.model,
    observed_model: calibrationCaseList[0].profile.model,
    model_proof_status: 'passed',
    receipt_status: 'verified',
    cost: knownCost(0.01),
    outcome: 'passed',
    verified: true,
    attestation: null,
  };
  const approvedDiagnosticPilotPlan = {
    ...diagnosticPilotPlan,
    approval_status: 'approved',
    quota_acknowledged: true,
    approved_by: 'Seth Gammon',
    approved_at: '2026-07-30T00:00:00.000Z',
    record_digest: null,
  };
  assert.doesNotThrow(() => validateDiagnosticPilotPlan(
    approvedDiagnosticPilotPlan,
    diagnosticPilotScenarios,
    executors,
  ));
  const diagnosticCases = diagnosticPilotCases(
    approvedDiagnosticPilotPlan,
    diagnosticPilotScenarios,
    executors,
  );
  assert.strictEqual(diagnosticCases.length, 2);
  assert.deepStrictEqual(
    new Set(diagnosticCases.map((item) => item.profile.runtime)),
    new Set(['claude', 'codex']),
  );
  const diagnosticRuns = diagnosticCases.map(({ scenario, profile }) => ({
    ...calibrationRun,
    scenario_set_id: scenarioSetIdentity(diagnosticPilotScenarios),
    scenario_id: scenario.id,
    selected_profile_id: profile.profile_id,
    observed_profile_id: profile.profile_id,
    requested_model: profile.model,
    observed_model: profile.model,
    outcome: 'passed',
    verified: true,
    failure_code: null,
    verification_receipts: calibrationRun.verification_receipts.map((receipt) => ({
      ...receipt,
      profile_id: profile.profile_id,
      status: 'passed',
      exit_code: 0,
    })),
  }));
  const diagnosticObservations = diagnosticRuns.map((run, index) => (
    diagnosticPilotObservation(run, diagnosticCases[index].profile)
  ));
  const diagnosticRecord = {
    schema: 1,
    kind: 'citadel_optimizer_diagnostic_pilot_record',
    authorization_digest: diagnosticPilotAuthorizationDigest(approvedDiagnosticPilotPlan),
    scenario_set_id: scenarioSetIdentity(diagnosticPilotScenarios),
    executor_set_id: executorSetIdentity(executors),
    access_basis: approvedDiagnosticPilotPlan.access_basis,
    quota_budget: approvedDiagnosticPilotPlan.quota_budget,
    started_at: '2026-07-30T00:00:00.000Z',
    completed_at: '2026-07-30T00:01:00.000Z',
    status: 'passed',
    planned_run_count: 2,
    completed_run_count: 2,
    stop_reason: null,
    runs: diagnosticObservations,
  };
  assert.doesNotThrow(() => validateDiagnosticPilotRecord(
    diagnosticRecord,
    approvedDiagnosticPilotPlan,
    diagnosticPilotScenarios,
    executors,
  ));
  assert.throws(() => validateDiagnosticPilotRecord({
    ...diagnosticRecord,
    runs: diagnosticRecord.runs.map((run) => ({
      ...run,
      task_outcome: 'failed',
      task_verified: false,
      failure_code: 'VERIFICATION_FAILED',
      verification_receipts: run.verification_receipts.map((receipt) => ({
        ...receipt,
        status: 'failed',
        exit_code: 1,
      })),
    })),
  }, approvedDiagnosticPilotPlan, diagnosticPilotScenarios, executors), /task-verifier pass/);
  const calibrationRecord = {
    schema: 1,
    kind: 'citadel_optimizer_calibration_record',
    authorization_digest: calibrationAuthorizationDigest(approvedCalibrationPlan),
    scenario_set_id: scenarioSetIdentity(calibrationScenarios),
    executor_set_id: executorSetIdentity(executors),
    access_basis: approvedCalibrationPlan.access_basis,
    quota_budget: approvedCalibrationPlan.quota_budget,
    started_at: '2026-07-30T00:00:00.000Z',
    completed_at: null,
    status: 'running',
    planned_run_count: 4,
    completed_run_count: 1,
    stop_reason: null,
    runs: [calibrationObservation(calibrationRun, calibrationCaseList[0].profile)],
  };
  assert.doesNotThrow(() => validateCalibrationRecord(
    calibrationRecord,
    approvedCalibrationPlan,
    calibrationScenarios,
    executors,
  ));
  assert.throws(() => validateCalibrationRecord(
    calibrationRecord,
    pendingCalibrationPlan,
    calibrationScenarios,
    executors,
  ), /approved subscription quota/);
  assert.throws(() => validateCalibrationRecord({
    ...calibrationRecord,
    quota_budget: { ...calibrationRecord.quota_budget, max_cli_runs: 13 },
  }, approvedCalibrationPlan, calibrationScenarios, executors), /frozen authorization/);
  assert.throws(() => validateCalibrationRecord({
    ...calibrationRecord,
    status: 'passed',
    completed_at: '2026-07-30T00:01:00.000Z',
  }, approvedCalibrationPlan, calibrationScenarios, executors), /every frozen calibration case/);
  assert(executors.every((executor) => executor.executor_profile_digest === boundExecutorProfileDigest(executor)));
  assert.strictEqual(freeze.scenario_set_id, scenarioSetIdentity(scenarios));
  assert.strictEqual(freeze.executor_set_id, executorSetIdentity(executors));
  assert.strictEqual(freeze.metric_set_id, metricSetIdentity());
  assert.deepStrictEqual(freeze.holdout_scenario_ids, scenarios.filter((scenario) => scenario.holdout).map((scenario) => scenario.id));
  assert.strictEqual(FIXTURE_PRICING_DIGEST, digest(
    JSON.parse(fs.readFileSync(path.join(BENCHMARK, 'fixtures', 'pricing-assumptions.json'), 'utf8')),
  ));
  assert(publicIndex.includes('href="optimizer.html">Optimizer Proof</a>'));
  assert(optimizerPage.includes('Measurement contract proven'));
  assert(optimizerPage.includes('The verifier rejected three economic stories.'));
  assert(optimizerPage.includes('168 / 168 signed'));
  assert(optimizerPage.includes('V3 · artifacts verified, savings gate missed'));
  assert(optimizerPage.includes('ECONOMIC_TARGET_OPEN'));
  assert(optimizerPage.includes('Fixture math exercises a 23.2507%'));
  assert.strictEqual((optimizerPage.match(/class="policy-tab"/g) || []).length, 4);

  assert.throws(() => validateScenario({ ...scenarios[0], pinned_ref: 'main' }), /full commit SHA/);
  assert.throws(() => validateScenario({ ...scenarios[0], unexpected: true }), /exactly match/);
  assert.throws(() => validateScenario({ ...scenarios[0], expected_artifacts: ['../escape'] }), /escapes/);
  assert.throws(() => validateFreeze({ ...freeze, scenario_set_id: 'optimizer-scenarios-sha256:forged' }, scenarios, executors), /mismatch/);
  assert.throws(() => validateCost({
    ...unknownCost(),
    amount_usd: 0,
  }), /unknown cost cannot carry/);
  assert.throws(() => validateCost({
    status: 'known',
    amount_usd: 1,
    provenance: 'price_derived',
    source: 'test',
    source_ref: 'test',
    pricing_snapshot_digest: null,
    components: [],
  }), /pricing snapshot/);
  assert.throws(() => validateCost({
    status: 'known',
    amount_usd: 2,
    provenance: 'vendor_reported',
    source: 'test',
    source_ref: 'test',
    pricing_snapshot_digest: null,
    components: [{ kind: 'model', amount_usd: 1, source: 'test' }],
  }), /do not sum/);

  const fixtureRuns = generateFixtureRuns(scenarios, executors, truth, freeze.repetitions);
  assert.strictEqual(fixtureRuns.length, 120);
  fixtureRuns.forEach(validateRun);
  const report = buildReport(fixtureRuns, { scenarios, executors, freeze });
  assert.strictEqual(report.engineering_gate.status, 'passed');
  assert.strictEqual(report.preliminary_performance_gate.status, 'passed',
    'fixture math should exercise a passing threshold while remaining non-claim evidence');
  assert(report.preliminary_performance_gate.median_cost_reduction_vs_frontier >= 0.20);
  assert.strictEqual(report.claim_status, 'engineering-contract-only');
  assert.strictEqual(report.submission_gate.status, 'open');
  for (const blocker of [
    'ACTUAL_RUNS_REQUIRED',
    'ACTUAL_RUNS_UNATTESTED',
    'MATRIX_QUOTA_NOT_APPROVED',
  ]) assert(report.submission_gate.blockers.includes(blocker), `missing blocker ${blocker}`);
  assert.strictEqual(report.submission_gate.blockers.includes('EXTERNAL_SCENARIO_NOT_SELECTED'), false);
  assert.strictEqual(report.submission_gate.blockers.includes('EXTERNAL_REPRODUCTION_REQUIRED'), false);

  const unknownRuns = fixtureRuns.map((run, index) => (
    index === fixtureRuns.findIndex((item) => item.holdout && item.policy_id === 'adaptive')
      ? { ...run, cost: unknownCost('test', 'telemetry_missing') }
      : run
  ));
  const unknownReport = buildReport(unknownRuns, { scenarios, executors, freeze });
  assert.strictEqual(unknownReport.preliminary_performance_gate.status, 'open');
  assert.strictEqual(unknownReport.held_out.adaptive.median_cost_usd, null);
  assert.strictEqual(unknownReport.preliminary_performance_gate.unknown_cost_excluded_from_savings, false);

  const adversarialIndex = fixtureRuns.findIndex((run) => run.adversarial_result === 'detected');
  const falsePassRuns = fixtureRuns.map((run, index) => (
    index === adversarialIndex ? { ...run, adversarial_result: 'false_pass' } : run
  ));
  const falsePassReport = buildReport(falsePassRuns, { scenarios, executors, freeze });
  assert.strictEqual(falsePassReport.engineering_gate.status, 'failed');
  assert.strictEqual(falsePassReport.engineering_gate.adversarial_false_passes, 1);
  assert(falsePassReport.submission_gate.blockers.includes('ADVERSARIAL_FALSE_PASS'));

  const pLimitShort = scenarios.find((scenario) => scenario.id === 'p-limit-short-clear-queue');
  const pLimitTruth = truth.scenarios.find((entry) => entry.scenario_id === pLimitShort.id);
  const shortProbe = fixtureProbe(pLimitShort, pLimitTruth.probe_facts);
  const shortAdaptive = route({
    scenario: pLimitShort,
    executors,
    policyId: 'adaptive',
    probe: shortProbe,
  });
  assert.strictEqual(shortAdaptive.selected_profile_id, 'claude-workhorse');
  assert.strictEqual(shortAdaptive.prediction_source, 'policy_assumption');
  const nanoid = scenarios.find((scenario) => scenario.id === 'nanoid-size-consistency');
  const nanoTruth = truth.scenarios.find((entry) => entry.scenario_id === nanoid.id);
  const nanoAdaptive = route({
    scenario: nanoid,
    executors,
    policyId: 'adaptive',
    probe: fixtureProbe(nanoid, nanoTruth.probe_facts),
  });
  assert(['claude-frontier', 'codex-frontier'].includes(nanoAdaptive.selected_profile_id));
  assert.throws(() => validateDecision({ ...shortAdaptive, predicted_cost_usd: 0 }), /does not bind/);
  const escalation = nextAdaptiveAction(shortAdaptive, {
    verification_status: 'failed',
    progress_status: 'stalled',
    attempts: 1,
    budget_remaining_usd: null,
  }, executors);
  assert.strictEqual(escalation.action, 'escalate');
  assert(['claude-frontier', 'codex-frontier'].includes(escalation.target_profile_id));
  assert.strictEqual(nextAdaptiveAction(shortAdaptive, {
    verification_status: 'passed',
    progress_status: 'progress',
    attempts: 1,
    budget_remaining_usd: null,
  }, executors).action, 'stop');

  const training = fixtureRuns.filter((run) => !run.holdout);
  const learned = learnCapabilityProfiles(executors, training);
  assert(learned.some((profile) => profile.priors.source === 'training_evidence'));
  assert(learned.filter((profile) => profile.priors.source === 'training_evidence')
    .every((profile) => planningProfile(profile).source === 'training_evidence'));
  assert.throws(() => learnCapabilityProfiles(executors, fixtureRuns), /Held-out runs cannot calibrate/);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-optimizer-test-'));
  try {
    const probeRoot = path.join(temp, 'probe');
    fs.mkdirSync(path.join(probeRoot, 'test'), { recursive: true });
    fs.writeFileSync(path.join(probeRoot, 'package.json'), JSON.stringify({
      scripts: { test: 'node test.js', lint: 'eslint .' },
    }));
    fs.writeFileSync(path.join(probeRoot, 'index.js'), 'export default 1;\n');
    fs.writeFileSync(path.join(probeRoot, 'test', 'clear-queue.test.js'), 'test("clear queue", () => {});\n');
    const probed = probeWorkspace(probeRoot, pLimitShort, { observedAt: '2026-01-02T00:00:00.000Z' });
    assert.strictEqual(probed.status, 'complete');
    assert.strictEqual(probed.facts.has_tests, true);
    assert(probed.facts.test_commands.includes('bun run test'));
    assert.strictEqual(probed.signals.scope, 'localized');

    const expectedProfile = executors.find((profile) => profile.profile_id === shortAdaptive.selected_profile_id);
    const adapterOutput = {
      schema: 1,
      profile_id: expectedProfile.profile_id,
      requested_model: expectedProfile.model,
      observed_model: expectedProfile.model,
      model_proof_status: 'passed',
      receipt_status: 'verified',
      cost: knownCost(0.5),
      human_interventions: 0,
      progress_status: 'progress',
    };
    assert.deepStrictEqual(validateAdapterOutput(adapterOutput, expectedProfile), adapterOutput);
    assert.throws(() => validateAdapterOutput({
      ...adapterOutput,
      observed_model: 'substituted-model',
    }, expectedProfile), /ADAPTER_OUTPUT_INVALID/);
  assert.strictEqual(sumAttemptCosts([knownCost(0.5), knownCost(0.25)]).amount_usd, 0.75);
    assert.strictEqual(sumAttemptCosts([knownCost(0.5), unknownCost()]).status, 'unknown');
    assert.deepStrictEqual(changedArtifacts(probeRoot, pLimitShort, () => ({
      status: 0,
      stdout: 'test.js\n',
    }), 1000), { passed: true, paths: ['test.js'], changed_paths: ['test.js'] });
    const diagnosticReceipt = verificationReceipt({
      attempt: 1,
      profileId: expectedProfile.profile_id,
      verification: {
        status: 1,
        stdout: `${probeRoot}\\test.js\n${'x'.repeat(9000)}`,
        stderr: `${process.env.USERPROFILE || ''}\\private\n${['ghp', '123456789012345678901234567890123456'].join('_')}`,
        timed_out: false,
      },
      patch: {
        status: 0,
        stdout: `diff --git a/test.js b/test.js\n--- ${probeRoot}\\test.js\n+++ ${probeRoot}\\test.js\n`,
      },
      changedPaths: ['test.js'],
      sandbox: temp,
      workspace: probeRoot,
    });
    assert.strictEqual(diagnosticReceipt.status, 'failed');
    assert.strictEqual(diagnosticReceipt.output_truncated, true);
    assert(diagnosticReceipt.output_excerpt.length <= 8192);
    assert(!diagnosticReceipt.output_excerpt.includes(probeRoot));
    assert(!diagnosticReceipt.output_excerpt.includes('ghp_'));
    assert(diagnosticReceipt.output_excerpt.includes('<REDACTED_SECRET_OR_PATH>'));
    assert(!diagnosticReceipt.patch_excerpt.includes(probeRoot));
    assert(diagnosticReceipt.patch_excerpt.includes('<WORKSPACE>'));
    assert.strictEqual(redactDiagnosticText(probeRoot, temp, probeRoot), '<WORKSPACE>');

    const adapterFile = path.join(temp, 'adapter.js');
    fs.writeFileSync(adapterFile, '// mock adapter file\n');
    const mockExecutors = executors.map((profile) => ({
      ...profile,
      adapter_digest: adapterSourceDigest(adapterFile),
    }));
    function fakeExecute(argv) {
      const ok = { status: 0, stdout: '', stderr: '', error: null, timed_out: false };
      if (argv[0] === 'git' && argv[1] === 'clone') {
        const workspace = argv.at(-1);
        fs.mkdirSync(workspace, { recursive: true });
        fs.writeFileSync(path.join(workspace, 'package.json'), '{"scripts":{"test":"node test.js"}}\n');
        fs.writeFileSync(path.join(workspace, 'test.js'), '// target\n');
        return ok;
      }
      if (argv[0] === process.execPath
        && fs.realpathSync(path.resolve(argv[1] || '')) === fs.realpathSync(path.resolve(adapterFile))) {
        const input = JSON.parse(fs.readFileSync(argv[2], 'utf8'));
        fs.writeFileSync(input.output_path, JSON.stringify({
          schema: 1,
          profile_id: input.profile.profile_id,
          requested_model: input.profile.model,
          observed_model: input.profile.model,
          model_proof_status: 'passed',
          receipt_status: 'verified',
          cost: knownCost(0.5),
          human_interventions: 0,
          progress_status: 'progress',
        }));
        return ok;
      }
      if (argv[0] === 'git' && argv[1] === 'diff') return { ...ok, stdout: 'test.js\n' };
      return ok;
    }
    const unsigned = runScenario({
      scenario: pLimitShort,
      scenarios,
      executors: mockExecutors,
      policyId: 'adaptive',
      repetition: 1,
      adapterFile,
      executeCommand: fakeExecute,
      observedAt: '2026-01-03T00:00:00.000Z',
    });
    assert.strictEqual(unsigned.outcome, 'passed');
    assert.strictEqual(unsigned.verified, true);
    assert.strictEqual(unsigned.cost.status, 'known');
    assert.strictEqual(unsigned.verification_receipts.length, 1);
    assert.strictEqual(unsigned.verification_receipts[0].status, 'passed');
    assert.strictEqual(unsigned.verification_receipts[0].profile_id, unsigned.selected_profile_id);
    assert.throws(() => validateRun({
      ...unsigned,
      verification_receipts: [{
        ...unsigned.verification_receipts[0],
        output_excerpt: 'x'.repeat(8193),
      }],
    }), /output_excerpt/);
    const keys = crypto.generateKeyPairSync('ed25519');
    const signed = attestRun(unsigned, keys.privateKey);
    assert.strictEqual(verifyRunAttestation(signed, keys.publicKey), true);
    assert.strictEqual(verifyRunAttestation({ ...signed, duration_ms: signed.duration_ms + 1 }, keys.publicKey), false);

    const claudeRepository = path.join(temp, 'claude-repository');
    const claudeHome = path.join(temp, 'claude-home');
    const claudeSessionId = '1777fd1c-78e6-4b90-8c6b-a067acc6c931';
    const claudeSessionDirectory = path.join(
      claudeHome,
      '.claude',
      'projects',
      'fixture-project',
    );
    fs.mkdirSync(claudeRepository, { recursive: true });
    fs.mkdirSync(claudeSessionDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(claudeSessionDirectory, `${claudeSessionId}.jsonl`),
      `${JSON.stringify({
        type: 'assistant',
        cwd: claudeRepository,
        sessionId: claudeSessionId,
        message: { model: 'claude-sonnet-5' },
      })}\n`,
    );
    const claudeReceipt = JSON.stringify({
      session_id: claudeSessionId,
      total_cost_usd: 0.25,
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 25,
        output_tokens: 50,
      },
    });
    const claudeFromSession = runtimeAdapter.claudeObservation(
      claudeReceipt,
      claudeRepository,
      { USERPROFILE: claudeHome },
    );
    assert.strictEqual(claudeFromSession.model, 'claude-sonnet-5');
    assert.strictEqual(claudeFromSession.source, 'claude-json+session-jsonl');
    assert.strictEqual(runtimeAdapter.claudeObservation(
      claudeReceipt,
      path.join(temp, 'different-repository'),
      { USERPROFILE: claudeHome },
    ).model, null);

    const raw = path.join(temp, 'fixture.jsonl');
    const aggregate = path.join(temp, 'report.json');
    const fixtureCli = invoke(['fixture', '--output', raw]);
    assert.strictEqual(fixtureCli.status, 0, fixtureCli.stderr);
    assert.strictEqual(fs.readFileSync(raw, 'utf8').trim().split(/\r?\n/).length, 120);
    const reportCli = invoke(['report', '--input', raw, '--output', aggregate]);
    assert.strictEqual(reportCli.status, 0, reportCli.stderr);
    assert.strictEqual(JSON.parse(fs.readFileSync(aggregate, 'utf8')).claim_status, 'engineering-contract-only');
    const bundleDirectory = path.join(temp, 'bundle');
    const bundle = buildBundle({
      root: ROOT,
      rawFile: raw,
      reportFile: aggregate,
      outputDirectory: bundleDirectory,
    });
    const verifiedBundle = verifyBundle(bundleDirectory);
    assert.strictEqual(verifiedBundle.valid, true);
    assert.strictEqual(verifiedBundle.bundle_id, bundle.manifest.bundle_id);
    assert.strictEqual(verifiedBundle.report_reproduced, true);
    for (const record of bundle.manifest.files) {
      const bundledText = fs.readFileSync(
        path.join(bundleDirectory, ...record.path.split('/')),
        'utf8',
      );
      assert(
        !bundledText.includes('\r'),
        `Proof bundle text must use portable LF line endings: ${record.path}`,
      );
    }
    assert.strictEqual(verifiedBundle.calibration_record_verified, true);
    assert.strictEqual(verifiedBundle.calibration_forensics_verified, true);
    assert.strictEqual(verifiedBundle.diagnostic_pilot_plan_verified, true);
    assert.strictEqual(verifiedBundle.diagnostic_pilot_record_verified, true);
    assert.strictEqual(verifiedBundle.diagnostic_pilot_forensics_verified, true);
    const bundledCalibration = path.join(bundleDirectory, 'inputs', 'calibration-record.json');
    assert.strictEqual(fs.existsSync(bundledCalibration), true);
    assert.strictEqual(fs.existsSync(path.join(bundleDirectory, 'inputs', 'calibration-forensics.json')), true);
    assert.strictEqual(fs.existsSync(path.join(bundleDirectory, 'inputs', 'diagnostic-pilot-plan.json')), true);
    assert.strictEqual(fs.existsSync(path.join(bundleDirectory, 'inputs', 'diagnostic-pilot-record.json')), true);
    assert.strictEqual(fs.existsSync(path.join(bundleDirectory, 'inputs', 'diagnostic-pilot-forensics.json')), true);
    assert.strictEqual(fs.existsSync(path.join(
      bundleDirectory,
      'inputs',
      'diagnostic-pilot-scenarios',
      '10-p-limit-cleanup-pending.json',
    )), true);
    assert.strictEqual(fs.existsSync(path.join(
      bundleDirectory,
      'inputs',
      'calibration-scenarios',
      '10-p-limit-cleanup-pending.json',
    )), true);
    const originalCalibration = fs.readFileSync(bundledCalibration, 'utf8');
    fs.writeFileSync(bundledCalibration, originalCalibration.replace('"status": "passed"', '"status": "failed"'));
    assert.throws(() => verifyBundle(bundleDirectory), /digest mismatch/);
    fs.writeFileSync(bundledCalibration, originalCalibration);
    fs.appendFileSync(path.join(bundleDirectory, 'README.md'), '\ntampered\n');
    assert.throws(() => verifyBundle(bundleDirectory), /digest mismatch/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const {
    privateKey: externalPrivateKey,
    publicKey: externalPublicKey,
  } = crypto.generateKeyPairSync('ed25519');
  const pricingSnapshot = validatePricingSnapshot({
    schema: 1,
    currency: 'USD',
    observed_at: '2026-07-29',
    source_url: 'https://example.com/pricing',
    billing_basis: 'official_api_list_price',
    models: [
      {
        provider: 'openai',
        model: 'codex-utility-exact',
        input_per_million_usd: 1,
        cached_input_per_million_usd: 0.1,
        output_per_million_usd: 4,
        standard_input_limit_tokens: 272000,
        over_limit_input_multiplier: 2,
        over_limit_output_multiplier: 1.5,
      },
      {
        provider: 'openai',
        model: 'codex-frontier-exact',
        input_per_million_usd: 2,
        cached_input_per_million_usd: 0.2,
        output_per_million_usd: 8,
        standard_input_limit_tokens: 272000,
        over_limit_input_multiplier: 2,
        over_limit_output_multiplier: 1.5,
      },
    ],
  });
  assert.throws(() => validateUsage({
    input_tokens: 1,
    cached_input_tokens: 2,
    output_tokens: 0,
  }), /exceeds/);
  const derived = deriveTokenCost(pricingSnapshot, 'openai', 'codex-utility-exact', {
    input_tokens: 1000,
    cached_input_tokens: 500,
    output_tokens: 100,
  });
  assert.strictEqual(derived.provenance, 'price_derived');
  assert.strictEqual(derived.amount_usd, 0.00095);
  assert.strictEqual(derived.pricing_snapshot_digest, pricingSnapshotDigest(pricingSnapshot));
  const adapterCodex = runtimeAdapter.codexObservation([
    JSON.stringify({ type: 'thread.started', thread_id: '019f5e9b-f6e6-7031-a377-7aeb4de3daea' }),
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 100 },
    }),
  ].join('\n'), ROOT, {});
  assert.deepStrictEqual(adapterCodex.usage, {
    input_tokens: 1000,
    cached_input_tokens: 500,
    output_tokens: 100,
  });
  const adapterDerived = runtimeAdapter.costForObservation(
    { runtime: 'codex', provider: 'openai', model: 'codex-utility-exact' },
    adapterCodex,
    pricingSnapshot,
  );
  assert.strictEqual(adapterDerived.amount_usd, 0.00095);
  assert.strictEqual(adapterDerived.pricing_snapshot_digest, pricingSnapshotDigest(pricingSnapshot));
  const adapterPath = path.join(ROOT, 'scripts', 'optimizer-runtime-adapter.js');
  const frozenAdapterDigest = adapterSourceDigest(adapterPath);
  assert(executors.every((profile) => profile.adapter_digest === frozenAdapterDigest));
  const crlfAdapter = path.join(os.tmpdir(), `optimizer-adapter-crlf-${process.pid}.js`);
  fs.writeFileSync(crlfAdapter, fs.readFileSync(adapterPath, 'utf8').replace(/\r?\n/g, '\r\n'));
  assert.strictEqual(adapterSourceDigest(crlfAdapter), frozenAdapterDigest);
  fs.rmSync(crlfAdapter, { force: true });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const boundExecutors = executors.map((profile, index) => {
    const candidate = {
      ...profile,
      model: `${profile.runtime}-${profile.tier}-exact`,
      executor_profile_digest: null,
      adapter_digest: `sha256:${String(index + 11).padStart(64, '0')}`,
    };
    return validateExecutorProfile({
      ...candidate,
      executor_profile_digest: boundExecutorProfileDigest(candidate),
    });
  });
  const preReproductionFreeze = validateFreeze({
    ...freeze,
    executor_set_id: executorSetIdentity(boundExecutors),
    pricing_snapshot_digest: pricingSnapshotDigest(pricingSnapshot),
    calibration_record_digest: `sha256:${'9'.repeat(64)}`,
    external_scenario: selectedExternalScenario,
    attestation_public_key: publicPem,
  }, scenarios, boundExecutors);
  const approvedMatrixAuthorization = validateMatrixAuthorization({
    ...matrixAuthorization,
    executor_set_id: preReproductionFreeze.executor_set_id,
    approval_status: 'approved',
    quota_acknowledged: true,
    approved_by: 'test-operator',
    approved_at: '2000-01-01T00:00:00.000Z',
  }, preReproductionFreeze, scenarios);
  const profileById = new Map(boundExecutors.map((profile) => [profile.profile_id, profile]));
  const actualRuns = fixtureRuns.map((run) => attestRun({
    ...run,
    requested_model: profileById.get(run.selected_profile_id).model,
    observed_model: profileById.get(run.observed_profile_id).model,
    cost: knownCost(run.cost.amount_usd, 'actual-test'),
  }, privateKey));
  const externalRun = attestRun({
    ...actualRuns.find((run) => run.scenario_id === selectedExternalScenario.scenario_id),
    attestation: null,
  }, externalPrivateKey);
  assert.throws(() => validateExternalReproduction({
    schema: 1,
    kind: 'citadel_optimizer_external_reproduction',
    scenario_id: selectedExternalScenario.scenario_id,
    reproduced_by: 'not-independent',
    reproduction_source: 'https://example.com/optimizer-reproduction',
    public_key: publicPem,
    run: actualRuns.find((run) => run.scenario_id === selectedExternalScenario.scenario_id),
  }, preReproductionFreeze), /must differ from the local matrix signer/);
  const externalReproduction = validateExternalReproduction({
    schema: 1,
    kind: 'citadel_optimizer_external_reproduction',
    scenario_id: selectedExternalScenario.scenario_id,
    reproduced_by: 'independent-maintainer',
    reproduction_source: 'https://example.com/optimizer-reproduction',
    public_key: externalPublicKey.export({ type: 'spki', format: 'pem' }),
    run: externalRun,
  }, preReproductionFreeze);
  const boundFreeze = validateFreeze({
    ...preReproductionFreeze,
    external_reproduction_digest: externalReproductionDigest(
      externalReproduction,
      preReproductionFreeze,
    ),
  }, scenarios, boundExecutors);
  const autonomousReport = buildReport(actualRuns, {
    scenarios,
    executors: boundExecutors,
    freeze: preReproductionFreeze,
    matrixAuthorization: approvedMatrixAuthorization,
  });
  assert.strictEqual(autonomousReport.submission_gate.status, 'passed');
  assert.strictEqual(autonomousReport.external_reproduction_verified, false);
  assert.strictEqual(autonomousReport.matrix_quota_authorization_verified, true);
  const actualReport = buildReport(actualRuns, {
    scenarios,
    executors: boundExecutors,
    freeze: boundFreeze,
    matrixAuthorization: approvedMatrixAuthorization,
    externalReproduction,
  });
  assert.strictEqual(actualReport.submission_gate.status, 'passed');
  assert.strictEqual(actualReport.claim_status, 'preliminary-performance-supported');
  const tamperedActual = actualRuns.map((run, index) => (
    index === 0 ? { ...run, cost: knownCost(0, 'tampered') } : run
  ));
  const tamperedReport = buildReport(tamperedActual, {
    scenarios,
    executors: boundExecutors,
    freeze: boundFreeze,
    matrixAuthorization: approvedMatrixAuthorization,
    externalReproduction,
  });
  assert.strictEqual(tamperedReport.actual_run_attestation_verified, false);
  assert(tamperedReport.submission_gate.blockers.includes('ACTUAL_RUNS_UNATTESTED'));

  const validateCli = invoke(['validate']);
  assert.strictEqual(validateCli.status, 0, validateCli.stderr);
  const validation = JSON.parse(validateCli.stdout);
  assert.strictEqual(validation.valid, true);
  assert.strictEqual(validation.actual_run_status, 'blocked');
  const calibrationCli = invoke(['calibration-plan']);
  assert.strictEqual(calibrationCli.status, 0, calibrationCli.stderr);
  const calibrationOutput = JSON.parse(calibrationCli.stdout);
  assert.strictEqual(calibrationOutput.no_model_calls_made, true);
  assert.strictEqual(calibrationOutput.plan.total_runs, 4);
  assert.strictEqual(calibrationOutput.plan.approval_status, 'completed');
  assert.strictEqual(calibrationOutput.blockers.includes('CALIBRATION_REQUIRED'), false);
  const pilotPlanCli = invoke(['pilot-plan']);
  assert.strictEqual(pilotPlanCli.status, 0, pilotPlanCli.stderr);
  const pilotPlanOutput = JSON.parse(pilotPlanCli.stdout);
  assert.strictEqual(pilotPlanOutput.no_model_calls_made, true);
  assert.strictEqual(pilotPlanOutput.plan.total_runs, 2);
  assert.strictEqual(
    pilotPlanOutput.plan.approval_status,
    diagnosticPilotPlan.approval_status,
  );
  const pilotRecordPath = path.join(BENCHMARK, 'diagnostic-pilot-record.json');
  assert.strictEqual(pilotPlanOutput.record_present, fs.existsSync(pilotRecordPath));
  assert.strictEqual(pilotPlanOutput.plan.quota_acknowledged, true);
  const selectionCli = invoke(['selection-request']);
  assert.strictEqual(selectionCli.status, 0, selectionCli.stderr);
  const selectionOutput = JSON.parse(selectionCli.stdout);
  assert.strictEqual(selectionOutput.no_model_calls_made, true);
  assert.deepStrictEqual(selectionOutput.current_selection, freeze.external_scenario);
  assert.strictEqual(selectionOutput.request.request_id, selectionRequest.request_id);
  assert.deepStrictEqual(
    selectionOutput.request.holdout_scenario_ids,
    freeze.holdout_scenario_ids,
  );
  const reproductionPlanCli = invoke(['reproduction-plan']);
  assert.strictEqual(reproductionPlanCli.status, 0, reproductionPlanCli.stderr);
  const reproductionPlanOutput = JSON.parse(reproductionPlanCli.stdout);
  assert.strictEqual(reproductionPlanOutput.no_model_calls_made, true);
  assert.strictEqual(reproductionPlanOutput.status, 'ready');
  assert.deepStrictEqual(reproductionPlanOutput.blockers, []);
  const selectionTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'optimizer-selection-'));
  try {
    const requestPath = path.join(selectionTemp, 'request.json');
    const selectionFileCli = invoke(['selection-request', '--output', requestPath]);
    assert.strictEqual(selectionFileCli.status, 0, selectionFileCli.stderr);
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(requestPath, 'utf8')),
      selectionRequest,
    );
    const responsePath = path.join(selectionTemp, 'selection.json');
    const candidateFreezePath = path.join(selectionTemp, 'freeze.candidate.json');
    fs.writeFileSync(responsePath, `${JSON.stringify(selectionRecord, null, 2)}\n`);
    const freezeSelectionCli = invoke([
      'freeze-selection',
      '--input', responsePath,
      '--output', candidateFreezePath,
    ]);
    assert.notStrictEqual(freezeSelectionCli.status, 0);
    assert.match(freezeSelectionCli.stderr, /already frozen/);
    assert.strictEqual(fs.existsSync(candidateFreezePath), false);
  } finally {
    fs.rmSync(selectionTemp, { recursive: true, force: true });
  }
  const matrixCli = invoke(['matrix-plan']);
  assert.strictEqual(matrixCli.status, 0, matrixCli.stderr);
  const matrixOutput = JSON.parse(matrixCli.stdout);
  assert.strictEqual(matrixOutput.no_model_calls_made, true);
  assert.strictEqual(matrixOutput.run_count, 120);
  assert.strictEqual(new Set(matrixOutput.runs.map((run) => run.run_key)).size, 120);
  assert.strictEqual(matrixOutput.blockers.includes('EXTERNAL_SCENARIO_NOT_SELECTED'), false);
  assert.strictEqual(matrixOutput.blockers.includes('EXTERNAL_REPRODUCTION_REQUIRED'), false);
  assert.strictEqual(matrixOutput.blockers.includes('MATRIX_QUOTA_NOT_APPROVED'), false);
  assert.strictEqual(matrixOutput.authorization_status, 'approved');
  assert.deepStrictEqual(matrixOutput.quota_budget, matrixAuthorization.quota_budget);
  const actualBlocked = invoke([
    'run',
    '--scenario', scenarios[0].id,
    '--policy', 'adaptive',
    '--repetition', '1',
    '--adapter', __filename,
    '--output', path.join(os.tmpdir(), 'must-not-write-optimizer-run.json'),
  ]);
  assert.notStrictEqual(actualBlocked.status, 0);
  assert.match(actualBlocked.stderr, /run requires --signing-key/);
  const reproductionOutput = path.join(
    os.tmpdir(),
    `must-not-write-optimizer-reproduction-${process.pid}.json`,
  );
  fs.rmSync(reproductionOutput, { force: true });
  const reproductionBlocked = invoke([
    'reproduce',
    '--signing-key', __filename,
    '--reproduced-by', 'independent-maintainer',
    '--source', 'https://example.com/optimizer-reproduction',
    '--output', reproductionOutput,
  ]);
  assert.notStrictEqual(reproductionBlocked.status, 0);
  assert.match(reproductionBlocked.stderr, /requires --acknowledge-external-quota/);
  assert.strictEqual(fs.existsSync(reproductionOutput), false);

  process.stdout.write('Optimizer contracts, routing, runner, and proof tests passed.\n');
}

main();
