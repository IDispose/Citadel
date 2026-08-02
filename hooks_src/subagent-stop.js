#!/usr/bin/env bun

/**
 * subagent-stop.js — SubagentStop hook
 *
 * Fires when a subagent session ends (spawned via Agent tool).
 * Logs the boundary event to telemetry and audit so the full agent
 * activity graph can be reconstructed.
 *
 * Fringe cases handled:
 * - Agent timed out (status != success) → elevated audit entry
 * - Agent never started (no output) → logged but not escalated
 * - Multiple agents finishing near-simultaneously → each gets its own entry
 */

const health = require('./harness-health-util');

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    let event = {};
    try { event = JSON.parse(input); } catch { /* partial input ok */ }

    const agentId = event.agent_id || event.subagent_id || null;
    const status = event.status || event.stop_reason || 'unknown';
    const agentType = event.subagent_type || event.agent_type || null;
    const outputTokens = event.output_tokens || null;

    health.increment('subagent-stop', 'count');

    // Log to telemetry for timeline reconstruction
    health.logTiming('subagent-stop', 0, {
      event: 'subagent-stop',
      agent_id: agentId,
      agent_type: agentType,
      status,
      output_tokens: outputTokens,
    });

    // Abnormal terminations go to audit — these are things to investigate
    const abnormal = status && !['end_turn', 'success', 'completed', 'stop_sequence'].includes(status.toLowerCase());
    if (abnormal) {
      health.writeAuditLog('subagent-abnormal-stop', {
        agent_id: agentId,
        agent_type: agentType,
        status,
        severity: 'medium',
      });
    }

    process.exit(0);
  });
}

main();
