#!/usr/bin/env bun
'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_ROOT = path.join(ROOT, 'benchmarks', 'fresh-clone-onboarding');

function run(command, args, options = {}) {
  const started = Date.now();
  const result = childProcess.spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: options.timeout || 120000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ...(options.env || {}) },
  });
  return {
    status: result.status,
    duration_ms: Date.now() - started,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: result.error ? result.error.message : null,
  };
}

function parseJson(result, label) {
  if (result.status !== 0) throw new Error(`${label} failed: ${result.error || result.stderr || result.stdout}`);
  try { return JSON.parse(result.stdout); }
  catch (error) { throw new Error(`${label} did not return JSON: ${error.message}`); }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function gitCommit(cwd) {
  const result = run('git', ['rev-parse', 'HEAD'], { cwd });
  if (result.status !== 0) throw new Error('could not resolve source commit');
  return result.stdout.trim();
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function render(report) {
  const rows = report.steps.map((step) => `| ${step.id} | ${step.status} | ${step.duration_ms} ms | ${step.detail} |`).join('\n');
  return `# Citadel fresh-clone onboarding proof

Source commit: \`${report.source_commit}\`  
Result: **${report.status}**
Total measured time: **${(report.total_duration_ms / 1000).toFixed(2)} seconds**

| Step | Status | Duration | Evidence |
|---|---|---:|---|
${rows}

## Claim boundary

This is an unattended, local, clean-clone installation and first-route proof on
Windows. It exercises governed planning, exact confirmation, adoption apply,
doctor, and proportional \`/do\` route preview against a new git repository. It
does not claim that a person completed the journey, that an external plugin UI
was clicked, or that a model performed repository work.

Report: \`${report.report_digest}\`
`;
}

function execute() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-fresh-clone-'));
  const clone = path.join(temporary, 'Citadel');
  const target = path.join(temporary, 'target-project');
  const planFile = path.join(temporary, 'citadel-adoption.plan.json');
  const proofEnv = { CITADEL_CONTROL_ROOT: path.join(temporary, 'private-control') };
  const steps = [];
  const overallStarted = Date.now();
  try {
    const cloneResult = run('git', ['clone', '--no-hardlinks', '--quiet', ROOT, clone], { cwd: temporary, timeout: 180000 });
    if (cloneResult.status !== 0) throw new Error(`fresh clone failed: ${cloneResult.stderr}`);
    steps.push({ id: 'fresh-clone', status: 'passed', duration_ms: cloneResult.duration_ms, detail: 'Local clone created from the committed source without shared hardlinks.' });

    fs.mkdirSync(target, { recursive: true });
    writeJson(path.join(target, 'package.json'), { name: 'citadel-onboarding-fixture', private: true, scripts: { test: 'node test.js' } });
    fs.writeFileSync(path.join(target, 'README.md'), '# Fresh target\n', 'utf8');
    fs.writeFileSync(path.join(target, 'test.js'), "process.stdout.write('fixture passed\\n');\n", 'utf8');
    for (const args of [
      ['init', '--quiet'],
      ['config', 'user.email', 'citadel-proof@example.invalid'],
      ['config', 'user.name', 'Citadel Proof'],
      ['add', 'package.json', 'README.md', 'test.js'],
      ['commit', '--quiet', '-m', 'fixture'],
    ]) {
      const result = run('git', args, { cwd: target });
      if (result.status !== 0) throw new Error(`target fixture git step failed: git ${args.join(' ')}`);
    }

    const planResult = run(process.execPath, [path.join(clone, 'scripts', 'adopt.js'), 'plan', clone,
      '--target', target, '--project-runtime', 'both', '--out', planFile, '--json'], { cwd: target, env: proofEnv });
    const plan = parseJson(planResult, 'adoption plan');
    if (!plan.confirmation || typeof plan.confirmation.token !== 'string') throw new Error('adoption plan did not expose an exact confirmation token');
    steps.push({ id: 'governed-plan', status: 'passed', duration_ms: planResult.duration_ms, detail: `${plan.effects.length} file operations bound to ${plan.plan_digest}.` });

    const applyResult = run(process.execPath, [path.join(clone, 'scripts', 'adopt.js'), 'apply', planFile,
      '--confirm', plan.confirmation.token, '--json'], { cwd: target, env: proofEnv });
    const receipt = parseJson(applyResult, 'adoption apply');
    steps.push({ id: 'exact-apply', status: applyResult.status === 0 ? 'passed' : 'failed', duration_ms: applyResult.duration_ms, detail: `Receipt ${receipt.receipt_digest || receipt.receipt_id || 'recorded'}; confirmation token revalidated.` });

    const doctorResult = run(process.execPath, [path.join(clone, 'scripts', 'adopt.js'), 'doctor', '--target', target, '--json'], { cwd: target, env: proofEnv });
    const doctor = parseJson(doctorResult, 'adoption doctor');
    steps.push({
      id: 'doctor-command-executed',
      status: doctorResult.status === 0 ? 'passed' : 'failed',
      doctor_health: doctor.status || doctor.health || 'unknown',
      duration_ms: doctorResult.duration_ms,
      detail: `Doctor command exited ${doctorResult.status}; semantic health ${doctor.status || doctor.health || 'unknown'}; owned footprint inspected.`,
    });

    const routeResult = run(process.execPath, [path.join(clone, 'scripts', 'route-preview.js'), '--json', '--project-root', target, '--', 'review README.md'], { cwd: target });
    const route = parseJson(routeResult, 'route preview');
    steps.push({ id: 'first-do-route', status: routeResult.status === 0 ? 'passed' : 'failed', duration_ms: routeResult.duration_ms, detail: `Plain request selected ${route.selected || route.route || route.skill || 'a proportional route'}.` });

    const reportBase = {
      schema: 1,
      kind: 'citadel-fresh-clone-onboarding-proof',
      generated_at: new Date().toISOString(),
      source_commit: gitCommit(clone),
      platform: process.platform,
      runtime_projection: 'both',
      external_registration: 'not-attempted',
      model_execution: 'not-attempted',
      status: steps.every((step) => step.status === 'passed') ? 'completed' : 'failed',
      total_duration_ms: Date.now() - overallStarted,
      steps,
      claim_boundary: 'Unattended local clean-clone adoption and route proof; not real-user utility or model-task evidence.',
    };
    const report = { ...reportBase, report_digest: digest(reportBase) };
    fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
    writeJson(path.join(OUTPUT_ROOT, 'REPORT.json'), report);
    fs.writeFileSync(path.join(OUTPUT_ROOT, 'REPORT.md'), render(report), 'utf8');
    return report;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function verify() {
  const report = JSON.parse(fs.readFileSync(path.join(OUTPUT_ROOT, 'REPORT.json'), 'utf8'));
  const unsigned = { ...report };
  delete unsigned.report_digest;
  if (report.report_digest !== digest(unsigned)) throw new Error('fresh-clone report digest drifted');
  if (report.status !== 'completed' || report.steps.length !== 5 || report.steps.some((step) => step.status !== 'passed')) {
    throw new Error('fresh-clone onboarding proof did not complete every command stage');
  }
  const doctor = report.steps.find((step) => step.id === 'doctor-command-executed');
  if (!doctor || doctor.doctor_health !== 'unknown') throw new Error('fresh-clone report must preserve unknown doctor health');
  const markdown = fs.readFileSync(path.join(OUTPUT_ROOT, 'REPORT.md'), 'utf8');
  if (!markdown.includes(report.report_digest) || !markdown.includes(report.source_commit)) throw new Error('fresh-clone report markdown drifted');
  return report;
}

function main() {
  const command = process.argv[2] || 'verify';
  const report = command === 'run' ? execute() : command === 'verify' ? verify() : null;
  if (!report) throw new Error(`unknown fresh-clone proof command: ${command}`);
  process.stdout.write(`${JSON.stringify({ status: report.status, report_digest: report.report_digest, total_duration_ms: report.total_duration_ms }, null, 2)}\n`);
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    process.stderr.write(`fresh-clone onboarding proof failed: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({ execute, render, verify });
