#!/usr/bin/env bun
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { MODELS, POLICIES, REPETITIONS, buildCell, capabilityClass, createAttempt, createFreeze, routeFor, scenarios, stableSchedule, summarize, verifyCell } = require('../core/application-readiness/capability-profile');

const values = scenarios();
assert.strictEqual(values.length, 12);
assert.strictEqual(stableSchedule(values).length, values.length * POLICIES.length * REPETITIONS);
assert.deepStrictEqual(values.map((item) => capabilityClass(item.task)).reduce((counts, tier) => ({ ...counts, [tier]: (counts[tier] || 0) + 1 }), {}), { tiny: 6, lexical: 2, strong: 4 });
assert(values.filter((item) => capabilityClass(item.task) !== 'strong').every((item) => routeFor(POLICIES[1], item.task).escalation_tier === 'strong'));

const pair = crypto.generateKeyPairSync('ed25519');
const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
const freeze = createFreeze(publicKey, '2026-08-01T00:00:00.000Z');
const scenario = values[0];
const scheduleCell = stableSchedule(values).find((cell) => cell.scenario_id === scenario.id && cell.policy_id === POLICIES[0]);
const response = { model: MODELS.strong.model, done: true, done_reason: 'stop', message: { content: '{"answer":47}' }, prompt_eval_count: 20, eval_count: 5, total_duration: 1000000 };
const attempt = { ...createAttempt({ scenario, tier: 'strong', response, startedAt: '2026-08-01T00:00:00.000Z', durationMs: 1000, gpu: { samples: 2, average_watts: 80, energy_kwh: 0.000022222 } }), attempt: 1 };
const cell = buildCell({ scheduleCell, scenario, route: routeFor(scheduleCell.policy_id, scenario.task), attempts: [attempt], previousCellDigest: null, privateKey });
assert.strictEqual(cell.status, 'passed');
assert.strictEqual(verifyCell(cell, scheduleCell, scenario, freeze), cell);

const synthetic = stableSchedule(values).map((entry) => {
  const item = values.find((candidate) => candidate.id === entry.scenario_id);
  const tier = routeFor(entry.policy_id, item.task).initial_tier;
  return { policy_id: entry.policy_id, scenario_id: entry.scenario_id, status: 'passed', final_verification: { answer_digest: item.verification.expected_digest }, attempts: [{ tier, duration_ms: tier === 'strong' ? 1000 : 300, usage: { prompt_tokens: 20, completion_tokens: 5 }, execution_evidence: { status: 'verified' }, economics: { gpu_energy: { status: 'measured', energy_kwh: tier === 'strong' ? 0.00003 : 0.000006 }, comparison_cost: { status: 'derived-comparison', total_usd: tier === 'strong' ? 0.00003 : 0.000006 } } }] };
});
const summary = summarize(synthetic);
assert.strictEqual(summary.evidence_result, 'passed');
assert.strictEqual(summary.gates.quality, true);
assert.strictEqual(summary.gates.gpu_energy, true);
process.stdout.write('capability-profile benchmark contracts passed\n');
