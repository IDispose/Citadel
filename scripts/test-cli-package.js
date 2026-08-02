#!/usr/bin/env bun

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const cli = require('../core/cli/package-cli');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'citadel.js');

function invoke(args, cwd = ROOT) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd, encoding: 'utf8', shell: false, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function tarEntries(buffer) {
  const result = [];
  for (let offset = 0; offset + 512 <= buffer.length;) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/, '');
    const name = [text(345, 155), text(0, 100)].filter(Boolean).join('/');
    const mode = Number.parseInt(text(100, 8).trim() || '0', 8);
    const size = Number.parseInt(text(124, 12).trim() || '0', 8);
    result.push({ name, mode, size });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return result;
}

function captureIo() {
  const output = { stdout: '', stderr: '' };
  return {
    output,
    io: {
      stdout: { write: (value) => { output.stdout += value; } },
      stderr: { write: (value) => { output.stderr += value; } },
    },
  };
}

const manifest = require('../package.json');
assert.deepEqual(manifest.bin, { citadel: 'bin/citadel.js' });
assert(manifest.files.includes('bin/'));
assert(manifest.files.includes('core/'));
assert(manifest.files.includes('.planning/_templates/'));
assert(!manifest.files.includes('.planning/'), 'operational planning state must not be published wholesale');

const markerFreeFs = { existsSync: () => false };
assert.deepEqual(cli.detectRuntime(['--runtime', 'claude']), { runtime: 'claude', source: 'argument' });
assert.deepEqual(cli.detectRuntime([], { env: { CITADEL_RUNTIME: 'codex' } }), { runtime: 'codex', source: 'environment' });
assert.deepEqual(cli.detectRuntime([], { env: {}, fsImpl: markerFreeFs, probe: (command) => command === 'claude' }), { runtime: 'claude', source: 'command' });
assert.throws(() => cli.detectRuntime([], { env: {}, fsImpl: markerFreeFs, probe: () => true }), (error) => error.code === cli.CODE.RUNTIME_AMBIGUOUS);
assert.throws(() => cli.detectRuntime([], { env: {}, fsImpl: markerFreeFs, probe: () => false }), (error) => error.code === cli.CODE.RUNTIME_NOT_FOUND);

const markerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-cli-marker-'));
fs.mkdirSync(path.join(markerRoot, '.codex'));
assert.deepEqual(cli.detectRuntime(['--project-root', markerRoot], { env: {}, probe: () => false }), { runtime: 'codex', source: 'project-marker' });

const help = invoke(['--help']);
assert.equal(help.status, 0, help.stderr);
for (const command of [
  'install', 'doctor', 'update', 'rollback', 'uninstall', 'pack', 'journey',
  'receipt', 'fork', 'adopt', 'config', 'governance',
  'control-plane', 'trial',
  'memory', 'operation',
]) {
  assert(help.stdout.includes(command), `root help missing ${command}`);
}

const packList = invoke(['pack', 'list', '--json']);
assert.equal(packList.status, 0, packList.stderr);
assert.equal(JSON.parse(packList.stdout).packs.length, 3);
assert.equal(invoke(['receipt', '--help']).status, 0);
assert.equal(invoke(['journey', '--help']).status, 0);
assert.equal(invoke(['fork', '--help']).status, 0);
assert.equal(invoke(['adopt', '--help']).status, 0);
assert.equal(invoke(['config', '--help']).status, 0);
assert.equal(invoke(['governance', '--help']).status, 0);
assert.equal(invoke(['control-plane', '--help']).status, 0);
assert.equal(invoke(['trial', '--help']).status, 0);
assert.equal(invoke(['memory', '--help']).status, 0);
assert.equal(invoke(['operation', '--help']).status, 0);

const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-cli-install & literal-'));
const install = invoke(['install', '--runtime', 'codex', '--project-root', installRoot, '--plugin-only', '--dry-run', '--json']);
assert.equal(install.status, 0, install.stderr);
const installReport = JSON.parse(install.stdout);
assert.equal(path.resolve(installReport.projectRoot), path.resolve(installRoot));
assert.equal(installReport.mode, 'plugin-only');
assert(installReport.steps.every((step) => step.skipped), 'dry-run installer must not execute a step');

const autoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-cli-auto-'));
fs.mkdirSync(path.join(autoRoot, '.codex'));
const automatic = invoke(['install', '--project-root', autoRoot, '--plugin-only', '--dry-run', '--json']);
assert.equal(automatic.status, 0, automatic.stderr);
assert.equal(JSON.parse(automatic.stdout).mode, 'plugin-only');

const uninstallRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-cli-uninstall-'));
fs.mkdirSync(path.join(uninstallRoot, '.planning'));
const uninstallPlan = invoke(['uninstall', uninstallRoot, '--dry-run', '--json']);
assert.equal(uninstallPlan.status, 2, uninstallPlan.stderr);
const leavePlan = JSON.parse(uninstallPlan.stdout);
assert.equal(leavePlan.operation, 'leave');
assert.equal(leavePlan.status, 'blocked');
assert(leavePlan.blockers.some((entry) => entry.code === 'NOT_ADOPTED'));
assert(fs.existsSync(path.join(uninstallRoot, '.planning')), 'dry-run uninstall must not mutate project');
const legacyUpdate = invoke([
  'update', '--archive', path.join(uninstallRoot, 'legacy-release.tar.gz'),
  '--target', uninstallRoot, '--apply', '--json',
]);
assert.equal(legacyUpdate.status, 64);
assert.match(JSON.parse(legacyUpdate.stdout).message, /receipt-owned/);
const legacyRollback = invoke([
  'rollback', path.join(uninstallRoot, 'legacy-backup'),
  '--target', uninstallRoot, '--apply', '--json',
]);
assert.equal(legacyRollback.status, 64);
assert.match(JSON.parse(legacyRollback.stdout).message, /receipt-owned/);

const doctorCapture = captureIo();
const doctor = cli.doctorReport(['--runtime', 'codex'], { env: {}, probe: () => false });
assert(doctor.checks.some((check) => check.name === 'runtime-selection' && check.pass && check.runtime === 'codex'));
assert(doctor.checks.some((check) => check.name === 'runtime-command' && !check.pass));
assert.equal(doctor.pass, false);
assert.equal(cli.main(['pack', 'list', '--json'], { io: doctorCapture.io, cwd: ROOT }), cli.EXIT.OK);
assert.equal(JSON.parse(doctorCapture.output.stdout).packs.length, 3);

const packRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-pack-'));
const { packStep } = require('../core/runtime/packager');
const npmEnvironment = { ...process.env, npm_config_cache: path.join(packRoot, 'npm-cache') };
const pack = packStep({ packageDir: ROOT, destDir: packRoot });
const packed = spawnSync(pack.command, pack.args, {
  cwd: pack.cwd, env: npmEnvironment, encoding: 'utf8', shell: false, stdio: ['ignore', 'pipe', 'pipe'],
});
assert.equal(packed.status, 0, packed.stderr);
const archive = pack.tarballFrom(packed.stdout);
const entries = tarEntries(zlib.gunzipSync(fs.readFileSync(archive)));
const names = new Set(entries.map((entry) => entry.name));
for (const required of [
  'package/bin/citadel.js', 'package/core/cli/package-cli.js', 'package/scripts/install.js',
  'package/core/forks/index.js', 'package/scripts/operation-fork.js',
  'package/core/adoption/index.js', 'package/scripts/adopt.js',
  'package/core/config/index.js', 'package/scripts/citadel-config.js',
  'package/core/governance/index.js', 'package/scripts/governance-gate.js',
  'package/core/control-plane/index.js', 'package/scripts/control-plane-stdio.js',
  'package/core/memory/repository-store.js', 'package/scripts/repository-memory.js',
  'package/core/product-proof/index.js', 'package/scripts/product-proof-trial.js',
  'package/core/operation-controller/index.js', 'package/scripts/operation.js',
  'package/scripts/operation-runtime-adapter.js',
  'package/examples/operation-control/request.json',
  'package/schemas/harness-config-v2.schema.json',
  'package/skills/unharness/SKILL.md',
  'package/skills/do/SKILL.md', 'package/.planning/_templates/campaign.md',
]) assert(names.has(required), `packed archive missing ${required}`);
for (const forbidden of [
  'package/.github/workflows/release.yml',
  'package/.planning/campaigns/citadel-product-proof.md',
  'package/.planning/research/twelve-month-unlocks/product-growth-audit.md',
]) assert(!names.has(forbidden), `packed archive leaked ${forbidden}`);
const binEntry = entries.find((entry) => entry.name === 'package/bin/citadel.js');
assert(binEntry.size > 0, 'npm tarball CLI entrypoint must contain executable code');

const installedRoot = path.join(packRoot, 'installed');
const { installTarballToPrefix } = require('../core/runtime/packager');
const installStep = installTarballToPrefix({ tarball: archive, prefix: installedRoot, cacheDir: path.join(packRoot, 'npm-cache') });
installStep.prepare();
const installPacked = spawnSync(installStep.command, installStep.args, {
  cwd: installStep.cwd, env: npmEnvironment, encoding: 'utf8', shell: false, stdio: ['ignore', 'pipe', 'pipe'],
});
assert.equal(installPacked.status, 0, installPacked.stderr);
const installedBin = path.join(installedRoot, 'node_modules', 'citadel', 'bin', 'citadel.js');
const shim = path.join(installedRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'citadel.cmd' : 'citadel');
assert(fs.existsSync(shim), 'package install must create the citadel executable shim');
if (process.platform !== 'win32') assert(fs.statSync(shim).mode & 0o111, 'installed citadel shim must be executable');
const packedHelp = spawnSync(process.execPath, [installedBin, '--help'], {
  cwd: packRoot, encoding: 'utf8', shell: false, stdio: ['ignore', 'pipe', 'pipe'],
});
assert.equal(packedHelp.status, 0, packedHelp.stderr);
assert(packedHelp.stdout.includes('Citadel'));

for (const directory of [markerRoot, installRoot, autoRoot, uninstallRoot, packRoot]) {
  fs.rmSync(directory, { recursive: true, force: true });
}

process.stdout.write('CLI package tests passed.\n');
