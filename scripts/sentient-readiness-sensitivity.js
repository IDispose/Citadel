#!/usr/bin/env bun
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RUN_ROOT = path.join(ROOT, 'benchmarks', 'sentient-readiness', 'published-run');
const OUTPUT_JSON = path.join(ROOT, 'benchmarks', 'sentient-readiness', 'SENSITIVITY.json');
const OUTPUT_MD = path.join(ROOT, 'benchmarks', 'sentient-readiness', 'SENSITIVITY.md');
const OMITTED_PAIR = Object.freeze({ scenario_id: 'weighted-path', repetition: 1 });

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function round(value, places = 6) {
  return Number(value.toFixed(places));
}

function loadCells() {
  const bundle = readJson(path.join(RUN_ROOT, 'bundle.json'));
  return bundle.artifacts.map((artifact) => readJson(path.join(RUN_ROOT, artifact.path)));
}

function summarize(cells, policyId) {
  const selected = cells.filter((cell) => cell.policy_id === policyId);
  const attempts = selected.flatMap((cell) => cell.attempts);
  return {
    policy_id: policyId,
    cells: selected.length,
    verified: selected.filter((cell) => cell.status === 'passed').length,
    failed: selected.filter((cell) => cell.status === 'failed').length,
    unknown: selected.filter((cell) => cell.status === 'unknown').length,
    attempts: attempts.length,
    request_wall_duration_ms: attempts.reduce((sum, attempt) => sum + attempt.duration_ms, 0),
    gpu_energy_kwh: round(attempts.reduce((sum, attempt) => sum + attempt.economics.gpu_energy.energy_kwh, 0), 9),
    modeled_gpu_cost_usd: round(attempts.reduce((sum, attempt) => sum + attempt.economics.comparison_cost.total_usd, 0), 9),
  };
}

function reduction(baseline, adaptive) {
  return round(1 - (adaptive / baseline), 6);
}

function build() {
  const allCells = loadCells();
  const omitted = allCells.filter((cell) => cell.scenario_id === OMITTED_PAIR.scenario_id && cell.repetition === OMITTED_PAIR.repetition);
  assert.deepStrictEqual(omitted.map((cell) => cell.policy_id).sort(), ['always-strong-local', 'citadel-adaptive-local']);
  const included = allCells.filter((cell) => !(cell.scenario_id === OMITTED_PAIR.scenario_id && cell.repetition === OMITTED_PAIR.repetition));
  const baseline = summarize(included, 'always-strong-local');
  const adaptive = summarize(included, 'citadel-adaptive-local');
  const result = {
    schema: 1,
    kind: 'citadel-sentient-readiness-v1-matched-pair-sensitivity',
    source_bundle: 'benchmarks/sentient-readiness/published-run/bundle.json',
    frozen_aggregate_unchanged: true,
    rationale: 'The omitted pair used the same strong route under both policies; its 60-second baseline timeout is not a routing-policy difference.',
    omitted_pair: {
      ...OMITTED_PAIR,
      cells: omitted.map((cell) => ({
        cell_id: cell.cell_id,
        policy_id: cell.policy_id,
        status: cell.status,
        request_wall_duration_ms: cell.attempts.reduce((sum, attempt) => sum + attempt.duration_ms, 0),
        gpu_energy_kwh: round(cell.attempts.reduce((sum, attempt) => sum + attempt.economics.gpu_energy.energy_kwh, 0), 9),
        modeled_gpu_cost_usd: round(cell.attempts.reduce((sum, attempt) => sum + attempt.economics.comparison_cost.total_usd, 0), 9),
      })),
    },
    sensitivity: {
      baseline,
      adaptive,
      quality_ratio: round((adaptive.verified / adaptive.cells) / (baseline.verified / baseline.cells), 6),
      gpu_energy_reduction: reduction(baseline.gpu_energy_kwh, adaptive.gpu_energy_kwh),
      modeled_gpu_cost_reduction: reduction(baseline.modeled_gpu_cost_usd, adaptive.modeled_gpu_cost_usd),
      request_wall_duration_reduction: reduction(baseline.request_wall_duration_ms, adaptive.request_wall_duration_ms),
    },
    conclusion: 'The economic direction reverses after excluding the matched timeout pair; v1 does not support a routing-policy savings claim.',
  };
  return { ...result, report_digest: digest(result) };
}

function render(report) {
  const comparison = report.sensitivity;
  return `# Sentient readiness v1 matched-pair sensitivity

The signed v1 aggregate is unchanged. This supplementary analysis removes the
same scenario/repetition from both policies because the baseline cell timed out
after 60 seconds while both policies had selected the same strong route. The
timeout is therefore not evidence of a routing-policy advantage.

| Metric after matched-pair exclusion | Always 7B | Adaptive | Adaptive reduction |
|---|---:|---:|---:|
| Verified cells | ${comparison.baseline.verified}/${comparison.baseline.cells} | ${comparison.adaptive.verified}/${comparison.adaptive.cells} | quality ratio ${comparison.quality_ratio.toFixed(3)} |
| Measured GPU energy | ${comparison.baseline.gpu_energy_kwh.toFixed(9)} kWh | ${comparison.adaptive.gpu_energy_kwh.toFixed(9)} kWh | ${(comparison.gpu_energy_reduction * 100).toFixed(2)}% |
| Modeled GPU cost | $${comparison.baseline.modeled_gpu_cost_usd.toFixed(9)} | $${comparison.adaptive.modeled_gpu_cost_usd.toFixed(9)} | ${(comparison.modeled_gpu_cost_reduction * 100).toFixed(2)}% |
| Request wall duration | ${comparison.baseline.request_wall_duration_ms} ms | ${comparison.adaptive.request_wall_duration_ms} ms | ${(comparison.request_wall_duration_reduction * 100).toFixed(2)}% |

Negative reduction means adaptive used more. After exclusion, adaptive used
${Math.abs(comparison.gpu_energy_reduction * 100).toFixed(2)}% more measured GPU energy,
${Math.abs(comparison.modeled_gpu_cost_reduction * 100).toFixed(2)}% more modeled GPU cost,
and ${Math.abs(comparison.request_wall_duration_reduction * 100).toFixed(2)}% more request wall time.

Conclusion: **v1 does not support a routing-policy savings claim.** It remains a
valid signed calibration run whose frozen economic gates failed.

Report: \`${report.report_digest}\`
`;
}

function outputs() {
  const report = build();
  return { report, markdown: render(report) };
}

function write() {
  const output = outputs();
  fs.writeFileSync(OUTPUT_JSON, `${JSON.stringify(output.report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(OUTPUT_MD, output.markdown, 'utf8');
  return output.report;
}

function verify() {
  const expected = outputs();
  assert.deepStrictEqual(readJson(OUTPUT_JSON), expected.report);
  assert.strictEqual(fs.readFileSync(OUTPUT_MD, 'utf8').replace(/\r\n/g, '\n'), expected.markdown);
  assert(expected.report.sensitivity.gpu_energy_reduction < 0);
  assert(expected.report.sensitivity.modeled_gpu_cost_reduction < 0);
  assert(expected.report.sensitivity.request_wall_duration_reduction < 0);
  return expected.report;
}

const command = process.argv[2] || 'verify';
const report = command === 'build' ? write() : command === 'verify' ? verify() : null;
if (!report) throw new Error(`unknown sensitivity command: ${command}`);
process.stdout.write(`v1 sensitivity ${command} passed: ${report.report_digest}\n`);

module.exports = Object.freeze({ build, render, verify });
