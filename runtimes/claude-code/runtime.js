#!/usr/bin/env bun

'use strict';

module.exports = Object.freeze({
  id: 'claude-code',
  displayName: 'Claude Code',
  capabilities: {
    guidance: { support: 'full', notes: 'Uses CLAUDE.md and project hook/config integration.' },
    skills: { support: 'full', notes: 'Canonical Citadel skill flow originated here.' },
    agents: { support: 'full', notes: 'Supports Citadel agent patterns directly.' },
    hooks: { support: 'full', notes: 'Supports the full Citadel lifecycle hook model.' },
    workspace: { support: 'full', notes: 'Standard file and shell workflow available.' },
    worktrees: { support: 'full', notes: 'Fleet worktree model is native to current Citadel design.' },
    approvals: { support: 'partial', notes: 'Approval and consent policies are partly Citadel-managed.' },
    history: { support: 'partial', notes: 'Session persistence exists but campaign files remain Citadel-owned.' },
    telemetry: { support: 'partial', notes: 'Telemetry is primarily Citadel-managed JSONL state.' },
    mcp: { support: 'partial', notes: 'Can integrate with MCP-like services, but not as the primary Citadel surface.' },
    surfaces: { support: 'full', notes: 'Slash-command and plugin-oriented surface is primary.' },
  },
  degradations: [],
});
