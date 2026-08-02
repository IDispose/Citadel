#!/usr/bin/env bun

'use strict';

const AGENT_REQUIRED_FRONTMATTER = Object.freeze([
  'name',
  'description',
]);

const AGENT_OPTIONAL_FRONTMATTER = Object.freeze([
  'model',
  'maxTurns',
  'effort',
  'tools',
  'skills',
]);

const AGENT_PROJECTIONS = Object.freeze([
  'agent_markdown',
  'codex_toml',
]);

module.exports = Object.freeze({
  AGENT_REQUIRED_FRONTMATTER,
  AGENT_OPTIONAL_FRONTMATTER,
  AGENT_PROJECTIONS,
});
