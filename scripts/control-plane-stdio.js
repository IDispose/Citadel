#!/usr/bin/env bun

'use strict';

const fs = require('fs');
const path = require('path');
const {
  ControlPlaneStartupError,
  MAX_NDJSON_LINE_BYTES,
  USAGE,
  createStdioControlPlaneAdapter,
  loadAuthorityTrustedKeys,
  loadProofPrivateKey,
  parseStdioArguments,
  runNdjsonControlPlane,
  transportError,
} = require('../core/control-plane/stdio-adapter');

function readPinnedFile(filePath, unreadableCode, maximumBytes) {
  try {
    const resolved = fs.realpathSync.native(path.resolve(filePath));
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size < 1 || stat.size > maximumBytes) {
      throw new ControlPlaneStartupError(unreadableCode);
    }
    return Object.freeze({
      resolved,
      content: fs.readFileSync(resolved, 'utf8'),
    });
  } catch (error) {
    if (error instanceof ControlPlaneStartupError) throw error;
    throw new ControlPlaneStartupError(unreadableCode);
  }
}

function validateStateTarget(statePath, protectedPaths) {
  const resolved = path.resolve(statePath);
  let identity = resolved;
  try {
    if (fs.existsSync(resolved)) {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) throw new ControlPlaneStartupError('STATE_INVALID');
      fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK);
      identity = fs.realpathSync.native(resolved);
    } else {
      const directory = path.dirname(resolved);
      fs.mkdirSync(directory, { recursive: true });
      fs.accessSync(directory, fs.constants.W_OK);
      identity = path.join(fs.realpathSync.native(directory), path.basename(resolved));
    }
  } catch (error) {
    if (error instanceof ControlPlaneStartupError) throw error;
    throw new ControlPlaneStartupError('STATE_INVALID');
  }
  if (protectedPaths.includes(identity) || protectedPaths.includes(resolved)) {
    throw new ControlPlaneStartupError('CONFIG_INVALID');
  }
  return resolved;
}

function loadConfiguration(configuration) {
  const authority = readPinnedFile(
    configuration['authority-keys'],
    'TRUST_CONFIG_UNREADABLE',
    MAX_NDJSON_LINE_BYTES,
  );
  const proof = readPinnedFile(
    configuration['proof-private-key'],
    'PROOF_KEY_UNREADABLE',
    16 * 1024,
  );
  if (authority.resolved === proof.resolved) {
    throw new ControlPlaneStartupError('CONFIG_INVALID');
  }
  const statePath = validateStateTarget(
    configuration.state,
    [authority.resolved, proof.resolved],
  );
  return Object.freeze({
    statePath,
    authorityTrustedKeys: loadAuthorityTrustedKeys(authority.content),
    proofPrivateKey: loadProofPrivateKey(proof.content),
    proofKeyId: configuration['proof-key-id'],
    proofIssuerId: configuration['proof-issuer-id'],
    installationId: configuration['installation-id'],
  });
}

async function main(argv = process.argv.slice(2), streams = {}) {
  const output = streams.output || process.stdout;
  const errorOutput = streams.error || process.stderr;
  try {
    const configuration = parseStdioArguments(argv);
    if (configuration.help) {
      output.write(`${USAGE}\n`);
      return 0;
    }
    const adapter = createStdioControlPlaneAdapter(loadConfiguration(configuration));
    return await runNdjsonControlPlane(adapter, {
      input: streams.input || process.stdin,
      output,
    });
  } catch (error) {
    const startup = error instanceof ControlPlaneStartupError
      ? error
      : new ControlPlaneStartupError('STARTUP_FAILED');
    errorOutput.write(`${JSON.stringify(transportError(startup.code, false))}\n`);
    return startup.exitCode;
  }
}

if (require.main === module) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

module.exports = Object.freeze({
  loadConfiguration,
  main,
  readPinnedFile,
  validateStateTarget,
});
