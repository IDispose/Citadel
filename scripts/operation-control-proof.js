#!/usr/bin/env bun
'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  POLICY_IDS,
  digest,
  validateObservation,
  validatePlan,
  validateScenario,
} = require('../core/operation-control/contracts');
const { promptRoute, routeRomaOperation } = require('../core/operation-control/policy');
const {
  createCellReceipt,
  generateAttestationKeyPair,
  reconcileRomaPlan,
  signPayload,
  verifyScenarioOutput,
  verifySignature,
} = require('../core/operation-control/receipt');
const { codexObservation } = require('./optimizer-runtime-adapter');

const ROOT = path.resolve(__dirname, '..');
const BENCHMARK = path.join(ROOT, 'benchmarks', 'roma-operation-control');
const SCENARIOS_FILE = path.join(BENCHMARK, 'scenarios.json');
const FREEZE_FILE = path.join(BENCHMARK, 'freeze.json');
const DEFAULT_OUTPUT = path.join(BENCHMARK, 'published-run');
const DEFAULT_KEY = path.join('C:\\tmp', 'citadel-operation-proof-ed25519.pem');
const ROMA_ROOT_DEFAULT = path.join('C:\\tmp', 'ROMA');
const PYTHON_DEFAULT = path.join('C:\\tmp', 'roma-venv', 'Scripts', 'python.exe');
const ROMA_COMMIT = 'a6e3bb4f9e0694375fa627fa4b8bf8cae50592a6';
const OLLAMA_ENDPOINT = 'http://127.0.0.1:11434';
const FRONTIER_MODEL = 'gpt-5.6-sol';
const FREEZE_SEED = 'citadel-roma-diagnostic-v1-2026-07-31';
const POLICIES = Object.freeze([
  'frontier-only',
  'prompt-router',
  'always-open-local',
  'citadel-whole-operation',
]);
const SOURCE_FILES = Object.freeze([
  'benchmarks/roma-operation-control/METHOD.md',
  'benchmarks/roma-operation-control/scenarios.json',
  'core/operation-control/contracts.js',
  'core/operation-control/policy.js',
  'core/operation-control/receipt.js',
  'scripts/operation-control-proof.js',
  'scripts/optimizer-runtime-adapter.js',
  'scripts/roma-operation-bridge.py',
  'scripts/test-operation-control.js',
]);

function resolveExecutable(name) {
  const probe = childProcess.spawnSync('where.exe', [name], { encoding: 'utf8', shell: false, windowsHide: true });
  if (probe.status !== 0) return name;
  const candidates = probe.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  return candidates[0] || name;
}

function codexInvocation(args) {
  const rtk = resolveExecutable('rtk');
  if (rtk !== 'rtk') return { command: rtk, args: ['codex', ...args] };
  return { command: resolveExecutable('codex'), args };
}

function option(name, fallback = null) {
  const prefix = `--${name}=`;
  const match = process.argv.find((argument) => argument.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function normalizedSource(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
}

function sourceDigests() {
  return Object.fromEntries(SOURCE_FILES.map((file) => [file, digest(normalizedSource(file))]));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function scenarios() {
  const values = readJson(SCENARIOS_FILE);
  if (!Array.isArray(values) || values.length !== 6) throw new Error('scenario set must contain exactly six scenarios');
  values.forEach((scenario, index) => validateScenario(scenario, `scenarios[${index}]`));
  if (new Set(values.map((scenario) => scenario.id)).size !== values.length) throw new Error('scenario ids must be unique');
  if (values.some((scenario) => scenario.holdout !== true)) throw new Error('every diagnostic scenario must be frozen holdout');
  return values;
}

function adapterDigest() {
  return digest(normalizedSource('scripts/roma-operation-bridge.py'));
}

function modelCatalog() {
  return {
    cheap: {
      provider: 'ollama',
      model: 'qwen2.5-coder:3b',
      model_digest: 'sha256:f72c60cabf6237b07f6e632b2c48d533cef25eda2efbd34bed21c5e9c01e6225',
      endpoint: OLLAMA_ENDPOINT,
    },
    strong: {
      provider: 'ollama',
      model: 'qwen2.5-coder:7b',
      model_digest: 'sha256:dae161e27b0e90dd1856c8bb3209201fd6736d8eb66298e75ed87571486f4364',
      endpoint: OLLAMA_ENDPOINT,
    },
  };
}

function stackBinding() {
  return {
    adapter_id: 'roma-dspy-python',
    upstream_repo: 'https://github.com/sentient-agi/ROMA',
    upstream_commit: ROMA_COMMIT,
    entrypoint: 'roma_dspy.core.engine.solve.RecursiveSolver.event_solve',
    adapter_digest: adapterDigest(),
  };
}

function stableCells(values, seed) {
  return values.flatMap((scenario) => [...POLICIES]
    .sort((left, right) => digest(`${seed}\n${scenario.id}\n${left}`).localeCompare(digest(`${seed}\n${scenario.id}\n${right}`)))
    .map((policyId, order) => ({ scenario_id: scenario.id, policy_id: policyId, order })));
}

function validateFreeze(value, { verifySources = true } = {}) {
  if (!value || value.schema !== 1 || typeof value.freeze_id !== 'string') throw new Error('freeze is invalid');
  if (value.freeze_id !== digest({ ...value, freeze_id: null })) throw new Error('freeze id does not match contents');
  if (value.method_digest !== digest(normalizedSource('benchmarks/roma-operation-control/METHOD.md'))) {
    throw new Error('frozen method drifted');
  }
  if (value.scenario_set_digest !== digest(scenarios())) throw new Error('frozen scenario set drifted');
  if (value.roma.upstream_repo !== 'https://github.com/sentient-agi/ROMA'
    || value.roma.upstream_commit !== ROMA_COMMIT || value.roma.adapter_digest !== adapterDigest()) {
    throw new Error('frozen ROMA binding drifted');
  }
  if (JSON.stringify(value.models) !== JSON.stringify(modelCatalog())) throw new Error('frozen model catalog drifted');
  if (value.frontier.runtime !== 'codex-cli-subscription' || value.frontier.model !== FRONTIER_MODEL
    || value.frontier.per_request_cost_status !== 'unknown') {
    throw new Error('frozen frontier binding drifted');
  }
  if (JSON.stringify(value.policies) !== JSON.stringify(POLICIES)) throw new Error('frozen policy set drifted');
  if (JSON.stringify(POLICIES) !== JSON.stringify(POLICY_IDS)) throw new Error('runner and contract policy ids diverged');
  if (value.seed !== FREEZE_SEED || value.repetitions !== 1
    || JSON.stringify(value.cells) !== JSON.stringify(stableCells(scenarios(), FREEZE_SEED))) {
    throw new Error('frozen cell schedule drifted');
  }
  const expectedGate = {
    primary_metric: 'independently_verified_completion_rate',
    zero_false_passes_required: true,
    citadel_must_not_underperform_always_open_local: true,
    strong_whole_operation_avoidance_required: 1,
  };
  if (JSON.stringify(value.success_gate) !== JSON.stringify(expectedGate)) throw new Error('frozen success gate drifted');
  if (verifySources && JSON.stringify(value.source_digests) !== JSON.stringify(sourceDigests())) {
    throw new Error('one or more frozen source files changed');
  }
  crypto.createPublicKey(value.attestation_public_key);
  return value;
}

function freeze() {
  if (fs.existsSync(FREEZE_FILE)) throw new Error('freeze.json already exists; remove it explicitly before freezing a replacement method');
  const method = normalizedSource('benchmarks/roma-operation-control/METHOD.md');
  if (/method draft/i.test(method)) throw new Error('METHOD.md still identifies itself as a draft');
  const keyFile = path.resolve(option('key-out', DEFAULT_KEY));
  if (fs.existsSync(keyFile)) throw new Error(`attestation key already exists: ${keyFile}`);
  const keys = generateAttestationKeyPair();
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, keys.private_key, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  const seed = FREEZE_SEED;
  const unsigned = {
    schema: 1,
    freeze_id: null,
    frozen_at: new Date().toISOString(),
    method_digest: digest(method),
    scenario_set_digest: digest(scenarios()),
    source_digests: sourceDigests(),
    policies: [...POLICIES],
    repetitions: 1,
    seed,
    cells: stableCells(scenarios(), seed),
    roma: {
      upstream_repo: 'https://github.com/sentient-agi/ROMA',
      upstream_commit: ROMA_COMMIT,
      adapter_digest: adapterDigest(),
    },
    models: modelCatalog(),
    frontier: {
      runtime: 'codex-cli-subscription',
      model: FRONTIER_MODEL,
      per_request_cost_status: 'unknown',
    },
    success_gate: {
      primary_metric: 'independently_verified_completion_rate',
      zero_false_passes_required: true,
      citadel_must_not_underperform_always_open_local: true,
      strong_whole_operation_avoidance_required: 1,
    },
    attestation_public_key: keys.public_key,
  };
  const value = { ...unsigned, freeze_id: digest(unsigned) };
  writeJson(FREEZE_FILE, value);
  process.stdout.write(`${JSON.stringify({ freeze_id: value.freeze_id, key_file: keyFile, cells: value.cells.length }, null, 2)}\n`);
}

function fetchJson(url, { method = 'GET', body = null, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {},
      timeout: timeoutMs,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode}: ${text.slice(-1000)}`));
          return;
        }
        try { resolve(JSON.parse(text)); } catch (error) { reject(new Error(`invalid JSON response: ${error.message}`)); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('HTTP request timed out')));
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function runProcess(command, args, { cwd, input = null, timeoutMs, env = process.env, maxBuffer = 32 * 1024 * 1024 }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = childProcess.spawn(command, args, { cwd, env, shell: false, windowsHide: true });
    } catch (error) {
      resolve({ status: null, signal: null, stdout: '', stderr: error.message, timed_out: false, duration_ms: Date.now() - started });
      return;
    }
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    let timedOut = false;
    const collect = (target, chunk, kind) => {
      const size = Buffer.byteLength(chunk);
      if ((kind === 'stdout' ? stdoutBytes : stderrBytes) + size > maxBuffer) {
        overflow = true;
        child.kill();
        return;
      }
      if (kind === 'stdout') stdoutBytes += size;
      else stderrBytes += size;
      target.push(chunk);
    };
    child.stdout.on('data', (chunk) => collect(stdout, chunk, 'stdout'));
    child.stderr.on('data', (chunk) => collect(stderr, chunk, 'stderr'));
    child.on('error', (error) => stderr.push(Buffer.from(error.message)));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        status: overflow ? null : code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timed_out: timedOut,
        duration_ms: Date.now() - started,
      });
    });
    if (input !== null) child.stdin.end(input);
    else child.stdin.end();
  });
}

function startGpuSampler() {
  const samples = [];
  let child = null;
  let available = true;
  try {
    child = childProcess.spawn('nvidia-smi', [
      '--query-gpu=power.draw',
      '--format=csv,noheader,nounits',
      '-lms',
      '500',
    ], { shell: false, windowsHide: true });
    let pending = '';
    child.stdout.on('data', (chunk) => {
      pending += chunk.toString('utf8');
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        const watts = Number(line.trim());
        if (Number.isFinite(watts) && watts >= 0) samples.push(watts);
      }
    });
    child.on('error', () => { available = false; });
  } catch (_error) {
    available = false;
  }
  return {
    async stop(durationMs) {
      if (child && !child.killed) child.kill();
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!available || !samples.length) return null;
      const averageWatts = samples.reduce((sum, value) => sum + value, 0) / samples.length;
      return {
        samples: samples.length,
        average_watts: Number(averageWatts.toFixed(6)),
        energy_kwh: Number((averageWatts * (durationMs / 3600000) / 1000).toFixed(9)),
      };
    },
  };
}

async function withGpu(task) {
  const sampler = startGpuSampler();
  const started = Date.now();
  try {
    const value = await task();
    return { value, gpu: await sampler.stop(Date.now() - started) };
  } catch (error) {
    await sampler.stop(Date.now() - started);
    throw error;
  }
}

function boundedFailure(result) {
  return {
    exit_code: result.status,
    timed_out: result.timed_out,
    stdout_digest: digest(result.stdout || ''),
    stdout_excerpt: String(result.stdout || '').slice(-4000),
    stderr_digest: digest(result.stderr || ''),
    stderr_excerpt: String(result.stderr || '').slice(-2000),
  };
}

function usageFromCodex(observation) {
  if (!observation || !observation.usage) return null;
  const value = observation.usage;
  return {
    prompt_tokens: Number(value.prompt_tokens || value.input_tokens || 0),
    completion_tokens: Number(value.completion_tokens || value.output_tokens || 0),
    total_tokens: Number(value.total_tokens || (value.input_tokens || 0) + (value.output_tokens || 0)),
    cached_input_tokens: Number(value.cached_input_tokens || 0),
  };
}

function lastCodexMessage(stdout) {
  let message = '';
  for (const line of String(stdout || '').split(/\r?\n/)) {
    let event;
    try { event = JSON.parse(line); } catch (_error) { continue; }
    if (event.type === 'item.completed' && event.item && event.item.type === 'agent_message') message = event.item.text || message;
  }
  return message;
}

function codexThreadId(stdout) {
  for (const line of String(stdout || '').split(/\r?\n/)) {
    let event;
    try { event = JSON.parse(line); } catch (_error) { continue; }
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') return event.thread_id;
  }
  return null;
}

function findCodexSessionFile(threadId) {
  if (typeof threadId !== 'string' || !/^[0-9a-f-]{36}$/.test(threadId)) return null;
  const home = process.env.CODEX_HOME
    || ((process.env.USERPROFILE || process.env.HOME) ? path.join(process.env.USERPROFILE || process.env.HOME, '.codex') : null);
  if (!home) return null;
  const sessions = path.resolve(home, 'sessions');
  let realRoot;
  try {
    realRoot = fs.realpathSync(sessions);
    if (!fs.statSync(realRoot).isDirectory() || fs.lstatSync(realRoot).isSymbolicLink()) return null;
  } catch (_error) {
    return null;
  }
  const suffix = `-${threadId}.jsonl`.toLowerCase();
  const stack = [realRoot];
  let scanned = 0;
  let match = null;
  while (stack.length) {
    const directory = stack.pop();
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (_error) { return null; }
    for (const entry of entries) {
      scanned += 1;
      if (scanned > 20000 || entry.isSymbolicLink()) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) stack.push(candidate);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(suffix)) {
        let real;
        try { real = fs.realpathSync(candidate); } catch (_error) { return null; }
        if (!real.startsWith(`${realRoot}${path.sep}`) || match !== null) return null;
        match = real;
      }
    }
  }
  return match;
}

function codexSessionReceipt(stdout, repositoryPath) {
  const threadId = codexThreadId(stdout);
  const file = threadId ? findCodexSessionFile(threadId) : null;
  if (!file) return null;
  const expectedCwd = fs.realpathSync(repositoryPath);
  const content = fs.readFileSync(file, 'utf8');
  let matched = null;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch (_error) { continue; }
    if (event.type !== 'turn_context' || !event.payload || typeof event.payload.cwd !== 'string') continue;
    let eventCwd;
    try { eventCwd = fs.realpathSync(event.payload.cwd); } catch (_error) { continue; }
    if (eventCwd !== expectedCwd || typeof event.payload.model !== 'string') continue;
    matched = {
      thread_id: threadId,
      model: event.payload.model,
      cwd_digest: digest(expectedCwd),
      turn_context_digest: digest(event),
      session_file_digest: digest(content.replace(/\r\n/g, '\n')),
      session_bytes: Buffer.byteLength(content),
    };
  }
  return matched;
}

async function runCodex(scenario, freezeValue) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-frontier-cell-'));
  const schemaFile = path.join(temporary, 'answer.schema.json');
  const outputFile = path.join(temporary, 'answer.json');
  writeJson(schemaFile, {
    type: 'object',
    properties: { answer: { type: scenario.verification.answer_type } },
    required: ['answer'],
    additionalProperties: false,
  });
  const startedAt = new Date().toISOString();
  try {
    const invocation = codexInvocation([
      'exec',
      '--model', freezeValue.frontier.model,
      '--sandbox', 'read-only',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '--ignore-rules',
      '--json',
      '--output-schema', schemaFile,
      '--output-last-message', outputFile,
      '-',
    ]);
    const result = await runProcess(invocation.command, invocation.args, {
      cwd: temporary,
      input: `${scenario.task}\nDo not use tools. Solve only from the supplied task.\n`,
      timeoutMs: scenario.timeout_seconds * 1000,
    });
    const observed = codexObservation(result.stdout, temporary);
    const sessionReceipt = codexSessionReceipt(result.stdout, temporary);
    const outputText = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : lastCodexMessage(result.stdout);
    const verified = result.status === 0
      && observed
      && observed.model === freezeValue.frontier.model
      && sessionReceipt
      && sessionReceipt.model === freezeValue.frontier.model;
    return {
      outputText,
      startedAt,
      durationMs: result.duration_ms,
      usage: usageFromCodex(observed),
      gpu: null,
      billingClass: 'subscription',
      executionEvidence: {
        status: verified ? 'verified' : 'unknown',
        runtime: 'codex-cli',
        requested_model: freezeValue.frontier.model,
        observed_model: observed ? observed.model : null,
        source: observed ? observed.source : null,
        session_receipt: sessionReceipt,
        process: boundedFailure(result),
      },
      raw: { stdout_digest: digest(result.stdout), stderr_digest: digest(result.stderr) },
    };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

async function runOllama(scenario, model, modelDigest) {
  const startedAt = new Date().toISOString();
  const measured = await withGpu(async () => {
    const started = Date.now();
    try {
      const response = await fetchJson(`${OLLAMA_ENDPOINT}/api/chat`, {
        method: 'POST',
        timeoutMs: scenario.timeout_seconds * 1000,
        body: JSON.stringify({
          model,
          stream: false,
          messages: [{ role: 'user', content: `${scenario.task}\nDo not use tools. Solve only from the supplied task.` }],
          options: { temperature: 0, num_predict: 2048 },
        }),
      });
      return { response, durationMs: Date.now() - started, error: null };
    } catch (error) {
      return { response: null, durationMs: Date.now() - started, error: error.message };
    }
  });
  const response = measured.value.response;
  const verified = response && response.model === model && response.done === true;
  const promptTokens = Number(response && response.prompt_eval_count || 0);
  const completionTokens = Number(response && response.eval_count || 0);
  return {
    outputText: response && response.message ? String(response.message.content || '') : '',
    startedAt,
    durationMs: measured.value.durationMs,
    usage: response ? {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      provider_total_duration_ns: Number(response.total_duration || 0),
    } : null,
    gpu: measured.gpu,
    billingClass: 'self-hosted-local',
    executionEvidence: {
      status: verified ? 'verified' : 'unknown',
      runtime: 'ollama-chat',
      requested_model: model,
      observed_model: response ? response.model : null,
      model_digest: modelDigest,
      done_reason: response ? response.done_reason || null : null,
      error: measured.value.error,
    },
    raw: response ? { response_digest: digest(response) } : null,
  };
}

async function runRomaAttempt(scenario, plan, romaRoot, python) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-roma-cell-'));
  const inputFile = path.join(temporary, 'input.json');
  const outputFile = path.join(temporary, 'output.json');
  writeJson(inputFile, {
    schema: 1,
    plan,
    task: scenario.task,
    roma_root: romaRoot,
    work_dir: temporary,
  });
  const startedAt = new Date().toISOString();
  try {
    const measured = await withGpu(() => runProcess(python, [
      path.join(ROOT, 'scripts', 'roma-operation-bridge.py'),
      inputFile,
      outputFile,
    ], {
      cwd: temporary,
      timeoutMs: (scenario.timeout_seconds + 60) * 1000,
      env: { ...process.env, LITELLM_LOCAL_MODEL_COST_MAP: 'True' },
    }));
    const result = measured.value;
    let observation = null;
    let reconciliation = null;
    if (fs.existsSync(outputFile)) {
      try {
        observation = validateObservation(readJson(outputFile));
        reconciliation = reconcileRomaPlan(plan, observation);
      } catch (_error) {
        observation = null;
      }
    }
    return {
      outputText: observation ? observation.output_text || '' : '',
      startedAt,
      durationMs: result.duration_ms,
      usage: observation ? observation.totals : null,
      gpu: measured.gpu,
      billingClass: 'self-hosted-local',
      observation,
      executionEvidence: {
        status: observation && reconciliation.status === 'verified' ? 'verified' : 'unknown',
        runtime: 'roma-dspy',
        plan_id: plan.plan_id,
        observation_digest: observation ? digest(observation) : null,
        reconciliation_status: reconciliation ? reconciliation.status : null,
        process: boundedFailure(result),
      },
      raw: { stdout_digest: digest(result.stdout), stderr_digest: digest(result.stderr) },
    };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function attemptArtifact({ scenario, policyId, attempt, execution, plan = null }) {
  const receipt = createCellReceipt({
    scenario,
    policyId,
    attempt,
    plan,
    observation: execution.observation || null,
    outputText: execution.outputText,
    startedAt: execution.startedAt,
    durationMs: execution.durationMs,
    usage: execution.usage,
    gpu: execution.gpu,
    billingClass: execution.billingClass,
    executionEvidence: execution.executionEvidence,
  });
  return {
    receipt,
    plan,
    observation: execution.observation || null,
    output_text: execution.outputText,
    raw_execution: execution.raw,
  };
}

async function executeCell(scenario, policyId, freezeValue, romaRoot, python) {
  if (policyId === 'frontier-only') {
    const execution = await runCodex(scenario, freezeValue);
    return { route: null, attempts: [attemptArtifact({ scenario, policyId, attempt: 1, execution })] };
  }
  if (policyId === 'always-open-local') {
    const model = freezeValue.models.strong;
    const execution = await runOllama(scenario, model.model, model.model_digest);
    return { route: null, attempts: [attemptArtifact({ scenario, policyId, attempt: 1, execution })] };
  }
  if (policyId === 'prompt-router') {
    const route = promptRoute(scenario.task);
    const execution = route.target === 'frontier'
      ? await runCodex(scenario, freezeValue)
      : await runOllama(scenario, freezeValue.models.cheap.model, freezeValue.models.cheap.model_digest);
    return { route, attempts: [attemptArtifact({ scenario, policyId, attempt: 1, execution })] };
  }
  const firstPlan = routeRomaOperation({
    scenario,
    catalog: freezeValue.models,
    stack: stackBinding(),
  });
  const firstExecution = await runRomaAttempt(scenario, firstPlan, romaRoot, python);
  const attempts = [attemptArtifact({ scenario, policyId, attempt: 1, execution: firstExecution, plan: firstPlan })];
  if (attempts[0].receipt.completion.status === 'failed') {
    const secondPlan = routeRomaOperation({
      scenario,
      catalog: freezeValue.models,
      stack: stackBinding(),
      attempt: 2,
      previous: { completion_status: 'failed' },
    });
    const secondExecution = await runRomaAttempt(scenario, secondPlan, romaRoot, python);
    attempts.push(attemptArtifact({ scenario, policyId, attempt: 2, execution: secondExecution, plan: secondPlan }));
  }
  return { route: null, attempts };
}

function cellArtifactPath(outputDirectory, scenarioId, policyId) {
  return path.join(outputDirectory, 'cells', `${scenarioId}--${policyId}.json`);
}

function validateReceiptId(receipt) {
  return receipt && receipt.receipt_id === digest({ ...receipt, receipt_id: null });
}

function validateCellArtifact(artifact, scenario, policyId, freezeValue, expectedRunId = null) {
  if (!artifact || artifact.schema !== 1 || artifact.scenario_id !== scenario.id || artifact.policy_id !== policyId) {
    throw new Error(`cell artifact identity is invalid for ${scenario.id}/${policyId}`);
  }
  if (artifact.freeze_id !== freezeValue.freeze_id || !/^sha256:[0-9a-f]{64}$/.test(artifact.run_id)) {
    throw new Error(`cell run binding is invalid for ${scenario.id}/${policyId}`);
  }
  if (expectedRunId !== null && artifact.run_id !== expectedRunId) {
    throw new Error(`cell run id does not match bundle for ${scenario.id}/${policyId}`);
  }
  if (!Array.isArray(artifact.attempts) || !artifact.attempts.length || artifact.attempts.length > 2) {
    throw new Error(`cell attempts are invalid for ${scenario.id}/${policyId}`);
  }
  if (policyId !== 'citadel-whole-operation' && artifact.attempts.length !== 1) {
    throw new Error(`baseline policy has multiple attempts for ${scenario.id}/${policyId}`);
  }
  if (artifact.attempts.length === 2 && artifact.attempts[0].receipt.completion.status !== 'failed') {
    throw new Error(`second attempt lacks an independently failed first attempt for ${scenario.id}/${policyId}`);
  }
  for (const [index, attempt] of artifact.attempts.entries()) {
    if (!validateReceiptId(attempt.receipt)) throw new Error(`receipt id is invalid for ${scenario.id}/${policyId}/${index + 1}`);
    const verification = verifyScenarioOutput(scenario, attempt.output_text);
    if (JSON.stringify(verification) !== JSON.stringify(attempt.receipt.completion)) {
      throw new Error(`completion receipt does not reproduce for ${scenario.id}/${policyId}/${index + 1}`);
    }
    if (attempt.plan || attempt.observation) {
      if (!attempt.plan || !attempt.observation) throw new Error(`plan/observation pair is incomplete for ${scenario.id}/${policyId}/${index + 1}`);
      validatePlan(attempt.plan);
      validateObservation(attempt.observation);
      if (policyId !== 'citadel-whole-operation') {
        throw new Error(`baseline policy contains a ROMA plan for ${scenario.id}/${policyId}/${index + 1}`);
      }
      const expectedPlan = routeRomaOperation({
        scenario,
        catalog: freezeValue.models,
        stack: stackBinding(),
        attempt: index + 1,
        previous: index === 0 ? null : { completion_status: 'failed' },
      });
      if (JSON.stringify(attempt.plan) !== JSON.stringify(expectedPlan)) {
        throw new Error(`operation plan does not reproduce for ${scenario.id}/${policyId}/${index + 1}`);
      }
      const control = reconcileRomaPlan(attempt.plan, attempt.observation);
      if (JSON.stringify(control) !== JSON.stringify(attempt.receipt.control)) {
        throw new Error(`control receipt does not reproduce for ${scenario.id}/${policyId}/${index + 1}`);
      }
    } else {
      const evidence = attempt.receipt.execution_evidence;
      let evidenceVerified = evidence && evidence.status === 'verified' && evidence.process === undefined;
      if (evidence && evidence.runtime === 'codex-cli') {
        evidenceVerified = evidence.status === 'verified'
          && evidence.requested_model === freezeValue.frontier.model
          && evidence.observed_model === freezeValue.frontier.model
          && evidence.process.exit_code === 0
          && evidence.session_receipt
          && evidence.session_receipt.model === freezeValue.frontier.model
          && typeof evidence.session_receipt.session_file_digest === 'string';
      } else if (evidence && evidence.runtime === 'ollama-chat') {
        const expected = Object.values(freezeValue.models).find((model) => model.model === evidence.requested_model);
        evidenceVerified = evidence.status === 'verified'
          && expected
          && evidence.observed_model === expected.model
          && evidence.model_digest === expected.model_digest;
      }
      const expectedStatus = evidenceVerified ? 'verified' : 'unknown';
      if (attempt.receipt.control.status !== expectedStatus) {
        throw new Error(`baseline control receipt does not reproduce for ${scenario.id}/${policyId}/${index + 1}`);
      }
    }
    const gpuComponent = attempt.receipt.cost.components.find((component) => component.kind === 'gpu_energy');
    const gpu = gpuComponent && gpuComponent.status === 'measured_nonmonetary'
      ? { energy_kwh: gpuComponent.energy_kwh, samples: gpuComponent.samples }
      : null;
    const billingClass = attempt.receipt.execution_evidence.runtime === 'codex-cli'
      ? 'subscription' : 'self-hosted-local';
    const reproduced = createCellReceipt({
      scenario,
      policyId,
      attempt: index + 1,
      plan: attempt.plan,
      observation: attempt.observation,
      outputText: attempt.output_text,
      startedAt: attempt.receipt.started_at,
      durationMs: attempt.receipt.duration_ms,
      usage: attempt.receipt.cost.usage,
      gpu,
      billingClass,
      executionEvidence: attempt.receipt.execution_evidence,
    });
    if (JSON.stringify(reproduced) !== JSON.stringify(attempt.receipt)) {
      throw new Error(`full receipt does not reproduce for ${scenario.id}/${policyId}/${index + 1}`);
    }
  }
  if (policyId === 'prompt-router') {
    const expectedRoute = promptRoute(scenario.task);
    if (JSON.stringify(artifact.route) !== JSON.stringify(expectedRoute)) throw new Error(`prompt route drifted for ${scenario.id}`);
    const runtime = artifact.attempts[0].receipt.execution_evidence.runtime;
    if ((expectedRoute.target === 'frontier' && runtime !== 'codex-cli')
      || (expectedRoute.target === 'open-local' && runtime !== 'ollama-chat')) {
      throw new Error(`prompt route delegate is invalid for ${scenario.id}`);
    }
  } else if (artifact.route !== null) {
    throw new Error(`unexpected route metadata for ${scenario.id}/${policyId}`);
  }
  return artifact;
}

function finalReceipt(artifact) {
  return artifact.attempts[artifact.attempts.length - 1].receipt;
}

function cellMetrics(artifact) {
  const receipt = finalReceipt(artifact);
  let promptTokens = 0;
  let completionTokens = 0;
  let durationMs = 0;
  let frontierCalls = 0;
  let local3bCalls = 0;
  let local7bCalls = 0;
  let strongWholeOperationAttempts = 0;
  for (const attempt of artifact.attempts) {
    const evidence = attempt.receipt.execution_evidence;
    durationMs += attempt.receipt.duration_ms;
    const usage = attempt.receipt.cost.usage;
    if (usage) {
      promptTokens += Number(usage.prompt_tokens || 0);
      completionTokens += Number(usage.completion_tokens || 0);
    }
    if (evidence.runtime === 'codex-cli') frontierCalls += 1;
    if (evidence.runtime === 'ollama-chat') {
      if (evidence.requested_model === 'qwen2.5-coder:3b') local3bCalls += 1;
      if (evidence.requested_model === 'qwen2.5-coder:7b') local7bCalls += 1;
      if (evidence.requested_model === 'qwen2.5-coder:7b') strongWholeOperationAttempts += 1;
    }
    if (attempt.observation) {
      for (const call of attempt.observation.provider_calls) {
        if (call.model.endsWith('qwen2.5-coder:3b')) local3bCalls += 1;
        if (call.model.endsWith('qwen2.5-coder:7b')) local7bCalls += 1;
      }
      if (attempt.plan.modules.find((module) => module.name === 'executor').model === 'qwen2.5-coder:7b') {
        strongWholeOperationAttempts += 1;
      }
    }
  }
  return {
    verified: receipt.completion.status === 'passed' && receipt.control.status === 'verified',
    completion_status: receipt.completion.status,
    control_status: receipt.control.status,
    duration_ms: durationMs,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    frontier_calls: frontierCalls,
    local_3b_calls: local3bCalls,
    local_7b_calls: local7bCalls,
    strong_whole_operation_attempts: strongWholeOperationAttempts,
    escalations: artifact.attempts.length - 1,
  };
}

function summarize(artifacts) {
  const policies = POLICIES.map((policyId) => {
    const selected = artifacts.filter((artifact) => artifact.policy_id === policyId);
    const metrics = selected.map(cellMetrics);
    const verified = metrics.filter((item) => item.verified).length;
    return {
      policy_id: policyId,
      cells: selected.length,
      independently_verified_completions: verified,
      independently_verified_completion_rate: Number((verified / selected.length).toFixed(6)),
      total_duration_ms: metrics.reduce((sum, item) => sum + item.duration_ms, 0),
      prompt_tokens: metrics.reduce((sum, item) => sum + item.prompt_tokens, 0),
      completion_tokens: metrics.reduce((sum, item) => sum + item.completion_tokens, 0),
      frontier_calls: metrics.reduce((sum, item) => sum + item.frontier_calls, 0),
      local_3b_calls: metrics.reduce((sum, item) => sum + item.local_3b_calls, 0),
      local_7b_calls: metrics.reduce((sum, item) => sum + item.local_7b_calls, 0),
      strong_whole_operation_attempts: metrics.reduce((sum, item) => sum + item.strong_whole_operation_attempts, 0),
      escalations: metrics.reduce((sum, item) => sum + item.escalations, 0),
      total_usd_status: 'unknown',
    };
  });
  const citadel = policies.find((policy) => policy.policy_id === 'citadel-whole-operation');
  const local = policies.find((policy) => policy.policy_id === 'always-open-local');
  const avoidance = local.strong_whole_operation_attempts - citadel.strong_whole_operation_attempts;
  // Every artifact has already passed validateCellArtifact before summarize runs.
  // A provider timeout or control mismatch is an execution outcome, not evidence
  // corruption, as long as the signed receipt records it truthfully.
  const integrityFailures = 0;
  const executionControlFailures = artifacts.reduce(
    (count, artifact) => count + artifact.attempts.filter((attempt) => attempt.receipt.control.status !== 'verified').length,
    0,
  );
  const falsePasses = artifacts.filter((artifact) => {
    const final = finalReceipt(artifact);
    return final.completion.status === 'passed' && verifyScenarioOutput(
      scenarios().find((scenario) => scenario.id === artifact.scenario_id),
      artifact.attempts[artifact.attempts.length - 1].output_text,
    ).status !== 'passed';
  }).length;
  const performanceSupported = citadel.independently_verified_completion_rate >= local.independently_verified_completion_rate
    && avoidance >= 1;
  return {
    policies,
    zero_false_passes: falsePasses === 0,
    false_passes: falsePasses,
    integrity_failures: integrityFailures,
    execution_control_failures: executionControlFailures,
    evidence_result: falsePasses === 0 && integrityFailures === 0 ? 'passed' : 'failed',
    performance_hypothesis: performanceSupported ? 'supported' : 'failed',
    performance_gate: {
      citadel_rate: citadel.independently_verified_completion_rate,
      always_open_local_rate: local.independently_verified_completion_rate,
      strong_whole_operation_avoidance: avoidance,
    },
  };
}

function reportMarkdown(runId, freezeValue, summary, startedAt, completedAt) {
  const lines = [
    '# Citadel whole-operation control diagnostic result',
    '',
    `Run: \`${runId}\`  `,
    `Freeze: \`${freezeValue.freeze_id}\`  `,
    `Window: ${startedAt} to ${completedAt}`,
    '',
    '## Outcome',
    '',
    `Evidence machinery: **${summary.evidence_result}**.  `,
    `Optimizer performance hypothesis: **${summary.performance_hypothesis}**.  `,
    `False passes: **${summary.false_passes}**.  `,
    `Receipt-integrity failures: **${summary.integrity_failures}**.  `,
    `Execution-control failures: **${summary.execution_control_failures}**.`,
    '',
    '| Policy | Verified | Rate | Duration | Prompt tokens | Completion tokens | Frontier calls | 3B calls | 7B calls | Escalations |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...summary.policies.map((policy) => `| ${policy.policy_id} | ${policy.independently_verified_completions}/${policy.cells} | ${(policy.independently_verified_completion_rate * 100).toFixed(1)}% | ${(policy.total_duration_ms / 1000).toFixed(1)}s | ${policy.prompt_tokens} | ${policy.completion_tokens} | ${policy.frontier_calls} | ${policy.local_3b_calls} | ${policy.local_7b_calls} | ${policy.escalations} |`),
    '',
    '## Interpretation boundary',
    '',
    'This is a six-task diagnostic, not a general superiority claim. A model or stack status never counted as completion; only the frozen deterministic answer verifier did. The total USD cost remains unknown because subscription allocation, CPU/system energy, electricity price, and hardware amortization were not all measured. Self-hosted Ollama provider invoice cost was $0 per request, which is not the same claim as zero total cost.',
    '',
    summary.performance_gate.strong_whole_operation_avoidance >= 0
      ? `Citadel avoided ${summary.performance_gate.strong_whole_operation_avoidance} strong whole-operation attempt(s) relative to always-7B local while recording every module/provider call and all verifier-triggered escalation.`
      : `Citadel used ${Math.abs(summary.performance_gate.strong_whole_operation_avoidance)} more strong whole-operation attempt(s) than always-7B local while recording every module/provider call and all verifier-triggered escalation.`,
    '',
    'Run `npm run operation-proof:verify` to recheck source bindings, cell artifacts, deterministic verification, control reconciliation, content digests, and the Ed25519 bundle signature.',
    '',
  ];
  return lines.join('\n');
}

async function doctor() {
  const freezeValue = fs.existsSync(FREEZE_FILE) ? validateFreeze(readJson(FREEZE_FILE)) : null;
  const romaRoot = path.resolve(option('roma-root', ROMA_ROOT_DEFAULT));
  const python = path.resolve(option('python', PYTHON_DEFAULT));
  const tags = await fetchJson(`${OLLAMA_ENDPOINT}/api/tags`);
  const inventory = new Map((tags.models || []).map((model) => [model.name, `sha256:${model.digest}`]));
  const catalog = modelCatalog();
  const commit = await runProcess('git', ['-c', `safe.directory=${romaRoot}`, 'rev-parse', 'HEAD'], {
    cwd: romaRoot,
    timeoutMs: 30000,
  });
  const imports = await runProcess(python, ['-c', "import dspy, roma_dspy; print(dspy.__version__)"], {
    cwd: romaRoot,
    timeoutMs: 120000,
    env: { ...process.env, LITELLM_LOCAL_MODEL_COST_MAP: 'True', DSPY_CACHEDIR: path.join(os.tmpdir(), 'citadel-dspy-doctor') },
  });
  const codexCommand = codexInvocation(['--version']);
  const codex = await runProcess(codexCommand.command, codexCommand.args, { cwd: ROOT, timeoutMs: 30000 });
  const result = {
    status: commit.status === 0
      && commit.stdout.trim() === ROMA_COMMIT
      && imports.status === 0
      && codex.status === 0
      && inventory.get(catalog.cheap.model) === catalog.cheap.model_digest
      && inventory.get(catalog.strong.model) === catalog.strong.model_digest ? 'ready' : 'not_ready',
    freeze_id: freezeValue ? freezeValue.freeze_id : null,
    roma_commit: commit.status === 0 ? commit.stdout.trim() : null,
    roma_import: imports.status === 0,
    dspy_version: imports.status === 0 ? imports.stdout.trim() : null,
    codex_cli: codex.status === 0 ? codex.stdout.trim() : null,
    codex_failure: codex.status === 0 ? null : boundedFailure(codex),
    frontier_model: FRONTIER_MODEL,
    models: {
      cheap: { expected: catalog.cheap.model_digest, observed: inventory.get(catalog.cheap.model) || null },
      strong: { expected: catalog.strong.model_digest, observed: inventory.get(catalog.strong.model) || null },
    },
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== 'ready') process.exitCode = 1;
}

async function preflight() {
  const romaRoot = path.resolve(option('roma-root', ROMA_ROOT_DEFAULT));
  const python = path.resolve(option('python', PYTHON_DEFAULT));
  const runtime = {
    models: modelCatalog(),
    frontier: { model: FRONTIER_MODEL },
  };
  let smoke = validateScenario({
    schema: 1,
    id: 'preflight-two-plus-two',
    category: 'atomic',
    task: 'Compute two plus two. Return exactly one valid JSON object and no prose using {"answer": 4}.',
    timeout_seconds: 300,
    holdout: false,
    adversarial_case: null,
    verification: {
      kind: 'json-answer-digest',
      answer_pointer: '/answer',
      answer_type: 'integer',
      expected_digest: digest(4),
      verifier_id: 'json-answer-v1',
    },
  });
  if (option('only', 'all') === 'roma-complex') {
    smoke = validateScenario({
      ...smoke,
      id: 'preflight-parallel-checksum',
      category: 'compositional',
      task: 'Compute three independent subtotals and then combine them by addition. 1) (8 * 7) - 3. 2) (9 * 9) + 4. 3) 150 - (7 * 12). Return exactly one valid JSON object and no prose using {"answer": 0} with the checksum substituted for 0.',
      verification: { ...smoke.verification, expected_digest: digest(204) },
    });
  }
  const selected = option('only', 'all');
  const items = [];
  let roma = null;
  if (selected === 'all' || selected === 'frontier') {
    const frontierExecution = await runCodex(smoke, runtime);
    items.push({ name: 'frontier', receipt: attemptArtifact({ scenario: smoke, policyId: 'frontier-only', attempt: 1, execution: frontierExecution }).receipt });
  }
  if (selected === 'all' || selected === 'local') {
    const localExecution = await runOllama(smoke, runtime.models.cheap.model, runtime.models.cheap.model_digest);
    items.push({ name: 'direct_open_local', receipt: attemptArtifact({ scenario: smoke, policyId: 'always-open-local', attempt: 1, execution: localExecution }).receipt });
  }
  if (selected === 'all' || selected === 'roma' || selected === 'roma-complex') {
    const plan = routeRomaOperation({ scenario: smoke, catalog: runtime.models, stack: stackBinding() });
    const romaExecution = await runRomaAttempt(smoke, plan, romaRoot, python);
    roma = attemptArtifact({ scenario: smoke, policyId: 'citadel-whole-operation', attempt: 1, execution: romaExecution, plan });
    items.push({ name: 'roma_controlled', receipt: roma.receipt });
  }
  if (!['all', 'frontier', 'local', 'roma', 'roma-complex'].includes(selected)) throw new Error(`unknown preflight selection: ${selected}`);
  const results = items.map((item) => ({
    name: item.name,
    completion: item.receipt.completion.status,
    control: item.receipt.control.status,
    duration_ms: item.receipt.duration_ms,
    observed_model: item.receipt.execution_evidence.observed_model || null,
    provider_calls: item.name === 'roma_controlled' && roma.observation ? roma.observation.provider_calls.length : item.name === 'roma_controlled' ? 0 : 1,
    modules: item.name === 'roma_controlled' ? item.receipt.control.module_exercise : null,
    failure: item.receipt.control.status === 'verified' ? null : item.receipt.execution_evidence,
    output_text: item.receipt.control.status === 'verified' ? null
      : (item.name === 'roma_controlled' ? roma.output_text : null),
  }));
  const status = results.every((item) => item.completion === 'passed' && item.control === 'verified') ? 'passed' : 'failed';
  process.stdout.write(`${JSON.stringify({ status, results }, null, 2)}\n`);
  if (status !== 'passed') process.exitCode = 1;
}

async function runBenchmark() {
  const freezeValue = validateFreeze(readJson(FREEZE_FILE));
  const keyFile = path.resolve(option('key', DEFAULT_KEY));
  const privateKey = fs.readFileSync(keyFile, 'utf8');
  const derivedPublic = crypto.createPublicKey(crypto.createPrivateKey(privateKey)).export({ type: 'spki', format: 'pem' });
  if (derivedPublic !== freezeValue.attestation_public_key) throw new Error('attestation private key does not match frozen public key');
  const outputDirectory = path.resolve(option('output', DEFAULT_OUTPUT));
  if (fs.existsSync(path.join(outputDirectory, 'bundle.json'))) throw new Error('completed proof bundle already exists; choose a new --output directory');
  fs.mkdirSync(path.join(outputDirectory, 'cells'), { recursive: true });
  const stateFile = path.join(outputDirectory, 'run-state.json');
  let runState;
  if (fs.existsSync(stateFile)) {
    runState = readJson(stateFile);
    const expectedStateId = digest({
      freeze_id: runState.freeze_id,
      started_at: runState.started_at,
      machine_hostname_digest: runState.machine_hostname_digest,
    });
    if (runState.schema !== 1 || runState.freeze_id !== freezeValue.freeze_id || runState.run_id !== expectedStateId) {
      throw new Error('saved run state is invalid or belongs to another freeze');
    }
  } else {
    const stateFields = {
      freeze_id: freezeValue.freeze_id,
      started_at: new Date().toISOString(),
      machine_hostname_digest: digest(os.hostname()),
    };
    runState = { schema: 1, run_id: digest(stateFields), ...stateFields };
    writeJson(stateFile, runState);
  }
  const romaRoot = path.resolve(option('roma-root', ROMA_ROOT_DEFAULT));
  const python = path.resolve(option('python', PYTHON_DEFAULT));
  const values = scenarios();
  const byId = new Map(values.map((scenario) => [scenario.id, scenario]));
  const artifacts = [];
  const startedAt = runState.started_at;
  const runId = runState.run_id;
  for (const [index, cell] of freezeValue.cells.entries()) {
    const scenario = byId.get(cell.scenario_id);
    const file = cellArtifactPath(outputDirectory, cell.scenario_id, cell.policy_id);
    if (fs.existsSync(file)) {
      const existing = validateCellArtifact(readJson(file), scenario, cell.policy_id, freezeValue, runId);
      artifacts.push(existing);
      process.stdout.write(`[${index + 1}/${freezeValue.cells.length}] resumed ${cell.scenario_id} / ${cell.policy_id}\n`);
      continue;
    }
    process.stdout.write(`[${index + 1}/${freezeValue.cells.length}] running ${cell.scenario_id} / ${cell.policy_id}\n`);
    const execution = await executeCell(scenario, cell.policy_id, freezeValue, romaRoot, python);
    const artifact = {
      schema: 1,
      run_id: runId,
      freeze_id: freezeValue.freeze_id,
      scenario_id: cell.scenario_id,
      policy_id: cell.policy_id,
      route: execution.route,
      attempts: execution.attempts,
    };
    validateCellArtifact(artifact, scenario, cell.policy_id, freezeValue, runId);
    writeJson(file, artifact);
    artifacts.push(artifact);
    const final = finalReceipt(artifact);
    process.stdout.write(`  completion=${final.completion.status} control=${final.control.status} attempts=${artifact.attempts.length}\n`);
  }
  const completedAt = new Date().toISOString();
  const summary = summarize(artifacts);
  const report = reportMarkdown(runId, freezeValue, summary, startedAt, completedAt);
  const reportFile = path.join(outputDirectory, 'REPORT.md');
  fs.writeFileSync(reportFile, report, 'utf8');
  const artifactIndex = freezeValue.cells.map((cell) => {
    const relative = path.relative(outputDirectory, cellArtifactPath(outputDirectory, cell.scenario_id, cell.policy_id)).replace(/\\/g, '/');
    return { path: relative, digest: digest(readJson(path.join(outputDirectory, relative))) };
  });
  const unsigned = {
    schema: 1,
    bundle_id: null,
    run_id: runId,
    freeze_id: freezeValue.freeze_id,
    started_at: startedAt,
    completed_at: completedAt,
    machine: {
      platform: process.platform,
      arch: process.arch,
      hostname_digest: digest(os.hostname()),
      cpu_count: os.cpus().length,
      total_memory_bytes: os.totalmem(),
    },
    artifacts: artifactIndex,
    report_digest: digest(report.replace(/\r\n/g, '\n')),
    summary,
  };
  const payload = { ...unsigned, bundle_id: digest(unsigned) };
  const bundle = { ...payload, attestation: signPayload(payload, privateKey) };
  writeJson(path.join(outputDirectory, 'bundle.json'), bundle);
  process.stdout.write(`${JSON.stringify({ bundle_id: bundle.bundle_id, summary }, null, 2)}\n`);
}

function verifyBundle() {
  const freezeValue = validateFreeze(readJson(FREEZE_FILE));
  const outputDirectory = path.resolve(option('output', DEFAULT_OUTPUT));
  const bundle = readJson(path.join(outputDirectory, 'bundle.json'));
  const { attestation, ...payload } = bundle;
  if (payload.bundle_id !== digest({ ...payload, bundle_id: null })) throw new Error('bundle id does not match contents');
  if (payload.freeze_id !== freezeValue.freeze_id) throw new Error('bundle freeze id is wrong');
  if (!verifySignature(payload, attestation, freezeValue.attestation_public_key)) throw new Error('bundle signature is invalid');
  const values = scenarios();
  const byId = new Map(values.map((scenario) => [scenario.id, scenario]));
  const artifacts = payload.artifacts.map((entry) => {
    const resolved = path.resolve(outputDirectory, entry.path);
    if (!resolved.startsWith(`${outputDirectory}${path.sep}`)) throw new Error('artifact path escapes proof directory');
    const artifact = readJson(resolved);
    if (digest(artifact) !== entry.digest) throw new Error(`artifact digest mismatch: ${entry.path}`);
    return validateCellArtifact(artifact, byId.get(artifact.scenario_id), artifact.policy_id, freezeValue, payload.run_id);
  });
  if (artifacts.length !== freezeValue.cells.length) throw new Error('bundle cell count is incomplete');
  const identities = artifacts.map((artifact) => `${artifact.scenario_id}/${artifact.policy_id}`);
  const expected = freezeValue.cells.map((cell) => `${cell.scenario_id}/${cell.policy_id}`);
  if (JSON.stringify(identities) !== JSON.stringify(expected)) throw new Error('bundle cell order does not match freeze');
  const summary = summarize(artifacts);
  if (JSON.stringify(summary) !== JSON.stringify(payload.summary)) throw new Error('bundle summary does not reproduce');
  const report = fs.readFileSync(path.join(outputDirectory, 'REPORT.md'), 'utf8').replace(/\r\n/g, '\n');
  if (digest(report) !== payload.report_digest) throw new Error('report digest does not match bundle');
  process.stdout.write(`${JSON.stringify({
    status: 'verified',
    freeze_id: freezeValue.freeze_id,
    bundle_id: payload.bundle_id,
    cells: artifacts.length,
    evidence_result: summary.evidence_result,
    performance_hypothesis: summary.performance_hypothesis,
    false_passes: summary.false_passes,
  }, null, 2)}\n`);
}

function validate() {
  const values = scenarios();
  const result = {
    status: 'valid',
    scenarios: values.length,
    policies: POLICIES.length,
    cells: values.length * POLICIES.length,
    scenario_set_digest: digest(values),
    source_digests: sourceDigests(),
    freeze: fs.existsSync(FREEZE_FILE) ? validateFreeze(readJson(FREEZE_FILE)).freeze_id : null,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function main() {
  const command = process.argv[2] || 'validate';
  if (command === 'validate') validate();
  else if (command === 'freeze') freeze();
  else if (command === 'doctor') await doctor();
  else if (command === 'preflight') await preflight();
  else if (command === 'run') await runBenchmark();
  else if (command === 'verify') verifyBundle();
  else throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`Operation-control proof failed: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
