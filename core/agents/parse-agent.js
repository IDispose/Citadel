#!/usr/bin/env bun

'use strict';

const fs = require('fs');
const path = require('path');
const {
  AGENT_REQUIRED_FRONTMATTER,
} = require(path.join(__dirname, '..', 'contracts', 'agent-role'));

function parseAgentFrontmatter(content) {
  const normalized = content.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const raw = match[1];
  const lines = raw.split('\n');
  const fm = {};
  let currentListKey = null;

  for (const line of lines) {
    if (!line.trim()) continue;

    const listMatch = line.match(/^\s*-\s+(.*)$/);
    if (listMatch && currentListKey) {
      if (!Array.isArray(fm[currentListKey])) fm[currentListKey] = [];
      fm[currentListKey].push(listMatch[1].trim());
      continue;
    }

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    let val = line.slice(colonIdx + 1).trim();
    currentListKey = null;

    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }

    if (val === '>-' || val === '>') {
      continue;
    }

    if (!val) {
      currentListKey = key;
      fm[key] = [];
      continue;
    }

    if (/^\d+$/.test(val)) {
      fm[key] = Number(val);
    } else {
      fm[key] = val;
    }
  }

  const descMatch = normalized.match(/description:\s*>-?\n([\s\S]*?)(?=\n[a-zA-Z][\w-]*:|\n---)/);
  if (descMatch) {
    fm.description = descMatch[1].replace(/\n\s*/g, ' ').trim();
  }

  return fm;
}

function extractAgentBody(content) {
  const normalized = content.replace(/\r\n/g, '\n');
  const bodyMatch = normalized.match(/^---\n[\s\S]*?\n---\n([\s\S]*)/);
  return bodyMatch ? bodyMatch[1].trim() : normalized.trim();
}

function validateParsedAgent(parsedAgent) {
  const errors = [];

  for (const field of AGENT_REQUIRED_FRONTMATTER) {
    if (!parsedAgent.frontmatter[field]) {
      errors.push(`missing frontmatter field: ${field}`);
    }
  }

  if (!parsedAgent.body) {
    errors.push('missing agent instructions body');
  }

  return errors;
}

function parseAgentContent(agentName, content, agentPath) {
  const frontmatter = parseAgentFrontmatter(content);
  const body = extractAgentBody(content);
  const parsedAgent = {
    name: agentName,
    path: agentPath || null,
    content,
    frontmatter,
    body,
  };

  return {
    ...parsedAgent,
    errors: validateParsedAgent(parsedAgent),
  };
}

function loadAgent(agentPath) {
  const resolvedPath = path.resolve(agentPath);
  const content = fs.readFileSync(resolvedPath, 'utf8');
  const agentName = path.basename(resolvedPath, path.extname(resolvedPath));
  return parseAgentContent(agentName, content, resolvedPath);
}

module.exports = Object.freeze({
  parseAgentFrontmatter,
  extractAgentBody,
  validateParsedAgent,
  parseAgentContent,
  loadAgent,
});
