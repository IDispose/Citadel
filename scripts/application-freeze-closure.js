#!/usr/bin/env bun
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STUDIES = Object.freeze([
  'benchmarks/sentient-readiness',
  'benchmarks/sentient-readiness-v2',
]);

function sha256(buffer) {
  return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}

function canonical(relative) {
  return relative.split(path.sep).join('/');
}

const gitFileCache = new Map();

function gitFile(commit, relative, optional = false) {
  const key = `${commit}:${relative}`;
  if (gitFileCache.has(key)) return gitFileCache.get(key);
  try {
    const value = childProcess.execFileSync('git', ['show', key], { cwd: ROOT, encoding: null, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    gitFileCache.set(key, value);
    return value;
  } catch (error) {
    if (optional) return null;
    throw new Error(`could not read ${key}: ${error.message}`);
  }
}

function resolveDependency(commit, fromRelative, request) {
  if (!request.startsWith('.')) return null;
  const base = canonical(path.normalize(path.join(path.dirname(fromRelative), request)));
  if (base.startsWith('../')) throw new Error(`dependency escaped repository: ${request}`);
  const candidates = [base, `${base}.js`, `${base}.json`, `${base}/index.js`];
  const resolved = candidates.find((candidate) => gitFile(commit, candidate, true));
  if (!resolved) throw new Error(`could not resolve ${request} from ${fromRelative} at ${commit}`);
  return resolved;
}

function dependencies(commit, relative) {
  if (!relative.endsWith('.js')) return [];
  const source = gitFile(commit, relative).toString('utf8');
  const requests = [];
  const pattern = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) requests.push(match[1]);
  return requests.map((request) => resolveDependency(commit, relative, request)).filter(Boolean);
}

function buildStudy(study) {
  const bundle = JSON.parse(fs.readFileSync(path.join(ROOT, study, 'published-run', 'bundle.json'), 'utf8'));
  const executionCommit = bundle.environment.git_commit;
  const freeze = JSON.parse(gitFile(executionCommit, `${study}/freeze.json`).toString('utf8'));
  const queue = Object.keys(freeze.source_digests);
  const files = new Set();
  while (queue.length) {
    const relative = canonical(queue.shift());
    if (files.has(relative)) continue;
    files.add(relative);
    for (const dependency of dependencies(executionCommit, relative)) queue.push(dependency);
  }
  const sourceClosure = Object.fromEntries([...files].sort().map((relative) => [
    relative,
    sha256(gitFile(executionCommit, relative)),
  ]));
  const missingFromFreeze = Object.keys(sourceClosure).filter((relative) => !(relative in freeze.source_digests));
  const report = {
    schema: 1,
    kind: 'citadel-supplementary-freeze-dependency-closure',
    study,
    freeze_id: freeze.freeze_id,
    signed_execution_commit: executionCommit,
    original_source_files: Object.keys(freeze.source_digests).length,
    closed_source_files: Object.keys(sourceClosure).length,
    missing_from_original_freeze: missingFromFreeze,
    source_closure: sourceClosure,
    boundary: 'Supplement created after execution from git objects at the signed execution commit. It documents transitive dependency closure but does not retroactively alter the preregistered freeze.',
  };
  return { ...report, closure_digest: sha256(Buffer.from(JSON.stringify(report))) };
}

function outputPath(study) {
  return path.join(ROOT, study, 'DEPENDENCY_CLOSURE.json');
}

function write() {
  const reports = STUDIES.map((study) => buildStudy(study));
  reports.forEach((report) => fs.writeFileSync(outputPath(report.study), `${JSON.stringify(report, null, 2)}\n`, 'utf8'));
  return reports;
}

function verify() {
  const expected = STUDIES.map((study) => buildStudy(study));
  expected.forEach((report) => {
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(outputPath(report.study), 'utf8')), report);
    assert(report.missing_from_original_freeze.length > 0, `${report.study} unexpectedly has no documented closure gap`);
  });
  return expected;
}

const command = process.argv[2] || 'verify';
const reports = command === 'build' ? write() : command === 'verify' ? verify() : null;
if (!reports) throw new Error(`unknown freeze closure command: ${command}`);
process.stdout.write(`freeze dependency closure ${command} passed: ${reports.map((report) => report.closure_digest).join(', ')}\n`);

module.exports = Object.freeze({ buildStudy, verify });
