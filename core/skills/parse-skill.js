#!/usr/bin/env bun

'use strict';

const fs = require('fs');
const path = require('path');
const {
  SKILL_REQUIRED_FRONTMATTER,
  SKILL_REQUIRED_SECTIONS,
} = require(path.join(__dirname, '..', 'contracts', 'skill-manifest'));

const HEADING_LEVEL_COMPAT = Object.freeze({
  Identity: '[#]{1,2}',
  Orientation: '[#]{1,2}',
  Protocol: '##',
  'Quality Gates': '##',
  'Exit Protocol': '##',
});

function parseSkillFrontmatter(content) {
  const normalized = content.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const fm = {};
  for (const line of match[1].split('\n')) {
    if (line.trim().startsWith('-')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    if (line.match(/^\s+\w/)) continue;
    let val = line.slice(colonIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (val === '>-' || val === '>') continue;
    if (key && val) fm[key] = val;
  }

  const descMatch = normalized.match(/description:\s*>-?\n([\s\S]*?)(?=\n[a-zA-Z][\w-]*:|\n---)/);
  if (descMatch) {
    fm.description = descMatch[1].replace(/\n\s*/g, ' ').trim();
  }

  return fm;
}

function extractSkillBody(content) {
  const normalized = content.replace(/\r\n/g, '\n');
  const bodyMatch = normalized.match(/^---\n[\s\S]*?\n---\n([\s\S]*)/);
  return bodyMatch ? bodyMatch[1].trim() : normalized.trim();
}

function validateParsedSkill(parsedSkill) {
  const errors = [];

  for (const field of SKILL_REQUIRED_FRONTMATTER) {
    if (!parsedSkill.frontmatter[field]) {
      errors.push(`missing frontmatter field: ${field}`);
    }
  }

  for (const section of SKILL_REQUIRED_SECTIONS) {
    const headingPrefix = HEADING_LEVEL_COMPAT[section] || '##';
    const sectionRegex = new RegExp(`^${headingPrefix}\\s+${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'mi');
    if (!sectionRegex.test(parsedSkill.body)) {
      errors.push(`missing section: ${section}`);
    }
  }

  return errors;
}

function parseSkillContent(skillName, content, skillPath) {
  const frontmatter = parseSkillFrontmatter(content);
  const body = extractSkillBody(content);
  const parsedSkill = {
    name: skillName,
    path: skillPath || null,
    content,
    frontmatter,
    body,
  };

  return {
    ...parsedSkill,
    errors: validateParsedSkill(parsedSkill),
  };
}

function loadSkill(skillRoot, skillName) {
  const resolvedName = skillName || path.basename(skillRoot);
  const skillPath = path.join(skillRoot, 'SKILL.md');
  const content = fs.readFileSync(skillPath, 'utf8');
  return parseSkillContent(resolvedName, content, skillPath);
}

module.exports = Object.freeze({
  parseSkillFrontmatter,
  extractSkillBody,
  validateParsedSkill,
  parseSkillContent,
  loadSkill,
});
