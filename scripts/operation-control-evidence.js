#!/usr/bin/env bun

'use strict';

const fs = require('fs');
const path = require('path');
const { canonical: optimizerCanonical, digest: optimizerDigest } = require('../core/optimizer/contracts');
const { verifyRunAttestation } = require('../core/optimizer/report');
const { COST_LENSES, digest, routeOperation } = require('../core/operation-controller');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'benchmarks', 'optimizer-proof');
const TARGET = path.join(ROOT, 'benchmarks', 'operation-control-v2');
const POLICY_IDS = Object.freeze(['always-frontier', 'always-cheap', 'prompt-only', 'adaptive']);

function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function unknown(source) { return { status: 'unknown', amount_usd: null, basis: 'observed', source }; }

function importedCosts(run) {
  const market = run.cost.status === 'known'
    ? { status: 'known', amount_usd: run.cost.amount_usd, basis: 'list-price', source: run.cost.source_ref }
    : { status: 'unknown', amount_usd: null, basis: 'list-price', source: run.cost.source_ref || 'source record unknown' };
  return {
    actual_cash: unknown('source run does not attribute subscription or invoice cash'),
    marginal: unknown('source run does not establish per-operation marginal cash'),
    market_equivalent: market,
  };
}

function loadSource() {
  const freeze = read(path.join(SOURCE, 'freeze.json'));
  const sourceReport = read(path.join(SOURCE, 'actual-report.json'));
  const recordsDirectory = path.join(SOURCE, 'actual-runs', 'records');
  const records = fs.readdirSync(recordsDirectory)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => read(path.join(recordsDirectory, file)));
  const scenarioDirectory = path.join(SOURCE, 'scenarios');
  const scenarios = fs.readdirSync(scenarioDirectory)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => read(path.join(scenarioDirectory, file)));
  return { freeze, sourceReport, records, scenarios };
}

function importHistory(records) {
  return records.map((run) => ({
    schema: 1,
    feature_key: run.category,
    plan_id: run.policy_id,
    verification_status: run.verified ? 'passed' : run.outcome === 'failed' ? 'failed' : 'unknown',
    duration_ms: run.duration_ms,
    costs: importedCosts(run),
    observed_tools: [],
  }));
}

function catalogFrom(records) {
  const plans = POLICY_IDS.map((policyId) => {
    const policyRecords = records.filter((record) => record.policy_id === policyId);
    const knownMarket = policyRecords.filter((record) => record.cost.status === 'known').map((record) => record.cost.amount_usd);
    const marketMedian = median(knownMarket);
    return {
      plan_id: policyId,
      label: `Historical ${policyId} policy`,
      adapter_id: 'retrospective-only',
      topology: policyId === 'adaptive' ? 'custom' : 'direct',
      model: null,
      tools: [],
      privacy: 'allow-remote',
      feature_keys: [],
      prior: { success_probability: 0.5, strength: 2, source: 'neutral-pre-history-prior' },
      expected_duration_ms: median(policyRecords.map((record) => record.duration_ms)),
      costs: {
        actual_cash: unknown('not attributable in source evidence'),
        marginal: unknown('not attributable in source evidence'),
        market_equivalent: marketMedian === null
          ? { status: 'unknown', amount_usd: null, basis: 'list-price', source: 'no known source cells' }
          : { status: 'known', amount_usd: marketMedian, basis: 'list-price', source: `median of ${knownMarket.length} source cells` },
      },
      retry_on: [],
      max_retries: 0,
      fallback_plan_ids: [],
    };
  });
  return {
    schema: 1,
    catalog_id: 'optimizer-proof-retrospective',
    adapters: {
      'retrospective-only': {
        protocol: 'citadel-operation-adapter-v1',
        executable: 'node',
        args: [],
        timeout_ms: 1000,
        environment_allowlist: [],
      },
    },
    plans,
  };
}

function requestFor(category) {
  return {
    schema: 2,
    operation_id: `retrospective-${category.replace(/_/g, '-')}`,
    objective: `Retrospectively compare declared policy candidates for ${category} using only verified historical outcomes.`,
    feature_key: category,
    quality_target: 0.3,
    constraints: {
      privacy: 'allow-remote',
      allowed_tools: [],
      required_tools: [],
      max_duration_ms: 3600000,
      budgets: Object.fromEntries(COST_LENSES.map((lens) => [lens, null])),
      unknown_cost_policy: 'allow',
    },
    verifier: { kind: 'adapter-result' },
  };
}

function buildEvidence() {
  const source = loadSource();
  if (source.records.length !== 120) throw new Error(`Expected 120 source cells, found ${source.records.length}`);
  const reportOrder = [...source.records].sort((left, right) => optimizerCanonical([
    left.scenario_id, left.policy_id, left.repetition,
  ]).localeCompare(optimizerCanonical([right.scenario_id, right.policy_id, right.repetition])));
  const rawDigestVerified = optimizerDigest(reportOrder) === source.sourceReport.generated_from_raw_digest;
  const attestationsVerified = source.records.every((record) => verifyRunAttestation(record, source.freeze.attestation_public_key));
  if (!rawDigestVerified || !attestationsVerified) throw new Error('Source optimizer proof integrity verification failed');
  const history = importHistory(source.records);
  const catalog = catalogFrom(source.records);
  const categories = [...new Set(source.records.map((record) => record.category))].sort();
  const decisions = Object.fromEntries(categories.map((category) => {
    const decision = routeOperation({ request: requestFor(category), catalog, history });
    return [category, {
      selection_status: decision.selection_status,
      selected_plan_id: decision.selected.root_plan_id,
      conservative_verified_success_probability: decision.selected.verified_success_probability,
      expected_market_equivalent_usd: decision.selected.expected_costs.market_equivalent,
      expected_duration_ms: decision.selected.expected_duration_ms,
      decision_digest: decision.decision_digest,
    }];
  }));
  const repositories = [...new Map(source.scenarios.map((scenario) => [scenario.repository, {
    repository: scenario.repository,
    pinned_refs: [],
  }])).values()];
  for (const repository of repositories) {
    repository.pinned_refs = [...new Set(source.scenarios.filter((scenario) => scenario.repository === repository.repository).map((scenario) => scenario.pinned_ref))].sort();
  }
  const baselinePolicies = Object.fromEntries(POLICY_IDS.map((policyId) => [policyId, source.sourceReport.policies[policyId]]));
  const unsigned = {
    schema: 1,
    kind: 'citadel_operation_control_v2_retrospective_evidence',
    evidence_class: 'retrospective-actual-run-calibration',
    source: {
      report_id: source.sourceReport.report_id,
      raw_digest: source.sourceReport.generated_from_raw_digest,
      raw_digest_verified: rawDigestVerified,
      attestations_verified: attestationsVerified,
      frozen_inputs: source.sourceReport.frozen_inputs,
      matrix_authorization_verified: source.sourceReport.matrix_quota_authorization_verified,
      cells: source.records.length,
      model_attempts: source.records.reduce((sum, record) => sum + record.attempts, 0) - source.records.filter((record) => record.observed_model === null).length,
      verified_completions: source.records.filter((record) => record.verified).length,
      failed: source.records.filter((record) => record.outcome === 'failed').length,
      unknown: source.records.filter((record) => record.outcome === 'unknown').length,
      adversarial_false_passes: source.sourceReport.engineering_gate.adversarial_false_passes,
      repositories,
      scenarios: source.scenarios.length,
      holdout_scenarios: source.scenarios.filter((scenario) => scenario.holdout).length,
    },
    imported_history: {
      schema: 1,
      records: history.length,
      digest: digest(history),
      cost_semantics: {
        actual_cash: 'unknown',
        marginal: 'unknown',
        market_equivalent: 'preserved from known list-price-normalized source cells',
      },
    },
    baselines: baselinePolicies,
    retrospective_decisions: decisions,
    claims: {
      demonstrated: [
        'The v2 controller ingests verified outcomes from pinned real-repository tasks.',
        'Failure and unknown outcomes remain distinct during calibration.',
        'Three economic lenses remain separate; unknown cash and marginal cost never become zero.',
        'Every retrospective decision is reproducible from a digest-bound history and catalog.',
      ],
      not_demonstrated: [
        'Retrospective selection is not a prospective or causal savings result.',
        'The source matrix did not observe tool-call identity, so this import cannot calibrate tool effectiveness.',
        'The source performance gate remained open and v2 does not relabel it as passed.',
      ],
    },
  };
  return { history, catalog, report: { ...unsigned, evidence_digest: digest(unsigned) } };
}

function markdown(report) {
  const rows = Object.entries(report.retrospective_decisions)
    .map(([category, decision]) => `| ${category} | ${decision.selected_plan_id} | ${decision.selection_status} | ${(decision.conservative_verified_success_probability * 100).toFixed(1)}% |`)
    .join('\n');
  return `# Operation Control v2 real-workload evidence\n\nThis report imports the frozen, signed 120-cell optimizer run into the v2 outcome model. The source tasks changed and verified pinned versions of Citadel, nanoid, and p-limit. It is retrospective calibration evidence, not a prospective savings claim.\n\n## Integrity\n\n- Source cells: ${report.source.cells}\n- Real model attempts: ${report.source.model_attempts}\n- Verified completions: ${report.source.verified_completions}\n- Failed: ${report.source.failed}\n- Unknown: ${report.source.unknown}\n- Source attestation verification: ${report.source.attestations_verified ? 'passed' : 'failed'}\n- Raw source digest verification: ${report.source.raw_digest_verified ? 'passed' : 'failed'}\n- Adversarial false passes: ${report.source.adversarial_false_passes}\n\n## Retrospective controller decisions\n\n| Workload category | Selected starting policy | Target status | Conservative verified-success estimate |\n|---|---|---|---|\n${rows}\n\nThese decisions show that the controller can learn from outcome evidence while preserving unknowns and separate economic lenses. They do not show that the selected policy would have saved money prospectively. The original performance gate remains open.\n\nRun \`npm run operation:evidence\` to reproduce and verify this report.\n`;
}

function freezeFor(evidence) {
  const reportMarkdown = markdown(evidence.report);
  const sourceFiles = [
    'core/operation-controller/contracts.js',
    'core/operation-controller/controller.js',
    'scripts/operation-control-evidence.js',
  ];
  const unsigned = {
    schema: 1,
    kind: 'citadel_operation_control_v2_evidence_freeze',
    frozen_at: '2026-07-31T00:00:00.000Z',
    source_optimizer_report_id: evidence.report.source.report_id,
    source_run_set_digest: evidence.report.source.raw_digest,
    controller_source_digests: Object.fromEntries(sourceFiles.map((relative) => [
      relative, digest(fs.readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n/g, '\n')),
    ])),
    artifact_digests: {
      'history.json': digest(evidence.history),
      'catalog.json': digest(evidence.catalog),
      'REPORT.json': digest(evidence.report),
      'REPORT.md': digest(reportMarkdown),
    },
    evidence_boundary: 'retrospective calibration only; prospective performance gate remains open',
  };
  return { ...unsigned, freeze_digest: digest(unsigned) };
}

function main(argv = process.argv.slice(2)) {
  const write = argv.includes('--write');
  const evidence = buildEvidence();
  const freeze = freezeFor(evidence);
  if (write) {
    fs.mkdirSync(TARGET, { recursive: true });
    fs.writeFileSync(path.join(TARGET, 'history.json'), `${JSON.stringify(evidence.history, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(TARGET, 'catalog.json'), `${JSON.stringify(evidence.catalog, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(TARGET, 'REPORT.json'), `${JSON.stringify(evidence.report, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(TARGET, 'REPORT.md'), markdown(evidence.report), 'utf8');
    fs.writeFileSync(path.join(TARGET, 'freeze.json'), `${JSON.stringify(freeze, null, 2)}\n`, 'utf8');
  } else {
    for (const [file, expected] of [
      ['history.json', evidence.history], ['catalog.json', evidence.catalog], ['REPORT.json', evidence.report],
    ]) {
      const actual = read(path.join(TARGET, file));
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${file} is stale; run npm run operation:evidence -- --write`);
    }
    if (fs.readFileSync(path.join(TARGET, 'REPORT.md'), 'utf8') !== markdown(evidence.report)) throw new Error('REPORT.md is stale; run npm run operation:evidence -- --write');
    if (JSON.stringify(read(path.join(TARGET, 'freeze.json'))) !== JSON.stringify(freeze)) throw new Error('freeze.json is stale; run npm run operation:evidence -- --write');
  }
  process.stdout.write(`${JSON.stringify({
    status: 'verified',
    cells: evidence.report.source.cells,
    model_attempts: evidence.report.source.model_attempts,
    repositories: evidence.report.source.repositories.length,
    evidence_digest: evidence.report.evidence_digest,
    freeze_digest: freeze.freeze_digest,
    mode: write ? 'written' : 'checked',
  }, null, 2)}\n`);
}

if (require.main === module) main();

module.exports = Object.freeze({ buildEvidence, catalogFrom, freezeFor, importHistory, main, markdown, requestFor });
