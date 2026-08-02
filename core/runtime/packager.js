'use strict';

// Runtime-aware packaging helpers. Citadel runs on Bun; these produce
// spawnable steps that pack a package directory into a tarball and install a
// local tarball, using Bun's package manager when available and falling back
// to npm (resolved next to the Node executable) otherwise.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function isBun() {
  return Boolean(process.versions && process.versions.bun);
}

// Locate npm's CLI entrypoint next to the current executable, if present.
function resolveNpmCli(env = process.env) {
  const dir = path.dirname(process.execPath);
  const candidates = [
    env.npm_execpath,
    path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  return candidates.find((candidate) => {
    try { return fs.existsSync(candidate); } catch { return false; }
  }) || null;
}

// Build a spawnable "pack this package into destDir" step.
//   bun:  `bun pm pack --destination <dir> --quiet --ignore-scripts` run inside
//         packageDir. With --quiet, stdout is the produced tarball path.
//   node: `npm pack <packageDir> --json --pack-destination <dir>`. stdout is
//         npm's JSON array; the tarball is <dir>/<json[0].filename>.
// The returned `tarballFrom(stdout)` extracts the produced tarball path.
function packStep({ packageDir, destDir }) {
  if (isBun()) {
    return {
      command: process.execPath,
      args: ['pm', 'pack', '--destination', destDir, '--quiet', '--ignore-scripts'],
      cwd: packageDir,
      json: false,
      tarballFrom(stdout) {
        const line = String(stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
        if (!line) throw new Error('bun pm pack produced no tarball path');
        return path.isAbsolute(line) ? line : path.join(destDir, path.basename(line));
      },
    };
  }
  const npmCli = resolveNpmCli();
  if (!npmCli) throw new Error('npm CLI is required to pack (no Bun runtime and npm not found next to node)');
  return {
    command: process.execPath,
    args: [npmCli, 'pack', packageDir, '--json', '--pack-destination', destDir],
    cwd: process.cwd(),
    json: true,
    tarballFrom(stdout) {
      const info = JSON.parse(stdout);
      return path.join(destDir, info[0].filename);
    },
  };
}

// Build a spawnable "install this local tarball into the current dir" step.
//   bun:  `bun add <tarball> --ignore-scripts --no-summary [--cache-dir <dir>]`
//   node: `npm install <tarball> --ignore-scripts --no-audit --no-fund --offline
//          [--cache <dir>]`
function installTarballStep({ tarball, cacheDir }) {
  if (isBun()) {
    return {
      command: process.execPath,
      args: ['add', tarball, '--ignore-scripts', '--no-summary', ...(cacheDir ? ['--cache-dir', cacheDir] : [])],
    };
  }
  const npmCli = resolveNpmCli();
  if (!npmCli) throw new Error('npm CLI is required to install a tarball (no Bun runtime and npm not found next to node)');
  return {
    command: process.execPath,
    args: [npmCli, 'install', tarball, '--ignore-scripts', '--no-audit', '--no-fund', '--offline', ...(cacheDir ? ['--cache', cacheDir] : [])],
  };
}

// Build a spawnable "install this local tarball into an isolated prefix" step,
// producing <prefix>/node_modules/<name> and a <prefix>/node_modules/.bin shim.
//   bun:  `bun add <tarball> ...` run inside prefix (seeded with a package.json).
//   node: `npm install --prefix <prefix> <tarball> ...`.
// Call `prepare()` before spawning.
function installTarballToPrefix({ tarball, prefix, cacheDir }) {
  if (isBun()) {
    return {
      command: process.execPath,
      args: ['add', tarball, '--ignore-scripts', '--no-summary', ...(cacheDir ? ['--cache-dir', cacheDir] : [])],
      cwd: prefix,
      prepare() {
        fs.mkdirSync(prefix, { recursive: true });
        const pkg = path.join(prefix, 'package.json');
        if (!fs.existsSync(pkg)) {
          fs.writeFileSync(pkg, `${JSON.stringify({ name: 'citadel-install-prefix', version: '1.0.0', private: true }, null, 2)}\n`);
        }
      },
    };
  }
  const npmCli = resolveNpmCli();
  if (!npmCli) throw new Error('npm CLI is required to install into a prefix (no Bun runtime and npm not found next to node)');
  return {
    command: process.execPath,
    args: [npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', prefix, tarball],
    cwd: process.cwd(),
    prepare() { fs.mkdirSync(prefix, { recursive: true }); },
  };
}

// Count regular-file entries in an (already gunzipped) tar buffer.
function countTarFiles(tar) {
  let count = 0;
  let offset = 0;
  while (offset + 512 <= tar.length) {
    if (tar[offset] === 0) break; // end-of-archive zero block
    const sizeField = tar.slice(offset + 124, offset + 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeField, 8) || 0;
    const typeFlag = tar[offset + 156];
    if (typeFlag === 0x30 || typeFlag === 0) count += 1; // '0' or legacy NUL == regular file
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return count;
}

// Runtime-neutral descriptor for a produced tarball, matching the npm-pack
// fields (version, entryCount, integrity) the proof journeys record as facts.
function describeTarball(tarball, packageDir) {
  const bytes = fs.readFileSync(tarball);
  const version = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')).version;
  const integrity = `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`;
  return { version, entryCount: countTarFiles(zlib.gunzipSync(bytes)), integrity };
}

module.exports = {
  isBun, resolveNpmCli, packStep, installTarballStep, installTarballToPrefix, describeTarball,
};
