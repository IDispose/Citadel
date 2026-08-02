#!/usr/bin/env bun
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  canonical,
  loadExecutors,
  loadFreeze,
  loadScenarios,
  validateRun,
} = require('../core/optimizer/contracts');
const {
  matrixAuthorizationDigest,
  validateMatrixAuthorization,
} = require('../core/optimizer/matrix-authorization');
const { verifyRunAttestation } = require('../core/optimizer/report');

const ROOT = path.resolve(__dirname, '..');
const BENCHMARK = path.join(ROOT, 'benchmarks', 'optimizer-proof');
const CLI = path.join(__dirname, 'optimizer-benchmark.js');
const DEFAULT_OUTPUT = path.join(BENCHMARK, 'actual-runs');
const DEFAULT_KEY = path.join(
  process.env.LOCALAPPDATA || '',
  'rtk',
  'citadel-optimizer-proof',
  'matrix-attestation-private.pem',
);

function args(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unknown argument: ${token}`);
    const key = token.slice(2);
    if (key === 'dry-run') {
      parsed[key] = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`Missing value for --${key}`);
    parsed[key] = argv[++index];
  }
  return parsed;
}

function contained(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function runFileName(item, ordinal) {
  for (const value of [item.scenario_id, item.policy_id]) {
    if (typeof value !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
      throw new Error('Matrix run key contains an unsafe identifier');
    }
  }
  if (!Number.isInteger(item.repetition) || item.repetition < 1) {
    throw new Error('Matrix repetition is invalid');
  }
  return `${String(ordinal).padStart(3, '0')}-${item.scenario_id}-${item.policy_id}-${item.repetition}.json`;
}

function writeExclusive(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}

function replaceJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
}

function privateKeyMatchesFreeze(file, freeze) {
  const privateKey = crypto.createPrivateKey(fs.readFileSync(file));
  const publicPem = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  if (publicPem !== freeze.attestation_public_key) {
    throw new Error('Matrix signing key does not match the frozen attestation public key');
  }
}

function validateCompletedRun(file, item, freeze, authorization, scenarios) {
  const run = validateRun(JSON.parse(fs.readFileSync(file, 'utf8')), file);
  if (run.evidence_kind !== 'actual-run'
    || run.scenario_id !== item.scenario_id
    || run.policy_id !== item.policy_id
    || run.repetition !== item.repetition
    || run.scenario_set_id !== freeze.scenario_set_id
    || run.metric_set_id !== freeze.metric_set_id
    || Date.parse(run.started_at) < Date.parse(authorization.approved_at)
    || !scenarios.some((scenario) => (
      scenario.id === run.scenario_id && scenario.holdout === run.holdout
    ))
    || !verifyRunAttestation(run, freeze.attestation_public_key)) {
    throw new Error(`Completed matrix run does not bind the plan: ${item.run_key}`);
  }
  return run;
}

function acquireLock(directory, authorizationDigest) {
  const lock = path.join(directory, 'matrix-run.lock.json');
  if (fs.existsSync(lock)) {
    let current = null;
    try {
      current = JSON.parse(fs.readFileSync(lock, 'utf8'));
    } catch {
      throw new Error('Matrix lock exists but is unreadable');
    }
    try {
      process.kill(current.pid, 0);
      throw new Error(`Matrix runner is already active as PID ${current.pid}`);
    } catch (error) {
      if (!['ESRCH', 'EINVAL'].includes(error.code)) throw error;
    }
    const stale = path.join(
      directory,
      `matrix-run.stale-${String(Date.now())}.json`,
    );
    fs.renameSync(lock, stale);
  }
  writeExclusive(lock, {
    schema: 1,
    kind: 'citadel_optimizer_matrix_lock',
    pid: process.pid,
    authorization_digest: authorizationDigest,
    acquired_at: new Date().toISOString(),
  });
  return lock;
}

function matrixPlan() {
  const result = spawnSync(process.execPath, [CLI, 'matrix-plan'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`Matrix plan failed: ${String(result.stderr).trim()}`);
  const plan = JSON.parse(result.stdout);
  if (plan.execution_status !== 'ready' || plan.blockers.length !== 0) {
    throw new Error(`Matrix is not ready: ${plan.blockers.join(', ') || 'unknown blocker'}`);
  }
  return plan;
}

function progress(directory, value) {
  const file = path.join(directory, 'progress.json');
  if (fs.existsSync(file)) replaceJson(file, value);
  else writeExclusive(file, value);
}

function main() {
  const options = args(process.argv.slice(2));
  const output = path.resolve(options['output-dir'] || DEFAULT_OUTPUT);
  if (!contained(BENCHMARK, output) || output === BENCHMARK) {
    throw new Error('Matrix output directory must be a child of benchmarks/optimizer-proof');
  }
  const scenarios = loadScenarios(path.join(BENCHMARK, 'scenarios'));
  const executors = loadExecutors(path.join(BENCHMARK, 'executors.json'));
  const freeze = loadFreeze(path.join(BENCHMARK, 'freeze.json'), scenarios, executors);
  const authorization = validateMatrixAuthorization(
    JSON.parse(fs.readFileSync(path.join(BENCHMARK, 'matrix-authorization.json'), 'utf8')),
    freeze,
    scenarios,
  );
  const authorizationDigest = matrixAuthorizationDigest(authorization, freeze, scenarios);
  const key = path.resolve(options['signing-key'] || DEFAULT_KEY);
  privateKeyMatchesFreeze(key, freeze);
  const plan = matrixPlan();
  if (plan.authorization_digest !== authorizationDigest
    || plan.run_count !== authorization.quota_budget.max_cli_runs) {
    throw new Error('Matrix plan does not bind the approved authorization');
  }
  fs.mkdirSync(output, { recursive: true });
  if (options['dry-run']) {
    process.stdout.write(`${JSON.stringify({
      schema: 1,
      kind: 'citadel_optimizer_matrix_dry_run',
      ready: true,
      no_model_calls_made: true,
      authorization_digest: authorizationDigest,
      run_count: plan.run_count,
      output_directory: output,
    }, null, 2)}\n`);
    return;
  }

  const lock = acquireLock(output, authorizationDigest);
  const intents = path.join(output, 'intents');
  const records = path.join(output, 'records');
  fs.mkdirSync(intents, { recursive: true });
  fs.mkdirSync(records, { recursive: true });
  const completed = [];
  try {
    for (let index = 0; index < plan.runs.length; index += 1) {
      const item = plan.runs[index];
      const ordinal = index + 1;
      const fileName = runFileName(item, ordinal);
      const intentFile = path.join(intents, fileName);
      const recordFile = path.join(records, fileName);
      if (fs.existsSync(intentFile)) {
        const intent = JSON.parse(fs.readFileSync(intentFile, 'utf8'));
        if (intent.state !== 'completed') {
          throw new Error(
            `Matrix cell ${item.run_key} is ${intent.state}; refusing an automatic quota retry`,
          );
        }
        completed.push(validateCompletedRun(
          recordFile,
          item,
          freeze,
          authorization,
          scenarios,
        ));
        continue;
      }
      if (fs.existsSync(recordFile)) {
        throw new Error(`Orphan matrix record exists without an intent: ${item.run_key}`);
      }
      const startedAt = new Date().toISOString();
      const intent = {
        schema: 1,
        kind: 'citadel_optimizer_matrix_intent',
        authorization_digest: authorizationDigest,
        ordinal,
        run_key: item.run_key,
        scenario_id: item.scenario_id,
        policy_id: item.policy_id,
        repetition: item.repetition,
        state: 'started',
        started_at: startedAt,
        completed_at: null,
        output_file: `records/${fileName}`,
        error: null,
      };
      writeExclusive(intentFile, intent);
      progress(output, {
        schema: 1,
        kind: 'citadel_optimizer_matrix_progress',
        authorization_digest: authorizationDigest,
        status: 'running',
        completed_run_count: completed.length,
        planned_run_count: plan.run_count,
        current_run_key: item.run_key,
        updated_at: startedAt,
      });
      const scenario = scenarios.find((entry) => entry.id === item.scenario_id);
      const child = spawnSync(process.execPath, [
        CLI,
        'run',
        '--scenario', item.scenario_id,
        '--policy', item.policy_id,
        '--repetition', String(item.repetition),
        '--adapter', path.join(__dirname, 'optimizer-runtime-adapter.js'),
        '--output', recordFile,
        '--signing-key', key,
      ], {
        cwd: ROOT,
        encoding: 'utf8',
        windowsHide: true,
        timeout: ((scenario.timeout_minutes * scenario.max_attempts) + 10) * 60 * 1000,
        maxBuffer: 8 * 1024 * 1024,
      });
      if (child.status !== 0) {
        replaceJson(intentFile, {
          ...intent,
          state: 'unknown',
          completed_at: new Date().toISOString(),
          error: String(child.stderr || child.error || 'matrix child failed')
            .replaceAll(key, '<signing-key>')
            .slice(0, 2000),
        });
        throw new Error(`Matrix cell failed before a verified record: ${item.run_key}`);
      }
      const run = validateCompletedRun(
        recordFile,
        item,
        freeze,
        authorization,
        scenarios,
      );
      completed.push(run);
      replaceJson(intentFile, {
        ...intent,
        state: 'completed',
        completed_at: new Date().toISOString(),
      });
      process.stdout.write(`${JSON.stringify({
        completed_run_count: completed.length,
        planned_run_count: plan.run_count,
        run_key: item.run_key,
        outcome: run.outcome,
        verified: run.verified,
        attempts: run.attempts,
      })}\n`);
    }
    const aggregate = path.join(output, 'actual-runs.jsonl');
    const aggregateText = `${completed.map((run) => JSON.stringify(run)).join('\n')}\n`;
    if (fs.existsSync(aggregate)) {
      if (fs.readFileSync(aggregate, 'utf8') !== aggregateText) {
        throw new Error('Existing aggregate matrix record does not match completed cells');
      }
    } else {
      fs.writeFileSync(aggregate, aggregateText, { encoding: 'utf8', flag: 'wx' });
    }
    progress(output, {
      schema: 1,
      kind: 'citadel_optimizer_matrix_progress',
      authorization_digest: authorizationDigest,
      status: 'completed',
      completed_run_count: completed.length,
      planned_run_count: plan.run_count,
      current_run_key: null,
      updated_at: new Date().toISOString(),
      aggregate_digest: crypto.createHash('sha256').update(aggregateText).digest('hex'),
    });
  } finally {
    if (fs.existsSync(lock)) fs.rmSync(lock);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Optimizer matrix failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  args,
  contained,
  runFileName,
  validateCompletedRun,
});
