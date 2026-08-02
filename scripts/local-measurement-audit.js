#!/usr/bin/env bun
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_ROOT = path.join(ROOT, 'benchmarks', 'local-measurement-audit');
const STUDIES = Object.freeze(['sentient-readiness', 'sentient-readiness-v2']);

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function auditStudy(study) {
  const root = path.join(ROOT, 'benchmarks', study, 'published-run');
  const bundle = readJson(path.join(root, 'bundle.json'));
  const cells = bundle.artifacts.map((artifact) => readJson(path.join(root, artifact.path)));
  const attempts = cells.flatMap((cell) => cell.attempts.map((attempt) => ({ cell_id: cell.cell_id, ...attempt })));
  let maximumAbsoluteErrorKwh = 0;
  for (const attempt of attempts) {
    const reconstructed = (attempt.economics.gpu_energy.average_watts * attempt.duration_ms) / 3_600_000_000;
    const error = Math.abs(reconstructed - attempt.economics.gpu_energy.energy_kwh);
    maximumAbsoluteErrorKwh = Math.max(maximumAbsoluteErrorKwh, error);
    assert(error <= 0.000000001, `${study}/${attempt.cell_id} GPU energy arithmetic drifted by ${error}`);
  }
  return {
    study,
    cells: cells.length,
    attempts: attempts.length,
    energy_arithmetic: {
      status: 'passed',
      formula: 'average_watts * request_wall_duration_ms / 3600000000',
      tolerance_kwh: 0.000000001,
      maximum_absolute_error_kwh: Number(maximumAbsoluteErrorKwh.toFixed(12)),
      raw_power_samples_retained: false,
      sample_count_retained: true,
      average_watts_retained: true,
    },
    duration_semantics: 'client request/attempt wall duration, not provider-only model duration',
    human_interventions_semantics: 'operator-declared, not instrumented telemetry',
  };
}

function build() {
  const reportBase = {
    schema: 1,
    kind: 'citadel-local-measurement-arithmetic-audit',
    studies: STUDIES.map(auditStudy),
    boundary: 'Arithmetic reconstruction validates stored average power times request wall duration. Raw 500 ms samples were not retained, so within-attempt power variance cannot be reconstructed.',
  };
  return { ...reportBase, report_digest: digest(reportBase) };
}

function render(report) {
  const rows = report.studies.map((study) => `| ${study.study} | ${study.cells} | ${study.attempts} | ${study.energy_arithmetic.status} | ${study.energy_arithmetic.maximum_absolute_error_kwh} kWh |`).join('\n');
  return `# Local measurement arithmetic audit

| Study | Cells | Attempts | Average-power × wall-time check | Maximum error |
|---|---:|---:|---|---:|
${rows}

- Duration means client request/attempt wall time, not provider-only model time.
- Human-intervention count is operator-declared, not instrumented telemetry.
- Raw 500 ms power samples were not retained; sample count and average watts were.
- This audit checks arithmetic consistency, not calibration of \`nvidia-smi\` or
  whole-system energy completeness.

Report: \`${report.report_digest}\`
`;
}

function outputs() { const report = build(); return { report, markdown: render(report) }; }
function write() {
  const output = outputs();
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_ROOT, 'REPORT.json'), `${JSON.stringify(output.report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(OUTPUT_ROOT, 'REPORT.md'), output.markdown, 'utf8');
  return output.report;
}
function verify() {
  const expected = outputs();
  assert.deepStrictEqual(readJson(path.join(OUTPUT_ROOT, 'REPORT.json')), expected.report);
  assert.strictEqual(fs.readFileSync(path.join(OUTPUT_ROOT, 'REPORT.md'), 'utf8').replace(/\r\n/g, '\n'), expected.markdown);
  return expected.report;
}

const command = process.argv[2] || 'verify';
const report = command === 'build' ? write() : command === 'verify' ? verify() : null;
if (!report) throw new Error(`unknown local measurement audit command: ${command}`);
process.stdout.write(`local measurement audit ${command} passed: ${report.report_digest}\n`);

module.exports = Object.freeze({ auditStudy, build, verify });
