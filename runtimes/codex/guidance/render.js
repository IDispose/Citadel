#!/usr/bin/env bun

'use strict';

const { renderCodexGuidance } = require('../../../core/project/render-codex-guidance');

const CODEX_GUIDANCE_TARGET = Object.freeze({
  runtime: 'codex',
  filePath: 'AGENTS.md',
  render: renderCodexGuidance,
});

module.exports = Object.freeze({
  CODEX_GUIDANCE_TARGET,
  renderCodexGuidance,
});
