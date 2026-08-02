#!/usr/bin/env bun

'use strict';

const fs = require('fs');
const path = require('path');
const { digest, verifyReport } = require('../core/operation-controller');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'benchmarks', 'operation-control-v2', 'prospective');
const FROZEN_AT = '2026-07-31T00:00:00.000Z';
const PINNED_REF = '4a02265c206d992b556fc1b38c3c9487ced880d8';
const SOURCE_FILES = Object.freeze([
  'METHOD.md',
  'CLAUDE_METHOD.md',
  'scenario.json',
  'claude-scenario.json',
  'report.json',
  'history.jsonl',
  'claude-report.json',
  'claude-history.jsonl',
  'claude-attempt-3-report.json',
  'claude-attempt-3-history.jsonl',
  'claude-attempt-3.patch',
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function read(relative) {
  return fs.readFileSync(path.join(TARGET, relative), 'utf8').replace(/\r\n/g, '\n');
}

function readJson(relative) {
  return JSON.parse(read(relative));
}

function verifyHistory(relative, expectedStatus, report) {
  const lines = read(relative).trim().split('\n').filter(Boolean);
  invariant(lines.length === 1, `${relative} must contain exactly one history record`);
  const record = JSON.parse(lines[0]);
  invariant(record.verification_status === expectedStatus, `${relative} status is stale`);
  invariant(record.plan_id === report.attempts[0].plan_id, `${relative} plan does not match its report`);
  invariant(record.duration_ms === report.attempts[0].duration_ms, `${relative} duration does not match its report`);
  invariant(digest(record.costs) === digest(report.attempts[0].costs), `${relative} costs do not match its report`);
}

function privacyCheck(relative, contents) {
  const forbidden = [
    { pattern: /[A-Za-z]:\\(?:Users|Documents and Settings)\\/i, label: 'local Windows user path' },
    { pattern: /\/(?:home|Users)\/[^/\s]+/i, label: 'local Unix user path' },
    { pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, label: 'email address' },
    { pattern: /(?:sk-|ghp_|github_pat_|AKIA)[A-Za-z0-9_-]{12,}/, label: 'credential-like token' },
  ];
  for (const rule of forbidden) {
    invariant(!rule.pattern.test(contents), `${relative} contains a ${rule.label}`);
  }
}

function build() {
  for (const relative of SOURCE_FILES) {
    const file = path.join(TARGET, relative);
    invariant(fs.existsSync(file), `Missing prospective artifact: ${relative}`);
    privacyCheck(relative, read(relative));
  }

  const scenario = readJson('scenario.json');
  const claudeScenario = readJson('claude-scenario.json');
  invariant(scenario.pinned_ref === PINNED_REF, 'Codex scenario revision changed');
  invariant(claudeScenario.pinned_ref === PINNED_REF, 'Claude scenario revision changed');
  invariant(digest(scenario.required_changed_paths) === digest(['scripts/test-executor-profiles.js']), 'Required artifact changed');

  const reports = {
    codex_windowsapps: readJson('report.json'),
    claude_sandbox: readJson('claude-report.json'),
    claude_public_clone: readJson('claude-attempt-3-report.json'),
  };
  for (const [cell, report] of Object.entries(reports)) {
    const verification = verifyReport(report);
    invariant(verification.status === 'verified', `${cell} report failed offline verification: ${verification.reason_code}`);
  }

  const codex = reports.codex_windowsapps;
  const sandbox = reports.claude_sandbox;
  const passed = reports.claude_public_clone;
  invariant(codex.status === 'failed' && codex.terminal_reason_code === 'RUNTIME_LAUNCH_FAILED', 'Codex infrastructure failure changed');
  invariant(codex.attempts[0].observed_model === null, 'Codex failure must not claim model observation');
  invariant(sandbox.status === 'failed' && sandbox.attempts[0].completion_status === 'failed', 'Claude sandbox failure changed');
  invariant(sandbox.attempts[0].observed_model === null, 'Claude sandbox failure must not claim model observation');
  invariant(passed.status === 'passed' && passed.terminal_reason_code === 'VERIFIED_SUCCESS', 'Prospective pass is missing');
  invariant(passed.attempts.length === 1, 'Prospective pass must remain a single direct attempt');

  const attempt = passed.attempts[0];
  invariant(attempt.requested_model === 'claude-opus-5' && attempt.observed_model === 'claude-opus-5', 'Requested/observed model proof changed');
  invariant(attempt.requested_topology === 'direct' && attempt.observed_topology === 'direct', 'Requested/observed topology proof changed');
  invariant(attempt.control_status === 'passed' && attempt.completion_status === 'passed', 'Control or outcome verification changed');
  invariant(attempt.evidence.kind === 'command' && attempt.evidence.exit_code === 0, 'Independent verifier proof changed');
  invariant(attempt.evidence.artifact_coverage === 'passed', 'Required artifact coverage changed');
  invariant(attempt.evidence.required_paths_digest === attempt.evidence.changed_paths_digest, 'Changed paths no longer exactly match the required artifact set');
  invariant(attempt.costs.actual_cash.status === 'unknown' && attempt.costs.actual_cash.amount_usd === null, 'Unknown actual cash was rewritten');
  invariant(attempt.costs.marginal.status === 'unknown' && attempt.costs.marginal.amount_usd === null, 'Unknown marginal cash was rewritten');
  invariant(attempt.costs.market_equivalent.status === 'known' && attempt.costs.market_equivalent.amount_usd === 0.7042557, 'Market-equivalent telemetry changed');

  verifyHistory('history.jsonl', 'failed', codex);
  verifyHistory('claude-history.jsonl', 'failed', sandbox);
  verifyHistory('claude-attempt-3-history.jsonl', 'passed', passed);

  const patch = read('claude-attempt-3.patch');
  invariant(patch.startsWith('diff --git a/scripts/test-executor-profiles.js b/scripts/test-executor-profiles.js'), 'Published patch has an unexpected target');
  invariant(!/^diff --git /m.test(patch.slice(patch.indexOf('\n') + 1)), 'Published patch contains more than one changed file');
  invariant(patch.includes('MODEL_OBSERVATION_MISSING'), 'Published patch does not contain the frozen regression');

  const summary = {
    schema: 1,
    kind: 'citadel_operation_control_v2_prospective_result',
    evidence_class: 'prospective-real-runtime-integration',
    source: {
      repository: scenario.repository,
      pinned_ref: PINNED_REF,
      required_changed_paths: scenario.required_changed_paths,
    },
    cells: {
      codex_windowsapps: {
        status: codex.status,
        reason_code: codex.terminal_reason_code,
        duration_ms: codex.attempts[0].duration_ms,
        observed_model: codex.attempts[0].observed_model,
        report_digest: codex.report_digest,
      },
      claude_sandbox: {
        status: sandbox.status,
        reason_code: sandbox.terminal_reason_code,
        diagnostic_classification: 'provider-connection-refused-observed-outside-public-report',
        duration_ms: sandbox.attempts[0].duration_ms,
        observed_model: sandbox.attempts[0].observed_model,
        report_digest: sandbox.report_digest,
      },
      claude_public_clone: {
        status: passed.status,
        terminal_reason_code: passed.terminal_reason_code,
        duration_ms: attempt.duration_ms,
        requested_model: attempt.requested_model,
        observed_model: attempt.observed_model,
        requested_topology: attempt.requested_topology,
        observed_topology: attempt.observed_topology,
        verifier_exit_code: attempt.evidence.exit_code,
        verifier_duration_ms: attempt.evidence.duration_ms,
        artifact_coverage: attempt.evidence.artifact_coverage,
        actual_cash: attempt.costs.actual_cash,
        marginal: attempt.costs.marginal,
        market_equivalent: attempt.costs.market_equivalent,
        report_digest: passed.report_digest,
      },
    },
    claims: {
      demonstrated: [
        'The packaged controller invoked a real declared coding runtime against a pinned public repository.',
        'Requested and observed model and topology matched on the successful cell.',
        'A separate repository command verified the changed required artifact before the operation passed.',
        'Failed infrastructure attempts remained published failures and did not acquire model or outcome proof.',
        'Unknown actual and marginal cash remained unknown while attributable market-equivalent telemetry stayed separate.',
      ],
      not_demonstrated: [
        'One successful integration cell does not establish savings, performance superiority, or general reliability.',
        'Aggregate Claude output did not expose individual tool-call identity, so this cell proves the bounded runtime configuration but not call-by-call tool provenance.',
        'The original comparative performance gate remains open.',
      ],
    },
  };
  return { reports, summary: { ...summary, evidence_digest: digest(summary) } };
}

function markdown(summary) {
  const pass = summary.cells.claude_public_clone;
  return `# Operation Control v2 prospective result\n\nA preregistered real-runtime integration cell passed against public Citadel commit \`${summary.source.pinned_ref}\`. The controller invoked Claude Code, reconciled the exact requested model and direct topology, required a real change to the declared test file, and accepted the outcome only after an independent repository verifier passed.\n\n## Published attempts\n\n| Cell | Result | What the report establishes |\n|---|---|---|\n| Codex via WindowsApps executable | Failed | Launch failed in ${summary.cells.codex_windowsapps.duration_ms} ms; no model or work was observed. |\n| Claude in the restricted sandbox | Failed | Runtime exited nonzero after ${summary.cells.claude_sandbox.duration_ms} ms; no model or verified work was observed. A separate diagnostic saw provider \`ConnectionRefused\`; raw provider output is intentionally not published or treated as report proof. |\n| Claude against a fresh public-only clone | Passed | Exact model/topology match, required artifact changed, and independent verifier exited zero. |\n\nInfrastructure failures were retained rather than discarded or relabeled.\n\n## Successful cell\n\n- Runtime/model: Claude Code / \`${pass.observed_model}\`\n- Topology: \`${pass.observed_topology}\`\n- Model work duration: ${pass.duration_ms} ms\n- Independent verifier: exit ${pass.verifier_exit_code} in ${pass.verifier_duration_ms} ms\n- Artifact coverage: ${pass.artifact_coverage}; the changed-path digest exactly equals the required-path digest\n- Actual cash: unknown\n- Marginal cash: unknown\n- Market-equivalent telemetry: $${pass.market_equivalent.amount_usd.toFixed(6)}\n- Offline report verification: passed\n- Report digest: \`${pass.report_digest}\`\n\nThe published patch changes only \`scripts/test-executor-profiles.js\` and adds a regression proving that missing model telemetry remains unknown even when other telemetry and a receipt are trusted.\n\n## Claim boundary\n\nThis proves end-to-end integration and honest control/evidence handling on one preregistered real task. It does not prove savings, comparative performance, or broad reliability. Aggregate Claude output did not expose individual tool-call identity, so call-by-call tool provenance is also not claimed. The comparative performance gate remains open.\n\nRun \`npm run operation:prospective\` to verify every report digest, history binding, gate, published patch, freeze, and privacy rule offline.\n`;
}

function freezeFor(result) {
  const rendered = markdown(result.summary);
  const unsigned = {
    schema: 1,
    kind: 'citadel_operation_control_v2_prospective_freeze',
    frozen_at: FROZEN_AT,
    repository: result.summary.source.repository,
    pinned_ref: PINNED_REF,
    source_digests: Object.fromEntries(SOURCE_FILES.map((relative) => [relative, digest(read(relative))])),
    report_digests: Object.fromEntries(Object.entries(result.reports).map(([cell, report]) => [cell, report.report_digest])),
    artifact_digests: {
      'RESULTS.json': digest(result.summary),
      'RESULTS.md': digest(rendered),
    },
    evidence_boundary: 'prospective integration only; comparative performance, savings, and broad reliability remain open',
  };
  return { ...unsigned, freeze_digest: digest(unsigned) };
}

function main(argv = process.argv.slice(2)) {
  const write = argv.includes('--write');
  const result = build();
  const rendered = markdown(result.summary);
  const freeze = freezeFor(result);
  if (write) {
    fs.writeFileSync(path.join(TARGET, 'RESULTS.json'), `${JSON.stringify(result.summary, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(TARGET, 'RESULTS.md'), rendered, 'utf8');
    fs.writeFileSync(path.join(TARGET, 'freeze.json'), `${JSON.stringify(freeze, null, 2)}\n`, 'utf8');
  } else {
    invariant(JSON.stringify(readJson('RESULTS.json')) === JSON.stringify(result.summary), 'RESULTS.json is stale; run npm run operation:prospective -- --write');
    invariant(read('RESULTS.md') === rendered, 'RESULTS.md is stale; run npm run operation:prospective -- --write');
    invariant(JSON.stringify(readJson('freeze.json')) === JSON.stringify(freeze), 'freeze.json is stale; run npm run operation:prospective -- --write');
  }
  process.stdout.write(`${JSON.stringify({
    status: 'verified',
    cells: 3,
    passed: 1,
    failed: 2,
    evidence_digest: result.summary.evidence_digest,
    freeze_digest: freeze.freeze_digest,
    mode: write ? 'written' : 'checked',
  }, null, 2)}\n`);
}

if (require.main === module) main();

module.exports = Object.freeze({ build, freezeFor, main, markdown, privacyCheck });
