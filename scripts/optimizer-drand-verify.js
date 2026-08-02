#!/usr/bin/env bun
'use strict';

const fs = require('fs');
const path = require('path');
const {
  buildExternalSelectionRequest,
  validateBeaconSelectionRecord,
} = require('../core/optimizer/external-selection');
const {
  loadExecutors,
  loadFreeze,
  loadScenarios,
} = require('../core/optimizer/contracts');

const ROOT = path.resolve(__dirname, '..');
const BENCHMARK = path.join(ROOT, 'benchmarks', 'optimizer-proof');
const DEFAULT_SELECTION = path.join(BENCHMARK, 'external-selection.json');

function option(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

async function main() {
  let drand;
  try {
    drand = require('drand-client');
  } catch {
    throw new Error(
      'Install the pinned verifier with: npm install --no-save --package-lock=false '
      + '--ignore-scripts drand-client@1.4.2',
    );
  }
  const scenarios = loadScenarios(path.join(BENCHMARK, 'scenarios'));
  const executors = loadExecutors(path.join(BENCHMARK, 'executors.json'));
  const freeze = loadFreeze(path.join(BENCHMARK, 'freeze.json'), scenarios, executors);
  const request = buildExternalSelectionRequest(freeze, scenarios);
  const selectionPath = path.resolve(option(process.argv.slice(2), '--input') || DEFAULT_SELECTION);
  const selection = validateBeaconSelectionRecord(
    JSON.parse(fs.readFileSync(selectionPath, 'utf8')),
    request,
    freeze,
    scenarios,
  );
  const chainInfo = {
    public_key: request.beacon.public_key,
    period: 30,
    genesis_time: 1595431050,
    hash: request.beacon.chain_hash,
    groupHash: '',
    schemeID: 'pedersen-bls-chained',
    metadata: { beaconID: 'default' },
  };
  const client = {
    options: {
      disableBeaconVerification: false,
      noCache: true,
      chainVerificationParams: {
        chainHash: request.beacon.chain_hash,
        publicKey: request.beacon.public_key,
      },
    },
    chain() {
      return { info: async () => chainInfo };
    },
    async get(round) {
      if (round !== selection.beacon.round) throw new Error('Unexpected drand round');
      return selection.beacon;
    },
  };
  await drand.fetchBeacon(client, request.beacon.round);
  process.stdout.write(`${JSON.stringify({
    schema: 1,
    kind: 'citadel_optimizer_drand_verification',
    request_id: request.request_id,
    selection_digest: selection.selection_digest,
    chain_hash: request.beacon.chain_hash,
    round: request.beacon.round,
    bls_signature_verified: true,
    verifier: 'drand-client@1.4.2',
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`Drand verification failed: ${error.message}\n`);
  process.exitCode = 1;
});
