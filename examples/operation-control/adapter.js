#!/usr/bin/env bun

'use strict';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  const costs = {
    actual_cash: { status: 'known', amount_usd: 0, basis: 'not-applicable', source: 'local-process' },
    marginal: { status: 'known', amount_usd: 0, basis: 'not-applicable', source: 'local-process' },
    market_equivalent: { status: 'unknown', amount_usd: null, basis: 'estimate', source: 'not-estimated' },
  };
  process.stdout.write(`${JSON.stringify({
    schema: 1,
    status: request.operation.operation_id === 'example-config-check' ? 'completed' : 'failed',
    failure_code: request.operation.operation_id === 'example-config-check' ? null : 'UNSUPPORTED_OPERATION',
    output: 'Local adapter inspected the declared example workspace.',
    observations: {
      model: null,
      topology: 'tool',
      tools: ['filesystem'],
      tool_calls: ['filesystem'],
      usage: { files_read: 1 },
      costs,
    },
  })}\n`);
});
