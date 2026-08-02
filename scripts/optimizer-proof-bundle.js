#!/usr/bin/env bun
'use strict';

const path = require('path');
const { buildBundle, verifyBundle } = require('../core/optimizer/bundle');

function args(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) parsed._.push(token);
    else {
      const key = token.slice(2);
      const next = argv[index + 1];
      parsed[key] = next && !next.startsWith('--') ? argv[++index] : true;
    }
  }
  return parsed;
}

function main() {
  const options = args(process.argv.slice(2));
  const command = options._[0];
  if (command === 'build') {
    for (const required of ['raw', 'report', 'output']) {
      if (!options[required]) throw new Error(`build requires --${required}`);
    }
    const result = buildBundle({
      root: path.resolve(__dirname, '..'),
      rawFile: options.raw,
      reportFile: options.report,
      outputDirectory: options.output,
    });
    process.stdout.write(`${JSON.stringify({
      built: true,
      output: result.output,
      bundle_id: result.manifest.bundle_id,
      claim_status: result.manifest.claim_status,
    }, null, 2)}\n`);
    return;
  }
  if (command === 'verify') {
    const directory = options._[1];
    if (!directory) throw new Error('verify requires <bundle-directory>');
    process.stdout.write(`${JSON.stringify(verifyBundle(directory), null, 2)}\n`);
    return;
  }
  throw new Error('Usage: optimizer-proof-bundle.js build --raw <jsonl> --report <json> --output <directory> | verify <directory>');
}

try {
  main();
} catch (error) {
  process.stderr.write(`Optimizer proof bundle failed: ${error.message}\n`);
  process.exitCode = 1;
}
