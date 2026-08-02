#!/usr/bin/env bun
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  bundleMap,
  filterHookTemplate,
  hookName,
  requiredBundle,
} = require('../core/hooks/bundles');
const { BUNDLE_CATALOG } = require('../core/config');
const { translateCodexHooks } = require('../runtimes/codex/generators/install-hooks');

const root = path.resolve(__dirname, '..');
const template = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'hooks-template.json'), 'utf8'));

const names = [];
for (const entries of Object.values(template.hooks)) {
  for (const entry of entries) {
    for (const hook of entry.hooks || []) {
      const name = hookName(hook.command);
      if (name) names.push(name);
    }
  }
}

assert(names.length > 0);
for (const name of names) {
  assert(bundleMap.hooks[name], `hook ${name} is missing bundle ownership`);
  assert.equal(requiredBundle(name), bundleMap.hooks[name]);
}
const catalogOwnership = Object.fromEntries(
  Object.values(BUNDLE_CATALOG).flatMap((bundle) =>
    bundle.owns.hooks.map((name) => [name, bundle.id])),
);
assert.deepEqual(
  Object.fromEntries(Object.entries(bundleMap.hooks).sort()),
  Object.fromEntries(Object.entries(catalogOwnership).sort()),
  'hook bundle-map and product bundle catalog must be identical',
);

const legacy = filterHookTemplate(template);
assert.strictEqual(legacy.template, template);
assert.equal(legacy.mode, 'legacy-all');

const core = filterHookTemplate(template, ['core']);
assert.equal(core.mode, 'effective-bundles');
assert(core.installed.length > 0);
assert(core.skipped.length > 0);
assert(core.installed.every((item) => item.bundle === 'core'));
assert(core.skipped.some((item) => item.bundle === 'parallel'));

const persistence = filterHookTemplate(template, ['persistence']);
assert(persistence.effectiveBundles.includes('core'));
assert(persistence.installed.some((item) => item.bundle === 'persistence'));
assert(persistence.skipped.every((item) => !['core', 'persistence'].includes(item.bundle)));

const translated = translateCodexHooks(template, '/tmp/citadel/codex-adapter.js', {
  effectiveBundles: ['core'],
});
assert(translated.installed.length > 0);
assert(translated.bundleFilter.skipped.some((item) => item.bundle === 'operations'));
assert(!translated.installed.some((item) => (
  ['subagent-start', 'subagent-stop', 'teammate-idle', 'task-events'].includes(item.hook)
)));

const commands = JSON.stringify(translated.hooks);
assert(commands.includes('protect-files'));
assert(!commands.includes('teammate-idle'));

process.stdout.write(`hook bundle tests passed (${new Set(names).size} hooks mapped)\n`);
