#!/usr/bin/env bun
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function args(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unknown argument: ${token}`);
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`Missing value for --${key}`);
    parsed[key] = argv[++index];
  }
  return parsed;
}

function generateAttestationKey(privateFile, publicFile) {
  const privatePath = path.resolve(privateFile);
  const publicPath = path.resolve(publicFile);
  if (privatePath === publicPath) throw new Error('Private and public key paths must differ');
  if (fs.existsSync(privatePath) || fs.existsSync(publicPath)) {
    throw new Error('Refusing to overwrite an existing attestation key');
  }
  fs.mkdirSync(path.dirname(privatePath), { recursive: true });
  fs.mkdirSync(path.dirname(publicPath), { recursive: true });
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  fs.writeFileSync(privatePath, privatePem, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    fs.writeFileSync(publicPath, publicPem, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
  } catch (error) {
    fs.rmSync(privatePath, { force: true });
    throw error;
  }
  return { privatePath, publicPath };
}

function main() {
  const options = args(process.argv.slice(2));
  if (!options.private || !options.public) {
    throw new Error('Usage: optimizer-attestation-key.js --private <path> --public <path>');
  }
  const result = generateAttestationKey(options.private, options.public);
  process.stdout.write(`Generated Ed25519 attestation key; private=${result.privatePath}; public=${result.publicPath}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Attestation key generation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({ args, generateAttestationKey });
