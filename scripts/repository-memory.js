#!/usr/bin/env bun

'use strict';

const path = require('path');
const memory = require('../core/memory/repository-store');

const HELP = `Citadel cross-clone memory

Usage:
  citadel memory status [--project-root PATH] [--json]
  citadel memory enable [--project-root PATH] [--json]
  citadel memory sync [--project-root PATH] [--json]
  citadel memory restore [--project-root PATH] [--force] [--json]
  citadel memory versions [--project-root PATH] [--path RELATIVE] [--json]
  citadel memory restore-version --path RELATIVE --sha256 DIGEST [--force] [--json]
  citadel memory disable [--project-root PATH] [--json]
  citadel memory purge [--project-root PATH] --confirm PURGE [--json]

The opt-in store keeps durable Citadel knowledge in a user-level SQLite database.
It never stores active campaigns, worktree state, telemetry, consent, or runtime
configuration, and it never sends data over the network. Node.js 22.13+ is required
for this optional capability; the rest of Citadel remains compatible with Node 18+.
`;

function has(args, flag) {
  return args.includes(flag);
}

function value(args, flag, fallback = null) {
  const inline = args.find((item) => item.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}

function parse(argv) {
  const command = argv[0] || 'status';
  return {
    command,
    projectRoot: path.resolve(value(argv, '--project-root', process.cwd())),
    json: has(argv, '--json'),
    force: has(argv, '--force'),
    confirm: value(argv, '--confirm'),
    relativePath: value(argv, '--path'),
    contentSha256: value(argv, '--sha256'),
  };
}

function printHuman(result) {
  const lines = [`Citadel memory: ${result.status}`];
  if (result.repository_id) lines.push(`Repository key: ${result.repository_id.slice(0, 12)}`);
  if (typeof result.portable === 'boolean') {
    lines.push(`Cross-clone identity: ${result.portable ? 'remote-backed' : 'local-path only'}`);
  }
  if (result.database_path) lines.push(`Database: ${result.database_path}`);
  if (Number.isInteger(result.entries_synced)) lines.push(`Synced: ${result.entries_synced} files (${result.versions_added} new versions)`);
  if (Number.isInteger(result.entries)) lines.push(`Stored: ${result.entries} files, ${result.versions} versions`);
  if (Array.isArray(result.restored)) lines.push(`Restored: ${result.restored.length} files`);
  if (Array.isArray(result.conflicts) && result.conflicts.length) {
    lines.push(`Conflicts left unchanged: ${result.conflicts.length}`);
    for (const conflict of result.conflicts) lines.push(`  - ${conflict.path}`);
  }
  if (Array.isArray(result.skipped) && result.skipped.length) lines.push(`Skipped: ${result.skipped.length}`);
  if (Array.isArray(result.versions)) {
    lines.push(`Versions: ${result.versions.length}`);
    for (const version of result.versions) {
      lines.push(`  ${version.is_current ? '*' : ' '} ${version.relative_path} ${version.content_sha256} ${version.captured_at}`);
    }
  }
  if (result.status === 'version-restored') {
    lines.push(`Restored version: ${result.relative_path} (${result.content_sha256})`);
  }
  if (result.reason) lines.push(result.reason);
  process.stdout.write(`${lines.join('\n')}\n`);
}

function main(argv = process.argv.slice(2)) {
  if (has(argv, '--help') || has(argv, '-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  const options = parse(argv);
  let result;
  if (options.command === 'status') result = memory.repositoryStatus(options.projectRoot);
  else if (options.command === 'enable') result = memory.enableRepository(options.projectRoot);
  else if (options.command === 'sync') result = memory.syncRepository(options.projectRoot);
  else if (options.command === 'restore') result = memory.restoreRepository(options.projectRoot, { force: options.force });
  else if (options.command === 'versions') result = memory.listVersions(options.projectRoot, { relativePath: options.relativePath });
  else if (options.command === 'restore-version') {
    result = memory.restoreVersion(options.projectRoot, {
      relativePath: options.relativePath,
      contentSha256: options.contentSha256,
      force: options.force,
    });
  }
  else if (options.command === 'disable') result = memory.disableRepository(options.projectRoot);
  else if (options.command === 'purge') result = memory.purgeRepository(options.projectRoot, { confirm: options.confirm });
  else {
    const error = new Error(`Unknown memory command: ${options.command}`);
    error.code = 'CITADEL_MEMORY_USAGE';
    throw error;
  }

  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else printHuman(result);
  if (result.status === 'unavailable') return 78;
  if (options.command === 'restore-version' && ['conflict', 'corrupt-version', 'disabled', 'not-configured', 'version-not-found'].includes(result.status)) return 1;
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    const json = process.argv.includes('--json');
    const payload = { status: 'error', code: error.code || 'CITADEL_MEMORY_FAILED', message: error.message };
    if (json) process.stderr.write(`${JSON.stringify(payload)}\n`);
    else process.stderr.write(`citadel memory: ${error.message}\n`);
    process.exitCode = error.code === 'CITADEL_MEMORY_USAGE'
      ? 64
      : error.code === 'CITADEL_SQLITE_UNAVAILABLE' ? 78 : 1;
  }
}

module.exports = Object.freeze({ HELP, main, parse });
