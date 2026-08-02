#!/usr/bin/env bun
'use strict';

const assert = require('assert');
const {
  buildConformance,
  buildManifest,
  checkOutputs,
} = require('./application-evidence');

const manifest = buildManifest();
assert.strictEqual(manifest.claims.optimizer_history.cells, 120);
assert.strictEqual(manifest.claims.optimizer_history.false_passes, 0);
assert.strictEqual(manifest.claims.roma_operation_control.cells, 24);
assert.strictEqual(manifest.claims.roma_operation_control.performance_hypothesis, 'failed');
assert.strictEqual(manifest.claims.prospective_runtime.passed, 1);
assert.strictEqual(manifest.claims.prospective_local_economics.cells, 72);
assert.strictEqual(manifest.claims.prospective_local_economics.evidence_result, 'failed');
assert.strictEqual(manifest.claims.prospective_local_economics.gpu_energy_reduction, 0.098673);
assert.strictEqual(manifest.claims.capability_profile_followup.cells, 72);
assert.strictEqual(manifest.claims.capability_profile_followup.quality_ratio, 1);
assert.strictEqual(manifest.claims.capability_profile_followup.gpu_energy_reduction, -0.156751);
assert.strictEqual(manifest.claims.capability_profile_followup.escalations, 12);
assert.strictEqual(manifest.claims.representative_repository_pilot.cells, 24);
assert.strictEqual(manifest.claims.representative_repository_pilot.unique_tasks, 6);
assert.strictEqual(manifest.claims.representative_repository_pilot.profile_verified, 6);
assert.strictEqual(manifest.claims.representative_repository_pilot.baseline_verified, 6);
assert.strictEqual(manifest.claims.representative_repository_pilot.false_passes, 0);
assert.strictEqual(manifest.claims.representative_repository_pilot.gates.gpu_energy, false);
assert.strictEqual(manifest.claims.fresh_clone_onboarding.status, 'completed');
assert.strictEqual(manifest.claims.fresh_clone_onboarding.stages_completed, 5);

const conformance = buildConformance(manifest);
assert.strictEqual(conformance.adapters.filter((adapter) => adapter.evidence_level === 'prospective-actual-run').length, 3);
assert.strictEqual(conformance.adapters.find((adapter) => adapter.id === 'codex-direct').status, 'unknown');
assert.strictEqual(conformance.adapters.find((adapter) => adapter.id === 'claude-code-direct').status, 'passed');

checkOutputs();
process.stdout.write('application evidence and adapter conformance passed\n');
