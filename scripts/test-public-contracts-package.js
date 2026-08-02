#!/usr/bin/env bun

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PACKAGE_ROOT = path.join(ROOT, 'packages', 'contracts');

const sync = spawnSync(process.execPath, [
  path.join(__dirname, 'generate-public-contracts.js'),
  '--check',
], {
  cwd: ROOT,
  encoding: 'utf8',
});
assert.equal(sync.status, 0, sync.stderr || sync.stdout);

const manifest = JSON.parse(
  fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'),
);
assert.equal(manifest.name, '@citadel/contracts');
assert.equal(manifest.version, '0.1.0');
assert.notEqual(manifest.private, true);
assert.equal(manifest.publishConfig.access, 'public');
assert(manifest.files.includes('vendor/'));

function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(target) : [target];
  });
}

function resolvesInsidePackage(fromFile, request) {
  const target = path.resolve(path.dirname(fromFile), request);
  const relative = path.relative(PACKAGE_ROOT, target);
  assert(
    relative && !relative.startsWith('..') && !path.isAbsolute(relative),
    `${path.relative(PACKAGE_ROOT, fromFile)} escapes package root via ${request}`,
  );
  const candidates = [
    target,
    `${target}.js`,
    `${target}.json`,
    path.join(target, 'index.js'),
  ];
  assert(
    candidates.some((candidate) => fs.existsSync(candidate)),
    `${path.relative(PACKAGE_ROOT, fromFile)} has unresolved dependency ${request}`,
  );
}

for (const file of filesUnder(PACKAGE_ROOT).filter((candidate) => candidate.endsWith('.js'))) {
  const source = fs.readFileSync(file, 'utf8');
  const requires = source.matchAll(/require\((['"])(\.[^'"]+)\1\)/g);
  for (const match of requires) resolvesInsidePackage(file, match[2]);
  assert.equal(
    source.includes(`${path.sep}core${path.sep}`) || source.includes('/core/'),
    false,
    `${path.relative(PACKAGE_ROOT, file)} contains a core-path dependency`,
  );
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-public-contracts-'));
const installed = path.join(sandbox, 'node_modules', '@citadel', 'contracts');
fs.mkdirSync(path.dirname(installed), { recursive: true });
fs.cpSync(PACKAGE_ROOT, installed, { recursive: true });

const external = spawnSync(process.execPath, ['-e', [
  "const assert=require('assert');",
  "const contracts=require('@citadel/contracts');",
  "const control=require('@citadel/contracts/control-plane');",
  "const app=require('@citadel/contracts/app');",
  "assert.equal(contracts.operations.PROTOCOL_VERSION,'0.1');",
  "assert.equal(control.CONTROL_PLANE_CONTRACT_VERSION,'0.1');",
  "assert.equal(control.CONTROL_PLANE_API_VERSION,1);",
  "assert.equal(typeof control.validateRequestEnvelope,'function');",
  "assert(control.validateRequestEnvelope({}).length>0);",
  "assert.equal(typeof app.validateAppContract,'function');",
  "assert.match(contracts.operations.sha256Digest({b:2,a:1}),/^sha256:[a-f0-9]{64}$/);",
  "process.stdout.write('external package load passed\\n');",
].join('')], {
  cwd: sandbox,
  encoding: 'utf8',
  env: { ...process.env, NODE_PATH: path.join(sandbox, 'node_modules') },
});
assert.equal(external.status, 0, external.stderr);
assert.match(external.stdout, /external package load passed/);

process.stdout.write('public contracts package tests passed (standalone install simulation)\n');
