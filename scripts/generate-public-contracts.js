#!/usr/bin/env bun

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PACKAGE_ROOT = path.join(ROOT, 'packages', 'contracts');
const CHECK = process.argv.includes('--check');

function jsFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => entry.name)
    .sort();
}

const copies = [];

for (const name of jsFiles(path.join(ROOT, 'core', 'contracts'))) {
  copies.push({
    source: path.join(ROOT, 'core', 'contracts', name),
    target: path.join(PACKAGE_ROOT, 'vendor', 'contracts', name),
  });
}

for (const name of jsFiles(path.join(ROOT, 'core', 'operations'))) {
  if (name === 'compiler.js') continue;
  copies.push({
    source: path.join(ROOT, 'core', 'operations', name),
    target: path.join(PACKAGE_ROOT, 'vendor', 'operations', name),
  });
}

copies.push({
  source: path.join(ROOT, 'core', 'telemetry', 'schema.js'),
  target: path.join(PACKAGE_ROOT, 'vendor', 'telemetry', 'schema.js'),
});

for (const name of [
  'authority.js',
  'contracts.js',
  'events.js',
  'proof-bundle.js',
  'proof-policy.js',
]) {
  copies.push({
    source: path.join(ROOT, 'core', 'control-plane', name),
    target: path.join(PACKAGE_ROOT, 'vendor', 'control-plane', name),
    transform(bytes) {
      return bytes.replace(
        "require('../../packages/contracts/app')",
        "require('../../app')",
      );
    },
  });
}

const drift = [];
for (const copy of copies) {
  const source = fs.readFileSync(copy.source, 'utf8');
  const expected = copy.transform ? copy.transform(source) : source;
  const observed = fs.existsSync(copy.target)
    ? fs.readFileSync(copy.target, 'utf8')
    : null;
  if (observed === expected) continue;
  if (CHECK) {
    drift.push(path.relative(ROOT, copy.target).replace(/\\/g, '/'));
    continue;
  }
  fs.mkdirSync(path.dirname(copy.target), { recursive: true });
  fs.writeFileSync(copy.target, expected);
  process.stdout.write(`updated ${path.relative(ROOT, copy.target)}\n`);
}

if (CHECK && drift.length) {
  process.stderr.write(
    `public contract package is out of sync:\n${drift.map((file) => `  ${file}`).join('\n')}\n`
      + 'Run: bun scripts/generate-public-contracts.js\n',
  );
  process.exit(1);
}

process.stdout.write(
  CHECK
    ? `public contract package is synchronized (${copies.length} files)\n`
    : `public contract package generated (${copies.length} files)\n`,
);
