#!/usr/bin/env bun
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CLONES = Object.freeze([
  'git clone https://github.com/SethGammon/Citadel.git "$env:USERPROFILE\\Citadel"',
  'git clone https://github.com/SethGammon/Citadel.git "$HOME/Citadel"',
]);
const COMMANDS = Object.freeze([
  {
    runtime: 'claude',
    powershell: 'bun "$env:USERPROFILE\\Citadel\\scripts\\install.js" --runtime claude --install --scope local',
    shell: 'bun "$HOME/Citadel/scripts/install.js" --runtime claude --install --scope local',
  },
  {
    runtime: 'codex',
    powershell: 'bun "$env:USERPROFILE\\Citadel\\scripts\\install.js" --runtime codex --add-marketplace',
    shell: 'bun "$HOME/Citadel/scripts/install.js" --runtime codex --add-marketplace',
  },
]);

const page = fs.readFileSync(path.join(ROOT, 'docs', 'index.html'), 'utf8');
for (const clone of CLONES) assert(page.includes(clone), `homepage missing platform clone command: ${clone}`);
assert(page.indexOf(CLONES[0]) < page.indexOf(COMMANDS[0].powershell), 'homepage clone command must precede installer command');
assert(page.includes('href="CLAUDE_INSTALLATION_GUIDE.md"'), 'homepage missing Claude Code install guide');
assert(page.includes('href="CODEX_INSTALLATION_GUIDE.md"'), 'homepage missing Codex install guide');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-public-install-'));
try {
  const fakeHome = path.join(temporary, 'home');
  const target = path.join(temporary, 'target');
  fs.mkdirSync(fakeHome, { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  fs.symlinkSync(ROOT, path.join(fakeHome, 'Citadel'), process.platform === 'win32' ? 'junction' : 'dir');
  childProcess.execFileSync('git', ['init', '--quiet'], { cwd: target, windowsHide: true });
  for (const item of COMMANDS) {
    assert(page.includes(item.powershell), `homepage missing ${item.runtime} PowerShell installer command`);
    assert(page.includes(item.shell), `homepage missing ${item.runtime} macOS/Linux installer command`);
    const command = `${process.platform === 'win32' ? item.powershell : item.shell} --dry-run --json`;
    const executable = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
    const args = process.platform === 'win32' ? ['-NoProfile', '-Command', command] : ['-c', command];
    const result = childProcess.spawnSync(executable, args, {
      cwd: target,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 30000,
      env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
    });
    assert.strictEqual(result.status, 0, `${item.runtime} displayed installer dry-run failed: ${result.stderr || result.stdout}`);
    const output = JSON.parse(result.stdout);
    assert.strictEqual(output.pass, true, `${item.runtime} installer did not return a passing dry-run plan`);
    assert.strictEqual(output.dryRun, true, `${item.runtime} installer did not preserve dry-run mode`);
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

process.stdout.write(`public install path passed: both platform paths are explicit and displayed ${process.platform === 'win32' ? 'PowerShell' : 'shell'} commands execute\n`);
