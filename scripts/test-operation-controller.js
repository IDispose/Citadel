#!/usr/bin/env bun

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const operation = require('../core/operation-controller');
const runtimeAdapter = require('./operation-runtime-adapter');

const ROOT = path.resolve(__dirname, '..');
const EXAMPLE = path.join(ROOT, 'examples', 'operation-control');
const request = JSON.parse(fs.readFileSync(path.join(EXAMPLE, 'request.json'), 'utf8'));
const catalog = JSON.parse(fs.readFileSync(path.join(EXAMPLE, 'catalog.json'), 'utf8'));

operation.validateRequest(request);
operation.validateCatalog(catalog);
assert.throws(() => operation.validateRequest({ ...request, surprise: true }), /fields must exactly match/);
assert.throws(() => operation.validateRequest({
  ...request,
  constraints: { ...request.constraints, required_tools: ['network'] },
}), /required tools must also be allowed/);
assert.throws(() => operation.validateRequest({
  ...request,
  verifier: { ...request.verifier, required_changed_paths: ['../escape'] },
}), /safe relative paths/);

const planned = operation.routeOperation({ request, catalog, history: [] });
assert.equal(planned.selection_status, 'meets-quality-target');
assert.deepEqual(planned.selected.plan_ids, ['local-filesystem-check']);
assert.equal(planned.selected.expected_costs.actual_cash.amount_usd, 0);
assert.match(planned.decision_digest, /^sha256:[a-f0-9]{64}$/);

const history = [{
  schema: 1,
  feature_key: 'repository-check',
  plan_id: 'local-filesystem-check',
  verification_status: 'passed',
  duration_ms: 50,
  costs: catalog.plans[0].costs,
  observed_tools: ['filesystem'],
}];
const learned = operation.calibratedPrediction(catalog.plans[0], request, history);
assert.equal(learned.evidence_basis, 'verified-outcome-history');
assert.equal(learned.evidence_records, 1);
assert.equal(learned.expected_duration_ms, 50);
assert.equal(operation.wilsonLowerBound(0.5, 100) > 0.4, true);

function cost(amount) {
  return {
    actual_cash: { status: 'known', amount_usd: amount, basis: 'estimate', source: 'test' },
    marginal: { status: 'known', amount_usd: amount, basis: 'estimate', source: 'test' },
    market_equivalent: { status: 'known', amount_usd: amount, basis: 'estimate', source: 'test' },
  };
}

function plan(planId, probability, amount, fallbackPlanIds = []) {
  return {
    plan_id: planId,
    label: planId,
    adapter_id: 'test',
    topology: 'direct',
    model: planId,
    tools: [],
    privacy: 'local-only',
    feature_keys: [],
    prior: { success_probability: probability, strength: 100, source: 'test' },
    expected_duration_ms: amount * 1000 + 1,
    costs: cost(amount),
    retry_on: ['MALFORMED_OUTPUT'],
    max_retries: 1,
    fallback_plan_ids: fallbackPlanIds,
  };
}

const pathCatalog = {
  schema: 1,
  catalog_id: 'path-test',
  adapters: { test: { protocol: operation.ADAPTER_PROTOCOL, executable: 'node', args: [], timeout_ms: 1000, environment_allowlist: [] } },
  plans: [plan('direct-small', 0.75, 0.1, ['frontier']), plan('frontier', 0.99, 1)],
};
const pathRequest = {
  ...request,
  operation_id: 'path-test',
  feature_key: 'general',
  quality_target: 0.9,
  constraints: {
    ...request.constraints,
    allowed_tools: [], required_tools: [], max_duration_ms: 10000,
    budgets: { actual_cash: 3, marginal: 3, market_equivalent: 3 },
  },
  verifier: { kind: 'adapter-result' },
};
const pathDecision = operation.routeOperation({ request: pathRequest, catalog: pathCatalog, history: [] });
assert.deepEqual(pathDecision.selected.plan_ids, ['direct-small', 'frontier']);
assert(pathDecision.selected.expected_costs.actual_cash.amount_usd < 1);
assert.equal(pathDecision.selected.maximum_costs.actual_cash.amount_usd, 2.2);
assert.equal(pathDecision.selected.maximum_duration_ms, 2204);
assert(pathDecision.selected.verified_success_probability >= pathRequest.quality_target);

const retry = operation.nextAction({
  decision: pathDecision,
  catalog: pathCatalog,
  attempt: { plan_id: 'direct-small', completion_status: 'unknown', control_status: 'unknown', failure_code: 'MALFORMED_OUTPUT', retry_count: 0 },
});
assert.deepEqual(retry, { action: 'retry', reason_code: 'MALFORMED_OUTPUT', target_plan_id: 'direct-small' });
const escalate = operation.nextAction({
  decision: pathDecision,
  catalog: pathCatalog,
  attempt: { plan_id: 'direct-small', completion_status: 'failed', control_status: 'passed', failure_code: 'VERIFICATION_FAILED', retry_count: 0 },
});
assert.equal(escalate.action, 'escalate');
assert.equal(escalate.target_plan_id, 'frontier');

const blockedRequest = {
  ...pathRequest,
  constraints: { ...pathRequest.constraints, budgets: { actual_cash: 0.01, marginal: 0.01, market_equivalent: 0.01 } },
};
assert.throws(() => operation.routeOperation({ request: blockedRequest, catalog: pathCatalog, history: [] }), (error) => error.code === 'NO_ELIGIBLE_PATH');
const disallowed = { ...catalog, plans: [{ ...catalog.plans[0], tools: ['network'] }] };
assert.throws(() => operation.routeOperation({ request, catalog: disallowed, history: [] }), (error) => error.code === 'NO_ELIGIBLE_PATH');

const report = operation.runOperation({ request, catalog, history: [], workspaceRoot: EXAMPLE });
assert.equal(report.status, 'passed');
assert.equal(report.attempts.length, 1);
assert.equal(report.attempts[0].control_status, 'passed');
assert.equal(report.attempts[0].completion_status, 'passed');
assert.equal(report.trust.signer, 'unsigned');
assert.equal(operation.verifyReport(report).status, 'verified');
assert.equal(operation.verifyReport({ ...report, status: 'failed' }).reason_code, 'REPORT_DIGEST_MISMATCH');
const failedAdapterVerification = operation.verifyAttempt({
  request: { ...request, verifier: { kind: 'adapter-result' } },
  adapterResult: { status: 'failed', failure_code: 'RUNTIME_EXIT_NONZERO', output: '' },
  workspaceRoot: EXAMPLE,
});
assert.equal(failedAdapterVerification.status, 'failed');

const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-operation-artifact-'));
spawnSync('git', ['init'], { cwd: artifactRoot, encoding: 'utf8', shell: false });
spawnSync('git', ['config', 'user.email', 'operation-test@example.invalid'], { cwd: artifactRoot, encoding: 'utf8', shell: false });
spawnSync('git', ['config', 'user.name', 'Operation Test'], { cwd: artifactRoot, encoding: 'utf8', shell: false });
fs.writeFileSync(path.join(artifactRoot, 'required.txt'), 'before\n');
spawnSync('git', ['add', 'required.txt'], { cwd: artifactRoot, encoding: 'utf8', shell: false });
spawnSync('git', ['commit', '-m', 'fixture'], { cwd: artifactRoot, encoding: 'utf8', shell: false });
fs.writeFileSync(path.join(artifactRoot, 'required.txt'), 'after\n');
const artifactRequest = {
  ...request,
  verifier: { kind: 'command', executable: process.execPath, args: ['-e', 'process.exit(0)'], cwd: '.', timeout_ms: 10000, required_changed_paths: ['required.txt'] },
};
const artifactVerification = operation.verifyAttempt({ request: artifactRequest, adapterResult: { status: 'completed', output: '' }, workspaceRoot: artifactRoot });
assert.equal(artifactVerification.status, 'passed');
const artifactAlias = `${artifactRoot}-alias`;
fs.symlinkSync(artifactRoot, artifactAlias, process.platform === 'win32' ? 'junction' : 'dir');
const aliasedArtifactVerification = operation.verifyAttempt({
  request: artifactRequest,
  adapterResult: { status: 'completed', output: '' },
  workspaceRoot: artifactAlias,
});
assert.equal(aliasedArtifactVerification.status, 'passed');
fs.unlinkSync(artifactAlias);
const uncoveredVerification = operation.verifyAttempt({
  request: { ...artifactRequest, verifier: { ...artifactRequest.verifier, required_changed_paths: ['missing.txt'] } },
  adapterResult: { status: 'completed', output: '' }, workspaceRoot: artifactRoot,
});
assert.equal(uncoveredVerification.failure_code, 'REQUIRED_ARTIFACT_NOT_CHANGED');
fs.rmSync(artifactRoot, { recursive: true, force: true });

const adapterInput = {
  schema: 1,
  protocol: operation.ADAPTER_PROTOCOL,
  operation: pathRequest,
  decision_digest: pathDecision.decision_digest,
  plan: { ...pathCatalog.plans[0], tools: ['filesystem', 'shell'] },
  workspace_root: EXAMPLE,
  retry_count: 0,
};
const fakeCodex = runtimeAdapter.execute(adapterInput, 'codex', {
  resolve: (invocation) => invocation,
  spawn: () => ({
    status: 0,
    stdout: [
      JSON.stringify({ type: 'item.completed', item: { type: 'file_change' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'command_execution' } }),
      JSON.stringify({ type: 'turn.completed', model: 'direct-small', usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 20 } }),
    ].join('\n'),
    stderr: '',
  }),
  env: {},
});
assert.equal(fakeCodex.status, 'completed');
assert.equal(fakeCodex.observations.model, 'direct-small');
assert.deepEqual(fakeCodex.observations.tool_calls, ['filesystem', 'shell']);
assert.equal(fakeCodex.observations.costs.actual_cash.status, 'unknown');
assert.equal(runtimeAdapter.invocationFor('claude', 'opus').command, 'claude');
assert.match(runtimeAdapter.invocationFor('claude', 'opus', {}, ['filesystem', 'shell']).args.join(' '), /Bash\(node \*\)/);
assert.equal(runtimeAdapter.claudeAllowedTools(['filesystem']).includes('Bash'), false);
assert.equal(runtimeAdapter.invocationFor('codex', 'gpt').args.at(-1), '-');
assert.equal(runtimeAdapter.invocationFor('codex', 'gpt', { CITADEL_CODEX_JS: 'codex.js' }).args[0], 'codex.js');

const scalePlans = Array.from({ length: 64 }, (_, index) => ({
  ...plan(`scale-${index}`, 0.6 + ((index % 4) * 0.05), 0.1 + (index / 1000)),
  feature_keys: ['scale'],
  max_retries: 0,
}));
const scaleCatalog = { ...pathCatalog, catalog_id: 'scale-test', plans: scalePlans };
const scaleRequest = {
  ...pathRequest,
  operation_id: 'scale-test', feature_key: 'scale', quality_target: 0.4,
  constraints: { ...pathRequest.constraints, budgets: { actual_cash: null, marginal: null, market_equivalent: null } },
};
const scaleHistory = Array.from({ length: 20000 }, (_, index) => ({
  schema: 1,
  feature_key: 'scale',
  plan_id: `scale-${index % 64}`,
  verification_status: index % 3 === 0 ? 'failed' : 'passed',
  duration_ms: 100 + (index % 50),
  costs: cost(0.1 + ((index % 64) / 1000)),
  observed_tools: [],
}));
const scaleStarted = Date.now();
operation.routeOperation({ request: scaleRequest, catalog: scaleCatalog, history: scaleHistory });
assert(Date.now() - scaleStarted < 1500, '20,000-outcome route should stay below 1.5 seconds');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-operation-test-'));
const initialized = path.join(temp, 'initialized');
const cliInit = spawnSync(process.execPath, [
  path.join(ROOT, 'bin', 'citadel.js'), 'operation', 'init',
  '--objective', 'Run the repository verification',
  '--runtime', 'codex', '--model', 'gpt-test', '--fallback-model', 'gpt-frontier',
  '--verifier-executable', 'node', '--verifier-arg', 'check.js', '--out-dir', initialized,
  '--required-changed-path', 'scripts/test.js',
  '--json',
], { cwd: ROOT, encoding: 'utf8', shell: false });
assert.equal(cliInit.status, 0, cliInit.stderr);
assert.equal(JSON.parse(cliInit.stdout).status, 'initialized');
const initializedRequest = JSON.parse(fs.readFileSync(path.join(initialized, 'request.json'), 'utf8'));
const initializedCatalog = JSON.parse(fs.readFileSync(path.join(initialized, 'catalog.json'), 'utf8'));
operation.validateRequest(initializedRequest);
operation.validateCatalog(initializedCatalog);
assert.equal(initializedRequest.constraints.budgets.actual_cash, null);
assert.deepEqual(initializedRequest.verifier.required_changed_paths, ['scripts/test.js']);
assert.equal(initializedCatalog.plans[0].fallback_plan_ids[0], initializedCatalog.plans[1].plan_id);
const output = path.join(temp, 'report.json');
const cliRun = spawnSync(process.execPath, [
  path.join(ROOT, 'bin', 'citadel.js'), 'operation', 'run',
  '--request', path.join(EXAMPLE, 'request.json'),
  '--catalog', path.join(EXAMPLE, 'catalog.json'),
  '--workspace', EXAMPLE,
  '--out', output,
  '--json',
], { cwd: ROOT, encoding: 'utf8', shell: false });
assert.equal(cliRun.status, 0, cliRun.stderr);
assert.equal(JSON.parse(cliRun.stdout).status, 'passed');
const cliVerify = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'citadel.js'), 'operation', 'verify', '--input', output, '--json'], { cwd: ROOT, encoding: 'utf8', shell: false });
assert.equal(cliVerify.status, 0, cliVerify.stderr);
assert.equal(JSON.parse(cliVerify.stdout).signer_trust, 'unknown');
fs.rmSync(temp, { recursive: true, force: true });

process.stdout.write('Operation controller tests passed: contracts, whole-path routing, conservative outcomes, budgets, tools, retries, execution, verification, tamper detection, and CLI.\n');
