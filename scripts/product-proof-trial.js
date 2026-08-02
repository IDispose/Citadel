#!/usr/bin/env bun
'use strict';

const fs = require('fs');
const path = require('path');

const {
  appendReceipt,
  appendRecord,
  buildReport,
  buildSharePreview,
  createPlan,
  loadStore,
  purgeStore,
  signReceipt,
  startStore,
  validatePlan,
  validateRecord,
  verifyPinnedReceipt,
  writeReport,
  writeSharePreview,
} = require('../core/product-proof');

function parseArgs(argv) {
  const options = { _: [], root: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      options._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    options[key] = next && !next.startsWith('--') ? argv[++index] : true;
  }
  options.root = path.resolve(options.root);
  return options;
}

function readJson(file, label) {
  if (!file) throw new Error(`--${label} is required`);
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}

function usage() {
  return [
    'Usage: bun scripts/product-proof-trial.js <command> [options]',
    '',
    'Commands:',
    '  validate [--spec FILE] [--root PATH]',
    '  plan --spec FILE',
    '  start --spec FILE [--root PATH]',
    '  record --input FILE [--root PATH] [--private-key FILE --signer ID --assignment ID]',
    '  report [--root PATH]',
    '  share-preview [--root PATH]',
    '  purge [--root PATH]',
    '',
    'The CLI is local-only. share-preview writes a redacted aggregate and never transmits it.',
  ].join('\n');
}

function emit(context, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  (context.stdout || process.stdout).write(text);
  return value;
}

function run(argv = process.argv.slice(2), context = {}) {
  const options = parseArgs(argv);
  const command = options._[0] || 'help';
  if (command === 'help' || options.help || options.h) {
    (context.stdout || process.stdout).write(`${usage()}\n`);
    return { outcome: 'help' };
  }

  if (command === 'plan' || command === 'start') {
    const plan = createPlan(readJson(options.spec, 'spec'));
    if (command === 'plan') {
      return emit(context, {
        outcome: 'plan_ready',
        wrote_files: false,
        claim_status: 'instrument_only',
        ...plan,
      });
    }
    const files = startStore(options.root, plan);
    return emit(context, {
      outcome: 'trial_store_started',
      claim_status: 'instrument_only',
      protocol_id: plan.protocol.protocol_id,
      assignments: plan.assignments.length,
      store: path.relative(options.root, files.dir).replace(/\\/g, '/'),
    });
  }

  if (command === 'validate') {
    if (options.spec) {
      const plan = createPlan(readJson(options.spec, 'spec'));
      validatePlan(plan.protocol, plan.assignments);
      return emit(context, {
        outcome: 'spec_valid',
        claim_status: 'instrument_only',
        protocol_id: plan.protocol.protocol_id,
        assignments: plan.assignments.length,
        commitment: plan.protocol.assignment_commitment,
      });
    }
    const store = loadStore(options.root);
    const report = buildReport(store);
    return emit(context, {
      outcome: 'store_valid',
      claim_status: 'instrument_only',
      protocol_id: store.protocol.protocol_id,
      records: store.records.length,
      receipts: store.receipts.length,
      instrument_status: report.instrument_status,
    });
  }

  if (command === 'record') {
    const record = validateRecord(readJson(options.input, 'input'));
    const store = loadStore(options.root);
    if (record.protocol_id !== store.protocol.protocol_id) throw new Error('record protocol mismatch');
    let receipt = null;
    if (options['private-key']) {
      const privateKey = fs.readFileSync(path.resolve(options['private-key']), 'utf8');
      receipt = signReceipt([record], privateKey, {
        protocol: store.protocol,
        signer: options.signer || 'local-facilitator',
        assignmentId: options.assignment || record.assignment_id,
      });
      if (!verifyPinnedReceipt(receipt, store.protocol)) {
        throw new Error('signed receipt does not match the protocol signing key');
      }
    }
    appendRecord(options.root, record);
    if (receipt) appendReceipt(options.root, receipt);
    return emit(context, {
      outcome: 'recorded',
      claim_status: 'instrument_only',
      kind: record.kind,
      signed: Boolean(receipt),
    });
  }

  if (command === 'report') {
    const store = loadStore(options.root);
    const report = buildReport(store);
    const output = writeReport(options.root, report);
    return emit(context, {
      ...report,
      report_relative: path.relative(options.root, output).replace(/\\/g, '/'),
    });
  }

  if (command === 'share-preview') {
    const store = loadStore(options.root);
    const report = buildReport(store);
    const preview = buildSharePreview(report, store.protocol.gates.minimum_public_cell);
    const output = writeSharePreview(options.root, preview);
    return emit(context, {
      ...preview,
      transmitted: false,
      preview_relative: path.relative(options.root, output).replace(/\\/g, '/'),
    });
  }

  if (command === 'purge') return emit(context, purgeStore(options.root));
  throw new Error(`unknown command: ${command}`);
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`Product proof trial failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({ parseArgs, run, usage });
