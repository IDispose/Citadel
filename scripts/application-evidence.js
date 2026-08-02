#!/usr/bin/env bun
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { digest } = require('../core/operation-control/contracts');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_JSON = path.join(ROOT, 'docs', 'evidence-manifest.json');
const OUTPUT_MD = path.join(ROOT, 'docs', 'EVIDENCE_MANIFEST.md');
const CONFORMANCE_ROOT = path.join(ROOT, 'benchmarks', 'application-adapter-conformance');

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
}

function normalized(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n/g, '\n');
}

function artifact(relative, value = null) {
  const parsed = value || readJson(relative);
  return Object.freeze({ path: relative.replace(/\\/g, '/'), digest: digest(parsed) });
}

function textArtifact(relative) {
  return Object.freeze({ path: relative.replace(/\\/g, '/'), digest: digest(normalized(relative)) });
}

function buildManifest() {
  const optimizer = readJson('benchmarks/optimizer-proof/actual-report.json');
  const optimizerV2 = readJson('benchmarks/operation-control-v2/REPORT.json');
  const roma = readJson('benchmarks/roma-operation-control/published-run/bundle.json');
  const prospective = readJson('benchmarks/operation-control-v2/prospective/RESULTS.json');
  const readiness = readJson('benchmarks/sentient-readiness/published-run/bundle.json');
  const readinessSensitivity = readJson('benchmarks/sentient-readiness/SENSITIVITY.json');
  const readinessClosure = readJson('benchmarks/sentient-readiness/DEPENDENCY_CLOSURE.json');
  const capabilityProfile = readJson('benchmarks/sentient-readiness-v2/published-run/bundle.json');
  const capabilityClosure = readJson('benchmarks/sentient-readiness-v2/DEPENDENCY_CLOSURE.json');
  const measurementAudit = readJson('benchmarks/local-measurement-audit/REPORT.json');
  const representative = readJson('benchmarks/representative-operation-pilot-v2/published-run/bundle.json');
  const onboarding = readJson('benchmarks/fresh-clone-onboarding/REPORT.json');
  const romaPolicies = Object.fromEntries(roma.summary.policies.map((entry) => [entry.policy_id, entry]));
  const readinessPolicies = Object.fromEntries(readiness.summary.policies.map((entry) => [entry.policy_id, entry]));
  const capabilityPolicies = Object.fromEntries(capabilityProfile.summary.policies.map((entry) => [entry.policy_id, entry]));
  const representativePolicies = Object.fromEntries(representative.summary.policies.map((entry) => [entry.policy_id, entry]));
  const manifest = {
    schema: 1,
    kind: 'citadel-public-evidence-manifest',
    as_of: representative.completed_at,
    claim_policy: 'Every value in this manifest is generated from a canonical committed artifact. Public prose is separately contract-tested. Unknown is never converted to zero.',
    claims: {
      optimizer_history: {
        evidence_class: 'retrospective-actual-run',
        cells: optimizerV2.source.cells,
        real_model_attempts: optimizerV2.source.model_attempts,
        verified: optimizerV2.source.verified_completions,
        failed: optimizerV2.source.failed,
        unknown: optimizerV2.source.unknown,
        false_passes: optimizerV2.source.adversarial_false_passes,
        performance_gate: optimizer.preliminary_performance_gate.status,
        adaptive_holdout_verified: optimizer.held_out.adaptive.verified_completions,
        adaptive_holdout_total: optimizer.held_out.adaptive.runs,
        actual_cash_status: 'unknown',
      },
      roma_operation_control: {
        evidence_class: 'prospective-stack-diagnostic',
        cells: roma.artifacts.length,
        evidence_result: roma.summary.evidence_result,
        performance_hypothesis: roma.summary.performance_hypothesis,
        false_passes: roma.summary.false_passes,
        citadel_verified: romaPolicies['citadel-whole-operation'].independently_verified_completions,
        citadel_total: romaPolicies['citadel-whole-operation'].cells,
        local_baseline_verified: romaPolicies['always-open-local'].independently_verified_completions,
        local_baseline_total: romaPolicies['always-open-local'].cells,
        actual_cash_status: 'unknown',
      },
      prospective_runtime: {
        evidence_class: prospective.evidence_class,
        attempts: Object.keys(prospective.cells).length,
        passed: Object.values(prospective.cells).filter((cell) => cell.status === 'passed').length,
        failed: Object.values(prospective.cells).filter((cell) => cell.status === 'failed').length,
        successful_runtime: 'claude-code',
        successful_model: prospective.cells.claude_public_clone.observed_model,
        actual_cash_status: prospective.cells.claude_public_clone.actual_cash.status,
        market_equivalent_usd: prospective.cells.claude_public_clone.market_equivalent.amount_usd,
      },
      prospective_local_economics: {
        evidence_class: 'prospective-local-economic-comparison',
        cells: readiness.artifacts.length,
        evidence_result: readiness.summary.evidence_result,
        baseline_verified: readinessPolicies['always-strong-local'].verified,
        baseline_total: readinessPolicies['always-strong-local'].cells,
        baseline_failed: readinessPolicies['always-strong-local'].failed,
        baseline_unknown: readinessPolicies['always-strong-local'].unknown,
        adaptive_verified: readinessPolicies['citadel-adaptive-local'].verified,
        adaptive_total: readinessPolicies['citadel-adaptive-local'].cells,
        adaptive_failed: readinessPolicies['citadel-adaptive-local'].failed,
        adaptive_unknown: readinessPolicies['citadel-adaptive-local'].unknown,
        quality_ratio: readiness.summary.comparison.quality_ratio,
        gpu_energy_reduction: readiness.summary.comparison.gpu_energy_reduction,
        modeled_cost_reduction: readiness.summary.comparison.modeled_cost_reduction,
        request_wall_duration_reduction: readiness.summary.comparison.duration_reduction,
        false_passes: readiness.summary.false_passes,
        integrity_failures: readiness.summary.integrity_failures,
        gates: readiness.summary.gates,
        sensitivity: {
          omitted_pair: readinessSensitivity.omitted_pair,
          gpu_energy_reduction: readinessSensitivity.sensitivity.gpu_energy_reduction,
          modeled_gpu_cost_reduction: readinessSensitivity.sensitivity.modeled_gpu_cost_reduction,
          request_wall_duration_reduction: readinessSensitivity.sensitivity.request_wall_duration_reduction,
          conclusion: readinessSensitivity.conclusion,
        },
        dependency_closure: {
          signed_execution_commit: readinessClosure.signed_execution_commit,
          original_source_files: readinessClosure.original_source_files,
          closed_source_files: readinessClosure.closed_source_files,
          supplementary: true,
        },
        actual_cash_status: readiness.summary.actual_end_to_end_cash_status,
      },
      capability_profile_followup: {
        evidence_class: 'prospective-local-capability-profile-comparison',
        cells: capabilityProfile.artifacts.length,
        evidence_result: capabilityProfile.summary.evidence_result,
        baseline_verified: capabilityPolicies['always-strong-local'].verified,
        baseline_total: capabilityPolicies['always-strong-local'].cells,
        profile_verified: capabilityPolicies['citadel-capability-profile-local'].verified,
        profile_total: capabilityPolicies['citadel-capability-profile-local'].cells,
        profile_failed: capabilityPolicies['citadel-capability-profile-local'].failed,
        profile_unknown: capabilityPolicies['citadel-capability-profile-local'].unknown,
        baseline_failed: capabilityPolicies['always-strong-local'].failed,
        baseline_unknown: capabilityPolicies['always-strong-local'].unknown,
        escalations: capabilityPolicies['citadel-capability-profile-local'].escalations,
        quality_ratio: capabilityProfile.summary.comparison.quality_ratio,
        gpu_energy_reduction: capabilityProfile.summary.comparison.gpu_energy_reduction,
        modeled_cost_reduction: capabilityProfile.summary.comparison.modeled_cost_reduction,
        request_wall_duration_reduction: capabilityProfile.summary.comparison.duration_reduction,
        false_passes: capabilityProfile.summary.false_passes,
        integrity_failures: capabilityProfile.summary.integrity_failures,
        gates: capabilityProfile.summary.gates,
        dependency_closure: {
          signed_execution_commit: capabilityClosure.signed_execution_commit,
          original_source_files: capabilityClosure.original_source_files,
          closed_source_files: capabilityClosure.closed_source_files,
          supplementary: true,
        },
        actual_cash_status: capabilityProfile.summary.actual_end_to_end_cash_status,
      },
      representative_repository_pilot: {
        evidence_class: 'prospective-representative-repository-operation-shakedown',
        cells: representative.artifacts.length,
        unique_tasks: representative.summary.policies[0].unique_tasks,
        timing_repetitions: 2,
        evidence_result: representative.summary.evidence_result,
        baseline_verified: representativePolicies['always-strong-local'].verified,
        baseline_total: representativePolicies['always-strong-local'].cells,
        profile_verified: representativePolicies['citadel-risk-profile-local'].verified,
        profile_total: representativePolicies['citadel-risk-profile-local'].cells,
        escalations: representativePolicies['citadel-risk-profile-local'].escalations,
        gpu_energy_reduction: representative.summary.comparison.gpu_energy_reduction,
        modeled_cost_reduction: representative.summary.comparison.modeled_gpu_cost_reduction,
        token_reduction: representative.summary.comparison.token_reduction,
        path_violations: representative.summary.path_violations,
        false_passes: representative.summary.false_passes,
        integrity_failures: representative.summary.integrity_failures,
        gates: representative.summary.gates,
        actual_cash_status: representative.summary.actual_end_to_end_cash_status,
      },
      fresh_clone_onboarding: {
        evidence_class: 'unattended-clean-clone-engineering-proof',
        status: onboarding.status,
        stages_completed: onboarding.steps.filter((step) => step.status === 'passed').length,
        steps_total: onboarding.steps.length,
        doctor_health: onboarding.steps.find((step) => step.id === 'doctor-command-executed').doctor_health,
        total_duration_ms: onboarding.total_duration_ms,
        source_commit: onboarding.source_commit,
        model_execution: onboarding.model_execution,
      },
    },
    boundaries: [
      'The 120-cell optimizer result is retrospective and its performance gate remained open because cost coverage was incomplete.',
      'The 24-cell ROMA result proves control and evidence integration; its efficiency hypothesis failed.',
      'The Claude prospective cell proves one real runtime integration, not savings or broad reliability.',
      'V1 recorded 27/36 versus 24/36 verified cells, but its apparent GPU savings reverse when one same-route timeout pair is excluded; it does not support a savings claim.',
      'The separately frozen 72-cell capability-profile follow-up matched baseline cell completion, but verification-driven escalations increased measured GPU energy and modeled GPU cost.',
      'The capability-profile v2 corrigendum discloses v1-informed design, task-template overlap, and deterministic repetition semantics without changing the frozen negative result.',
      'The 24-cell representative repository-operation shakedown matched 6/12 verified cells under both policies with zero false passes and zero path violations. Its 7.1% measured GPU-energy reduction missed the frozen 20% gate, so the evidence result is failed and no general savings claim is permitted.',
      'The representative shakedown contains six unique fixture tasks repeated twice per policy; timing repetitions are not independent tasks and the small fixture set is not production generalization.',
      'The fresh-clone proof completed five command stages; doctor semantic health remained unknown, and no real-user utility or model-task completion is claimed.',
      'Actual end-to-end cash remains unknown wherever subscription allocation or whole-system energy is unmeasured.',
      'GPU energy arithmetic reconstructs from retained average watts and request wall duration across both local studies; raw 500 ms power samples were not retained.',
    ],
    artifacts: [
      artifact('benchmarks/optimizer-proof/actual-report.json', optimizer),
      artifact('benchmarks/roma-operation-control/published-run/bundle.json', roma),
      artifact('benchmarks/operation-control-v2/prospective/RESULTS.json', prospective),
      artifact('benchmarks/sentient-readiness/published-run/bundle.json', readiness),
      artifact('benchmarks/sentient-readiness/SENSITIVITY.json', readinessSensitivity),
      artifact('benchmarks/sentient-readiness/DEPENDENCY_CLOSURE.json', readinessClosure),
      artifact('benchmarks/sentient-readiness-v2/published-run/bundle.json', capabilityProfile),
      artifact('benchmarks/sentient-readiness-v2/DEPENDENCY_CLOSURE.json', capabilityClosure),
      textArtifact('benchmarks/sentient-readiness-v2/CORRIGENDUM.md'),
      artifact('benchmarks/local-measurement-audit/REPORT.json', measurementAudit),
      artifact('benchmarks/representative-operation-pilot-v2/published-run/bundle.json', representative),
      artifact('benchmarks/fresh-clone-onboarding/REPORT.json', onboarding),
    ],
  };
  manifest.manifest_digest = digest({ ...manifest, manifest_digest: null });
  return manifest;
}

function renderManifest(manifest) {
  const o = manifest.claims.optimizer_history;
  const r = manifest.claims.roma_operation_control;
  const p = manifest.claims.prospective_runtime;
  const l = manifest.claims.prospective_local_economics;
  const c = manifest.claims.capability_profile_followup;
  const x = manifest.claims.representative_repository_pilot;
  const f = manifest.claims.fresh_clone_onboarding;
  return `# Citadel public evidence manifest

Generated from committed canonical artifacts. As of ${manifest.as_of}.

| Evidence | Result | Boundary |
|---|---|---|
| Optimizer history | ${o.cells} signed cells; ${o.real_model_attempts} real attempts; ${o.verified} verified; ${o.false_passes} false passes | Performance gate ${o.performance_gate}; retrospective |
| ROMA operation control | ${r.cells} cells; Citadel ${r.citadel_verified}/${r.citadel_total}; direct local ${r.local_baseline_verified}/${r.local_baseline_total} | Evidence ${r.evidence_result}; performance ${r.performance_hypothesis} |
| Prospective runtime | ${p.passed}/${p.attempts} passed; ${p.successful_runtime}/${p.successful_model} | Integration only; actual cash ${p.actual_cash_status} |
| Prospective local v1 | adaptive ${l.adaptive_verified}/${l.adaptive_total} verified, ${l.adaptive_failed} failed, ${l.adaptive_unknown} unknown; baseline ${l.baseline_verified}/${l.baseline_total} verified, ${l.baseline_failed} failed, ${l.baseline_unknown} unknown | Frozen gate ${l.evidence_result}; timeout sensitivity ${(l.sensitivity.gpu_energy_reduction * 100).toFixed(1)}% GPU energy; identity gate ${l.gates.execution_identity} |
| Capability-profile follow-up | profile ${c.profile_verified}/${c.profile_total} verified, ${c.profile_failed} failed, ${c.profile_unknown} unknown; baseline ${c.baseline_verified}/${c.baseline_total} | Matched baseline cell completion; ${Math.abs(c.gpu_energy_reduction * 100).toFixed(1)}% more GPU energy; gate ${c.evidence_result} |
| Representative repository pilot | profile ${x.profile_verified}/${x.profile_total} verified; baseline ${x.baseline_verified}/${x.baseline_total}; ${x.unique_tasks} unique fixture tasks | ${(x.gpu_energy_reduction * 100).toFixed(1)}% less measured GPU energy missed the 20% gate; evidence ${x.evidence_result} |
| Fresh-clone onboarding | ${f.stages_completed}/${f.steps_total} command stages in ${(f.total_duration_ms / 1000).toFixed(2)}s | Doctor health ${f.doctor_health}; model execution ${f.model_execution} |

## Claim boundaries

${manifest.boundaries.map((boundary) => `- ${boundary}`).join('\n')}

Manifest: \`${manifest.manifest_digest}\`
`;
}

function buildConformance(manifest = buildManifest()) {
  const roma = manifest.claims.roma_operation_control;
  const prospective = manifest.claims.prospective_runtime;
  const local = manifest.claims.prospective_local_economics;
  return {
    schema: 1,
    kind: 'citadel-application-adapter-conformance',
    as_of: manifest.as_of,
    contract: {
      required: ['requested_identity', 'observed_identity', 'outcome_verification', 'failure_preservation', 'cost_lenses'],
      rule: 'A runtime is actual-run conformant only when committed evidence exercises it. Contract-only tests are reported separately.',
    },
    adapters: [
      {
        id: 'claude-code-direct',
        runtime_family: 'frontier-coding-agent',
        evidence_level: 'prospective-actual-run',
        status: prospective.passed === 1 ? 'passed' : 'failed',
        requested_identity: 'claude-opus-5',
        observed_identity: prospective.successful_model,
        outcome_verification: 'independent repository verifier plus exact changed-path coverage',
        cost_lenses: { actual_cash: 'unknown', market_equivalent: 'known' },
      },
      {
        id: 'ollama-chat-local',
        runtime_family: 'open-local-model-runtime',
        evidence_level: 'prospective-actual-run',
        status: local.cells === 72 && local.integrity_failures === 0 ? 'passed-with-observed-runtime-failure' : 'failed',
        requested_identity: 'exact Qwen2.5-Coder manifest digests',
        observed_identity: '75 attempts total; 74 identity-observed attempts and one timeout before model identity was observed',
        outcome_verification: 'exact canonical answer digest',
        cost_lenses: { provider_invoice: 'known-zero', gpu_energy: 'measured', actual_end_to_end_cash: 'unknown' },
      },
      {
        id: 'roma-dspy-recursive-stack',
        runtime_family: 'open-recursive-agent-stack',
        evidence_level: 'prospective-actual-run',
        status: roma.evidence_result,
        requested_identity: 'pinned ROMA commit plus per-module Ollama manifests',
        observed_identity: 'configured modules and provider-call history reconciled',
        outcome_verification: 'exact canonical answer digest outside ROMA',
        cost_lenses: { provider_invoice: 'known-zero-local', actual_end_to_end_cash: 'unknown' },
      },
      {
        id: 'codex-direct',
        runtime_family: 'frontier-coding-agent',
        evidence_level: 'contract-and-launch-failure',
        status: 'unknown',
        requested_identity: 'explicit Codex model binding',
        observed_identity: 'not observed in the published Windows launch failure',
        outcome_verification: 'not reached',
        cost_lenses: { actual_cash: 'unknown', market_equivalent: 'unknown' },
      },
    ],
  };
}

function renderConformance(report) {
  const rows = report.adapters.map((adapter) => `| ${adapter.id} | ${adapter.runtime_family} | ${adapter.evidence_level} | ${adapter.status} | ${adapter.outcome_verification} |`).join('\n');
  return `# Citadel adapter conformance evidence

This report separates actual-run portability from contract-only support.

| Adapter | Family | Evidence | Status | Independent outcome gate |
|---|---|---|---|---|
${rows}

Codex remains an honest unknown at the prospective actual-run layer: its public
Windows attempt failed before model work. It is not counted as a successful
runtime merely because its adapter contract and fixtures pass.
`;
}

function expectedOutputs() {
  const manifest = buildManifest();
  const conformance = buildConformance(manifest);
  return {
    manifest,
    manifestMarkdown: renderManifest(manifest),
    conformance,
    conformanceMarkdown: renderConformance(conformance),
  };
}

function writeOutputs() {
  const output = expectedOutputs();
  fs.mkdirSync(CONFORMANCE_ROOT, { recursive: true });
  fs.writeFileSync(OUTPUT_JSON, `${JSON.stringify(output.manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(OUTPUT_MD, output.manifestMarkdown, 'utf8');
  fs.writeFileSync(path.join(CONFORMANCE_ROOT, 'REPORT.json'), `${JSON.stringify(output.conformance, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(CONFORMANCE_ROOT, 'REPORT.md'), output.conformanceMarkdown, 'utf8');
  return output;
}

function checkOutputs() {
  const expected = expectedOutputs();
  assert.deepStrictEqual(readJson('docs/evidence-manifest.json'), expected.manifest);
  assert.strictEqual(normalized('docs/EVIDENCE_MANIFEST.md'), expected.manifestMarkdown.replace(/\r\n/g, '\n'));
  assert.deepStrictEqual(readJson('benchmarks/application-adapter-conformance/REPORT.json'), expected.conformance);
  assert.strictEqual(normalized('benchmarks/application-adapter-conformance/REPORT.md'), expected.conformanceMarkdown.replace(/\r\n/g, '\n'));
  return expected;
}

function main() {
  const command = process.argv[2] || 'check';
  const result = command === 'build' ? writeOutputs() : command === 'check' ? checkOutputs() : null;
  if (!result) throw new Error(`unknown application evidence command: ${command}`);
  process.stdout.write(`application evidence ${command} passed: ${result.manifest.manifest_digest}\n`);
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    process.stderr.write(`application evidence failed: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({ buildConformance, buildManifest, checkOutputs, expectedOutputs, renderConformance, renderManifest, writeOutputs });
