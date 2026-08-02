#!/usr/bin/env bun
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const base = require('../core/application-readiness/representative-operation');
const pilot = require('../core/application-readiness/representative-operation-v2');

assert.strictEqual(pilot.stableSchedule().length, 24);
assert.strictEqual(new Set(pilot.stableSchedule().map((cell) => `${cell.scenario_id}/${cell.policy_id}/${cell.repetition}`)).size, 24);
assert(pilot.SOURCE_FILES.includes('core/application-readiness/representative-operation.js'));
assert(pilot.SOURCE_FILES.includes('core/operation-control/contracts.js'));
const first = 'F:\\Temp\\citadel-representative-refactor-dedupe-types-AbC123\\test.js:4';
const second = 'F:\\Temp\\citadel-representative-refactor-dedupe-types-XyZ789\\test.js:4';
assert.strictEqual(pilot.normalizeWorkspaceText(first), pilot.normalizeWorkspaceText(second));
assert.strictEqual(pilot.normalizeWorkspaceText(first), '<ISOLATED_WORKSPACE>\\test.js:4');

const scenario = base.scenarios()[0];
const repair = JSON.stringify({ files: { 'src/clamp.js': "'use strict';\nfunction clamp(value,min,max){if(value<min)return min;if(value>max)return max;return value;}\nmodule.exports={clamp};\n" } });
assert.strictEqual(pilot.evaluateRepositoryOutput(scenario, repair).status, 'passed');
const pair = crypto.generateKeyPairSync('ed25519');
const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
const freeze = pilot.createFreeze(base.publicKeyFromPrivate(privateKey), '2026-08-01T00:00:00.000Z');
pilot.validateFreeze(freeze);
const attempt = { ...pilot.createAttempt({ scenario, tier: 'strong', response: { done: true, model: base.MODELS.strong.model, done_reason: 'stop', message: { content: repair }, prompt_eval_count: 20, eval_count: 10, total_duration: 123 }, startedAt: '2026-08-01T00:00:01.000Z', durationMs: 1000, gpu: { energy_kwh: 0.00001, samples: 2, average_watts: 36 } }), attempt: 1 };
const scheduleCell = { order: 0, scenario_id: scenario.id, policy_id: 'always-strong-local', repetition: 1 };
const cell = pilot.buildCell({ scheduleCell, scenario, route: base.routeFor(scheduleCell.policy_id, scenario), attempts: [attempt], previousCellDigest: null, privateKey });
pilot.verifyCell(cell, scheduleCell, scenario, freeze);
process.stdout.write('representative operation v2 contract passed: deterministic workspace normalization, full source closure, signing, and verifier replay\n');
