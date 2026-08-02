#!/usr/bin/env bun
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  executorSetIdentity,
  loadExecutors,
  loadFreeze,
  loadScenarios,
  metricSetIdentity,
  scenarioSetIdentity,
  digest,
  validateBenchmarkShape,
  validateFreeze,
} = require('../core/optimizer/contracts');
const { generateFixtureRuns, validateFixtureTruth } = require('../core/optimizer/fixture');
const { fixtureProbe, probeWorkspace } = require('../core/optimizer/probe');
const { route } = require('../core/optimizer/policy');
const { attestRun, buildReport } = require('../core/optimizer/report');
const { assertActualReady, runScenario } = require('../core/optimizer/runner');
const {
  pricingCoversExecutors,
  pricingSnapshotDigest,
  validatePricingSnapshot,
} = require('../core/optimizer/pricing');
const { platformInvocation } = require('../core/forks/launcher');
const { validateExecutorBindings } = require('../core/optimizer/executor-binding');
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
} = require('../core/optimizer/external-selection');
const {
  assertMatrixAuthorized,
  matrixAuthorizationDigest,
  validateMatrixAuthorization,
} = require('../core/optimizer/matrix-authorization');

const ROOT = path.resolve(__dirname, '..');
const BENCHMARK_ROOT = path.join(ROOT, 'benchmarks', 'optimizer-proof');
const SCENARIO_DIRECTORY = path.join(BENCHMARK_ROOT, 'scenarios');
const CALIBRATION_SCENARIO_DIRECTORY = path.join(BENCHMARK_ROOT, 'calibration-scenarios');
const DIAGNOSTIC_PILOT_SCENARIO_DIRECTORY = path.join(
  BENCHMARK_ROOT,
  'diagnostic-pilot-scenarios',
);
const EXECUTOR_FILE = path.join(BENCHMARK_ROOT, 'executors.json');
const FREEZE_FILE = path.join(BENCHMARK_ROOT, 'freeze.json');
const FIXTURE_TRUTH_FILE = path.join(BENCHMARK_ROOT, 'fixtures', 'truth.json');
const PRICING_FILE = path.join(BENCHMARK_ROOT, 'pricing.json');
const CALIBRATION_PLAN_FILE = path.join(BENCHMARK_ROOT, 'calibration-plan.json');
const CALIBRATION_RECORD_FILE = path.join(BENCHMARK_ROOT, 'calibration-record.json');
const CALIBRATION_FORENSICS_FILE = path.join(BENCHMARK_ROOT, 'calibration-forensics.json');
const DIAGNOSTIC_PILOT_PLAN_FILE = path.join(BENCHMARK_ROOT, 'diagnostic-pilot-plan.json');
const DIAGNOSTIC_PILOT_RECORD_FILE = path.join(BENCHMARK_ROOT, 'diagnostic-pilot-record.json');
const DIAGNOSTIC_PILOT_FORENSICS_FILE = path.join(
  BENCHMARK_ROOT,
  'diagnostic-pilot-forensics.json',
);
const MATRIX_AUTHORIZATION_FILE = path.join(BENCHMARK_ROOT, 'matrix-authorization.json');
const EXTERNAL_REPRODUCTION_FILE = path.join(BENCHMARK_ROOT, 'external-reproduction.json');

function args(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) parsed._.push(token);
    else {
      const key = token.slice(2);
      const next = argv[index + 1];
      parsed[key] = next && !next.startsWith('--') ? argv[++index] : true;
    }
  }
  return parsed;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeJsonl(file, values) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `${values.map((value) => JSON.stringify(value)).join('\n')}\n`, 'utf8');
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function checkedInBenchmark() {
  const scenarios = loadScenarios(SCENARIO_DIRECTORY);
  const calibrationScenarios = loadScenarios(CALIBRATION_SCENARIO_DIRECTORY);
  const diagnosticPilotScenarios = loadScenarios(DIAGNOSTIC_PILOT_SCENARIO_DIRECTORY);
  const executors = loadExecutors(EXECUTOR_FILE);
  validateBenchmarkShape(scenarios, executors);
  const freeze = loadFreeze(FREEZE_FILE, scenarios, executors);
  const matrixAuthorization = validateMatrixAuthorization(
    JSON.parse(fs.readFileSync(MATRIX_AUTHORIZATION_FILE, 'utf8')),
    freeze,
    scenarios,
  );
  const fixtureTruth = validateFixtureTruth(JSON.parse(fs.readFileSync(FIXTURE_TRUTH_FILE, 'utf8')), scenarios);
  const calibrationPlan = validateCalibrationPlan(
    JSON.parse(fs.readFileSync(CALIBRATION_PLAN_FILE, 'utf8')),
    calibrationScenarios,
    executors,
  );
  if (digest(calibrationPlan) !== freeze.calibration_plan_digest) {
    throw new Error('Frozen calibration plan digest mismatch');
  }
  if (calibrationPlan.record_digest !== freeze.calibration_record_digest) {
    throw new Error('Calibration plan and freeze record digests differ');
  }
  if (!fs.existsSync(CALIBRATION_FORENSICS_FILE)) throw new Error('Frozen calibration forensics are missing');
  const calibrationForensics = validateCalibrationForensics(
    JSON.parse(fs.readFileSync(CALIBRATION_FORENSICS_FILE, 'utf8')),
    calibrationScenarios,
    scenarios,
  );
  if (digest(calibrationForensics) !== freeze.calibration_forensics_digest) {
    throw new Error('Frozen calibration forensics digest mismatch');
  }
  const diagnosticPilotPlan = validateDiagnosticPilotPlan(
    JSON.parse(fs.readFileSync(DIAGNOSTIC_PILOT_PLAN_FILE, 'utf8')),
    diagnosticPilotScenarios,
    executors,
  );
  let diagnosticPilotRecord = null;
  if (diagnosticPilotPlan.record_digest !== null) {
    if (!fs.existsSync(DIAGNOSTIC_PILOT_RECORD_FILE)) {
      throw new Error('Completed diagnostic pilot record is missing');
    }
    diagnosticPilotRecord = validateDiagnosticPilotRecord(
      JSON.parse(fs.readFileSync(DIAGNOSTIC_PILOT_RECORD_FILE, 'utf8')),
      diagnosticPilotPlan,
      diagnosticPilotScenarios,
      executors,
    );
    if (digest(diagnosticPilotRecord) !== diagnosticPilotPlan.record_digest) {
      throw new Error('Diagnostic pilot record digest mismatch');
    }
  }
  if (diagnosticPilotRecord === null) {
    throw new Error('Diagnostic pilot forensics require a completed pilot record');
  }
  const diagnosticPilotForensics = validateDiagnosticPilotForensics(
    JSON.parse(fs.readFileSync(DIAGNOSTIC_PILOT_FORENSICS_FILE, 'utf8')),
    diagnosticPilotPlan,
    diagnosticPilotRecord,
    diagnosticPilotScenarios,
    scenarios,
  );
  if (digest(diagnosticPilotForensics) !== freeze.diagnostic_pilot_forensics_digest) {
    throw new Error('Diagnostic pilot forensics digest mismatch');
  }
  let calibrationRecord = null;
  if (freeze.calibration_record_digest !== null) {
    if (!fs.existsSync(CALIBRATION_RECORD_FILE)) throw new Error('Frozen calibration record is missing');
    calibrationRecord = validateCalibrationRecord(
      JSON.parse(fs.readFileSync(CALIBRATION_RECORD_FILE, 'utf8')),
      calibrationPlan,
      calibrationScenarios,
      executors,
    );
    if (digest(calibrationRecord) !== freeze.calibration_record_digest) {
      throw new Error('Frozen calibration record digest mismatch');
    }
  }
  let pricingSnapshot = null;
  if (freeze.pricing_snapshot_digest !== null) {
    if (!fs.existsSync(PRICING_FILE)) throw new Error('Frozen pricing snapshot is missing');
    pricingSnapshot = validatePricingSnapshot(JSON.parse(fs.readFileSync(PRICING_FILE, 'utf8')));
    if (pricingSnapshotDigest(pricingSnapshot) !== freeze.pricing_snapshot_digest) {
      throw new Error('Frozen pricing snapshot digest mismatch');
    }
  }
  let externalReproduction = null;
  if (freeze.external_reproduction_digest !== null) {
    if (!fs.existsSync(EXTERNAL_REPRODUCTION_FILE)) throw new Error('Frozen external reproduction is missing');
    externalReproduction = validateExternalReproduction(
      JSON.parse(fs.readFileSync(EXTERNAL_REPRODUCTION_FILE, 'utf8')),
      freeze,
    );
    if (externalReproductionDigest(externalReproduction, freeze) !== freeze.external_reproduction_digest) {
      throw new Error('Frozen external reproduction digest mismatch');
    }
  }
  return {
    scenarios,
    calibrationScenarios,
    diagnosticPilotScenarios,
    executors,
    freeze,
    fixtureTruth,
    pricingSnapshot,
    calibrationPlan,
    calibrationRecord,
    calibrationForensics,
    diagnosticPilotPlan,
    diagnosticPilotRecord,
    diagnosticPilotForensics,
    matrixAuthorization,
    externalReproduction,
  };
}

function runtimeProbe(runtime) {
  const command = runtime === 'claude' ? 'claude' : 'codex';
  let invocation;
  try {
    invocation = platformInvocation({ command, args: ['--version'] });
  } catch {
    invocation = { command, args: ['--version'] };
  }
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: false,
    timeout: 10000,
    windowsHide: true,
  });
  return {
    runtime,
    command,
    resolved_command: invocation.command,
    available: result.status === 0,
    version: result.status === 0 ? String(result.stdout || result.stderr || '').trim().slice(0, 200) : null,
    reason_code: result.status === 0
      ? 'RUNTIME_AVAILABLE'
      : result.error && result.error.code === 'ENOENT' ? 'RUNTIME_NOT_INSTALLED' : 'RUNTIME_NOT_LAUNCHABLE',
  };
}

function doctor(benchmark) {
  const runtimes = [...new Set(benchmark.executors.map((profile) => profile.runtime))].sort().map(runtimeProbe);
  const unresolvedModels = benchmark.executors
    .filter((profile) => profile.model.startsWith('runtime-default-'))
    .map((profile) => profile.profile_id);
  const unboundProfiles = benchmark.executors
    .filter((profile) => profile.executor_profile_digest === null)
    .map((profile) => profile.profile_id);
  const unboundAdapters = benchmark.executors
    .filter((profile) => profile.adapter_digest === null)
    .map((profile) => profile.profile_id);
  const invalidProfileBindings = benchmark.executors.every((profile) => profile.executor_profile_digest !== null)
    ? [...validateExecutorBindings(benchmark.executors)] : [];
  const blockers = [];
  if (runtimes.some((runtime) => !runtime.available)) blockers.push('RUNTIME_NOT_LAUNCHABLE');
  if (unresolvedModels.length) blockers.push('EXACT_MODELS_NOT_FROZEN');
  if (unboundProfiles.length) blockers.push('EXECUTOR_PROFILES_UNBOUND');
  if (invalidProfileBindings.length) blockers.push('EXECUTOR_PROFILE_BINDING_INVALID');
  if (unboundAdapters.length) blockers.push('EXECUTOR_ADAPTERS_UNBOUND');
  if (!benchmark.freeze.pricing_snapshot_digest) blockers.push('PRICING_SNAPSHOT_NOT_FROZEN');
  else if (!benchmark.pricingSnapshot || !pricingCoversExecutors(benchmark.pricingSnapshot, benchmark.executors)) {
    blockers.push('PRICING_SNAPSHOT_INCOMPLETE');
  }
  if (!benchmark.freeze.calibration_record_digest) blockers.push('CALIBRATION_REQUIRED');
  if (!benchmark.freeze.external_scenario) blockers.push('EXTERNAL_SCENARIO_NOT_SELECTED');
  if (benchmark.matrixAuthorization.approval_status !== 'approved'
    || benchmark.matrixAuthorization.quota_acknowledged !== true) {
    blockers.push('MATRIX_QUOTA_NOT_APPROVED');
  }
  if (!benchmark.freeze.attestation_public_key) blockers.push('ATTESTATION_KEY_NOT_FROZEN');
  return {
    schema: 1,
    kind: 'citadel_optimizer_doctor',
    status: blockers.length ? 'blocked' : 'ready',
    no_model_calls_made: true,
    runtimes,
    unresolved_models: unresolvedModels,
    unbound_profiles: unboundProfiles,
    invalid_profile_bindings: invalidProfileBindings,
    unbound_adapters: unboundAdapters,
    pricing_snapshot_digest: benchmark.freeze.pricing_snapshot_digest,
    calibration_record_digest: benchmark.freeze.calibration_record_digest,
    calibration_forensics_digest: benchmark.freeze.calibration_forensics_digest,
    calibration_scenario_set_id: scenarioSetIdentity(benchmark.calibrationScenarios),
    diagnostic_pilot_approval_status: benchmark.diagnosticPilotPlan.approval_status,
    diagnostic_pilot_record_present: benchmark.diagnosticPilotRecord !== null,
    diagnostic_pilot_forensics_digest: benchmark.freeze.diagnostic_pilot_forensics_digest,
    blockers,
  };
}

function privateEd25519Key(file) {
  const text = fs.readFileSync(path.resolve(file), 'utf8');
  const privateKey = crypto.createPrivateKey(text);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('signing key must be Ed25519');
  return privateKey;
}

function privateKeyForRun(file, freeze) {
  const privateKey = privateEd25519Key(file);
  const publicPem = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  if (publicPem.trim() !== freeze.attestation_public_key.trim()) {
    throw new Error('signing key does not match the frozen attestation public key');
  }
  return privateKey;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const options = args(process.argv.slice(2));
  const command = options._[0] || 'validate';
  if (options.scenarios || options.executors || options.freeze) {
    throw new Error('Publishable optimizer commands use only checked-in frozen benchmark inputs');
  }
  const benchmark = checkedInBenchmark();

  if (command === 'validate') {
    process.stdout.write(`${JSON.stringify({
      valid: true,
      scenario_count: benchmark.scenarios.length,
      repository_count: new Set(benchmark.scenarios.map((scenario) => scenario.repository)).size,
      runtime_count: new Set(benchmark.executors.map((executor) => executor.runtime)).size,
      scenario_set_id: scenarioSetIdentity(benchmark.scenarios),
      executor_set_id: executorSetIdentity(benchmark.executors),
      metric_set_id: metricSetIdentity(),
      policies: benchmark.freeze.policies,
      repetitions: benchmark.freeze.repetitions,
      diagnostic_pilot_status: benchmark.diagnosticPilotPlan.approval_status,
      actual_run_status: doctor(benchmark).status,
    }, null, 2)}\n`);
    return;
  }

  if (command === 'doctor') {
    process.stdout.write(`${JSON.stringify(doctor(benchmark), null, 2)}\n`);
    return;
  }

  if (command === 'calibration-plan') {
    process.stdout.write(`${JSON.stringify({
      no_model_calls_made: true,
      plan: benchmark.calibrationPlan,
      blockers: doctor(benchmark).blockers,
    }, null, 2)}\n`);
    return;
  }

  if (command === 'pilot-plan') {
    process.stdout.write(`${JSON.stringify({
      no_model_calls_made: true,
      plan: benchmark.diagnosticPilotPlan,
      record_present: benchmark.diagnosticPilotRecord !== null,
      output_path: path.relative(ROOT, DIAGNOSTIC_PILOT_RECORD_FILE).replace(/\\/g, '/'),
    }, null, 2)}\n`);
    return;
  }

  if (command === 'selection-request') {
    const request = buildExternalSelectionRequest(benchmark.freeze, benchmark.scenarios);
    if (options.output) {
      const output = path.resolve(options.output);
      if (fs.existsSync(output)) throw new Error('selection request output already exists');
      writeJson(output, request);
    }
    process.stdout.write(`${JSON.stringify({
      no_model_calls_made: true,
      request,
      current_selection: benchmark.freeze.external_scenario,
      output_path: options.output ? path.resolve(options.output) : null,
    }, null, 2)}\n`);
    return;
  }

  if (command === 'select-holdout') {
    if (!options.output) throw new Error('select-holdout requires --output');
    if (benchmark.freeze.external_scenario !== null) {
      throw new Error('Public-random scenario is already frozen');
    }
    const output = path.resolve(options.output);
    if (fs.existsSync(output)) throw new Error('selection output already exists');
    const request = buildExternalSelectionRequest(benchmark.freeze, benchmark.scenarios);
    if (Date.now() < Date.parse(request.beacon.round_time)) {
      throw new Error(`Committed drand round is not available before ${request.beacon.round_time}`);
    }
    const relayResponses = await Promise.all(request.beacon.source_urls.map(async (sourceUrl) => ({
      source_url: sourceUrl,
      beacon: await fetchJson(sourceUrl),
    })));
    const selection = buildBeaconSelectionRecord(
      request,
      benchmark.freeze,
      benchmark.scenarios,
      relayResponses,
      new Date().toISOString(),
    );
    writeJson(output, selection);
    process.stdout.write(`Wrote public-random holdout selection to ${output}; no model calls made\n`);
    return;
  }

  if (command === 'reproduction-plan') {
    const scenario = benchmark.freeze.external_scenario === null
      ? null
      : benchmark.scenarios.find((item) => item.id === benchmark.freeze.external_scenario.scenario_id);
    process.stdout.write(`${JSON.stringify({
      no_model_calls_made: true,
      status: scenario === null ? 'blocked' : 'ready',
      blockers: scenario === null ? ['EXTERNAL_SCENARIO_NOT_SELECTED'] : [],
      scenario_id: scenario === null ? null : scenario.id,
      policy_id: 'adaptive',
      repetition: 1,
      min_model_calls: scenario === null ? null : 1,
      max_model_calls: scenario === null ? null : scenario.max_attempts,
      max_model_runtime_minutes: scenario === null
        ? null
        : scenario.max_attempts * scenario.timeout_minutes,
      purpose: 'independent_reproduction_not_local_matrix_evidence',
    }, null, 2)}\n`);
    return;
  }

  if (command === 'freeze-selection') {
    for (const required of ['input', 'output']) {
      if (!options[required]) throw new Error(`freeze-selection requires --${required}`);
    }
    if (benchmark.freeze.external_scenario !== null) {
      throw new Error('External scenario is already frozen');
    }
    const output = path.resolve(options.output);
    if (fs.existsSync(output)) throw new Error('selection freeze output already exists');
    const request = buildExternalSelectionRequest(benchmark.freeze, benchmark.scenarios);
    const record = JSON.parse(fs.readFileSync(path.resolve(options.input), 'utf8'));
    const externalScenario = frozenSelectionFromRecord(
      record,
      request,
      benchmark.freeze,
      benchmark.scenarios,
    );
    const nextFreeze = validateFreeze({
      ...benchmark.freeze,
      external_scenario: externalScenario,
    }, benchmark.scenarios, benchmark.executors);
    writeJson(output, nextFreeze);
    process.stdout.write(`Wrote public-random selected candidate freeze to ${output}; no model calls made\n`);
    return;
  }

  if (command === 'verify-reproduction') {
    if (!options.input) throw new Error('verify-reproduction requires --input');
    const reproduction = validateExternalReproduction(
      JSON.parse(fs.readFileSync(path.resolve(options.input), 'utf8')),
      benchmark.freeze,
    );
    const recordDigest = externalReproductionDigest(reproduction, benchmark.freeze);
    process.stdout.write(`${JSON.stringify({
      valid: true,
      no_model_calls_made: true,
      scenario_id: reproduction.scenario_id,
      record_digest: recordDigest,
      bound_to_freeze: benchmark.freeze.external_reproduction_digest === recordDigest,
    }, null, 2)}\n`);
    return;
  }

  if (command === 'freeze-reproduction') {
    for (const required of ['input', 'output']) {
      if (!options[required]) throw new Error(`freeze-reproduction requires --${required}`);
    }
    if (benchmark.freeze.external_reproduction_digest !== null) {
      throw new Error('External reproduction is already frozen');
    }
    const output = path.resolve(options.output);
    if (fs.existsSync(output)) throw new Error('reproduction freeze output already exists');
    const reproduction = validateExternalReproduction(
      JSON.parse(fs.readFileSync(path.resolve(options.input), 'utf8')),
      benchmark.freeze,
    );
    const nextFreeze = validateFreeze({
      ...benchmark.freeze,
      external_reproduction_digest: externalReproductionDigest(
        reproduction,
        benchmark.freeze,
      ),
    }, benchmark.scenarios, benchmark.executors);
    writeJson(output, nextFreeze);
    process.stdout.write(`Wrote externally reproduced candidate freeze to ${output}; no model calls made\n`);
    return;
  }

  if (command === 'pilot') {
    if (benchmark.diagnosticPilotPlan.approval_status !== 'approved'
      || benchmark.diagnosticPilotPlan.quota_acknowledged !== true) {
      throw new Error('Diagnostic pilot requires an explicitly approved subscription quota');
    }
    if (fs.existsSync(DIAGNOSTIC_PILOT_RECORD_FILE)) {
      throw new Error('Diagnostic pilot record already exists; refusing duplicate quota consumption');
    }
    const readiness = doctor(benchmark);
    const allowedBlockers = new Set([
      'EXTERNAL_SCENARIO_NOT_SELECTED',
      'MATRIX_QUOTA_NOT_APPROVED',
    ]);
    const blocking = readiness.blockers.filter((blocker) => !allowedBlockers.has(blocker));
    if (blocking.length) throw new Error(`Diagnostic pilot readiness failed: ${blocking.join(', ')}`);
    const cases = diagnosticPilotCases(
      benchmark.diagnosticPilotPlan,
      benchmark.diagnosticPilotScenarios,
      benchmark.executors,
    );
    const record = {
      schema: 1,
      kind: 'citadel_optimizer_diagnostic_pilot_record',
      authorization_digest: diagnosticPilotAuthorizationDigest(benchmark.diagnosticPilotPlan),
      scenario_set_id: benchmark.diagnosticPilotPlan.scenario_set_id,
      executor_set_id: benchmark.freeze.executor_set_id,
      access_basis: benchmark.diagnosticPilotPlan.access_basis,
      quota_budget: benchmark.diagnosticPilotPlan.quota_budget,
      started_at: new Date().toISOString(),
      completed_at: null,
      status: 'running',
      planned_run_count: benchmark.diagnosticPilotPlan.total_runs,
      completed_run_count: 0,
      stop_reason: null,
      runs: [],
    };
    writeJson(DIAGNOSTIC_PILOT_RECORD_FILE, validateDiagnosticPilotRecord(
      record,
      benchmark.diagnosticPilotPlan,
      benchmark.scenarios,
      benchmark.executors,
    ));
    const adapterFile = path.join(ROOT, 'scripts', 'optimizer-runtime-adapter.js');
    for (const item of cases) {
      const run = runScenario({
        scenario: item.scenario,
        scenarios: benchmark.diagnosticPilotScenarios,
        executors: [item.profile],
        policyId: benchmark.diagnosticPilotPlan.policy_id,
        repetition: 1,
        adapterFile,
        pricingSnapshot: benchmark.pricingSnapshot,
      });
      const observation = diagnosticPilotObservation(run, item.profile);
      record.runs.push(observation);
      record.completed_run_count = record.runs.length;
      if (observation.evidence_status !== 'passed') {
        record.status = 'failed';
        record.completed_at = new Date().toISOString();
        record.stop_reason = 'PILOT_EVIDENCE_FAILED';
      } else if (record.completed_run_count === record.planned_run_count) {
        record.completed_at = new Date().toISOString();
        if (record.runs.some((candidate) => candidate.task_verified)) {
          record.status = 'passed';
        } else {
          record.status = 'failed';
          record.stop_reason = 'NO_TASK_VERIFIER_PASS';
        }
      }
      writeJson(DIAGNOSTIC_PILOT_RECORD_FILE, validateDiagnosticPilotRecord(
        record,
        benchmark.diagnosticPilotPlan,
        benchmark.diagnosticPilotScenarios,
        benchmark.executors,
      ));
      process.stdout.write(`${JSON.stringify({
        diagnostic_case: `${item.scenario.id}/${item.profile.profile_id}`,
        evidence_status: observation.evidence_status,
        task_verified: observation.task_verified,
        completed_run_count: record.completed_run_count,
        planned_run_count: record.planned_run_count,
      })}\n`);
      if (record.stop_reason === 'PILOT_EVIDENCE_FAILED') {
        process.exitCode = 2;
        return;
      }
    }
    if (record.status !== 'passed') process.exitCode = 2;
    process.stdout.write(`Diagnostic pilot ${record.status}; record written to ${DIAGNOSTIC_PILOT_RECORD_FILE}\n`);
    return;
  }

  if (command === 'calibrate') {
    if (!options.output) throw new Error('calibrate requires --output');
    if (benchmark.calibrationPlan.approval_status !== 'approved'
      || benchmark.calibrationPlan.quota_acknowledged !== true) {
      throw new Error('Calibration requires an explicitly approved subscription quota');
    }
    const readiness = doctor(benchmark);
    const allowedBlockers = new Set([
      'CALIBRATION_REQUIRED',
      'EXTERNAL_SCENARIO_NOT_SELECTED',
      'MATRIX_QUOTA_NOT_APPROVED',
      'ATTESTATION_KEY_NOT_FROZEN',
    ]);
    const blocking = readiness.blockers.filter((blocker) => !allowedBlockers.has(blocker));
    if (blocking.length) throw new Error(`Calibration readiness failed: ${blocking.join(', ')}`);
    const output = path.resolve(options.output);
    if (fs.existsSync(output)) throw new Error('Calibration output already exists');
    const adapterFile = path.join(ROOT, 'scripts', 'optimizer-runtime-adapter.js');
    const cases = calibrationCases(
      benchmark.calibrationPlan,
      benchmark.calibrationScenarios,
      benchmark.executors,
    );
    const record = {
      schema: 1,
      kind: 'citadel_optimizer_calibration_record',
      authorization_digest: calibrationAuthorizationDigest(benchmark.calibrationPlan),
      scenario_set_id: scenarioSetIdentity(benchmark.calibrationScenarios),
      executor_set_id: benchmark.freeze.executor_set_id,
      access_basis: benchmark.calibrationPlan.access_basis,
      quota_budget: benchmark.calibrationPlan.quota_budget,
      started_at: new Date().toISOString(),
      completed_at: null,
      status: 'running',
      planned_run_count: benchmark.calibrationPlan.total_runs,
      completed_run_count: 0,
      stop_reason: null,
      runs: [],
    };
    writeJson(output, validateCalibrationRecord(
      record,
      benchmark.calibrationPlan,
      benchmark.calibrationScenarios,
      benchmark.executors,
    ));
    for (const item of cases) {
      const run = runScenario({
        scenario: item.scenario,
        scenarios: benchmark.calibrationScenarios,
        executors: [item.profile],
        policyId: 'prompt-only',
        repetition: 1,
        adapterFile,
        pricingSnapshot: benchmark.pricingSnapshot,
      });
      const observation = calibrationObservation(run, item.profile);
      record.runs.push(observation);
      record.completed_run_count = record.runs.length;
      if (observation.evidence_status !== 'passed') {
        record.status = 'failed';
        record.completed_at = new Date().toISOString();
        record.stop_reason = 'CALIBRATION_EVIDENCE_FAILED';
      } else if (record.completed_run_count === record.planned_run_count) {
        record.status = 'passed';
        record.completed_at = new Date().toISOString();
      }
      writeJson(output, validateCalibrationRecord(
        record,
        benchmark.calibrationPlan,
        benchmark.calibrationScenarios,
        benchmark.executors,
      ));
      process.stdout.write(`${JSON.stringify({
        calibration_case: `${item.scenario.id}/${item.profile.profile_id}`,
        evidence_status: observation.evidence_status,
        completed_run_count: record.completed_run_count,
        planned_run_count: record.planned_run_count,
      })}\n`);
      if (record.status === 'failed') {
        process.exitCode = 2;
        return;
      }
    }
    process.stdout.write(`Calibration passed; record written to ${output}\n`);
    return;
  }

  if (command === 'matrix-plan') {
    const runs = [];
    for (const scenario of benchmark.scenarios) {
      for (const policy of benchmark.freeze.policies) {
        for (let repetition = 1; repetition <= benchmark.freeze.repetitions; repetition += 1) {
          runs.push({
            run_key: `${scenario.id}/${policy}/${repetition}`,
            scenario_id: scenario.id,
            policy_id: policy,
            repetition,
            holdout: scenario.holdout,
          });
        }
      }
    }
    const submissionReadiness = doctor(benchmark);
    const executionBlockers = submissionReadiness.blockers;
    process.stdout.write(`${JSON.stringify({
      schema: 1,
      kind: 'citadel_optimizer_matrix_plan',
      no_model_calls_made: true,
      scenario_set_id: benchmark.freeze.scenario_set_id,
      executor_set_id: benchmark.freeze.executor_set_id,
      metric_set_id: benchmark.freeze.metric_set_id,
      run_count: runs.length,
      execution_status: executionBlockers.length ? 'blocked' : 'ready',
      blockers: executionBlockers,
      submission_blockers: submissionReadiness.blockers,
      authorization_status: benchmark.matrixAuthorization.approval_status,
      authorization_digest: matrixAuthorizationDigest(
        benchmark.matrixAuthorization,
        benchmark.freeze,
        benchmark.scenarios,
      ),
      access_basis: benchmark.matrixAuthorization.access_basis,
      quota_budget: benchmark.matrixAuthorization.quota_budget,
      runs,
    }, null, 2)}\n`);
    return;
  }

  if (command === 'fixture') {
    if (!options.output) throw new Error('fixture requires --output');
    const runs = generateFixtureRuns(
      benchmark.scenarios,
      benchmark.executors,
      benchmark.fixtureTruth,
      benchmark.freeze.repetitions,
    );
    writeJsonl(options.output, runs);
    process.stdout.write(`Wrote ${runs.length} non-claim fixture simulations to ${options.output}\n`);
    return;
  }

  if (command === 'report') {
    if (!options.input || !options.output) throw new Error('report requires --input and --output');
    const report = buildReport(readJsonl(options.input), benchmark);
    writeJson(options.output, report);
    process.stdout.write(`Wrote ${report.claim_status} optimizer report (${report.submission_gate.status}) to ${options.output}\n`);
    return;
  }

  if (command === 'plan') {
    if (!options.scenario || !options.policy) throw new Error('plan requires --scenario and --policy');
    const scenario = benchmark.scenarios.find((item) => item.id === options.scenario);
    if (!scenario) throw new Error(`Unknown scenario: ${options.scenario}`);
    let probe;
    if (options.policy === 'adaptive') {
      if (options.repository) probe = probeWorkspace(options.repository, scenario);
      else if (options['fixture-probe']) {
        const truth = benchmark.fixtureTruth.scenarios.find((item) => item.scenario_id === scenario.id);
        probe = fixtureProbe(scenario, truth.probe_facts);
      } else {
        throw new Error('adaptive plan requires --repository or explicit --fixture-probe');
      }
    }
    const decision = route({
      scenario,
      executors: benchmark.executors,
      policyId: options.policy,
      probe,
    });
    process.stdout.write(`${JSON.stringify({ decision, probe: probe || null }, null, 2)}\n`);
    return;
  }

  if (command === 'run') {
    for (const required of ['scenario', 'policy', 'repetition', 'adapter', 'output', 'signing-key']) {
      if (!options[required]) throw new Error(`run requires --${required}`);
    }
    assertMatrixAuthorized(
      benchmark.matrixAuthorization,
      benchmark.freeze,
      benchmark.scenarios,
    );
    assertActualReady(benchmark.freeze, benchmark.executors);
    const scenario = benchmark.scenarios.find((item) => item.id === options.scenario);
    if (!scenario) throw new Error(`Unknown scenario: ${options.scenario}`);
    const output = path.resolve(options.output);
    if (fs.existsSync(output)) throw new Error('actual run output already exists');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.accessSync(path.dirname(output), fs.constants.W_OK);
    const privateKey = privateKeyForRun(options['signing-key'], benchmark.freeze);
    const unsigned = runScenario({
      scenario,
      scenarios: benchmark.scenarios,
      executors: benchmark.executors,
      policyId: options.policy,
      repetition: Number(options.repetition),
      adapterFile: options.adapter,
      pricingSnapshot: benchmark.pricingSnapshot,
    });
    const signed = attestRun(unsigned, privateKey);
    writeJson(output, signed);
    process.stdout.write(`Wrote attested actual optimizer run to ${output}\n`);
    return;
  }

  if (command === 'reproduce') {
    for (const required of ['signing-key', 'reproduced-by', 'source', 'output']) {
      if (!options[required]) throw new Error(`reproduce requires --${required}`);
    }
    if (options['acknowledge-external-quota'] !== true) {
      throw new Error('reproduce requires --acknowledge-external-quota');
    }
    assertActualReady(benchmark.freeze, benchmark.executors);
    if (benchmark.freeze.external_reproduction_digest !== null) {
      throw new Error('External reproduction is already frozen');
    }
    if (typeof options['reproduced-by'] !== 'string' || !options['reproduced-by'].trim()) {
      throw new Error('reproduce --reproduced-by must be non-empty');
    }
    if (typeof options.source !== 'string' || !/^https:\/\//.test(options.source)) {
      throw new Error('reproduce --source must be an HTTPS URL');
    }
    const output = path.resolve(options.output);
    if (fs.existsSync(output)) throw new Error('reproduction output already exists');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.accessSync(path.dirname(output), fs.constants.W_OK);
    const scenario = benchmark.scenarios.find((item) => (
      item.id === benchmark.freeze.external_scenario.scenario_id
    ));
    const privateKey = privateEd25519Key(options['signing-key']);
    const publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
    const unsigned = runScenario({
      scenario,
      scenarios: benchmark.scenarios,
      executors: benchmark.executors,
      policyId: 'adaptive',
      repetition: 1,
      adapterFile: path.join(ROOT, 'scripts', 'optimizer-runtime-adapter.js'),
      pricingSnapshot: benchmark.pricingSnapshot,
    });
    const reproduction = validateExternalReproduction({
      schema: 1,
      kind: 'citadel_optimizer_external_reproduction',
      scenario_id: scenario.id,
      reproduced_by: options['reproduced-by'],
      reproduction_source: options.source,
      public_key: publicKey,
      run: attestRun(unsigned, privateKey),
    }, benchmark.freeze);
    writeJson(output, reproduction);
    process.stdout.write(`Wrote independently signed optimizer reproduction to ${output}\n`);
    return;
  }

  throw new Error(`Unknown optimizer benchmark command: ${command}`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Optimizer benchmark failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({
  checkedInBenchmark,
  doctor,
  runtimeProbe,
});
