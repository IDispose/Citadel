#!/usr/bin/env bun
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  applyPlan, createAdoptionPlan, createLeavePlan, doctor,
} = require('../core/adoption');
const { ACTIVE_RECEIPT, LOCK_PATH } = require('../core/adoption/footprint');

let passed = 0;

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', shell: false, windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.error}`);
  }
  return result.stdout;
}

function git(root, args) {
  return run('git', args, root).trim();
}

function initializeGit(root, files = { 'README.md': '# Test\n' }) {
  fs.mkdirSync(root, { recursive: true });
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'citadel-test@example.invalid']);
  git(root, ['config', 'user.name', 'Citadel Test']);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'baseline']);
  return root;
}

function source(root) {
  return initializeGit(root, {
    'package.json': `${JSON.stringify({ name: 'citadel', version: '9.9.9' }, null, 2)}\n`,
    '.citadel/project.template.md': '# Citadel Project\n',
  });
}

function target(root) {
  return initializeGit(root);
}

function treeDigest(root) {
  const hash = crypto.createHash('sha256');
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git') continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/g, '/');
      hash.update(`${entry.isDirectory() ? 'd' : 'f'}:${relative}\0`);
      if (entry.isDirectory()) visit(absolute);
      else hash.update(fs.readFileSync(absolute));
    }
  };
  visit(root);
  return hash.digest('hex');
}

function expectCode(fn, code) {
  let caught;
  try { fn(); } catch (error) { caught = error; }
  assert(caught, `Expected ${code} error`);
  assert.strictEqual(caught.code, code);
  return caught;
}

function test(name, body) {
  body();
  passed += 1;
  process.stdout.write(`ok ${passed} - ${name}\n`);
}

const suite = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-adoption-'));
const sourceRoot = source(path.join(suite, 'source'));

try {
  test('fresh plan is no-write, apply is receipted, doctor is healthy, and exact leave exits', () => {
    const root = target(path.join(suite, 'fresh'));
    const before = treeDigest(root);
    const plan = createAdoptionPlan({ source: sourceRoot, target: root });
    assert.strictEqual(treeDigest(root), before);
    assert.strictEqual(plan.status, 'ready');
    const result = applyPlan(plan);
    assert(result.receipt);
    assert(fs.existsSync(path.join(root, ...ACTIVE_RECEIPT.split('/'))));
    assert.strictEqual(doctor(root).status, 'healthy');
    fs.mkdirSync(path.join(root, '.planning', 'campaigns'), { recursive: true });
    fs.writeFileSync(path.join(root, '.planning', 'campaigns', 'portable.md'), '# Portable campaign\n');
    const leave = createLeavePlan({ target: root });
    assert.strictEqual(leave.status, 'confirmation_required');
    const exited = applyPlan(leave, { confirm: leave.confirmation.token });
    assert(fs.existsSync(path.join(root, ...exited.archive.split('/'))));
    const archive = JSON.parse(fs.readFileSync(path.join(root, ...exited.archive.split('/')), 'utf8'));
    const portable = archive.portable_state.find((entry) => entry.path === '.planning/campaigns/portable.md');
    assert.strictEqual(Buffer.from(portable.content_base64, 'base64').toString('utf8'), '# Portable campaign\n');
    assert(!fs.existsSync(path.join(root, ...ACTIVE_RECEIPT.split('/'))));
    assert(fs.existsSync(path.join(root, 'README.md')));
    assert.strictEqual(doctor(root).status, 'not_adopted');
    for (const entry of result.receipt.footprint.entries.filter((item) => item.ownership === 'owned')) {
      assert(!fs.existsSync(path.join(root, ...entry.path.split('/'))), entry.path);
    }
  });

  test('dirty target requires the exact confirmation token', () => {
    const root = target(path.join(suite, 'dirty'));
    fs.appendFileSync(path.join(root, 'README.md'), 'user edit\n');
    const plan = createAdoptionPlan({ source: sourceRoot, target: root });
    assert.strictEqual(plan.status, 'confirmation_required');
    expectCode(() => applyPlan(plan), 'CONFIRMATION_REQUIRED');
    assert(applyPlan(plan, { confirm: plan.confirmation.token }).receipt);
  });

  test('pre-existing project state is adopted ambiguously and never removed', () => {
    const root = initializeGit(path.join(suite, 'preexisting'), {
      'README.md': '# Test\n',
      '.citadel/project.md': '# User-owned project settings\n',
    });
    const plan = createAdoptionPlan({ source: sourceRoot, target: root });
    assert.strictEqual(plan.status, 'confirmation_required');
    applyPlan(plan, { confirm: plan.confirmation.token });
    assert.strictEqual(doctor(root).status, 'healthy');
    const leave = createLeavePlan({ target: root });
    applyPlan(leave, { confirm: leave.confirmation.token });
    assert.strictEqual(fs.readFileSync(path.join(root, '.citadel', 'project.md'), 'utf8'), '# User-owned project settings\n');
  });

  test('unborn Git target is blocked without mutation', () => {
    const root = path.join(suite, 'unborn');
    fs.mkdirSync(root);
    git(root, ['init', '-q']);
    const before = treeDigest(root);
    const plan = createAdoptionPlan({ source: sourceRoot, target: root });
    assert.strictEqual(plan.status, 'blocked');
    assert(plan.blockers.some((item) => item.code === 'TARGET_UNBORN'));
    assert.strictEqual(treeDigest(root), before);
  });

  test('target drift rejects apply and does not activate a receipt', () => {
    const root = target(path.join(suite, 'drift'));
    const plan = createAdoptionPlan({ source: sourceRoot, target: root });
    fs.appendFileSync(path.join(root, 'README.md'), 'drift\n');
    expectCode(() => applyPlan(plan), 'TARGET_DRIFT');
    assert(!fs.existsSync(path.join(root, ...ACTIVE_RECEIPT.split('/'))));
  });

  test('concurrent target lock rejects a second apply', () => {
    const root = target(path.join(suite, 'locked'));
    const plan = createAdoptionPlan({ source: sourceRoot, target: root });
    const lock = path.join(root, ...LOCK_PATH.split('/'));
    fs.mkdirSync(lock, { recursive: true });
    expectCode(() => applyPlan(plan), 'TARGET_LOCKED');
    fs.rmdirSync(lock);
  });

  test('injected mid-apply failure compensates completed effects', () => {
    const root = target(path.join(suite, 'failure'));
    const plan = createAdoptionPlan({ source: sourceRoot, target: root });
    const failure = expectCode(() => applyPlan(plan, { failAt: 'after-effect:2' }), 'INJECTED_FAILURE');
    assert.strictEqual(failure.recovery.state, 'recovered');
    assert(!fs.existsSync(path.join(root, '.citadel', 'plugin-root.txt')));
    assert(!fs.existsSync(path.join(root, '.citadel', 'version.txt')));
    assert(!fs.existsSync(path.join(root, ...ACTIVE_RECEIPT.split('/'))));
    assert(!fs.existsSync(path.join(root, ...LOCK_PATH.split('/'))));
  });

  test('leave retains a modified owned footprint with an explicit conflict', () => {
    const root = target(path.join(suite, 'modified'));
    const adoption = applyPlan(createAdoptionPlan({ source: sourceRoot, target: root }));
    const modified = adoption.receipt.footprint.entries.find((entry) => entry.path.endsWith('plugin-root.txt'));
    fs.appendFileSync(path.join(root, ...modified.path.split('/')), 'user-owned-now\n');
    const leave = createLeavePlan({ target: root });
    assert(leave.warnings.some((item) => item.code === 'MODIFIED_FOOTPRINT_RETAINED'));
    applyPlan(leave, { confirm: leave.confirmation.token });
    assert(fs.existsSync(path.join(root, ...modified.path.split('/'))));
    assert.strictEqual(doctor(root).status, 'not_adopted');
  });

  test('source drift rejects a previously saved plan', () => {
    const separateSource = source(path.join(suite, 'source-drift'));
    const root = target(path.join(suite, 'source-drift-target'));
    const plan = createAdoptionPlan({ source: separateSource, target: root });
    fs.writeFileSync(path.join(separateSource, '.citadel', 'project.template.md'), '# Changed\n');
    expectCode(() => applyPlan(plan), 'SOURCE_DRIFT');
  });

  test('CLI exposes stable JSON and exit codes for a real adoption lifecycle', () => {
    const root = target(path.join(suite, 'cli'));
    const cli = path.resolve(__dirname, 'adopt.js');
    const planRun = spawnSync(process.execPath, [cli, 'plan', sourceRoot, '--target', root, '--json'], {
      cwd: suite, encoding: 'utf8', shell: false, windowsHide: true,
    });
    assert.strictEqual(planRun.status, 0, planRun.stderr);
    const plan = JSON.parse(planRun.stdout);
    const planFile = path.join(suite, 'cli-plan.json');
    const cliControl = path.join(suite, 'cli-control');
    fs.writeFileSync(planFile, JSON.stringify(plan));
    const applyRun = spawnSync(process.execPath, [cli, 'apply', planFile, '--control-root', cliControl, '--json'], {
      cwd: root, encoding: 'utf8', shell: false, windowsHide: true,
    });
    assert.strictEqual(applyRun.status, 0, applyRun.stderr);
    assert(JSON.parse(applyRun.stdout).receipt);
    const doctorRun = spawnSync(process.execPath, [cli, 'doctor', '--target', root, '--control-root', cliControl, '--json'], {
      cwd: suite, encoding: 'utf8', shell: false, windowsHide: true,
    });
    assert.strictEqual(doctorRun.status, 0, doctorRun.stderr);
    assert.strictEqual(JSON.parse(doctorRun.stdout).status, 'healthy');
  });

  process.stdout.write(`1..${passed}\n`);
} finally {
  fs.rmSync(suite, { recursive: true, force: true });
}
