#!/usr/bin/env bun

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const control = require('../core/control-plane');
const publicControl = require('../packages/contracts/control-plane');
const operations = require('../core/operations');
const { fixture, request, runConformance } = require('./control-plane-conformance');

const report = runConformance();
assert.equal(report.status, 'passed', JSON.stringify(
  report.checks.filter((check) => check.status !== 'passed'), null, 2,
));
assert.equal(report.failed_count, 0);
assert.ok(report.check_count >= 15);
assert.match(report.report_digest, /^sha256:[a-f0-9]{64}$/);

const keys = crypto.generateKeyPairSync('ed25519');
const proofKeys = crypto.generateKeyPairSync('ed25519');
const value = fixture('operation-contract', keys.privateKey);
const service = control.createControlPlaneService({
  now: () => '2026-07-30T12:00:01.000Z',
  installationId: 'contract-test',
  authorityTrustedKeys: new Map([['external-key', keys.publicKey]]),
  proofPrivateKey: proofKeys.privateKey,
  proofKeyId: 'proof-key',
  proofIssuerId: 'citadel-test',
});

const futureRequest = request('operations.submit', value.submission, {
  requestId: 'request-future',
  idempotencyKey: 'idem-future',
});
futureRequest.control_plane_api_version = 99;
assert.equal(service.handle(futureRequest).reason_code, 'REQUEST_INVALID');

const extraSubmission = { ...value.submission, metadata: {} };
assert.ok(control.validateSubmission(
  extraSubmission, control.validateProofPolicy, control.validateAuthorityEnvelope,
).some((error) => /fields/.test(error)));

const urlSubmission = {
  ...value.submission,
  operation_spec: { ...value.operation, title: 'Read https://private.example' },
};
const urlResult = service.handle(request('operations.submit', urlSubmission, {
  requestId: 'request-url',
  idempotencyKey: 'idem-url',
}));
assert.equal(urlResult.reason_code, 'REQUEST_INVALID');

const oversized = {
  ...value.submission,
  operation_spec: { ...value.operation, title: 'x'.repeat(70 * 1024) },
};
const oversizedResult = service.handle(request('operations.submit', oversized, {
  requestId: 'request-large',
  idempotencyKey: 'idem-large',
}));
assert.equal(oversizedResult.reason_code, 'REQUEST_INVALID');

const controlPlaneDir = path.join(__dirname, '..', 'core', 'control-plane');
for (const name of fs.readdirSync(controlPlaneDir).filter((file) => file.endsWith('.js'))) {
  const source = fs.readFileSync(path.join(controlPlaneDir, name), 'utf8');
  assert.doesNotMatch(source, /require\(['"]\.\.\/(?:forks|packs)\b/);
  assert.doesNotMatch(source, /require\(['"]\.\.\/operations\/graph-/);
  if (name !== 'file-adapter.js') {
    assert.doesNotMatch(source, /child_process|process\.env|fs\.(?:read|write|rm|unlink)/);
  }
}

assert.deepEqual(control.validateRequestEnvelope(request('handshake', {
  supported_control_plane_contract_versions: ['0.1'],
  supported_operations_protocol_versions: [operations.PROTOCOL_VERSION],
}, { requestId: 'request-validation' })), []);

const stateRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'citadel-control-plane-'));
const statePath = path.join(stateRoot, 'state', 'snapshot.json');
const durable = control.createFileControlPlaneAdapter({
  statePath,
  now: () => '2026-07-30T12:00:01.000Z',
  installationId: 'durable-test',
  authorityTrustedKeys: new Map([['external-key', keys.publicKey]]),
  proofPrivateKey: proofKeys.privateKey,
  proofKeyId: 'proof-key',
  proofIssuerId: 'citadel-test',
});
const durableSubmit = request('operations.submit', value.submission, {
  requestId: 'request-durable',
  idempotencyKey: 'idem-durable',
});
assert.equal(durable.handle(durableSubmit).outcome, 'accepted');
assert.ok(fs.existsSync(statePath));
const restarted = control.createFileControlPlaneAdapter({
  statePath,
  now: () => '2026-07-30T12:00:02.000Z',
  installationId: 'durable-test',
  authorityTrustedKeys: new Map([['external-key', keys.publicKey]]),
  proofPrivateKey: proofKeys.privateKey,
  proofKeyId: 'proof-key',
  proofIssuerId: 'citadel-test',
});
const beforeReplay = restarted.eventCount;
assert.equal(restarted.handle({ ...durableSubmit, request_id: 'request-durable-replay' }).outcome, 'accepted');
assert.equal(restarted.eventCount, beforeReplay);
const durableEvents = restarted.handle(request('events.replay', {
  after_cursor: null,
  limit: 500,
}, { requestId: 'request-durable-events' }));
assert.equal(durableEvents.outcome, 'accepted');
assert(durableEvents.result.events.length > 0);
assert(durableEvents.result.events.every((event, index) => event.data.sequence === index + 1));
assert.equal(
  restarted.handle(request('events.replay', {
    after_cursor: 'cursor-999',
    limit: 500,
  }, { requestId: 'request-durable-gap' })).reason_code,
  'REPLAY_CURSOR_AHEAD',
);

assert.equal(typeof publicControl.validateRequestEnvelope, 'function');
assert.equal(typeof publicControl.verifyProofBundle, 'function');
assert.equal(publicControl.createControlPlaneService, undefined);
assert.doesNotMatch(
  fs.readFileSync(path.join(__dirname, '..', 'packages', 'contracts', 'control-plane', 'index.js'), 'utf8'),
  /service|graph-|forks|packs/,
);

process.stdout.write(`control-plane tests passed (${report.check_count} conformance checks)\n`);
