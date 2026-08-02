#!/usr/bin/env bun
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const {
  ECONOMICS,
  GATES,
  MODELS,
  POLICIES,
  REPETITIONS,
  buildCell,
  createAttempt,
  createFreeze,
  modeledCost,
  routeFor,
  scenarios,
  stableSchedule,
  summarize,
  verifyCell,
} = require('../core/application-readiness/benchmark');

const values = scenarios();
assert.strictEqual(values.length, 12);
assert.strictEqual(stableSchedule(values).length, 12 * POLICIES.length * REPETITIONS);
assert.strictEqual(new Set(stableSchedule(values).map((cell) => cell.order)).size, 72);

const routes = values.map((scenario) => routeFor('citadel-adaptive-local', scenario.task));
assert.deepStrictEqual({
  cheap: routes.filter((route) => route.initial_tier === 'cheap').length,
  strong: routes.filter((route) => route.initial_tier === 'strong').length,
}, { cheap: 8, strong: 4 });
assert(routes.filter((route) => route.initial_tier === 'cheap').every((route) => route.escalation_tier === 'strong'));
assert(routes.filter((route) => route.initial_tier === 'strong').every((route) => route.escalation_tier === null));

const comparison = modeledCost(0.001, 360000, ECONOMICS);
assert.strictEqual(comparison.status, 'derived-comparison');
assert.strictEqual(comparison.components.find((item) => item.kind === 'provider_invoice').amount_usd, 0);
assert.strictEqual(comparison.components.find((item) => item.kind === 'cpu_memory_storage_display_energy').status, 'unknown');

const pair = crypto.generateKeyPairSync('ed25519');
const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
const freeze = createFreeze(publicKey, '2026-07-31T00:00:00.000Z');
const scenario = values[0];
const scheduleCell = stableSchedule(values).find((cell) => cell.scenario_id === scenario.id && cell.policy_id === 'always-strong-local');
const response = {
  model: MODELS.strong.model,
  done: true,
  done_reason: 'stop',
  message: { content: '{"answer":45}' },
  prompt_eval_count: 20,
  eval_count: 5,
  total_duration: 1000000,
};
const attempt = {
  ...createAttempt({
    scenario,
    tier: 'strong',
    response,
    startedAt: '2026-07-31T00:00:00.000Z',
    durationMs: 1000,
    gpu: { samples: 2, average_watts: 80, energy_kwh: 0.000022222 },
  }),
  attempt: 1,
};
const cell = buildCell({
  scheduleCell,
  scenario,
  route: routeFor(scheduleCell.policy_id, scenario.task),
  attempts: [attempt],
  previousCellDigest: null,
  privateKey,
});
assert.strictEqual(cell.status, 'passed');
assert.strictEqual(verifyCell(cell, scheduleCell, scenario, freeze), cell);

const syntheticCells = stableSchedule(values).map((entry) => {
  const item = values.find((candidate) => candidate.id === entry.scenario_id);
  const tier = routeFor(entry.policy_id, item.task).initial_tier;
  const model = MODELS[tier];
  return {
    policy_id: entry.policy_id,
    scenario_id: entry.scenario_id,
    status: 'passed',
    final_verification: { answer_digest: item.verification.expected_digest },
    attempts: [{
      tier,
      duration_ms: tier === 'cheap' ? 500 : 1000,
      usage: { prompt_tokens: 20, completion_tokens: 5 },
      execution_evidence: { status: 'verified' },
      economics: {
        gpu_energy: { status: 'measured', energy_kwh: tier === 'cheap' ? 0.00001 : 0.00003 },
        comparison_cost: { status: 'derived-comparison', total_usd: tier === 'cheap' ? 0.00001 : 0.00003 },
      },
    }],
  };
});
const summary = summarize(syntheticCells);
assert.strictEqual(summary.policies.length, 2);
assert.strictEqual(summary.gates.quality, true);
assert.strictEqual(summary.gates.gpu_energy, true);
assert.strictEqual(summary.gates.modeled_cost, true);
assert.strictEqual(summary.evidence_result, 'passed');
assert.strictEqual(GATES.minimum_gpu_energy_reduction, 0.30);

process.stdout.write('application-readiness benchmark contracts passed\n');

