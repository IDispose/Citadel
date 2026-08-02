#!/usr/bin/env bun

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const memory = require('../core/memory/repository-store');

const ROOT = path.resolve(__dirname, '..');

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8', shell: false, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(result.status, 0, result.stderr);
}

function write(root, relative, content) {
  const target = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function initialize(root, remote) {
  fs.mkdirSync(root, { recursive: true });
  git(root, ['init', '--quiet']);
  git(root, ['remote', 'add', 'origin', remote]);
}

assert.equal(
  memory.normalizeRemoteUrl('https://github.com/Example/Memory.git'),
  'github.com/Example/Memory',
);
assert.equal(
  memory.normalizeRemoteUrl('git@github.com:Example/Memory.git'),
  'github.com/Example/Memory',
);
assert.equal(
  memory.normalizeRemoteUrl('ssh://git@github.com/Example/Memory.git'),
  'github.com/Example/Memory',
);
assert.equal(
  memory.normalizeRemoteUrl('ssh://git@github.com:22/Example/Memory.git'),
  'github.com/Example/Memory',
);
assert.equal(
  memory.normalizeRemoteUrl('ssh://git@git.example.test:2222/Example/Memory.git'),
  'git.example.test:2222/Example/Memory',
);
assert.equal(memory.normalizeRemoteUrl('../local-origin.git'), null);
assert(memory.isDurablePath('.planning/campaigns/completed/one.md'));
assert(memory.isDurablePath('.planning/research/fleet-topic/REPORT.md'));
assert(memory.isDurablePath('.citadel/project.md'));
assert(!memory.isDurablePath('.planning/campaigns/active.md'));
assert(!memory.isDurablePath('.planning/telemetry/session.jsonl'));
assert(!memory.isDurablePath('.planning/intake/_TEMPLATE.md'));
assert(!memory.isDurablePath('../outside.md'));

const capability = memory.sqliteCapability();
if (!capability.available) {
  assert.equal(capability.code, 'CITADEL_SQLITE_UNAVAILABLE');
  process.stdout.write(`Repository memory pure-contract tests passed; SQLite exercise skipped on Node ${process.versions.node}.\n`);
  process.exit(0);
}

const suite = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-repository-memory-'));
const source = path.join(suite, 'source clone');
const target = path.join(suite, 'target clone');
const databasePath = path.join(suite, 'user-state', 'memory.sqlite3');
initialize(source, 'https://github.com/Example/Memory.git');
initialize(target, 'git@github.com:Example/Memory.git');

const unsafeDatabasePath = path.join(suite, 'unsafe-database-target');
fs.mkdirSync(unsafeDatabasePath, { recursive: true });
assert.throws(
  () => memory.enableRepository(source, { databasePath: unsafeDatabasePath }),
  (error) => error.code === 'CITADEL_MEMORY_DB_UNSAFE',
);

write(source, '.citadel/project.md', '# Project\nDurable project context.\n');
write(source, '.planning/campaigns/completed/alpha.md', '# Alpha\nCompleted.\n');
const researchPath = write(source, '.planning/research/nested/note.md', '# Note\nFirst lesson.\n');
write(source, '.planning/intake/follow-up.md', '# Follow-up\nLater.\n');
write(source, '.planning/intake/_TEMPLATE.md', '# Template\n');
write(source, '.planning/campaigns/active.md', '# Active\nMust stay clone-local.\n');
write(source, '.planning/telemetry/session.jsonl', '{"private":"runtime"}\n');

const enabled = memory.enableRepository(source, { databasePath });
assert.equal(enabled.status, 'enabled');
assert.equal(enabled.portable, true);
assert.equal(enabled.entries_synced, 4);
assert.equal(enabled.versions_added, 4);
assert(fs.existsSync(databasePath));
if (process.platform !== 'win32') {
  assert.equal(fs.statSync(databasePath).mode & 0o077, 0, 'database must not grant group or other permissions');
}
const sourceAlias = path.join(suite, 'source-alias');
try {
  fs.symlinkSync(source, sourceAlias, process.platform === 'win32' ? 'junction' : 'dir');
  const aliasSync = memory.syncRepository(sourceAlias, {
    databasePath,
    filePath: path.join(sourceAlias, '.planning', 'research', 'nested', 'note.md'),
  });
  assert.equal(aliasSync.entries_synced, 1, 'filesystem aliases must resolve within the canonical Git root');
} catch (error) {
  if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
}
const initialResearchVersions = memory.listVersions(source, {
  databasePath,
  relativePath: '.planning/research/nested/note.md',
});
assert.equal(initialResearchVersions.versions.length, 1);
const firstLessonDigest = initialResearchVersions.versions[0].content_sha256;

const sourceIdentity = memory.repositoryIdentity(source);
const targetIdentity = memory.repositoryIdentity(target);
assert.equal(sourceIdentity.repository_id, targetIdentity.repository_id, 'HTTPS and SSH clones must share identity');
const databaseBytes = fs.readFileSync(databasePath);
assert(!databaseBytes.includes(Buffer.from('github.com/Example/Memory')), 'raw remote identity must not enter SQLite');

write(target, '.planning/research/nested/note.md', '# Note\nLocal divergent lesson.\n');
const restored = memory.restoreRepository(target, { databasePath });
assert.equal(restored.status, 'restored-with-conflicts');
assert.equal(restored.restored.length, 3);
assert.equal(restored.conflicts.length, 1);
assert.equal(fs.readFileSync(path.join(target, '.planning/research/nested/note.md'), 'utf8'), '# Note\nLocal divergent lesson.\n');
assert(!fs.existsSync(path.join(target, '.planning/campaigns/active.md')));
assert(!fs.existsSync(path.join(target, '.planning/telemetry/session.jsonl')));

const forced = memory.restoreRepository(target, { databasePath, force: true });
assert.equal(forced.conflicts.length, 0);
assert.equal(fs.readFileSync(path.join(target, '.planning/research/nested/note.md'), 'utf8'), '# Note\nFirst lesson.\n');

fs.writeFileSync(researchPath, '# Note\nSecond lesson.\n');
const synced = memory.syncRepository(source, { databasePath, filePath: researchPath });
assert.equal(synced.entries_synced, 1);
assert.equal(synced.versions_added, 1);
const status = memory.repositoryStatus(source, { databasePath });
assert.equal(status.status, 'enabled');
assert.equal(status.entries, 4);
assert.equal(status.versions, 5, 'prior content versions must be retained');

fs.writeFileSync(researchPath, '# Note\nThird lesson from a file-change event.\n');
const fileChanged = spawnSync(process.execPath, [path.join(ROOT, 'hooks_src', 'file-changed.js')], {
  cwd: source,
  env: { ...process.env, CLAUDE_PROJECT_DIR: source, CITADEL_MEMORY_DB: databasePath },
  input: JSON.stringify({ file_path: researchPath, change_type: 'modified', session_id: 'memory-test' }),
  encoding: 'utf8', shell: false, stdio: ['pipe', 'pipe', 'pipe'],
});
assert.equal(fileChanged.status, 0, fileChanged.stderr);
assert.equal(memory.repositoryStatus(source, { databasePath }).versions, 6, 'file-change hook must capture durable edits');

const researchVersions = memory.listVersions(source, {
  databasePath,
  relativePath: '.planning/research/nested/note.md',
});
assert.equal(researchVersions.versions.length, 3, 'all distinct lesson versions must remain recoverable');
assert.equal(researchVersions.versions.filter((version) => version.is_current).length, 1);

write(target, '.planning/research/nested/note.md', '# Note\nDo not overwrite this manually edited copy.\n');
const versionConflict = memory.restoreVersion(target, {
  databasePath,
  relativePath: '.planning/research/nested/note.md',
  contentSha256: firstLessonDigest,
});
assert.equal(versionConflict.status, 'conflict');
const recoveredVersion = memory.restoreVersion(target, {
  databasePath,
  relativePath: '.planning/research/nested/note.md',
  contentSha256: firstLessonDigest,
  force: true,
});
assert.equal(recoveredVersion.status, 'version-restored');
assert.equal(fs.readFileSync(path.join(target, '.planning/research/nested/note.md'), 'utf8'), '# Note\nFirst lesson.\n');

const cli = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'citadel.js'), 'memory', 'status', '--project-root', source, '--json'], {
  cwd: ROOT,
  env: { ...process.env, CITADEL_MEMORY_DB: databasePath },
  encoding: 'utf8', shell: false, stdio: ['ignore', 'pipe', 'pipe'],
});
assert.equal(cli.status, 0, cli.stderr);
assert.equal(JSON.parse(cli.stdout).versions, 6);

const versionsCli = spawnSync(process.execPath, [
  path.join(ROOT, 'bin', 'citadel.js'), 'memory', 'versions', '--project-root', source,
  '--path', '.planning/research/nested/note.md', '--json',
], {
  cwd: ROOT,
  env: { ...process.env, CITADEL_MEMORY_DB: databasePath },
  encoding: 'utf8', shell: false, stdio: ['ignore', 'pipe', 'pipe'],
});
assert.equal(versionsCli.status, 0, versionsCli.stderr);
assert.equal(JSON.parse(versionsCli.stdout).versions.length, 3);

const linkedOutside = path.join(suite, 'outside-memory');
fs.mkdirSync(linkedOutside, { recursive: true });
write(linkedOutside, 'escaped.md', '# Outside\nNever capture through a link.\n');
const linkedDirectory = path.join(source, '.planning', 'research', 'linked-outside');
try {
  fs.symlinkSync(linkedOutside, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  assert(memory.pathContainsSymlink(source, '.planning/research/linked-outside/escaped.md'));
  const symlinkSync = memory.syncRepository(source, {
    databasePath,
    filePath: path.join(linkedDirectory, 'escaped.md'),
  });
  assert.equal(symlinkSync.entries_synced, 0);
  assert(['unsafe-path', 'symlink-path'].includes(symlinkSync.skipped[0].reason));
} catch (error) {
  if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
}

const disabled = memory.disableRepository(target, { databasePath });
assert.equal(disabled.status, 'disabled');
assert.equal(memory.syncRepository(source, { databasePath }).status, 'disabled');
assert.equal(memory.restoreRepository(target, { databasePath }).status, 'disabled');

memory.enableRepository(source, { databasePath });
assert.throws(
  () => memory.purgeRepository(source, { databasePath }),
  (error) => error.code === 'CITADEL_MEMORY_CONFIRMATION_REQUIRED',
);
assert.equal(memory.purgeRepository(source, { databasePath, confirm: 'PURGE' }).status, 'purged');
assert.equal(memory.repositoryStatus(source, { databasePath }).status, 'not-enabled');

fs.rmSync(suite, { recursive: true, force: true });
process.stdout.write('Repository memory tests passed.\n');
