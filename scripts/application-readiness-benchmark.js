#!/usr/bin/env bun
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  DEFAULT_KEY,
  DEFAULT_OUTPUT,
  FREEZE_FILE,
  createFreeze,
  doctor,
  publicKeyFromPrivate,
  runBenchmark,
  validateFreeze,
  verifyPublished,
  writeJson,
} = require('../core/application-readiness/benchmark');

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) return process.argv[index + 1];
  const inline = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : fallback;
}

function freeze() {
  if (fs.existsSync(FREEZE_FILE)) {
    const existing = validateFreeze(JSON.parse(fs.readFileSync(FREEZE_FILE, 'utf8')));
    process.stdout.write(`${JSON.stringify({ status: 'already-frozen', freeze_id: existing.freeze_id }, null, 2)}\n`);
    return existing;
  }
  const keyFile = path.resolve(option('key', DEFAULT_KEY));
  if (fs.existsSync(keyFile)) throw new Error(`refusing to reuse an unbound readiness key: ${keyFile}`);
  const pair = crypto.generateKeyPairSync('ed25519');
  const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, privatePem, { encoding: 'utf8', mode: 0o600 });
  const value = createFreeze(publicKeyFromPrivate(privatePem));
  writeJson(FREEZE_FILE, value);
  process.stdout.write(`${JSON.stringify({ status: 'frozen', freeze_id: value.freeze_id, key_file: keyFile }, null, 2)}\n`);
  return value;
}

async function main() {
  const command = process.argv[2] || 'doctor';
  if (command === 'doctor') {
    const report = await doctor();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status !== 'passed') process.exitCode = 1;
    return;
  }
  if (command === 'freeze') {
    freeze();
    return;
  }
  if (command === 'run') {
    const output = path.resolve(option('output', DEFAULT_OUTPUT));
    const keyFile = path.resolve(option('key', DEFAULT_KEY));
    const result = await runBenchmark({ output, keyFile });
    process.stdout.write(`${JSON.stringify({ status: result.summary.evidence_result, bundle_id: result.bundle_id, output }, null, 2)}\n`);
    return;
  }
  if (command === 'verify') {
    const output = path.resolve(option('output', DEFAULT_OUTPUT));
    process.stdout.write(`${JSON.stringify(verifyPublished(output), null, 2)}\n`);
    return;
  }
  throw new Error(`unknown readiness benchmark command: ${command}`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`application-readiness benchmark failed: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({ freeze, main, option });

