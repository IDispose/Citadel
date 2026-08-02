#!/usr/bin/env bun
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pilot = require('../core/application-readiness/representative-operation');

const ROOT = path.resolve(__dirname, '..');
const scenarios = pilot.scenarios();
assert.strictEqual(scenarios.length, 6);
assert.strictEqual(pilot.stableSchedule().length, 24);
assert.strictEqual(new Set(pilot.stableSchedule().map((cell) => `${cell.scenario_id}/${cell.policy_id}/${cell.repetition}`)).size, 24);
assert.strictEqual(pilot.sourceFiles().includes('core/operation-control/contracts.js'), true);
assert.strictEqual(pilot.sourceFiles().includes('core/operation-control/receipt.js'), true);

for (const scenario of scenarios) {
  assert.notStrictEqual(pilot.evaluateRepositoryOutput(scenario, '{"files":{}}').status, 'passed', `${scenario.id} accepted missing changed files`);
  const fixture = path.join(ROOT, 'benchmarks', 'representative-operation-pilot', 'fixtures', scenario.fixture);
  const initial = Object.fromEntries(scenario.allowed_files.map((relative) => [relative, fs.readFileSync(path.join(fixture, relative), 'utf8')]));
  const forged = { ...initial, '../escape.txt': 'bad' };
  assert.strictEqual(pilot.evaluateRepositoryOutput(scenario, JSON.stringify({ files: forged })).code, 'FILES_JSON_INVALID', `${scenario.id} accepted traversal`);
}

const referenceRepairs = {
  'bugfix-clamp': { 'src/clamp.js': "'use strict';\nfunction clamp(value,min,max){if(value<min)return min;if(value>max)return max;return value;}\nmodule.exports={clamp};\n" },
  'config-timeout-migration': { 'config/app.json': '{"schema_version":2,"service":"worker","timeout_seconds":30,"retries":2}\n' },
  'docs-command-consistency': { 'README.md': '# Fixture app\n\nPrepare the repository with `/do setup --express`, then begin work in a fresh session.\nThe setup step creates local project state.\n' },
  'refactor-dedupe-types': { 'src/dedupe.js': "'use strict';\nfunction dedupe(values){return [...new Set(values)];}\nmodule.exports={dedupe};\n" },
  'security-path-boundary': { 'src/safe-path.js': "'use strict';\nconst path=require('path');\nfunction isWithinRoot(root,candidate){const r=path.resolve(root);const c=path.resolve(candidate);return c===r||c.startsWith(r+path.sep);}\nmodule.exports={isWithinRoot};\n" },
  'multifile-profile-api': {
    'src/format.js': "'use strict';\nfunction formatProfile(user){return `${user.name} <${user.email}>`;}\nconst formatUser=formatProfile;\nmodule.exports={formatProfile,formatUser};\n",
    'src/render.js': "'use strict';\nconst {formatProfile}=require('./format');\nfunction renderProfile(user){return `Profile: ${formatProfile(user)}`;}\nmodule.exports={renderProfile};\n",
  },
};

for (const scenario of scenarios) {
  const verification = pilot.evaluateRepositoryOutput(scenario, JSON.stringify({ files: referenceRepairs[scenario.id] }));
  assert.strictEqual(verification.status, 'passed', `${scenario.id} reference repair failed: ${JSON.stringify(verification)}`);
}

assert.strictEqual(pilot.routeFor('citadel-risk-profile-local', scenarios.find((item) => item.risk === 'low')).initial_tier, 'cheap');
assert.strictEqual(pilot.routeFor('citadel-risk-profile-local', scenarios.find((item) => item.risk === 'high')).initial_tier, 'strong');
const pair = crypto.generateKeyPairSync('ed25519');
const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
const freeze = pilot.createFreeze(pilot.publicKeyFromPrivate(privateKey), '2026-08-01T00:00:00.000Z');
pilot.validateFreeze(freeze);
const scenario = scenarios[0];
const output = JSON.stringify({ files: referenceRepairs[scenario.id] });
const attempt = { ...pilot.createAttempt({ scenario, tier: 'strong', response: { done: true, model: pilot.MODELS.strong.model, done_reason: 'stop', message: { content: output }, prompt_eval_count: 20, eval_count: 10, total_duration: 123 }, startedAt: '2026-08-01T00:00:01.000Z', durationMs: 1000, gpu: { energy_kwh: 0.00001, samples: 2, average_watts: 36 } }), attempt: 1 };
const scheduleCell = { order: 0, scenario_id: scenario.id, policy_id: 'always-strong-local', repetition: 1 };
const cell = pilot.buildCell({ scheduleCell, scenario, route: pilot.routeFor(scheduleCell.policy_id, scenario), attempts: [attempt], previousCellDigest: null, privateKey });
pilot.verifyCell(cell, scheduleCell, scenario, freeze);
process.stdout.write('representative operation pilot contract passed: 6 fixtures, 24 scheduled cells, reference repairs, path rejection, and full source closure\n');
