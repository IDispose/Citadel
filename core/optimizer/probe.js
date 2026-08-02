'use strict';

const fs = require('fs');
const path = require('path');
const { validateProbe, validateScenario } = require('./contracts');

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'coverage',
  '.next',
  '.cache',
]);
const LANGUAGE_BY_EXTENSION = Object.freeze({
  '.c': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cs': 'csharp',
  '.css': 'css',
  '.go': 'go',
  '.h': 'c',
  '.hpp': 'cpp',
  '.html': 'html',
  '.java': 'java',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.kt': 'kotlin',
  '.md': 'markdown',
  '.php': 'php',
  '.py': 'python',
  '.rb': 'ruby',
  '.rs': 'rust',
  '.sh': 'shell',
  '.sql': 'sql',
  '.swift': 'swift',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.vue': 'vue',
});
const MANIFEST_NAMES = new Set([
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'Gemfile',
  'composer.json',
]);
const CROSS_CUTTING = /\b(across|parallel|lifecycle|rollback|recovery|resume|catalog|runtime parity|cross[- ]cutting|multiple|end[- ]to[- ]end)\b/i;
const RECOVERY = /\b(recover|recovery|resume|rollback|interrupted|context reset|crash|handoff)\b/i;
const PARALLEL = /\b(parallel|concurrent|fan[- ]out|several independent|multiple independent)\b/i;
const SAFETY = /\b(safety|security|protected|permission|traversal|symlink|secret|adversarial|tamper|untrusted)\b/i;
const HIGH_COMPLEXITY = /\b(diagnose|trace|reconcile|architecture|lifecycle|cross[- ]hook|end[- ]to[- ]end|hardening)\b/i;

function safeRealRoot(root) {
  const resolved = fs.realpathSync(path.resolve(root));
  if (!fs.statSync(resolved).isDirectory() || fs.lstatSync(resolved).isSymbolicLink()) {
    throw new Error('Probe root must be a real directory');
  }
  return resolved;
}

function relativeContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : null;
}

function taskTokens(task) {
  return [...new Set(task.toLowerCase().match(/[a-z0-9_-]{4,}/g) || [])]
    .filter((token) => !['that', 'with', 'without', 'from', 'into', 'then', 'must', 'across'].includes(token))
    .slice(0, 32);
}

function packageTestCommands(file, remainingBytes) {
  if (path.basename(file) !== 'package.json' || remainingBytes <= 0) return [];
  try {
    const text = fs.readFileSync(file, 'utf8').slice(0, remainingBytes);
    const parsed = JSON.parse(text);
    const scripts = parsed && parsed.scripts && typeof parsed.scripts === 'object' ? parsed.scripts : {};
    return Object.keys(scripts)
      .filter((name) => /^(test|check|lint|verify)(:|$)/.test(name))
      .map((name) => `bun run ${name}`)
      .slice(0, 20);
  } catch {
    return [];
  }
}

function classifySignals(scenario, facts, budgetExhausted) {
  const task = scenario.task;
  const candidateCount = facts.candidate_files.length;
  const scope = candidateCount > 3 || CROSS_CUTTING.test(task)
    ? 'cross_cutting'
    : candidateCount > 0 ? 'localized' : 'unknown';
  let complexity = 'medium';
  if (HIGH_COMPLEXITY.test(task)
    || scope === 'cross_cutting'
    || (facts.file_count_scanned > 500 && scope !== 'localized')) complexity = 'high';
  else if (scope === 'localized' && task.length < 180) complexity = 'low';
  else if (scope === 'unknown' && budgetExhausted) complexity = 'unknown';
  const verificationStrength = facts.has_tests && facts.test_commands.length > 0
    ? 'strong'
    : facts.has_tests || facts.test_commands.length > 0 ? 'weak' : 'unknown';
  let uncertainty = 0;
  if (budgetExhausted) uncertainty += 0.35;
  if (scope === 'unknown') uncertainty += 0.30;
  if (verificationStrength === 'unknown') uncertainty += 0.20;
  if (facts.languages.length === 0) uncertainty += 0.15;
  return {
    scope,
    complexity,
    verification_strength: verificationStrength,
    recovery_required: RECOVERY.test(task),
    parallelizable: PARALLEL.test(task),
    safety_sensitive: SAFETY.test(task),
    uncertainty: Number(Math.min(1, uncertainty).toFixed(6)),
  };
}

function probeWorkspace(root, scenario, options = {}) {
  validateScenario(scenario);
  const observedAt = options.observedAt || new Date().toISOString();
  const start = Date.now();
  const budget = scenario.probe_budget;
  let realRoot;
  try {
    realRoot = safeRealRoot(root);
  } catch {
    return validateProbe({
      schema: 1,
      scenario_id: scenario.id,
      status: 'unknown',
      observed_at: observedAt,
      budget_exhausted: false,
      facts: {
        file_count_scanned: 0,
        bytes_scanned: 0,
        languages: [],
        package_manifests: [],
        test_commands: [],
        candidate_files: [],
        has_ci: false,
        has_tests: false,
      },
      signals: {
        scope: 'unknown',
        complexity: 'unknown',
        verification_strength: 'unknown',
        recovery_required: RECOVERY.test(scenario.task),
        parallelizable: PARALLEL.test(scenario.task),
        safety_sensitive: SAFETY.test(scenario.task),
        uncertainty: 1,
      },
    });
  }
  const queue = [realRoot];
  const languages = new Set();
  const manifests = [];
  const tests = [];
  const testCommands = [];
  const candidates = [];
  const tokens = taskTokens(scenario.task);
  let files = 0;
  let bytes = 0;
  let hasCi = false;
  let budgetExhausted = false;

  while (queue.length > 0) {
    if (files >= budget.max_files || bytes >= budget.max_bytes || Date.now() - start >= budget.max_duration_ms) {
      budgetExhausted = true;
      break;
    }
    const directory = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files >= budget.max_files || bytes >= budget.max_bytes || Date.now() - start >= budget.max_duration_ms) {
        budgetExhausted = true;
        break;
      }
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      const relative = relativeContained(realRoot, absolute);
      if (!relative) continue;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) queue.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      let size;
      try {
        size = fs.statSync(absolute).size;
      } catch {
        continue;
      }
      files += 1;
      bytes += Math.min(size, Math.max(0, budget.max_bytes - bytes));
      const extension = path.extname(entry.name).toLowerCase();
      if (LANGUAGE_BY_EXTENSION[extension]) languages.add(LANGUAGE_BY_EXTENSION[extension]);
      if (MANIFEST_NAMES.has(entry.name)) {
        manifests.push(relative.replace(/\\/g, '/'));
        const remaining = Math.max(0, budget.max_bytes - bytes);
        testCommands.push(...packageTestCommands(absolute, remaining));
      }
      const normalized = relative.replace(/\\/g, '/');
      if (/(^|\/)(test|tests|__tests__|spec)(\/|$)|(?:\.test|\.spec)\.[^.]+$/i.test(normalized)) tests.push(normalized);
      if (/^\.github\/workflows\//.test(normalized)) hasCi = true;
      const lower = normalized.toLowerCase();
      if (tokens.some((token) => lower.includes(token))) candidates.push(normalized);
    }
  }
  const facts = {
    file_count_scanned: files,
    bytes_scanned: bytes,
    languages: [...languages].sort(),
    package_manifests: [...new Set(manifests)].sort().slice(0, 50),
    test_commands: [...new Set(testCommands)].sort().slice(0, 50),
    candidate_files: [...new Set(candidates)].sort().slice(0, 50),
    has_ci: hasCi,
    has_tests: tests.length > 0,
  };
  const signals = classifySignals(scenario, facts, budgetExhausted);
  return validateProbe({
    schema: 1,
    scenario_id: scenario.id,
    status: budgetExhausted ? 'partial' : 'complete',
    observed_at: observedAt,
    budget_exhausted: budgetExhausted,
    facts,
    signals,
  });
}

function fixtureProbe(scenario, facts, options = {}) {
  validateScenario(scenario);
  const normalizedFacts = {
    file_count_scanned: facts.file_count_scanned,
    bytes_scanned: facts.bytes_scanned,
    languages: [...facts.languages],
    package_manifests: [...facts.package_manifests],
    test_commands: [...facts.test_commands],
    candidate_files: [...facts.candidate_files],
    has_ci: facts.has_ci,
    has_tests: facts.has_tests,
  };
  const exhausted = options.budgetExhausted === true;
  return validateProbe({
    schema: 1,
    scenario_id: scenario.id,
    status: exhausted ? 'partial' : 'complete',
    observed_at: options.observedAt || '2026-01-01T00:00:00.000Z',
    budget_exhausted: exhausted,
    facts: normalizedFacts,
    signals: classifySignals(scenario, normalizedFacts, exhausted),
  });
}

module.exports = Object.freeze({
  IGNORED_DIRECTORIES,
  classifySignals,
  fixtureProbe,
  probeWorkspace,
  taskTokens,
});
