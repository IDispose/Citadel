#!/usr/bin/env bun

'use strict';

const fs = require('fs');
const path = require('path');
const { projectAgentToCodex } = require('../../../core/agents/project-agent');

function projectCodexAgents(options = {}) {
  const citadelRoot = options.citadelRoot || path.resolve(__dirname, '..', '..', '..');
  const projectRoot = options.projectRoot || process.cwd();
  const agentName = options.agentName || null;
  const dryRun = options.dryRun === true;

  const sourceBase = path.join(citadelRoot, 'agents');
  const targetBase = path.join(projectRoot, '.codex', 'agents');
  const agentFiles = agentName
    ? [`${agentName}.md`]
    : fs.readdirSync(sourceBase).filter((name) => name.endsWith('.md'));

  return agentFiles.map((agentFile) => projectAgentToCodex(path.join(sourceBase, agentFile), targetBase, { dryRun }));
}

module.exports = Object.freeze({
  projectCodexAgents,
});
