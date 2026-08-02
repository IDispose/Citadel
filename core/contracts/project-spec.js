#!/usr/bin/env bun

'use strict';

const PROJECT_SPEC_VERSION = '1';

const PROJECT_SPEC_FIELDS = Object.freeze([
  'version',
  'project',
  'conventions',
  'workflows',
  'constraints',
]);

const PROJECT_GUIDANCE_PROJECTIONS = Object.freeze([
  'claude_md',
  'agents_md',
]);

function createProjectSpecSkeleton() {
  return {
    version: PROJECT_SPEC_VERSION,
    project: {
      name: '',
      summary: '',
    },
    conventions: [],
    workflows: [],
    constraints: [],
  };
}

module.exports = Object.freeze({
  PROJECT_SPEC_VERSION,
  PROJECT_SPEC_FIELDS,
  PROJECT_GUIDANCE_PROJECTIONS,
  createProjectSpecSkeleton,
});
