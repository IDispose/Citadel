#!/usr/bin/env bun
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BENCHMARK = path.join(ROOT, 'benchmarks', 'roma-operation-control');

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

const bundle = JSON.parse(read('benchmarks/roma-operation-control/published-run/bundle.json'));
const report = read('benchmarks/roma-operation-control/published-run/REPORT.md');
const page = read('docs/operation-control.html');
const grant = read('docs/grants/SENTIENT_OPTIMIZER_APPLICATION_DRAFT.md');
const index = read('docs/index.html');
const policy = Object.fromEntries(bundle.summary.policies.map((entry) => [entry.policy_id, entry]));

assert.strictEqual(bundle.bundle_id, 'sha256:95b49d26019296adcb5f05121d3faf0e43c9c91a349da63d737640277557b719');
assert.strictEqual(bundle.freeze_id, 'sha256:f1ecf932261ceac604978952c42cdb8ec14032b795bffd1848fae90e9572ded5');
assert.strictEqual(bundle.artifacts.length, 24);
assert.strictEqual(bundle.summary.evidence_result, 'passed');
assert.strictEqual(bundle.summary.performance_hypothesis, 'failed');
assert.strictEqual(bundle.summary.false_passes, 0);
assert.strictEqual(bundle.summary.integrity_failures, 0);
assert.strictEqual(bundle.summary.execution_control_failures, 0);
assert.strictEqual(policy['frontier-only'].independently_verified_completions, 6);
assert.strictEqual(policy['prompt-router'].independently_verified_completions, 3);
assert.strictEqual(policy['always-open-local'].independently_verified_completions, 2);
assert.strictEqual(policy['citadel-whole-operation'].independently_verified_completions, 4);
assert.strictEqual(policy['citadel-whole-operation'].strong_whole_operation_attempts, 6);
assert.strictEqual(bundle.summary.performance_gate.strong_whole_operation_avoidance, 0);
assert(fs.existsSync(path.join(BENCHMARK, 'freeze.json')));

for (const artifact of bundle.artifacts) {
  assert(fs.existsSync(path.join(BENCHMARK, 'published-run', artifact.path)));
}

for (const surface of [report, page, grant]) {
  assert(surface.includes('performance hypothesis') || surface.includes('performance_hypothesis') || surface.includes('efficiency hypothesis'));
  assert(/failed/i.test(surface));
  assert(/zero false passes|false passes: \*\*0\*\*|false_passes.*0/is.test(surface));
  assert(/total USD.*unknown|total dollar cost is still unknown/is.test(surface));
}

assert(page.includes('4 / 6'));
assert(page.includes('2 / 6'));
assert(page.includes('{"answer":999}'));
assert(page.includes('{"answer":213}'));
assert(page.includes('href="https://github.com/SethGammon/Citadel/tree/main/benchmarks/roma-operation-control"'));
assert(grant.includes('Citadel-controlled ROMA'));
assert(grant.includes('Proposed public-goods grant: **$150,000**'));
assert(grant.includes('No outside reviewer, outreach campaign, or third-party selector is required.'));
assert(index.includes('href="operation-control.html">Operation Proof</a>'));

for (const surface of [page, grant]) {
  assert(!/optimizer performance hypothesis (?:is |was )?passed/i.test(surface));
  assert(!/total (?:USD|cost)(?: is|:) \$0/i.test(surface));
}
assert(page.includes('does not establish best-in-class performance'));

process.stdout.write('operation-control publication claims match the signed bundle\n');
