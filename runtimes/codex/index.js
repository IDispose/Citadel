#!/usr/bin/env bun

'use strict';

const runtime = require('./runtime');
const hookInput = require('./adapters/hook-input');
const { installCodexHooks } = require('./generators/install-hooks');
const { projectCodexSkills } = require('./generators/project-skills');
const { projectCodexAgents } = require('./generators/project-agents');
const { CODEX_GUIDANCE_TARGET, renderCodexGuidance } = require('./guidance/render');

module.exports = Object.freeze({
  runtime,
  hookInput,
  installCodexHooks,
  projectCodexSkills,
  projectCodexAgents,
  guidance: Object.freeze({
    target: CODEX_GUIDANCE_TARGET,
    render: renderCodexGuidance,
  }),
});
