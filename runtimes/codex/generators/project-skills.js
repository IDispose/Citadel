#!/usr/bin/env bun

'use strict';

const fs = require('fs');
const path = require('path');
const { projectSkillToCodex } = require('../../../core/skills/project-skill');

function projectCodexSkills(options = {}) {
  const citadelRoot = options.citadelRoot || path.resolve(__dirname, '..', '..', '..');
  const projectRoot = options.projectRoot || process.cwd();
  const skillName = options.skillName || null;
  const dryRun = options.dryRun === true;

  const sourceBase = path.join(citadelRoot, 'skills');
  const targetBase = path.join(projectRoot, '.agents', 'skills');
  const skillNames = skillName
    ? [skillName]
    : fs.readdirSync(sourceBase).filter((name) => fs.existsSync(path.join(sourceBase, name, 'SKILL.md')));

  return skillNames.map((name) => projectSkillToCodex(path.join(sourceBase, name), targetBase, name, { dryRun }));
}

module.exports = Object.freeze({
  projectCodexSkills,
});
