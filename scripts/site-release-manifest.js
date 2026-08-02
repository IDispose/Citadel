#!/usr/bin/env bun
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const OUTPUT = path.join(DOCS, 'site-release-manifest.json');
const ROOT_FILES = Object.freeze([
  '404.html', 'index.html', 'evidence.html', 'operation-control.html',
  'optimizer.html', 'research.html', 'walkthrough.html', 'site-system.css',
  'site-system.js', 'evidence-manifest.json', 'EVIDENCE_MANIFEST.md',
  'robots.txt', 'sitemap.xml', 'site.webmanifest',
]);
const TEXT_EXTENSIONS = new Set([
  '.css', '.html', '.js', '.json', '.md', '.svg', '.txt', '.vtt', '.webmanifest', '.xml',
]);

function digest(buffer) { return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`; }
function normalizeForManifest(relative, buffer) {
  if (!TEXT_EXTENSIONS.has(path.extname(relative).toLowerCase())) return buffer;
  return Buffer.from(buffer.toString('utf8').replace(/\r\n?/g, '\n'), 'utf8');
}
function walk(relativeRoot) {
  const absoluteRoot = path.join(DOCS, relativeRoot);
  if (!fs.existsSync(absoluteRoot)) return [];
  const output = [];
  for (const entry of fs.readdirSync(absoluteRoot, { withFileTypes: true })) {
    const relative = path.posix.join(relativeRoot.split(path.sep).join('/'), entry.name);
    if (entry.isDirectory()) output.push(...walk(relative));
    else output.push(relative);
  }
  return output;
}

function build() {
  const files = [...ROOT_FILES, ...walk('assets'), ...walk('grants')]
    .filter((relative) => relative !== 'site-release-manifest.json')
    .filter((relative) => fs.existsSync(path.join(DOCS, relative)))
    .sort();
  const entries = files.map((relative) => {
    const content = normalizeForManifest(relative, fs.readFileSync(path.join(DOCS, relative)));
    return { path: relative, bytes: content.length, digest: digest(content) };
  });
  return {
    schema: 1,
    kind: 'citadel-site-release-manifest',
    files: entries,
    source_digest: digest(Buffer.from(JSON.stringify(entries))),
  };
}

function write() {
  const manifest = build();
  fs.writeFileSync(OUTPUT, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

function verify() {
  const expected = build();
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(OUTPUT, 'utf8')), expected);
  return expected;
}

if (require.main === module) {
  const command = process.argv[2] || 'verify';
  const manifest = command === 'build' ? write() : command === 'verify' ? verify() : null;
  if (!manifest) throw new Error(`unknown site release manifest command: ${command}`);
  process.stdout.write(`site release manifest ${command} passed: ${manifest.source_digest}\n`);
}

module.exports = Object.freeze({ build, normalizeForManifest, verify });
