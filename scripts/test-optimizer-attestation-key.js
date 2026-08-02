#!/usr/bin/env bun
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { generateAttestationKey } = require('./optimizer-attestation-key');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-optimizer-key-test-'));
try {
  const privateFile = path.join(root, 'private', 'attestation.pem');
  const publicFile = path.join(root, 'public', 'attestation.pem');
  generateAttestationKey(privateFile, publicFile);
  const privateKey = crypto.createPrivateKey(fs.readFileSync(privateFile, 'utf8'));
  const publicKey = crypto.createPublicKey(fs.readFileSync(publicFile, 'utf8'));
  assert.strictEqual(privateKey.asymmetricKeyType, 'ed25519');
  assert.strictEqual(publicKey.asymmetricKeyType, 'ed25519');
  assert.strictEqual(
    crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).trim(),
    publicKey.export({ type: 'spki', format: 'pem' }).trim(),
  );
  assert.throws(
    () => generateAttestationKey(privateFile, path.join(root, 'other-public.pem')),
    /Refusing to overwrite/,
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

process.stdout.write('Optimizer attestation key generation tests passed.\n');
