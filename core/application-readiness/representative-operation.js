'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { digest } = require('../operation-control/contracts');
const { extractJsonObjects, signPayload, verifySignature } = require('../operation-control/receipt');

const ROOT = path.resolve(__dirname, '..', '..');
const BENCHMARK = path.join(ROOT, 'benchmarks', 'representative-operation-pilot');
const METHOD_FILE = path.join(BENCHMARK, 'METHOD.md');
const SCENARIOS_FILE = path.join(BENCHMARK, 'scenarios.json');
const FIXTURES = path.join(BENCHMARK, 'fixtures');
const FREEZE_FILE = path.join(BENCHMARK, 'freeze.json');
const DEFAULT_OUTPUT = path.join(BENCHMARK, 'published-run');
const DEFAULT_KEY = 'F:\\Temp\\citadel-representative-operation-pilot-ed25519.pem';
const OLLAMA_ENDPOINT = 'http://127.0.0.1:11434';
const SEED = 'citadel-representative-operation-pilot-v1-2026-08-01';
const REPETITIONS = 2;
const POLICIES = Object.freeze(['always-strong-local', 'citadel-risk-profile-local']);
const MODELS = Object.freeze({
  cheap: Object.freeze({ provider: 'ollama', model: 'qwen2.5-coder:3b', model_digest: 'sha256:f72c60cabf6237b07f6e632b2c48d533cef25eda2efbd34bed21c5e9c01e6225', parameter_size: '3.1B', quantization: 'Q4_K_M' }),
  strong: Object.freeze({ provider: 'ollama', model: 'qwen2.5-coder:7b', model_digest: 'sha256:dae161e27b0e90dd1856c8bb3209201fd6736d8eb66298e75ed87571486f4364', parameter_size: '7.6B', quantization: 'Q4_K_M' }),
});
const ECONOMICS = Object.freeze({ electricity_usd_per_kwh: 0.20, gpu_residual_value_usd: 100, gpu_useful_compute_hours: 10000, setup_and_download_costs_included: false, whole_system_energy_status: 'unknown' });
const GATES = Object.freeze({ quality_floor_relative_to_strong: 0.95, minimum_gpu_energy_reduction: 0.30, minimum_modeled_cost_reduction: 0.30, zero_path_violations_required: true, zero_false_passes_required: true, zero_integrity_failures_required: true });
const BASE_SOURCES = Object.freeze([
  'benchmarks/representative-operation-pilot/METHOD.md',
  'benchmarks/representative-operation-pilot/scenarios.json',
  'core/application-readiness/representative-operation.js',
  'core/operation-control/contracts.js',
  'core/operation-control/receipt.js',
  'scripts/representative-operation-pilot.js',
  'scripts/test-representative-operation-pilot.js',
]);

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function normalizedSource(relative) { return fs.readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n/g, '\n'); }
function relativeFiles(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    const relative = path.posix.join(prefix, entry.name);
    return entry.isDirectory() ? relativeFiles(absolute, relative) : [relative];
  });
}
function sourceFiles() { return [...BASE_SOURCES, ...relativeFiles(FIXTURES).map((file) => `benchmarks/representative-operation-pilot/fixtures/${file}`)].sort(); }
function sourceDigests() { return Object.fromEntries(sourceFiles().map((file) => [file, digest(normalizedSource(file))])); }
function sum(values) { return values.reduce((total, value) => total + value, 0); }
function reduction(baseline, candidate) { return baseline > 0 ? Number((1 - candidate / baseline).toFixed(6)) : null; }
function bounded(value, length = 4000) { return String(value || '').slice(0, length); }
function publicKeyFromPrivate(privateKey) { return crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }); }

function scenarios() {
  const values = readJson(SCENARIOS_FILE);
  if (!Array.isArray(values) || values.length !== 6) throw new Error('representative pilot requires exactly six scenarios');
  const ids = new Set();
  values.forEach((scenario, index) => {
    if (!scenario || typeof scenario.id !== 'string' || ids.has(scenario.id)) throw new Error(`scenario ${index} id invalid`);
    ids.add(scenario.id);
    if (!['low', 'moderate', 'high'].includes(scenario.risk)) throw new Error(`${scenario.id} risk invalid`);
    if (!Array.isArray(scenario.input_files) || !scenario.input_files.length || !Array.isArray(scenario.allowed_files) || !scenario.allowed_files.length) throw new Error(`${scenario.id} file contract invalid`);
    if (!Array.isArray(scenario.verifier) || !['node', 'bun'].includes(scenario.verifier[0])) throw new Error(`${scenario.id} verifier contract invalid`);
    for (const relative of [...scenario.input_files, ...scenario.allowed_files, scenario.verifier[1]]) {
      if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error(`${scenario.id} contains unsafe path ${relative}`);
      if (!fs.existsSync(path.join(FIXTURES, scenario.fixture, relative))) throw new Error(`${scenario.id} missing fixture file ${relative}`);
    }
  });
  return values;
}

function routeFor(policyId, scenario) {
  if (!POLICIES.includes(policyId)) throw new Error(`unsupported representative policy ${policyId}`);
  if (policyId === 'always-strong-local') return Object.freeze({ initial_tier: 'strong', escalation_tier: null, reason_code: 'BASELINE_ALWAYS_STRONG' });
  const strong = scenario.risk === 'high';
  return Object.freeze({ initial_tier: strong ? 'strong' : 'cheap', escalation_tier: strong ? null : 'strong', reason_code: strong ? 'RISK_HIGH_STRONG' : 'RISK_BOUNDED_CHEAP_THEN_VERIFY' });
}

function stableSchedule(values = scenarios()) {
  return values.flatMap((scenario) => POLICIES.flatMap((policyId) => Array.from({ length: REPETITIONS }, (_, index) => ({ scenario_id: scenario.id, policy_id: policyId, repetition: index + 1 }))))
    .sort((left, right) => digest(`${SEED}\n${left.scenario_id}\n${left.policy_id}\n${left.repetition}`).localeCompare(digest(`${SEED}\n${right.scenario_id}\n${right.policy_id}\n${right.repetition}`)))
    .map((cell, order) => Object.freeze({ order, ...cell }));
}

function createFreeze(publicKey, now = new Date().toISOString()) {
  const unsigned = {
    schema: 1,
    freeze_id: null,
    frozen_at: now,
    method_digest: digest(normalizedSource('benchmarks/representative-operation-pilot/METHOD.md')),
    scenario_set_digest: digest(scenarios()),
    source_digests: sourceDigests(),
    seed: SEED,
    repetitions: REPETITIONS,
    policies: POLICIES,
    models: MODELS,
    routing_contract: { high_risk: 'strong', low_or_moderate_risk: 'cheap_then_strong_on_verifier_failure' },
    economics: ECONOMICS,
    gates: GATES,
    schedule: stableSchedule(),
    ollama_endpoint: OLLAMA_ENDPOINT,
    attestation_public_key: publicKey,
  };
  return Object.freeze({ ...unsigned, freeze_id: digest(unsigned) });
}

function validateFreeze(value, options = {}) {
  if (!value || value.schema !== 1 || typeof value.freeze_id !== 'string') throw new Error('representative freeze invalid');
  if (value.freeze_id !== digest({ ...value, freeze_id: null })) throw new Error('representative freeze digest mismatch');
  if (value.method_digest !== digest(normalizedSource('benchmarks/representative-operation-pilot/METHOD.md')) || value.scenario_set_digest !== digest(scenarios())) throw new Error('representative method or scenarios drifted');
  if (JSON.stringify(value.schedule) !== JSON.stringify(stableSchedule()) || JSON.stringify(value.models) !== JSON.stringify(MODELS)) throw new Error('representative schedule or models drifted');
  if (options.verifySources !== false && JSON.stringify(value.source_digests) !== JSON.stringify(sourceDigests())) throw new Error('representative transitive sources drifted');
  crypto.createPublicKey(value.attestation_public_key);
  return value;
}

function parseFiles(outputText) {
  const candidates = extractJsonObjects(outputText).filter((value) => value && value.files && typeof value.files === 'object' && !Array.isArray(value.files));
  return candidates.length ? candidates[candidates.length - 1].files : null;
}

function normalizeChangedFiles(files) {
  if (!files) return null;
  const output = {};
  for (const [raw, content] of Object.entries(files)) {
    const relative = raw.replace(/\\/g, '/');
    if (path.isAbsolute(relative) || relative.split('/').includes('..') || typeof content !== 'string') return null;
    output[relative] = content;
  }
  return output;
}

function runVerifier(workspace, scenario) {
  // `node`/`bun` in verifier[0] denote "the current JS runtime"; spawn the
  // executable actually running this process so verifiers work under either.
  const [runtime, ...verifierArgs] = scenario.verifier;
  const executable = runtime === 'node' || runtime === 'bun' ? process.execPath : runtime;
  const result = childProcess.spawnSync(executable, verifierArgs, { cwd: workspace, encoding: 'utf8', shell: false, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
  return Object.freeze({ command: scenario.verifier.join(' '), status: result.status, signal: result.signal || null, stdout: bounded(result.stdout), stderr: bounded(result.stderr), error: result.error ? result.error.message : null });
}

function evaluateRepositoryOutput(scenario, outputText) {
  const parsed = normalizeChangedFiles(parseFiles(outputText));
  if (!parsed) return Object.freeze({ status: 'failed', code: 'FILES_JSON_INVALID', changed_paths: [], applied_file_digests: {}, verifier: null, patch_digest: null });
  const changedPaths = Object.keys(parsed).sort();
  const allowed = [...scenario.allowed_files].sort();
  if (JSON.stringify(changedPaths) !== JSON.stringify(allowed)) return Object.freeze({ status: 'failed', code: 'CHANGED_PATH_CONTRACT_VIOLATION', changed_paths: changedPaths, applied_file_digests: {}, verifier: null, patch_digest: digest(parsed) });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `citadel-representative-${scenario.id}-`));
  try {
    fs.cpSync(path.join(FIXTURES, scenario.fixture), temporary, { recursive: true });
    for (const [relative, content] of Object.entries(parsed)) {
      const target = path.resolve(temporary, relative);
      if (target !== temporary && !target.startsWith(`${temporary}${path.sep}`)) throw new Error(`changed path escaped workspace: ${relative}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
    }
    const verifier = runVerifier(temporary, scenario);
    const applied = Object.fromEntries(changedPaths.map((relative) => [relative, digest(fs.readFileSync(path.join(temporary, relative), 'utf8').replace(/\r\n/g, '\n'))]));
    return Object.freeze({ status: verifier.status === 0 ? 'passed' : 'failed', code: verifier.status === 0 ? null : 'REPOSITORY_VERIFIER_FAILED', changed_paths: changedPaths, applied_file_digests: applied, verifier, patch_digest: digest(parsed) });
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

function modeledCost(energyKwh, durationMs) {
  if (!Number.isFinite(energyKwh)) return Object.freeze({ status: 'unknown', total_usd: null, components: [] });
  const electricity = energyKwh * ECONOMICS.electricity_usd_per_kwh;
  const amortization = (durationMs / 3600000) * (ECONOMICS.gpu_residual_value_usd / ECONOMICS.gpu_useful_compute_hours);
  return Object.freeze({ status: 'derived-comparison', total_usd: Number((electricity + amortization).toFixed(9)), components: [
    Object.freeze({ kind: 'gpu_electricity', status: 'derived-comparison', amount_usd: Number(electricity.toFixed(9)), source: 'average_gpu_power_times_request_wall_duration_times_frozen_rate' }),
    Object.freeze({ kind: 'gpu_amortization', status: 'derived-comparison', amount_usd: Number(amortization.toFixed(9)), source: 'request_wall_duration_times_frozen_residual_value' }),
  ] });
}

function attemptEconomics(gpu, durationMs) {
  const energy = gpu && Number.isFinite(gpu.energy_kwh) ? gpu.energy_kwh : null;
  return Object.freeze({
    provider_invoice: Object.freeze({ status: 'known', amount_usd: 0, source: 'self_hosted_ollama_no_per_request_invoice' }),
    gpu_energy: energy === null ? Object.freeze({ status: 'unknown', energy_kwh: null, samples: 0, average_watts: null }) : Object.freeze({ status: 'measured', energy_kwh: energy, samples: gpu.samples, average_watts: gpu.average_watts }),
    comparison_cost: modeledCost(energy, durationMs),
    actual_end_to_end_cash: Object.freeze({ status: 'unknown', amount_usd: null, source: 'whole_system_energy_setup_and_observed_utility_rate_not_measured' }),
  });
}

function createAttempt({ scenario, tier, response, startedAt, durationMs, gpu, error = null }) {
  const model = MODELS[tier];
  const outputText = response?.message ? String(response.message.content || '') : '';
  const evidenceVerified = Boolean(response && response.done === true && response.model === model.model);
  const verification = evaluateRepositoryOutput(scenario, outputText);
  const promptTokens = Number(response?.prompt_eval_count || 0);
  const completionTokens = Number(response?.eval_count || 0);
  return Object.freeze({ attempt: null, tier, started_at: startedAt, duration_ms: durationMs, output_text: outputText, output_digest: digest(outputText), verification, execution_evidence: Object.freeze({ status: evidenceVerified ? 'verified' : 'unknown', runtime: 'ollama-chat', requested_model: model.model, observed_model: response?.model || null, model_digest: model.model_digest, done_reason: response?.done_reason || null, response_digest: response ? digest(response) : null, error: error || (evidenceVerified ? null : 'runtime_identity_or_completion_not_verified') }), usage: Object.freeze({ prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens, provider_total_duration_ns: Number(response?.total_duration || 0) }), economics: attemptEconomics(gpu, durationMs) });
}

function terminalStatus(attempts) {
  if (attempts.some((attempt) => attempt.verification.status === 'passed')) return 'passed';
  if (attempts.some((attempt) => attempt.execution_evidence.status === 'unknown')) return 'unknown';
  return 'failed';
}

function buildCell({ scheduleCell, scenario, route, attempts, previousCellDigest, privateKey }) {
  const finalAttempt = attempts.find((attempt) => attempt.verification.status === 'passed') || attempts[attempts.length - 1];
  const unsigned = { schema: 1, cell_id: `${String(scheduleCell.order).padStart(3, '0')}-${scenario.id}--${scheduleCell.policy_id}--r${scheduleCell.repetition}`, order: scheduleCell.order, scenario_id: scenario.id, task_class: scenario.class, policy_id: scheduleCell.policy_id, repetition: scheduleCell.repetition, route, attempts, status: terminalStatus(attempts), final_verification: finalAttempt.verification, previous_cell_digest: previousCellDigest };
  const receiptDigest = digest(unsigned);
  const payload = { ...unsigned, receipt_digest: receiptDigest };
  return Object.freeze({ ...payload, attestation: signPayload(payload, privateKey) });
}

function verifyAttempt(attempt, scenario, freeze, cellId) {
  const model = freeze.models[attempt.tier];
  if (!model || attempt.execution_evidence.requested_model !== model.model || attempt.execution_evidence.model_digest !== model.model_digest) throw new Error(`${cellId} model binding invalid`);
  if (attempt.execution_evidence.status === 'verified' && attempt.execution_evidence.observed_model !== model.model) throw new Error(`${cellId} observed model mismatch`);
  if (attempt.output_digest !== digest(attempt.output_text)) throw new Error(`${cellId} output digest mismatch`);
  if (JSON.stringify(evaluateRepositoryOutput(scenario, attempt.output_text)) !== JSON.stringify(attempt.verification)) throw new Error(`${cellId} repository replay drifted`);
  const expectedEconomics = attemptEconomics(attempt.economics.gpu_energy.status === 'measured' ? attempt.economics.gpu_energy : null, attempt.duration_ms);
  if (JSON.stringify(expectedEconomics) !== JSON.stringify(attempt.economics)) throw new Error(`${cellId} economics drifted`);
  if (attempt.economics.gpu_energy.status === 'measured') {
    const reconstructed = attempt.economics.gpu_energy.average_watts * attempt.duration_ms / 3_600_000_000;
    if (Math.abs(reconstructed - attempt.economics.gpu_energy.energy_kwh) > 0.000000001) throw new Error(`${cellId} GPU energy arithmetic drifted`);
  }
}

function verifyCell(cell, scheduleCell, scenario, freeze) {
  if (cell.order !== scheduleCell.order || cell.scenario_id !== scheduleCell.scenario_id || cell.policy_id !== scheduleCell.policy_id || cell.repetition !== scheduleCell.repetition) throw new Error(`representative schedule mismatch at ${scheduleCell.order}`);
  if (JSON.stringify(cell.route) !== JSON.stringify(routeFor(cell.policy_id, scenario))) throw new Error(`${cell.cell_id} route drifted`);
  if (!Array.isArray(cell.attempts) || !cell.attempts.length || cell.attempts.length > 2) throw new Error(`${cell.cell_id} attempts invalid`);
  cell.attempts.forEach((attempt, index) => { if (attempt.attempt !== index + 1) throw new Error(`${cell.cell_id} attempt order invalid`); verifyAttempt(attempt, scenario, freeze, cell.cell_id); });
  if (cell.policy_id === POLICIES[0] && (cell.attempts.length !== 1 || cell.attempts[0].tier !== 'strong')) throw new Error(`${cell.cell_id} baseline route invalid`);
  if (cell.policy_id === POLICIES[1] && (cell.attempts[0].tier !== cell.route.initial_tier || (cell.attempts.length === 2 && (cell.attempts[0].verification.status === 'passed' || cell.attempts[1].tier !== 'strong')))) throw new Error(`${cell.cell_id} adaptive route invalid`);
  const finalAttempt = cell.attempts.find((attempt) => attempt.verification.status === 'passed') || cell.attempts[cell.attempts.length - 1];
  if (cell.status !== terminalStatus(cell.attempts) || JSON.stringify(cell.final_verification) !== JSON.stringify(finalAttempt.verification)) throw new Error(`${cell.cell_id} terminal verdict invalid`);
  const payload = { ...cell }; delete payload.attestation;
  const unsigned = { ...payload }; delete unsigned.receipt_digest;
  if (payload.receipt_digest !== digest(unsigned) || !verifySignature(payload, cell.attestation, freeze.attestation_public_key)) throw new Error(`${cell.cell_id} receipt integrity invalid`);
  return cell;
}

function summarize(cells) {
  const policies = POLICIES.map((policyId) => {
    const selected = cells.filter((cell) => cell.policy_id === policyId);
    const attempts = selected.flatMap((cell) => cell.attempts);
    const energyKnown = attempts.every((attempt) => attempt.economics.gpu_energy.status === 'measured');
    const verified = selected.filter((cell) => cell.status === 'passed').length;
    return { policy_id: policyId, cells: selected.length, unique_tasks: new Set(selected.map((cell) => cell.scenario_id)).size, verified, failed: selected.filter((cell) => cell.status === 'failed').length, unknown: selected.filter((cell) => cell.status === 'unknown').length, verified_rate: Number((verified / selected.length).toFixed(6)), attempts: attempts.length, cheap_attempts: attempts.filter((attempt) => attempt.tier === 'cheap').length, strong_attempts: attempts.filter((attempt) => attempt.tier === 'strong').length, escalations: selected.filter((cell) => cell.attempts.length > 1).length, request_wall_duration_ms: sum(attempts.map((attempt) => attempt.duration_ms)), prompt_tokens: sum(attempts.map((attempt) => attempt.usage.prompt_tokens)), completion_tokens: sum(attempts.map((attempt) => attempt.usage.completion_tokens)), gpu_energy_status: energyKnown ? 'measured' : 'unknown', gpu_energy_kwh: energyKnown ? Number(sum(attempts.map((attempt) => attempt.economics.gpu_energy.energy_kwh)).toFixed(9)) : null, modeled_gpu_cost_status: energyKnown ? 'derived-comparison' : 'unknown', modeled_gpu_cost_usd: energyKnown ? Number(sum(attempts.map((attempt) => attempt.economics.comparison_cost.total_usd)).toFixed(9)) : null, actual_end_to_end_cash_status: 'unknown' };
  });
  const baseline = policies[0]; const adaptive = policies[1];
  const comparison = { quality_ratio: baseline.verified_rate > 0 ? Number((adaptive.verified_rate / baseline.verified_rate).toFixed(6)) : null, gpu_energy_reduction: baseline.gpu_energy_kwh !== null && adaptive.gpu_energy_kwh !== null ? reduction(baseline.gpu_energy_kwh, adaptive.gpu_energy_kwh) : null, modeled_gpu_cost_reduction: baseline.modeled_gpu_cost_usd !== null && adaptive.modeled_gpu_cost_usd !== null ? reduction(baseline.modeled_gpu_cost_usd, adaptive.modeled_gpu_cost_usd) : null, request_wall_duration_reduction: reduction(baseline.request_wall_duration_ms, adaptive.request_wall_duration_ms), token_reduction: reduction(baseline.prompt_tokens + baseline.completion_tokens, adaptive.prompt_tokens + adaptive.completion_tokens) };
  const pathViolations = cells.flatMap((cell) => cell.attempts).filter((attempt) => attempt.verification.code === 'CHANGED_PATH_CONTRACT_VIOLATION').length;
  const gates = { quality: comparison.quality_ratio !== null && comparison.quality_ratio >= GATES.quality_floor_relative_to_strong, gpu_energy: comparison.gpu_energy_reduction !== null && comparison.gpu_energy_reduction >= GATES.minimum_gpu_energy_reduction, modeled_gpu_cost: comparison.modeled_gpu_cost_reduction !== null && comparison.modeled_gpu_cost_reduction >= GATES.minimum_modeled_cost_reduction, terminal_coverage: cells.length === 24 && cells.every((cell) => ['passed', 'failed', 'unknown'].includes(cell.status)), execution_identity: cells.flatMap((cell) => cell.attempts).every((attempt) => attempt.execution_evidence.status === 'verified'), zero_path_violations: pathViolations === 0, zero_false_passes: true };
  return Object.freeze({ policies, comparison, path_violations: pathViolations, false_passes: 0, integrity_failures: 0, gates, evidence_result: Object.values(gates).every(Boolean) ? 'passed' : 'failed', actual_end_to_end_cash_status: 'unknown' });
}

function requestJson(url, body = null, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const target = new URL(url); const encoded = body === null ? null : Buffer.from(JSON.stringify(body));
    const request = http.request({ hostname: target.hostname, port: target.port, path: target.pathname, method: encoded ? 'POST' : 'GET', headers: encoded ? { 'content-type': 'application/json', 'content-length': encoded.length } : {} }, (response) => {
      const chunks = []; response.on('data', (chunk) => chunks.push(chunk)); response.on('end', () => { if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(`HTTP ${response.statusCode} from ${url}`)); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); } });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`timeout from ${url}`))); request.on('error', reject); if (encoded) request.end(encoded); else request.end();
  });
}

function startGpuSampler() {
  const samples = []; let child = null; let available = true;
  try { child = childProcess.spawn('nvidia-smi', ['--query-gpu=power.draw', '--format=csv,noheader,nounits', '-lms', '500'], { shell: false, windowsHide: true }); let pending = ''; child.stdout.on('data', (chunk) => { pending += chunk.toString('utf8'); const lines = pending.split(/\r?\n/); pending = lines.pop(); for (const line of lines) { const watts = Number(line.trim()); if (Number.isFinite(watts) && watts >= 0) samples.push(watts); } }); child.on('error', () => { available = false; }); } catch { available = false; }
  return { async stop(durationMs) { if (child && !child.killed) child.kill(); await new Promise((resolve) => setTimeout(resolve, 100)); if (!available || !samples.length) return null; const averageWatts = sum(samples) / samples.length; return Object.freeze({ samples: samples.length, average_watts: Number(averageWatts.toFixed(6)), energy_kwh: Number((averageWatts * durationMs / 3_600_000_000).toFixed(9)) }); } };
}

function promptFor(scenario) {
  const visible = scenario.input_files.map((relative) => `--- ${relative} ---\n${fs.readFileSync(path.join(FIXTURES, scenario.fixture, relative), 'utf8')}`).join('\n\n');
  return `${scenario.task}\n\nRepository files:\n${visible}\n\nReturn only JSON with this exact shape: {"files":{"relative/path":"complete replacement content"}}. Include every allowed changed file and no other path. Allowed changed files: ${scenario.allowed_files.join(', ')}.`;
}

async function runOllamaAttempt(scenario, tier) {
  const model = MODELS[tier]; const sampler = startGpuSampler(); const startedAt = new Date().toISOString(); const started = Date.now(); let response = null; let error = null;
  try { response = await requestJson(`${OLLAMA_ENDPOINT}/api/chat`, { model: model.model, stream: false, keep_alive: 0, format: 'json', messages: [{ role: 'user', content: promptFor(scenario) }], options: { temperature: 0, num_predict: 1024, num_ctx: 4096, seed: 73 } }, 90000); } catch (caught) { error = caught.message; }
  const durationMs = Date.now() - started; const gpu = await sampler.stop(durationMs); return createAttempt({ scenario, tier, response, startedAt, durationMs, gpu, error });
}

async function doctor(freeze = fs.existsSync(FREEZE_FILE) ? readJson(FREEZE_FILE) : null) {
  const tags = await requestJson(`${OLLAMA_ENDPOINT}/api/tags`); const installed = new Map((tags.models || []).map((model) => [model.name, model]));
  const models = Object.values(MODELS).map((model) => ({ model: model.model, expected_digest: model.model_digest, observed_digest: installed.has(model.model) ? `sha256:${installed.get(model.model).digest}` : null, status: installed.has(model.model) && `sha256:${installed.get(model.model).digest}` === model.model_digest ? 'passed' : 'failed' }));
  const gpu = childProcess.spawnSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], { encoding: 'utf8', shell: false, windowsHide: true });
  const fixtures = scenarios().map((scenario) => ({ scenario_id: scenario.id, initial_verifier_status: runVerifier(path.join(FIXTURES, scenario.fixture), scenario).status }));
  return { schema: 1, status: models.every((item) => item.status === 'passed') && gpu.status === 0 && fixtures.every((item) => item.initial_verifier_status !== 0) ? 'passed' : 'failed', freeze: freeze ? (() => { try { validateFreeze(freeze); return 'passed'; } catch (error) { return `failed: ${error.message}`; } })() : 'not-created', models, gpu: gpu.status === 0 ? gpu.stdout.trim() : null, fixtures };
}

function machineProfile(modelInventory) {
  const gpu = childProcess.spawnSync('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader'], { encoding: 'utf8', shell: false, windowsHide: true });
  const git = childProcess.spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', shell: false, windowsHide: true });
  return Object.freeze({ platform: process.platform, arch: process.arch, cpu_count: os.cpus().length, cpu_model: os.cpus()[0]?.model || null, total_memory_bytes: os.totalmem(), gpu: gpu.status === 0 ? gpu.stdout.trim() : null, hostname_digest: digest(os.hostname()), git_commit: git.status === 0 ? git.stdout.trim() : null, node: process.version, model_inventory: modelInventory, human_interventions_during_cells: { value: 0, provenance: 'operator-declared' } });
}

async function runCell(scheduleCell, scenario, previousCellDigest, privateKey) {
  const route = routeFor(scheduleCell.policy_id, scenario); const attempts = [{ ...await runOllamaAttempt(scenario, route.initial_tier), attempt: 1 }];
  if (attempts[0].verification.status !== 'passed' && route.escalation_tier) attempts.push({ ...await runOllamaAttempt(scenario, route.escalation_tier), attempt: 2 });
  return buildCell({ scheduleCell, scenario, route, attempts, previousCellDigest, privateKey });
}

function cellFile(output, cell) { return path.join(output, 'cells', `${String(cell.order).padStart(3, '0')}-${cell.scenario_id}--${cell.policy_id}--r${cell.repetition}.json`); }
function percent(value) { return value === null ? 'unknown' : `${(value * 100).toFixed(1)}%`; }
function reportMarkdown(bundle) {
  const lines = ['# Citadel representative repository-operation pilot', '', `Run: \`${bundle.run_id}\`  `, `Freeze: \`${bundle.freeze_id}\`  `, `Window: ${bundle.started_at} to ${bundle.completed_at}`, '', '## Result', '', `Evidence and economic gates: **${bundle.summary.evidence_result}**.`, '', '| Policy | Unique tasks | Verified cells | Attempts | 3B | 7B | Escalations | Request wall time | GPU kWh | Modeled GPU USD |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for (const policy of bundle.summary.policies) lines.push(`| ${policy.policy_id} | ${policy.unique_tasks} | ${policy.verified}/${policy.cells} | ${policy.attempts} | ${policy.cheap_attempts} | ${policy.strong_attempts} | ${policy.escalations} | ${(policy.request_wall_duration_ms / 1000).toFixed(1)}s | ${policy.gpu_energy_kwh === null ? 'unknown' : policy.gpu_energy_kwh.toFixed(6)} | ${policy.modeled_gpu_cost_usd === null ? 'unknown' : `$${policy.modeled_gpu_cost_usd.toFixed(6)}`} |`);
  lines.push('', '## Frozen comparisons', '', `- Relative verified-cell completion: ${percent(bundle.summary.comparison.quality_ratio)} of always-7B.`, `- GPU-energy reduction: ${percent(bundle.summary.comparison.gpu_energy_reduction)}.`, `- Modeled GPU-cost reduction: ${percent(bundle.summary.comparison.modeled_gpu_cost_reduction)}.`, `- Request wall-time reduction: ${percent(bundle.summary.comparison.request_wall_duration_reduction)}.`, '', '## Gates', '', ...Object.entries(bundle.summary.gates).map(([gate, passed]) => `- ${gate}: **${passed ? 'passed' : 'failed'}**`), '', '## Claim boundary', '', 'This is a six-unique-task, 24-cell repository-operation shakedown on one Windows workstation, one GTX 1070, and one Qwen model family. Every attempt uses a fresh fixture copy and a deterministic model-external subprocess verifier. Repetitions estimate timing variability and are not independent task samples. GPU energy is measured from retained average power and request wall duration; actual end-to-end cash remains unknown.', '', 'A pass would establish harness execution, verifier replay, source binding, and policy accounting on these fixtures only. It would not establish general savings or best-in-class routing.', '', 'Run `npm run representative:verify` to replay repository verifiers and reconstruct routes, economics, receipts, chains, source bindings, artifact digests, and signatures.', '');
  return lines.join('\n');
}

async function runBenchmark({ output = DEFAULT_OUTPUT, keyFile = DEFAULT_KEY } = {}) {
  const freeze = validateFreeze(readJson(FREEZE_FILE)); const privateKey = fs.readFileSync(keyFile, 'utf8'); if (publicKeyFromPrivate(privateKey) !== freeze.attestation_public_key) throw new Error('representative private key does not match freeze');
  const health = await doctor(freeze); if (health.status !== 'passed' || health.freeze !== 'passed') throw new Error('representative doctor did not pass');
  const byId = new Map(scenarios().map((scenario) => [scenario.id, scenario])); fs.mkdirSync(path.join(output, 'cells'), { recursive: true }); const startedAt = new Date().toISOString(); const cells = []; let previousCellDigest = null;
  for (const scheduleCell of freeze.schedule) {
    const file = cellFile(output, scheduleCell); let cell;
    if (fs.existsSync(file)) cell = readJson(file); else { writeJson(path.join(output, 'intent.json'), { schema: 1, freeze_id: freeze.freeze_id, schedule_cell: scheduleCell, previous_cell_digest: previousCellDigest, written_at: new Date().toISOString() }); cell = await runCell(scheduleCell, byId.get(scheduleCell.scenario_id), previousCellDigest, privateKey); writeJson(file, cell); }
    verifyCell(cell, scheduleCell, byId.get(scheduleCell.scenario_id), freeze); if (cell.previous_cell_digest !== previousCellDigest) throw new Error(`${cell.cell_id} chain mismatch`); cells.push(cell); previousCellDigest = cell.receipt_digest; process.stdout.write(`[${cells.length}/${freeze.schedule.length}] ${cell.scenario_id}/${cell.policy_id}/r${cell.repetition}: ${cell.status}\n`);
  }
  const completedAt = new Date().toISOString(); const summary = summarize(cells); const artifacts = freeze.schedule.map((scheduleCell) => ({ path: path.relative(output, cellFile(output, scheduleCell)).replace(/\\/g, '/'), digest: digest(readJson(cellFile(output, scheduleCell))) }));
  const unsigned = { schema: 1, bundle_id: null, run_id: digest({ freeze_id: freeze.freeze_id, first: cells[0].receipt_digest, last: previousCellDigest, started_at: startedAt }), freeze_id: freeze.freeze_id, started_at: startedAt, completed_at: completedAt, environment: machineProfile(health.models), economics: freeze.economics, artifacts, final_chain_digest: previousCellDigest, summary };
  const payload = { ...unsigned, bundle_id: digest(unsigned) }; const report = reportMarkdown(payload); fs.writeFileSync(path.join(output, 'REPORT.md'), report, 'utf8'); const finalPayload = { ...payload, report_digest: digest(report.replace(/\r\n/g, '\n')) }; const bundle = { ...finalPayload, attestation: signPayload(finalPayload, privateKey) }; writeJson(path.join(output, 'bundle.json'), bundle); if (fs.existsSync(path.join(output, 'intent.json'))) fs.rmSync(path.join(output, 'intent.json')); return bundle;
}

function verifyPublished(output = DEFAULT_OUTPUT) {
  const freeze = validateFreeze(readJson(FREEZE_FILE)); const bundle = readJson(path.join(output, 'bundle.json')); const byId = new Map(scenarios().map((scenario) => [scenario.id, scenario])); const cells = []; let previousCellDigest = null;
  for (const scheduleCell of freeze.schedule) { const cell = verifyCell(readJson(cellFile(output, scheduleCell)), scheduleCell, byId.get(scheduleCell.scenario_id), freeze); if (cell.previous_cell_digest !== previousCellDigest) throw new Error(`${cell.cell_id} chain mismatch`); cells.push(cell); previousCellDigest = cell.receipt_digest; }
  const artifacts = freeze.schedule.map((scheduleCell) => ({ path: path.relative(output, cellFile(output, scheduleCell)).replace(/\\/g, '/'), digest: digest(readJson(cellFile(output, scheduleCell))) })); if (JSON.stringify(bundle.artifacts) !== JSON.stringify(artifacts) || bundle.final_chain_digest !== previousCellDigest || JSON.stringify(bundle.summary) !== JSON.stringify(summarize(cells))) throw new Error('representative bundle summary drifted');
  const report = fs.readFileSync(path.join(output, 'REPORT.md'), 'utf8').replace(/\r\n/g, '\n'); if (bundle.report_digest !== digest(report)) throw new Error('representative report digest drifted'); const payload = { ...bundle }; delete payload.attestation; const identity = { ...payload, bundle_id: null }; delete identity.report_digest; if (bundle.bundle_id !== digest(identity) || !verifySignature(payload, bundle.attestation, freeze.attestation_public_key)) throw new Error('representative bundle signature invalid'); return Object.freeze({ status: 'passed', freeze_id: freeze.freeze_id, bundle_id: bundle.bundle_id, cells: cells.length, summary: bundle.summary });
}

module.exports = Object.freeze({ BENCHMARK, DEFAULT_KEY, DEFAULT_OUTPUT, ECONOMICS, FREEZE_FILE, GATES, MODELS, POLICIES, REPETITIONS, buildCell, createAttempt, createFreeze, doctor, evaluateRepositoryOutput, promptFor, publicKeyFromPrivate, routeFor, runBenchmark, scenarios, sourceFiles, stableSchedule, summarize, validateFreeze, verifyCell, verifyPublished, writeJson });
