#!/usr/bin/env bun

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  fixture,
  intentCommand,
  request,
} = require('./control-plane-conformance');

const SCRIPT = path.join(__dirname, 'control-plane-stdio.js');

function writeRestricted(filePath, content) {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
}

function invoke(argumentsList, input = '') {
  return spawnSync(process.execPath, [SCRIPT, ...argumentsList], {
    cwd: path.dirname(__dirname),
    encoding: 'utf8',
    input,
    timeout: 15_000,
    windowsHide: true,
  });
}

function ndjson(values) {
  return `${values.map((value) => JSON.stringify(value)).join('\n')}\n`;
}

function responseLines(output) {
  return output.trim().length === 0
    ? []
    : output.trim().split(/\r?\n/).map((line) => JSON.parse(line));
}

function run() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-control-plane-stdio-'));
  try {
    const authority = crypto.generateKeyPairSync('ed25519');
    const proof = crypto.generateKeyPairSync('ed25519');
    const authorityPublicPem = authority.publicKey.export({ type: 'spki', format: 'pem' });
    const proofPrivatePem = proof.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const trustPath = path.join(temporaryRoot, 'authority-keys.json');
    const proofPath = path.join(temporaryRoot, 'proof-private.pem');
    const statePath = path.join(temporaryRoot, 'state', 'governance-port.json');
    writeRestricted(trustPath, `${JSON.stringify({
      control_plane_trust_version: 1,
      kind: 'authority_public_key_map',
      keys: [{
        key_id: 'external-key',
        algorithm: 'ed25519',
        public_key_pem: authorityPublicPem,
      }],
    })}\n`);
    writeRestricted(proofPath, proofPrivatePem);

    const argumentsList = [
      '--state', statePath,
      '--authority-keys', trustPath,
      '--proof-private-key', proofPath,
      '--proof-key-id', 'citadel-proof',
      '--proof-issuer-id', 'citadel-local',
      '--installation-id', 'stdio-installation',
    ];
    const current = Date.now();
    const mainFixture = fixture(
      'stdio-operation',
      authority.privateKey,
      'external-key',
      {
        issuedAt: new Date(current - 86_400_000).toISOString(),
        expiresAt: new Date(current + 365 * 86_400_000).toISOString(),
      },
    );
    const handshake = request('handshake', {
      supported_control_plane_contract_versions: ['0.1'],
      supported_operations_protocol_versions: ['0.1'],
    }, { requestId: 'request-stdio-handshake' });
    const submit = request('operations.submit', mainFixture.submission, {
      requestId: 'request-stdio-submit',
      idempotencyKey: 'idem-stdio-submit',
    });
    const start = request(
      'intents.submit',
      intentCommand(
        mainFixture,
        'start',
        'intent-stdio-start',
        authority.privateKey,
      ),
      {
        requestId: 'request-stdio-start',
        idempotencyKey: 'idem-stdio-start',
        expectedRevision: 0,
      },
    );

    const first = invoke(argumentsList, ndjson([handshake, submit, start]));
    assert.strictEqual(first.error, undefined, first.error?.message);
    assert.strictEqual(first.signal, null);
    assert.strictEqual(first.status, 0, first.stderr);
    assert.strictEqual(first.stderr, '');
    const firstResponses = responseLines(first.stdout);
    assert.strictEqual(firstResponses.length, 3);
    assert.strictEqual(firstResponses[0].reason_code, 'HANDSHAKE_NEGOTIATED');
    assert.deepStrictEqual(
      firstResponses[0].result.trusted_authority_key_ids,
      ['external-key'],
    );
    assert.strictEqual(firstResponses[1].reason_code, 'OPERATION_REGISTERED');
    assert.strictEqual(firstResponses[2].reason_code, 'INTENT_CONSUMED');
    assert.strictEqual(firstResponses[2].result.run_status, 'running');
    assert.ok(fs.existsSync(statePath), 'accepted commands must persist state');

    const replayRequest = request('events.replay', {
      after_cursor: null,
      limit: 50,
    }, { requestId: 'request-stdio-replay' });
    const restarted = invoke(argumentsList, ndjson([replayRequest]));
    assert.strictEqual(restarted.status, 0, restarted.stderr);
    assert.strictEqual(restarted.stderr, '');
    const replay = responseLines(restarted.stdout);
    assert.strictEqual(replay.length, 1);
    assert.strictEqual(replay[0].reason_code, 'EVENTS_REPLAYED');
    assert.strictEqual(replay[0].result.events.length, 3);
    assert.strictEqual(replay[0].result.next_cursor, 'cursor-3');
    assert.deepStrictEqual(
      replay[0].result.events.map((event) => event.type),
      [
        'dev.citadel.control.run.changed.v1alpha1',
        'dev.citadel.control.intent.accepted.v1alpha1',
        'dev.citadel.control.run.changed.v1alpha1',
      ],
    );

    const persisted = fs.readFileSync(statePath, 'utf8');
    const observedOutput = `${first.stdout}${first.stderr}${restarted.stdout}${restarted.stderr}${persisted}`;
    assert.ok(!observedOutput.includes(proofPrivatePem.trim()));
    assert.ok(!observedOutput.includes(authorityPublicPem.trim()));
    assert.ok(!observedOutput.includes('BEGIN PRIVATE KEY'));
    assert.ok(!observedOutput.includes('BEGIN PUBLIC KEY'));

    const malformed = invoke(argumentsList, '{not-json}\n');
    assert.strictEqual(malformed.status, 0, malformed.stderr);
    assert.deepStrictEqual(responseLines(malformed.stdout), [{
      transport_version: 1,
      kind: 'control_plane_transport_error',
      request_id: 'request-invalid',
      error_code: 'MALFORMED_JSON',
      recoverable: true,
    }]);

    const missingArguments = invoke([]);
    const missingArgumentsAgain = invoke([]);
    assert.strictEqual(missingArguments.status, 64);
    assert.strictEqual(missingArguments.stdout, '');
    assert.strictEqual(missingArguments.stderr, missingArgumentsAgain.stderr);
    assert.deepStrictEqual(responseLines(missingArguments.stderr), [{
      transport_version: 1,
      kind: 'control_plane_transport_error',
      request_id: 'request-invalid',
      error_code: 'CONFIG_INVALID',
      recoverable: false,
    }]);

    const missingTrustArguments = [...argumentsList];
    missingTrustArguments[3] = path.join(temporaryRoot, 'missing-trust.json');
    const missingTrust = invoke(missingTrustArguments);
    assert.strictEqual(missingTrust.status, 65);
    assert.strictEqual(missingTrust.stdout, '');
    assert.strictEqual(
      responseLines(missingTrust.stderr)[0].error_code,
      'TRUST_CONFIG_UNREADABLE',
    );
    assert.ok(!missingTrust.stderr.includes(missingTrustArguments[3]));

    const invalidProofPath = path.join(temporaryRoot, 'invalid-proof.pem');
    const proofSecretMarker = 'DO-NOT-LEAK-PROOF-CONTENT';
    writeRestricted(invalidProofPath, proofSecretMarker);
    const invalidProofArguments = [...argumentsList];
    invalidProofArguments[5] = invalidProofPath;
    const invalidProof = invoke(invalidProofArguments);
    assert.strictEqual(invalidProof.status, 65);
    assert.strictEqual(
      responseLines(invalidProof.stderr)[0].error_code,
      'PROOF_KEY_INVALID',
    );
    assert.ok(!invalidProof.stderr.includes(proofSecretMarker));
    assert.ok(!invalidProof.stderr.includes(invalidProofPath));

    const corruptStatePath = path.join(temporaryRoot, 'corrupt-state.json');
    writeRestricted(corruptStatePath, '{"operations":"not-a-snapshot"}\n');
    const corruptStateArguments = [...argumentsList];
    corruptStateArguments[1] = corruptStatePath;
    const corruptState = invoke(corruptStateArguments);
    assert.strictEqual(corruptState.status, 70);
    assert.strictEqual(corruptState.stdout, '');
    assert.strictEqual(
      responseLines(corruptState.stderr)[0].error_code,
      'STATE_INVALID',
    );
    assert.ok(!corruptState.stderr.includes(corruptStatePath));

    process.stdout.write('control-plane stdio tests passed (spawn, restart, replay, fail-closed config)\n');
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (require.main === module) run();

module.exports = Object.freeze({ run });
