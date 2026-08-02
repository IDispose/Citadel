#!/usr/bin/env bun
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILES = [
  'README.md',
  'docs/EVIDENCE_MANIFEST.md',
  'docs/evidence.html',
  'docs/index.html',
  'docs/operation-control.html',
  'docs/optimizer.html',
  'docs/research.html',
  'docs/walkthrough.html',
  'docs/grants/APPLICATION_CHECKLIST.md',
  'docs/grants/APPLICATION_MEDIA.md',
  'docs/grants/CLAIM_EVIDENCE_MATRIX.md',
  'docs/grants/EVALUATOR_START_HERE.md',
  'docs/grants/DEMO_SCRIPT.md',
  'docs/grants/SENTIENT_OPTIMIZER_APPLICATION_DRAFT.md',
];

const FORBIDDEN = [
  [/independently frozen/gi, 'Freeze provenance must name separate identities or exact artifacts.'],
  [/(quality preserved|preserved quality)/gi, 'Use exact verified-cell counts, not an unbounded quality claim.'],
  [/latest prospective local economic comparison/gi, 'Do not call a superseded study latest.'],
  [/71\s*\/\s*72\s+completed/gi, 'A timeout is not a completed model attempt.'],
  [/two\s+Qwen/gi, 'Name the exact model sizes or model family.'],
  [/120\s+completed\s+actual-run/gi, 'Only 84 historical cells reached a model.'],
  [/5\s*\/\s*5\s+passed/gi, 'Fresh-clone stages completed; doctor semantic health is unknown.'],
  [/independent(?:ly)?\s+(?:verifier|verified|graded)/gi, 'Say model-external or verifier outside the routed model.'],
  [/citadel improved this result/gi, 'V1 apparent savings reverse under matched-timeout sensitivity.'],
];

const failures = [];
for (const relative of FILES) {
  const value = fs.readFileSync(path.join(ROOT, relative), 'utf8');
  for (const [pattern, reason] of FORBIDDEN) {
    const matches = value.match(pattern);
    if (matches) failures.push(`${relative}: ${JSON.stringify(matches[0])} - ${reason}`);
  }
  for (const match of value.matchAll(/9\.9% less (?:measured )?GPU energy/gi)) {
    const nearby = value.slice(Math.max(0, match.index - 500), match.index + match[0].length + 700);
    assert.match(nearby, /timeout|sensitivity|apparent/i, `${relative}: v1 aggregate requires a nearby timeout-sensitivity boundary`);
  }
}

const canonicalGateFiles = [
  'docs/grants/MILESTONES_AND_BUDGET.md',
  'docs/grants/SENTIENT_OPTIMIZER_APPLICATION_DRAFT.md',
  'docs/grants/EVALUATOR_START_HERE.md',
  'docs/grants/DEMO_SCRIPT.md',
  'docs/research.html',
  'docs/evidence.html',
  'docs/optimizer.html',
  'docs/operation-control.html',
  'docs/walkthrough.html',
];
for (const relative of canonicalGateFiles) {
  const value = fs.readFileSync(path.join(ROOT, relative), 'utf8');
  assert.match(value, /80%|&ge;80%|≥80%/, `${relative}: missing the 80% absolute completion floor`);
  assert.match(value, /95%|&ge;95%|≥95%/, `${relative}: missing the 95% valid-frontier retention gate`);
  assert.match(value, /30%|&ge;30%|≥30%/, `${relative}: missing the 30% end-to-end cost gate`);
}

for (const relative of [
  'docs/grants/MILESTONES_AND_BUDGET.md',
  'docs/grants/SENTIENT_OPTIMIZER_APPLICATION_DRAFT.md',
  'docs/grants/EVALUATOR_START_HERE.md',
  'docs/research.html',
  'docs/evidence.html',
  'docs/optimizer.html',
  'docs/operation-control.html',
  'docs/walkthrough.html',
]) {
  const value = fs.readFileSync(path.join(ROOT, relative), 'utf8');
  assert.match(value, /70%|seventy percent/, `${relative}: missing the 70% per-stratum frontier validity floor`);
}

const applicationDraft = fs.readFileSync(path.join(ROOT, 'docs/grants/SENTIENT_OPTIMIZER_APPLICATION_DRAFT.md'), 'utf8');
assert.doesNotMatch(applicationDraft, /adaptive whole-operation control beats prompt-only routing/i);
assert.match(applicationDraft, /Prompt-only paired differences remain a reported routing diagnostic, not a pass\s+condition/i);

for (const relative of [
  'docs/grants/MILESTONES_AND_BUDGET.md',
  'docs/grants/APPLICANT_AND_ADOPTION.md',
  'docs/grants/SENTIENT_OPTIMIZER_APPLICATION_DRAFT.md',
]) {
  const value = fs.readFileSync(path.join(ROOT, relative), 'utf8');
  assert.match(value, /15-20/, `${relative}: missing the bounded operator cohort size`);
  assert.match(value, /\$2,000/, `${relative}: missing the operator cohort budget`);
}

assert.deepStrictEqual(failures, [], `Application claim-discipline failures:\n${failures.join('\n')}`);
console.log(`Application claim discipline passed (${FILES.length} public surfaces).`);
