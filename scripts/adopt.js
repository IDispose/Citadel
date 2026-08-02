#!/usr/bin/env bun
'use strict';

const path = require('path');
const {
  AdoptionError, applyPlan, createAdoptionPlan, createImportPlan,
  createLeavePlan, createRestorePlan, createRollbackPlan, createUpdatePlan,
  defaultControlRoot, doctor, loadPlan, proposeClaudeProjection,
  proposeCodexProjection,
} = require('../core/adoption');
const fs = require('fs');

function parse(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    if (['json', 'allow-dirty-source', 'allow-downgrade'].includes(name)) flags[name] = true;
    else {
      if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`Flag --${name} requires a value`);
      flags[name] = argv[++index];
    }
  }
  return { positional, flags };
}

function print(value, json, summary) {
  if (json || !summary) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else process.stdout.write(`${summary}\n`);
}

function printPlan(plan, flags) {
  if (flags.out) {
    const target = path.resolve(flags.out);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  }
  print(plan, true);
}

function usage() {
  return [
    'Usage:',
    '  bun scripts/adopt.js plan [source] [--target <path>] [--allow-dirty-source] [--out <plan.json>] [--json]',
    '  bun scripts/adopt.js apply <plan.json> [--confirm <token>] [--json]',
    '  bun scripts/adopt.js doctor [--target <path>] [--json]',
    '  bun scripts/adopt.js update plan <source> --migration <file> [--target <path>] [--json]',
    '  bun scripts/adopt.js update apply <plan.json> [--confirm <token>] [--json]',
    '  bun scripts/adopt.js rollback plan [--target <path>] [--json]',
    '  bun scripts/adopt.js rollback apply <plan.json> [--confirm <token>] [--json]',
    '  bun scripts/adopt.js leave plan [--target <path>] [--out <plan.json>] [--json]',
    '  bun scripts/adopt.js leave apply <plan.json> [--confirm <token>] [--json]',
    '  bun scripts/adopt.js restore plan <archive.json> [--target <path>] [--json]',
    '  bun scripts/adopt.js restore apply <plan.json> [--confirm <token>] [--json]',
    '  bun scripts/adopt.js import plan [source] [--target <path>] [--json]',
    '  bun scripts/adopt.js import apply <plan.json> [--confirm <token>] [--json]',
  ].join('\n');
}

function runtimeProjections(flags, target, source) {
  if (!flags['project-runtime'] || !source) return [];
  const requested = flags['project-runtime'].split(',').map((item) => item.trim());
  const projections = [];
  if (requested.includes('claude') || requested.includes('both')) {
    projections.push(proposeClaudeProjection({ target, source }));
  }
  if (requested.includes('codex') || requested.includes('both')) {
    projections.push(proposeCodexProjection({ target, source }));
  }
  return projections;
}

function migrationFile(flags) {
  if (!flags.migration) return null;
  return JSON.parse(fs.readFileSync(path.resolve(flags.migration), 'utf8').replace(/^\uFEFF/, ''));
}

function applyOptions(flags) {
  return {
    confirm: flags.confirm,
    controlRoot: path.resolve(flags['control-root'] || defaultControlRoot()),
    failAt: flags['fail-at'],
  };
}

function main(argv) {
  const { positional, flags } = parse(argv);
  const [command, subcommand] = positional;
  const target = path.resolve(flags.target || process.cwd());
  const controlRoot = path.resolve(flags['control-root'] || defaultControlRoot());
  if (command === 'plan') {
    const source = path.resolve(subcommand || path.join(__dirname, '..'));
    const plan = createAdoptionPlan({
      source, target, runtime: flags.runtime,
      allowDirtySource: Boolean(flags['allow-dirty-source']),
      runtimeProjections: runtimeProjections(flags, target, source),
    });
    printPlan(plan, flags);
    return plan.status === 'blocked' ? 2 : 0;
  }
  if (command === 'apply') {
    if (!subcommand) throw new Error('apply requires a saved plan path');
    const result = applyPlan(loadPlan(path.resolve(subcommand)), applyOptions(flags));
    print(result, Boolean(flags.json), `Citadel adoption ${result.operation} completed (${result.operation_id})`);
    return 0;
  }
  if (command === 'doctor') {
    const result = doctor(target, { controlRoot });
    print(result, Boolean(flags.json), `Citadel adoption status: ${result.status}`);
    return result.status === 'blocked' ? 2 : 0;
  }
  if (command === 'leave' && subcommand === 'plan') {
    const plan = createLeavePlan({ target, controlRoot });
    printPlan(plan, flags);
    return plan.status === 'blocked' ? 2 : 0;
  }
  if (command === 'leave' && subcommand === 'apply') {
    const file = positional[2];
    if (!file) throw new Error('leave apply requires a saved plan path');
    const plan = loadPlan(path.resolve(file));
    if (plan.operation !== 'leave') throw new Error('leave apply requires a leave plan');
    const result = applyPlan(plan, applyOptions(flags));
    print(result, Boolean(flags.json), `Citadel leave completed (${result.operation_id})`);
    return 0;
  }
  if (command === 'update' && subcommand === 'plan') {
    const sourceArg = positional[2];
    if (!sourceArg) throw new Error('update plan requires a source path');
    const source = path.resolve(sourceArg);
    const planOptions = {
      source, target, controlRoot, migration: migrationFile(flags),
      allowDirtySource: Boolean(flags['allow-dirty-source']),
      allowDowngrade: Boolean(flags['allow-downgrade']),
    };
    if (flags['project-runtime']) planOptions.runtimeProjections = runtimeProjections(flags, target, source);
    const plan = createUpdatePlan(planOptions);
    printPlan(plan, flags);
    return plan.status === 'blocked' ? 2 : 0;
  }
  if (command === 'rollback' && subcommand === 'plan') {
    const plan = createRollbackPlan({ target, controlRoot });
    printPlan(plan, flags);
    return plan.status === 'blocked' ? 2 : 0;
  }
  if (command === 'restore' && subcommand === 'plan') {
    if (!positional[2]) throw new Error('restore plan requires an archive path');
    const plan = createRestorePlan({ target, controlRoot, archive: path.resolve(positional[2]) });
    printPlan(plan, flags);
    return plan.status === 'blocked' ? 2 : 0;
  }
  if (command === 'import' && subcommand === 'plan') {
    const source = positional[2] ? path.resolve(positional[2]) : null;
    const plan = createImportPlan({
      target, source, controlRoot,
      allowDirtySource: Boolean(flags['allow-dirty-source']),
      runtimeProjections: runtimeProjections(flags, target, source),
    });
    printPlan(plan, flags);
    return plan.status === 'blocked' ? 2 : 0;
  }
  if (['update', 'rollback', 'restore', 'import'].includes(command) && subcommand === 'apply') {
    const file = positional[2];
    if (!file) throw new Error(`${command} apply requires a saved plan path`);
    const plan = loadPlan(path.resolve(file));
    if (plan.operation !== command) throw new Error(`${command} apply requires a ${command} plan`);
    const result = applyPlan(plan, applyOptions(flags));
    print(result, Boolean(flags.json), `Citadel ${command} completed (${result.operation_id})`);
    return 0;
  }
  process.stderr.write(`${usage()}\n`);
  return 64;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  const payload = {
    ok: false,
    code: error instanceof AdoptionError ? error.code : 'INVALID_REQUEST',
    message: error.message,
    recovery: error.recovery || null,
  };
  if (process.argv.includes('--json')) process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stderr.write(`Citadel adoption failed [${payload.code}]: ${payload.message}\n`);
  process.exitCode = error instanceof AdoptionError && error.code === 'CONFIRMATION_REQUIRED' ? 3 : 1;
}
