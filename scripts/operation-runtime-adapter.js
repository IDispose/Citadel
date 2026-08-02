#!/usr/bin/env bun

'use strict';

const { spawnSync } = require('child_process');
const { platformInvocation } = require('../core/forks/launcher');
const { claudeObservation, codexObservation } = require('./optimizer-runtime-adapter');

function unknown(source) { return { status: 'unknown', amount_usd: null, basis: 'observed', source }; }

function costsFor(runtime, observation) {
  const market = runtime === 'claude' && Number.isFinite(observation?.vendor_cost_usd)
    ? { status: 'known', amount_usd: observation.vendor_cost_usd, basis: 'list-price', source: 'claude total_cost_usd telemetry' }
    : unknown('runtime did not provide attributable list-price telemetry');
  return {
    actual_cash: unknown('invoice and subscription attribution are outside the runtime adapter'),
    marginal: unknown('per-operation marginal cash was not observed'),
    market_equivalent: market,
  };
}

function promptFor(input) {
  return [
    'Complete the following operation in the current repository.',
    'Stay inside the repository. Do not commit, push, publish, deploy, or contact external systems.',
    'Use only the tools permitted by the runtime and operation. Leave the working tree ready for the independent verifier.',
    'Do not claim success merely because you finished; Citadel will run the declared verifier.',
    '',
    `Objective: ${input.operation.objective}`,
  ].join('\n');
}

function claudeAllowedTools(tools) {
  const allowed = [];
  if (tools.includes('filesystem')) allowed.push('Read', 'Edit', 'Write', 'Glob', 'Grep');
  if (tools.includes('shell')) allowed.push(
    'Bash(node *)', 'Bash(npm *)', 'Bash(npx *)',
    'Bash(git diff *)', 'Bash(git status *)', 'Bash(git rev-parse *)',
  );
  return allowed.join(',');
}

function invocationFor(runtime, model, env = process.env, tools = []) {
  if (runtime === 'claude') {
    const args = [
      '--print', '--output-format', 'json', '--permission-mode', 'acceptEdits',
      '--allowedTools', claudeAllowedTools(tools),
    ];
    if (model) args.push('--model', model);
    return { command: 'claude', args };
  }
  if (runtime === 'codex') {
    const args = ['exec', '--json', '--sandbox', 'workspace-write', '--ignore-user-config'];
    if (model) args.push('--model', model);
    args.push('-');
    if (env.CITADEL_CODEX_JS) {
      return { command: process.execPath, args: [env.CITADEL_CODEX_JS, ...args] };
    }
    return { command: 'codex', args };
  }
  throw new TypeError(`unsupported runtime adapter: ${runtime}`);
}

function observedToolCalls(runtime, stdout) {
  if (runtime !== 'codex') return [];
  const tools = new Set();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    let event;
    try { event = JSON.parse(line); } catch (_error) { continue; }
    const item = event.item || event.msg?.item || null;
    const type = item?.type || event.type;
    if (type === 'command_execution') tools.add('shell');
    if (type === 'file_change') tools.add('filesystem');
    if (type === 'mcp_tool_call') tools.add('mcp');
  }
  return [...tools].sort();
}

function execute(input, runtime, options = {}) {
  if (!input || input.protocol !== 'citadel-operation-adapter-v1') throw new TypeError('invalid operation adapter input');
  const invocation = (options.resolve || platformInvocation)(
    invocationFor(runtime, input.plan.model, options.env || process.env, input.plan.tools),
    { env: options.env || process.env },
  );
  const result = (options.spawn || spawnSync)(invocation.command, invocation.args, {
    cwd: input.workspace_root,
    input: promptFor(input),
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: input.plan.expected_duration_ms ? Math.max(input.plan.expected_duration_ms * 2, 60000) : 1800000,
    maxBuffer: 16 * 1024 * 1024,
    env: options.env || process.env,
  });
  const observation = runtime === 'claude'
    ? claudeObservation(result.stdout || '', input.workspace_root, options.env || process.env)
    : codexObservation(result.stdout || '', input.workspace_root, options.env || process.env);
  const failure = result.error ? (result.error.code === 'ETIMEDOUT' ? 'TIMEOUT' : 'RUNTIME_LAUNCH_FAILED')
    : result.status === 0 ? null : 'RUNTIME_EXIT_NONZERO';
  return {
    schema: 1,
    status: failure === null ? 'completed' : 'failed',
    failure_code: failure,
    output: String(result.stdout || ''),
    observations: {
      model: observation?.model || null,
      topology: input.plan.topology,
      tools: input.plan.tools,
      tool_calls: observedToolCalls(runtime, result.stdout),
      usage: observation?.usage || {},
      costs: costsFor(runtime, observation),
    },
  };
}

function main(argv = process.argv.slice(2)) {
  const runtime = argv[0];
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { text += chunk; });
  process.stdin.on('end', () => {
    try { process.stdout.write(`${JSON.stringify(execute(JSON.parse(text), runtime))}\n`); }
    catch (error) {
      process.stdout.write(`${JSON.stringify({
        schema: 1,
        status: 'failed',
        failure_code: 'ADAPTER_INTERNAL_ERROR',
        output: '',
        observations: {
          model: null, topology: null, tools: [], tool_calls: [], usage: {},
          costs: costsFor(runtime, null),
        },
      })}\n`);
      process.stderr.write(`operation runtime adapter: ${error.message}\n`);
      process.exitCode = 1;
    }
  });
}

if (require.main === module) main();

module.exports = Object.freeze({ claudeAllowedTools, costsFor, execute, invocationFor, main, observedToolCalls, promptFor });
