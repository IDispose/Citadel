#!/usr/bin/env bun

'use strict';

const fs = require('fs');
const path = require('path');
const governance = require('../core/governance');

const INPUT_FIELDS = Object.freeze([
  'input_version',
  'policy',
  'observations',
  'failures',
  'subject',
  'subject_digest',
  'subject_generation',
  'started_at',
  'requested_disposition',
]);
const FAILURE_FIELDS = Object.freeze([
  'failure_kind',
  'observation_id',
  'attempt_id',
  'producer',
  'producer_contract_digest',
  'observed_at',
  'expires_at',
]);

function output(value) {
  process.stdout.write(`${governance.canonicalSerialize(value)}\n`);
}

function fail(code, message) {
  output({
    status: 'unknown',
    error_code: code,
    message,
  });
  process.exitCode = 1;
}

function exact(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...fields].sort());
}

function parseFlags(args) {
  const flags = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error(`invalid flag sequence at ${name || '<end>'}`);
    }
    const key = name.slice(2);
    if (Object.hasOwn(flags, key)) throw new Error(`duplicate flag --${key}`);
    flags[key] = value;
  }
  return flags;
}

function requireFlags(flags, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  for (const name of required) {
    if (!flags[name]) throw new Error(`missing --${name}`);
  }
  for (const name of Object.keys(flags)) {
    if (!allowed.has(name)) throw new Error(`unknown flag --${name}`);
  }
}

function readInput(filePath) {
  let text;
  try {
    text = fs.readFileSync(path.resolve(filePath), 'utf8');
  } catch (error) {
    const failure = new Error(`cannot read input: ${error.message}`);
    failure.code = 'INPUT_UNREADABLE';
    throw failure;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    const failure = new Error(`input is not valid JSON: ${error.message}`);
    failure.code = 'INPUT_UNPARSEABLE';
    throw failure;
  }
}

function failureObservation(failure, envelope) {
  if (!exact(failure, FAILURE_FIELDS)) {
    const error = new Error('failure fields do not match exact input contract');
    error.code = 'INPUT_INVALID';
    throw error;
  }
  return governance.createFailureObservation({
    failureKind: failure.failure_kind,
    observationId: failure.observation_id,
    attemptId: failure.attempt_id,
    producer: failure.producer,
    producerContractDigest: failure.producer_contract_digest,
    subject: envelope.subject,
    subjectDigest: envelope.subject_digest,
    subjectGeneration: envelope.subject_generation,
    observedAt: failure.observed_at,
    expiresAt: failure.expires_at,
  });
}

function evaluate(flags) {
  requireFlags(flags, ['project-root', 'input'], ['at']);
  const envelope = readInput(flags.input);
  if (!exact(envelope, INPUT_FIELDS) || envelope.input_version !== 1
    || !Array.isArray(envelope.observations) || !Array.isArray(envelope.failures)) {
    const error = new Error('evaluate input does not match exact version 1 contract');
    error.code = 'INPUT_INVALID';
    throw error;
  }
  const observations = [
    ...envelope.observations,
    ...envelope.failures.map((failure) => failureObservation(failure, envelope)),
  ];
  const result = governance.evaluateAndRecord({
    projectRoot: flags['project-root'],
    policy: envelope.policy,
    observations,
    subject: envelope.subject,
    subjectDigest: envelope.subject_digest,
    subjectGeneration: envelope.subject_generation,
    startedAt: envelope.started_at,
    decidedAt: flags.at || new Date().toISOString(),
    requestedDisposition: envelope.requested_disposition,
  });
  output({
    status: result.decision.truth_status,
    decision: result.decision,
    receipt: result.receipt,
  });
  if (result.decision.truth_status !== 'passed'
    || result.decision.disposition !== envelope.requested_disposition) {
    process.exitCode = 1;
  }
}

function authorize(flags) {
  requireFlags(flags, [
    'project-root',
    'subject-kind',
    'subject-id',
    'subject-digest',
    'subject-generation',
    'disposition',
  ]);
  const result = governance.authorizeDecision(
    flags['project-root'],
    {
      kind: flags['subject-kind'],
      id: flags['subject-id'],
      digest: flags['subject-digest'],
      generation: Number(flags['subject-generation']),
    },
    flags.disposition,
  );
  output(result);
  if (!result.authorized) process.exitCode = 1;
}

function check(flags) {
  requireFlags(flags, ['project-root']);
  const result = governance.checkGovernanceStore(flags['project-root']);
  output(result);
  if (result.status !== 'passed') process.exitCode = 1;
}

function main(argv) {
  const [command, ...rest] = argv;
  if (!['evaluate', 'authorize', 'check'].includes(command)) {
    fail('INVALID_REQUEST', 'usage: governance-gate.js <evaluate|authorize|check> [flags]');
    return;
  }
  try {
    const flags = parseFlags(rest);
    if (command === 'evaluate') evaluate(flags);
    if (command === 'authorize') authorize(flags);
    if (command === 'check') check(flags);
  } catch (error) {
    fail(error.code || 'INPUT_INVALID', error.message);
  }
}

main(process.argv.slice(2));
