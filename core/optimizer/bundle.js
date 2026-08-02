'use strict';

const fs = require('fs');
const path = require('path');
const {
  canonical,
  digest,
  exactFields,
  loadExecutors,
  loadFreeze,
  loadScenarios,
} = require('./contracts');
const { pricingSnapshotDigest, validatePricingSnapshot } = require('./pricing');
const { buildReport } = require('./report');
const { validateAttestationRotation } = require('./attestation-rotation');
const { validateCalibrationPlan, validateCalibrationRecord } = require('./calibration');
const { validateCalibrationForensics } = require('./calibration-forensics');
const {
  validateDiagnosticPilotPlan,
  validateDiagnosticPilotRecord,
} = require('./diagnostic-pilot');
const {
  validateDiagnosticPilotForensics,
} = require('./diagnostic-pilot-forensics');
const {
  externalReproductionDigest,
  validateExternalReproduction,
} = require('./external-reproduction');
const {
  buildExternalSelectionRequest,
  frozenSelectionFromRecord,
  validateBeaconSelectionRecord,
  validateExternalSelectionRequest,
} = require('./external-selection');
const { validateMatrixAuthorization } = require('./matrix-authorization');

const MANIFEST_FIELDS = Object.freeze([
  'schema',
  'kind',
  'bundle_id',
  'claim_status',
  'scenario_set_id',
  'executor_set_id',
  'metric_set_id',
  'created_at',
  'files',
]);
const FILE_FIELDS = Object.freeze(['path', 'digest', 'bytes']);

function relativePosix(root, file) {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Bundle path escapes output directory');
  }
  return relative.replace(/\\/g, '/');
}

function contained(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function realRegularFile(root, candidate) {
  if (!contained(root, candidate)) return false;
  try {
    const stat = fs.lstatSync(candidate);
    return stat.isFile()
      && !stat.isSymbolicLink()
      && contained(fs.realpathSync(root), fs.realpathSync(candidate));
  } catch {
    return false;
  }
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function fileRecord(root, file) {
  const bytes = fs.readFileSync(file);
  return Object.freeze({
    path: relativePosix(root, file),
    digest: digest(bytes.toString('utf8')),
    bytes: bytes.length,
  });
}

function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const content = fs.readFileSync(source, 'utf8').replace(/\r\n?/g, '\n');
  fs.writeFileSync(target, content, { encoding: 'utf8', flag: 'wx' });
}

function writeFile(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, { encoding: 'utf8', flag: 'wx' });
}

function checkedInInputs(root) {
  const benchmarkRoot = path.join(root, 'benchmarks', 'optimizer-proof');
  const scenarioDirectory = path.join(benchmarkRoot, 'scenarios');
  const calibrationScenarioDirectory = path.join(benchmarkRoot, 'calibration-scenarios');
  const diagnosticPilotScenarioDirectory = path.join(
    benchmarkRoot,
    'diagnostic-pilot-scenarios',
  );
  const executorFile = path.join(benchmarkRoot, 'executors.json');
  const freezeFile = path.join(benchmarkRoot, 'freeze.json');
  const pricingFile = path.join(benchmarkRoot, 'pricing.json');
  const calibrationPlanFile = path.join(benchmarkRoot, 'calibration-plan.json');
  const calibrationRecordFile = path.join(benchmarkRoot, 'calibration-record.json');
  const calibrationForensicsFile = path.join(benchmarkRoot, 'calibration-forensics.json');
  const attestationRotationFile = path.join(benchmarkRoot, 'attestation-key-rotation.json');
  const matrixAuthorizationFile = path.join(benchmarkRoot, 'matrix-authorization.json');
  const selectionRequestFile = path.join(
    benchmarkRoot,
    'holdout',
    'external-selection-request.json',
  );
  const selectionRecordFile = path.join(benchmarkRoot, 'external-selection.json');
  const diagnosticPilotPlanFile = path.join(benchmarkRoot, 'diagnostic-pilot-plan.json');
  const diagnosticPilotRecordFile = path.join(benchmarkRoot, 'diagnostic-pilot-record.json');
  const diagnosticPilotForensicsFile = path.join(
    benchmarkRoot,
    'diagnostic-pilot-forensics.json',
  );
  const externalReproductionFile = path.join(benchmarkRoot, 'external-reproduction.json');
  const scenarios = loadScenarios(scenarioDirectory);
  const calibrationScenarios = loadScenarios(calibrationScenarioDirectory);
  const diagnosticPilotScenarios = loadScenarios(diagnosticPilotScenarioDirectory);
  const executors = loadExecutors(executorFile);
  const freeze = loadFreeze(freezeFile, scenarios, executors);
  for (const [label, file] of [
    ['attestation key rotation', attestationRotationFile],
    ['matrix authorization', matrixAuthorizationFile],
    ['selection request', selectionRequestFile],
    ['selection record', selectionRecordFile],
  ]) {
    if (!realRegularFile(benchmarkRoot, file)) throw new Error(`Frozen ${label} is missing`);
  }
  const attestationRotation = validateAttestationRotation(
    JSON.parse(fs.readFileSync(attestationRotationFile, 'utf8')),
    freeze,
  );
  const matrixAuthorization = validateMatrixAuthorization(
    JSON.parse(fs.readFileSync(matrixAuthorizationFile, 'utf8')),
    freeze,
    scenarios,
  );
  const expectedSelectionRequest = buildExternalSelectionRequest(freeze, scenarios);
  const selectionRequest = validateExternalSelectionRequest(
    JSON.parse(fs.readFileSync(selectionRequestFile, 'utf8')),
    freeze,
    scenarios,
  );
  if (canonical(selectionRequest) !== canonical(expectedSelectionRequest)) {
    throw new Error('Published selection request does not reproduce from the freeze');
  }
  const selectionRecord = validateBeaconSelectionRecord(
    JSON.parse(fs.readFileSync(selectionRecordFile, 'utf8')),
    selectionRequest,
    freeze,
    scenarios,
  );
  if (canonical(freeze.external_scenario) !== canonical(
    frozenSelectionFromRecord(selectionRecord, selectionRequest, freeze, scenarios),
  )) {
    throw new Error('Frozen external scenario does not match the public-random selection');
  }
  if (!realRegularFile(benchmarkRoot, calibrationPlanFile)) throw new Error('Frozen calibration plan is missing');
  const calibrationPlan = validateCalibrationPlan(
    JSON.parse(fs.readFileSync(calibrationPlanFile, 'utf8')),
    calibrationScenarios,
    executors,
  );
  if (digest(calibrationPlan) !== freeze.calibration_plan_digest) {
    throw new Error('Frozen calibration plan digest mismatch');
  }
  if (calibrationPlan.record_digest !== freeze.calibration_record_digest) {
    throw new Error('Calibration plan and freeze record digests differ');
  }
  if (!realRegularFile(benchmarkRoot, calibrationForensicsFile)) {
    throw new Error('Frozen calibration forensics are missing');
  }
  const calibrationForensics = validateCalibrationForensics(
    JSON.parse(fs.readFileSync(calibrationForensicsFile, 'utf8')),
    calibrationScenarios,
    scenarios,
  );
  if (digest(calibrationForensics) !== freeze.calibration_forensics_digest) {
    throw new Error('Frozen calibration forensics digest mismatch');
  }
  if (!realRegularFile(benchmarkRoot, diagnosticPilotPlanFile)) {
    throw new Error('Diagnostic pilot plan is missing');
  }
  const diagnosticPilotPlan = validateDiagnosticPilotPlan(
    JSON.parse(fs.readFileSync(diagnosticPilotPlanFile, 'utf8')),
    diagnosticPilotScenarios,
    executors,
  );
  let diagnosticPilotRecord = null;
  if (diagnosticPilotPlan.record_digest !== null) {
    if (!realRegularFile(benchmarkRoot, diagnosticPilotRecordFile)) {
      throw new Error('Completed diagnostic pilot record is missing');
    }
    diagnosticPilotRecord = validateDiagnosticPilotRecord(
      JSON.parse(fs.readFileSync(diagnosticPilotRecordFile, 'utf8')),
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
  if (!realRegularFile(benchmarkRoot, diagnosticPilotForensicsFile)) {
    throw new Error('Diagnostic pilot forensics are missing');
  }
  const diagnosticPilotForensics = validateDiagnosticPilotForensics(
    JSON.parse(fs.readFileSync(diagnosticPilotForensicsFile, 'utf8')),
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
    if (!realRegularFile(benchmarkRoot, calibrationRecordFile)) {
      throw new Error('Frozen calibration record is missing');
    }
    calibrationRecord = validateCalibrationRecord(
      JSON.parse(fs.readFileSync(calibrationRecordFile, 'utf8')),
      calibrationPlan,
      calibrationScenarios,
      executors,
    );
    if (digest(calibrationRecord) !== freeze.calibration_record_digest) {
      throw new Error('Frozen calibration record digest mismatch');
    }
  }
  if (freeze.pricing_snapshot_digest !== null) {
    if (!realRegularFile(benchmarkRoot, pricingFile)) throw new Error('Frozen pricing snapshot is missing');
    const pricing = validatePricingSnapshot(JSON.parse(fs.readFileSync(pricingFile, 'utf8')));
    if (pricingSnapshotDigest(pricing) !== freeze.pricing_snapshot_digest) {
      throw new Error('Frozen pricing snapshot digest mismatch');
    }
  }
  let externalReproduction = null;
  if (freeze.external_reproduction_digest !== null) {
    if (!realRegularFile(benchmarkRoot, externalReproductionFile)) {
      throw new Error('Frozen external reproduction is missing');
    }
    externalReproduction = validateExternalReproduction(
      JSON.parse(fs.readFileSync(externalReproductionFile, 'utf8')),
      freeze,
    );
    if (externalReproductionDigest(externalReproduction, freeze) !== freeze.external_reproduction_digest) {
      throw new Error('Frozen external reproduction digest mismatch');
    }
  }
  return {
    benchmarkRoot,
    scenarioDirectory,
    calibrationScenarioDirectory,
    diagnosticPilotScenarioDirectory,
    executorFile,
    freezeFile,
    pricingFile: freeze.pricing_snapshot_digest === null ? null : pricingFile,
    calibrationPlanFile,
    calibrationRecordFile: calibrationRecord === null ? null : calibrationRecordFile,
    calibrationRecord,
    calibrationForensicsFile,
    calibrationForensics,
    attestationRotationFile,
    attestationRotation,
    matrixAuthorizationFile,
    matrixAuthorization,
    selectionRequestFile,
    selectionRequest,
    selectionRecordFile,
    selectionRecord,
    diagnosticPilotPlanFile,
    diagnosticPilotPlan,
    diagnosticPilotRecordFile: diagnosticPilotRecord === null ? null : diagnosticPilotRecordFile,
    diagnosticPilotRecord,
    diagnosticPilotForensicsFile,
    diagnosticPilotForensics,
    externalReproductionFile: externalReproduction === null ? null : externalReproductionFile,
    externalReproduction,
    scenarios,
    executors,
    freeze,
  };
}

function ensureEmptyTarget(outputDirectory) {
  const resolved = path.resolve(outputDirectory);
  if (fs.existsSync(resolved)) {
    if (!fs.statSync(resolved).isDirectory() || fs.readdirSync(resolved).length > 0) {
      throw new Error('Bundle output directory must not exist or must be empty');
    }
  } else {
    fs.mkdirSync(resolved, { recursive: true });
  }
  return resolved;
}

function bundleReadme(report) {
  return `# Citadel Optimizer Proof Bundle

Claim status: **${report.claim_status}**

This directory contains frozen benchmark inputs, the archived calibration
scenario set, the archived diagnostic-pilot scenario set, the completed
calibration and forensic records, the bounded diagnostic-pilot plan, immutable
pilot record and forensic replay, raw run records, the derived report, and a
content-addressed manifest.

Verify from a Citadel checkout:

\`\`\`bash
bun scripts/optimizer-proof-bundle.js verify <bundle-directory>
\`\`\`

Fixture simulations validate the evidence machinery only. They are not model
performance or cost-savings evidence.
`;
}

function buildBundle({ root, rawFile, reportFile, outputDirectory }) {
  const inputs = checkedInInputs(root);
  const rawPath = fs.realpathSync(path.resolve(rawFile));
  const reportPath = fs.realpathSync(path.resolve(reportFile));
  if (!fs.statSync(rawPath).isFile() || !fs.statSync(reportPath).isFile()) {
    throw new Error('Bundle raw and report inputs must be files');
  }
  const runs = readJsonl(rawPath);
  const expectedReport = buildReport(runs, inputs);
  const providedReport = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  if (canonical(expectedReport) !== canonical(providedReport)) {
    throw new Error('Bundle report does not reproduce from raw evidence');
  }
  const output = ensureEmptyTarget(outputDirectory);
  copyFile(inputs.freezeFile, path.join(output, 'inputs', 'freeze.json'));
  copyFile(inputs.executorFile, path.join(output, 'inputs', 'executors.json'));
  copyFile(inputs.calibrationPlanFile, path.join(output, 'inputs', 'calibration-plan.json'));
  if (inputs.calibrationRecordFile !== null) {
    copyFile(inputs.calibrationRecordFile, path.join(output, 'inputs', 'calibration-record.json'));
  }
  copyFile(inputs.calibrationForensicsFile, path.join(output, 'inputs', 'calibration-forensics.json'));
  copyFile(inputs.attestationRotationFile, path.join(output, 'inputs', 'attestation-key-rotation.json'));
  copyFile(inputs.matrixAuthorizationFile, path.join(output, 'inputs', 'matrix-authorization.json'));
  copyFile(inputs.selectionRequestFile, path.join(output, 'inputs', 'external-selection-request.json'));
  copyFile(inputs.selectionRecordFile, path.join(output, 'inputs', 'external-selection.json'));
  copyFile(inputs.diagnosticPilotPlanFile, path.join(output, 'inputs', 'diagnostic-pilot-plan.json'));
  if (inputs.diagnosticPilotRecordFile !== null) {
    copyFile(inputs.diagnosticPilotRecordFile, path.join(output, 'inputs', 'diagnostic-pilot-record.json'));
  }
  copyFile(
    inputs.diagnosticPilotForensicsFile,
    path.join(output, 'inputs', 'diagnostic-pilot-forensics.json'),
  );
  if (inputs.pricingFile !== null) {
    copyFile(inputs.pricingFile, path.join(output, 'inputs', 'pricing.json'));
  }
  if (inputs.externalReproductionFile !== null) {
    copyFile(inputs.externalReproductionFile, path.join(output, 'inputs', 'external-reproduction.json'));
  }
  for (const name of fs.readdirSync(inputs.scenarioDirectory).filter((item) => item.endsWith('.json')).sort()) {
    copyFile(
      path.join(inputs.scenarioDirectory, name),
      path.join(output, 'inputs', 'scenarios', name),
    );
  }
  for (const name of fs.readdirSync(inputs.calibrationScenarioDirectory).filter((item) => item.endsWith('.json')).sort()) {
    copyFile(
      path.join(inputs.calibrationScenarioDirectory, name),
      path.join(output, 'inputs', 'calibration-scenarios', name),
    );
  }
  for (const name of fs.readdirSync(inputs.diagnosticPilotScenarioDirectory).filter((item) => item.endsWith('.json')).sort()) {
    copyFile(
      path.join(inputs.diagnosticPilotScenarioDirectory, name),
      path.join(output, 'inputs', 'diagnostic-pilot-scenarios', name),
    );
  }
  copyFile(rawPath, path.join(output, 'evidence', 'raw.jsonl'));
  copyFile(reportPath, path.join(output, 'evidence', 'report.json'));
  writeFile(path.join(output, 'README.md'), bundleReadme(expectedReport));
  const files = [];
  for (const relative of [
    'README.md',
    'inputs/freeze.json',
    'inputs/executors.json',
    'inputs/calibration-plan.json',
    ...(inputs.calibrationRecordFile === null ? [] : ['inputs/calibration-record.json']),
    'inputs/calibration-forensics.json',
    'inputs/attestation-key-rotation.json',
    'inputs/matrix-authorization.json',
    'inputs/external-selection-request.json',
    'inputs/external-selection.json',
    'inputs/diagnostic-pilot-plan.json',
    ...(inputs.diagnosticPilotRecordFile === null ? [] : ['inputs/diagnostic-pilot-record.json']),
    'inputs/diagnostic-pilot-forensics.json',
    ...(inputs.pricingFile === null ? [] : ['inputs/pricing.json']),
    ...(inputs.externalReproductionFile === null ? [] : ['inputs/external-reproduction.json']),
    ...fs.readdirSync(path.join(output, 'inputs', 'calibration-scenarios')).sort()
      .map((name) => `inputs/calibration-scenarios/${name}`),
    ...fs.readdirSync(path.join(output, 'inputs', 'diagnostic-pilot-scenarios')).sort()
      .map((name) => `inputs/diagnostic-pilot-scenarios/${name}`),
    ...fs.readdirSync(path.join(output, 'inputs', 'scenarios')).sort()
      .map((name) => `inputs/scenarios/${name}`),
    'evidence/raw.jsonl',
    'evidence/report.json',
  ]) {
    files.push(fileRecord(output, path.join(output, ...relative.split('/'))));
  }
  const unsigned = {
    schema: 1,
    kind: 'citadel_optimizer_proof_bundle',
    bundle_id: null,
    claim_status: expectedReport.claim_status,
    scenario_set_id: expectedReport.scenario_set_id,
    executor_set_id: expectedReport.executor_set_id,
    metric_set_id: expectedReport.metric_set_id,
    created_at: expectedReport.generated_at,
    files,
  };
  const manifest = { ...unsigned, bundle_id: digest(unsigned) };
  writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return Object.freeze({ output, manifest });
}

function validateManifest(value) {
  if (!exactFields(value, MANIFEST_FIELDS)) throw new Error('Bundle manifest fields are invalid');
  if (value.schema !== 1 || value.kind !== 'citadel_optimizer_proof_bundle') {
    throw new Error('Bundle manifest identity is invalid');
  }
  if (!Array.isArray(value.files) || !value.files.length) throw new Error('Bundle manifest files are invalid');
  for (const file of value.files) {
    if (!exactFields(file, FILE_FIELDS)
      || typeof file.path !== 'string'
      || !file.path
      || path.isAbsolute(file.path)
      || file.path.includes('..')
      || !/^sha256:[0-9a-f]{64}$/.test(file.digest)
      || !Number.isInteger(file.bytes)
      || file.bytes < 0) {
      throw new Error('Bundle manifest file record is invalid');
    }
  }
  if (new Set(value.files.map((file) => file.path)).size !== value.files.length) {
    throw new Error('Bundle manifest file paths must be unique');
  }
  const unsigned = { ...value, bundle_id: null };
  if (value.bundle_id !== digest(unsigned)) throw new Error('Bundle ID does not bind the manifest');
  return value;
}

function listFiles(root, directory = root) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Bundle cannot contain symlinks');
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(root, candidate));
    else if (entry.isFile()) found.push(relativePosix(root, candidate));
    else throw new Error('Bundle contains an unsupported file type');
  }
  return found.sort();
}

function verifyBundle(bundleDirectory) {
  const root = fs.realpathSync(path.resolve(bundleDirectory));
  if (!fs.statSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) {
    throw new Error('Bundle root must be a real directory');
  }
  const manifestFile = path.join(root, 'manifest.json');
  if (!realRegularFile(root, manifestFile)) throw new Error('Bundle manifest is missing');
  const manifest = validateManifest(JSON.parse(fs.readFileSync(manifestFile, 'utf8')));
  const expectedPaths = [...manifest.files.map((file) => file.path), 'manifest.json'].sort();
  const actualPaths = listFiles(root);
  if (canonical(expectedPaths) !== canonical(actualPaths)) throw new Error('Bundle files do not match the manifest');
  for (const record of manifest.files) {
    const file = path.join(root, ...record.path.split('/'));
    if (!realRegularFile(root, file)) throw new Error(`Bundle file is unsafe: ${record.path}`);
    const actual = fileRecord(root, file);
    if (canonical(actual) !== canonical(record)) throw new Error(`Bundle file digest mismatch: ${record.path}`);
  }
  const scenarioDirectory = path.join(root, 'inputs', 'scenarios');
  const calibrationScenarioDirectory = path.join(root, 'inputs', 'calibration-scenarios');
  const diagnosticPilotScenarioDirectory = path.join(
    root,
    'inputs',
    'diagnostic-pilot-scenarios',
  );
  const executors = loadExecutors(path.join(root, 'inputs', 'executors.json'));
  const scenarios = loadScenarios(scenarioDirectory);
  const calibrationScenarios = loadScenarios(calibrationScenarioDirectory);
  const diagnosticPilotScenarios = loadScenarios(diagnosticPilotScenarioDirectory);
  const freeze = loadFreeze(path.join(root, 'inputs', 'freeze.json'), scenarios, executors);
  validateAttestationRotation(
    JSON.parse(fs.readFileSync(path.join(root, 'inputs', 'attestation-key-rotation.json'), 'utf8')),
    freeze,
    'bundle attestation key rotation',
  );
  const matrixAuthorization = validateMatrixAuthorization(
    JSON.parse(fs.readFileSync(path.join(root, 'inputs', 'matrix-authorization.json'), 'utf8')),
    freeze,
    scenarios,
  );
  const expectedSelectionRequest = buildExternalSelectionRequest(freeze, scenarios);
  const selectionRequest = validateExternalSelectionRequest(
    JSON.parse(fs.readFileSync(path.join(root, 'inputs', 'external-selection-request.json'), 'utf8')),
    freeze,
    scenarios,
  );
  if (canonical(selectionRequest) !== canonical(expectedSelectionRequest)) {
    throw new Error('Bundle selection request does not reproduce from the freeze');
  }
  const selectionRecord = validateBeaconSelectionRecord(
    JSON.parse(fs.readFileSync(path.join(root, 'inputs', 'external-selection.json'), 'utf8')),
    selectionRequest,
    freeze,
    scenarios,
  );
  if (canonical(freeze.external_scenario) !== canonical(
    frozenSelectionFromRecord(selectionRecord, selectionRequest, freeze, scenarios),
  )) {
    throw new Error('Bundle frozen scenario does not match the public-random selection');
  }
  const calibrationPlan = validateCalibrationPlan(
    JSON.parse(fs.readFileSync(path.join(root, 'inputs', 'calibration-plan.json'), 'utf8')),
    calibrationScenarios,
    executors,
  );
  if (digest(calibrationPlan) !== freeze.calibration_plan_digest) {
    throw new Error('Bundle calibration plan digest mismatch');
  }
  if (calibrationPlan.record_digest !== freeze.calibration_record_digest) {
    throw new Error('Bundle calibration plan and freeze record digests differ');
  }
  const calibrationForensicsFile = path.join(root, 'inputs', 'calibration-forensics.json');
  if (!realRegularFile(root, calibrationForensicsFile)) {
    throw new Error('Bundle calibration forensics are missing');
  }
  const calibrationForensics = validateCalibrationForensics(
    JSON.parse(fs.readFileSync(calibrationForensicsFile, 'utf8')),
    calibrationScenarios,
    scenarios,
  );
  if (digest(calibrationForensics) !== freeze.calibration_forensics_digest) {
    throw new Error('Bundle calibration forensics digest mismatch');
  }
  const diagnosticPilotPlan = validateDiagnosticPilotPlan(
    JSON.parse(fs.readFileSync(path.join(root, 'inputs', 'diagnostic-pilot-plan.json'), 'utf8')),
    diagnosticPilotScenarios,
    executors,
  );
  let diagnosticPilotRecord = null;
  if (diagnosticPilotPlan.record_digest !== null) {
    const diagnosticPilotRecordFile = path.join(root, 'inputs', 'diagnostic-pilot-record.json');
    if (!realRegularFile(root, diagnosticPilotRecordFile)) {
      throw new Error('Bundle completed diagnostic pilot record is missing');
    }
    diagnosticPilotRecord = validateDiagnosticPilotRecord(
      JSON.parse(fs.readFileSync(diagnosticPilotRecordFile, 'utf8')),
      diagnosticPilotPlan,
      diagnosticPilotScenarios,
      executors,
    );
    if (digest(diagnosticPilotRecord) !== diagnosticPilotPlan.record_digest) {
      throw new Error('Bundle diagnostic pilot record digest mismatch');
    }
  }
  if (diagnosticPilotRecord === null) {
    throw new Error('Bundle diagnostic pilot forensics require a completed pilot record');
  }
  const diagnosticPilotForensicsFile = path.join(
    root,
    'inputs',
    'diagnostic-pilot-forensics.json',
  );
  if (!realRegularFile(root, diagnosticPilotForensicsFile)) {
    throw new Error('Bundle diagnostic pilot forensics are missing');
  }
  const diagnosticPilotForensics = validateDiagnosticPilotForensics(
    JSON.parse(fs.readFileSync(diagnosticPilotForensicsFile, 'utf8')),
    diagnosticPilotPlan,
    diagnosticPilotRecord,
    diagnosticPilotScenarios,
    scenarios,
  );
  if (digest(diagnosticPilotForensics) !== freeze.diagnostic_pilot_forensics_digest) {
    throw new Error('Bundle diagnostic pilot forensics digest mismatch');
  }
  if (freeze.calibration_record_digest !== null) {
    const calibrationRecordFile = path.join(root, 'inputs', 'calibration-record.json');
    if (!realRegularFile(root, calibrationRecordFile)) {
      throw new Error('Bundle calibration record is missing');
    }
    const calibrationRecord = validateCalibrationRecord(
      JSON.parse(fs.readFileSync(calibrationRecordFile, 'utf8')),
      calibrationPlan,
      calibrationScenarios,
      executors,
    );
    if (digest(calibrationRecord) !== freeze.calibration_record_digest) {
      throw new Error('Bundle calibration record digest mismatch');
    }
  }
  if (freeze.pricing_snapshot_digest !== null) {
    const pricingFile = path.join(root, 'inputs', 'pricing.json');
    if (!realRegularFile(root, pricingFile)) throw new Error('Bundle pricing snapshot is missing');
    const pricing = validatePricingSnapshot(JSON.parse(fs.readFileSync(pricingFile, 'utf8')));
    if (pricingSnapshotDigest(pricing) !== freeze.pricing_snapshot_digest) {
      throw new Error('Bundle pricing snapshot digest mismatch');
    }
  }
  let externalReproduction = null;
  if (freeze.external_reproduction_digest !== null) {
    const reproductionFile = path.join(root, 'inputs', 'external-reproduction.json');
    if (!realRegularFile(root, reproductionFile)) throw new Error('Bundle external reproduction is missing');
    externalReproduction = validateExternalReproduction(
      JSON.parse(fs.readFileSync(reproductionFile, 'utf8')),
      freeze,
    );
    if (externalReproductionDigest(externalReproduction, freeze) !== freeze.external_reproduction_digest) {
      throw new Error('Bundle external reproduction digest mismatch');
    }
  }
  const runs = readJsonl(path.join(root, 'evidence', 'raw.jsonl'));
  const report = JSON.parse(fs.readFileSync(path.join(root, 'evidence', 'report.json'), 'utf8'));
  const reproduced = buildReport(runs, {
    scenarios,
    executors,
    freeze,
    matrixAuthorization,
    externalReproduction,
  });
  if (canonical(report) !== canonical(reproduced)) throw new Error('Bundle report does not reproduce');
  if (manifest.claim_status !== report.claim_status
    || manifest.scenario_set_id !== report.scenario_set_id
    || manifest.executor_set_id !== report.executor_set_id
    || manifest.metric_set_id !== report.metric_set_id) {
    throw new Error('Bundle manifest does not bind report identities');
  }
  return Object.freeze({
    valid: true,
    bundle_id: manifest.bundle_id,
    claim_status: manifest.claim_status,
    files_verified: manifest.files.length,
    report_reproduced: true,
    calibration_record_verified: freeze.calibration_record_digest !== null,
    calibration_forensics_verified: true,
    diagnostic_pilot_plan_verified: true,
    diagnostic_pilot_record_verified: diagnosticPilotRecord !== null,
    diagnostic_pilot_forensics_verified: true,
  });
}

module.exports = Object.freeze({
  buildBundle,
  checkedInInputs,
  validateManifest,
  verifyBundle,
});
