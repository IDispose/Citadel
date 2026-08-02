#!/usr/bin/env bun

'use strict';

const SUPPORT_LEVELS = Object.freeze({
  FULL: 'full',
  PARTIAL: 'partial',
  NONE: 'none',
});

const CAPABILITY_IDS = Object.freeze({
  GUIDANCE: 'guidance',
  SKILLS: 'skills',
  AGENTS: 'agents',
  HOOKS: 'hooks',
  WORKSPACE: 'workspace',
  WORKTREES: 'worktrees',
  APPROVALS: 'approvals',
  HISTORY: 'history',
  TELEMETRY: 'telemetry',
  MCP: 'mcp',
  SURFACES: 'surfaces',
});

const REQUIRED_CAPABILITY_FIELDS = Object.freeze([
  'support',
  'notes',
]);

function isSupportLevel(value) {
  return Object.values(SUPPORT_LEVELS).includes(value);
}

module.exports = Object.freeze({
  SUPPORT_LEVELS,
  CAPABILITY_IDS,
  REQUIRED_CAPABILITY_FIELDS,
  isSupportLevel,
});
