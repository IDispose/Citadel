#!/usr/bin/env bun

'use strict';

const SKILL_REQUIRED_FRONTMATTER = Object.freeze([
  'name',
  'description',
]);

const SKILL_OPTIONAL_FRONTMATTER = Object.freeze([
  'user-invocable',
  'auto-trigger',
  'last-updated',
  'dependencies',
]);

const SKILL_REQUIRED_SECTIONS = Object.freeze([
  'Identity',
  'Orientation',
  'Protocol',
  'Quality Gates',
  'Exit Protocol',
]);

const SKILL_PROJECTIONS = Object.freeze([
  'skill_md',
  'openai_yaml',
]);

module.exports = Object.freeze({
  SKILL_REQUIRED_FRONTMATTER,
  SKILL_OPTIONAL_FRONTMATTER,
  SKILL_REQUIRED_SECTIONS,
  SKILL_PROJECTIONS,
});
