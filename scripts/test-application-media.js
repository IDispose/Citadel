#!/usr/bin/env bun
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MEDIA = path.join(ROOT, 'docs', 'assets', 'application');

function words(value) {
  return String(value).toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) || [];
}

function pngSize(filename) {
  const value = fs.readFileSync(path.join(MEDIA, filename));
  assert(value.subarray(1, 4).toString('ascii') === 'PNG', `${filename} is not PNG`);
  return [value.readUInt32BE(16), value.readUInt32BE(20)];
}

for (const filename of ['01-product-entry.png', '02-evidence-hero.png', '03-policy-comparison.png']) {
  assert.deepStrictEqual(pngSize(filename), [1440, 900], `${filename} must be a 1440 by 900 application capture`);
}

for (const filename of ['citadel-sentient-walkthrough.mp4', 'citadel-live-verification-demo.mp4']) {
  assert(fs.statSync(path.join(MEDIA, filename)).size > 200000, `${filename} is missing or implausibly small`);
}

const narration = fs.readFileSync(path.join(MEDIA, 'walkthrough-narration.txt'), 'utf8');
const vtt = fs.readFileSync(path.join(MEDIA, 'citadel-sentient-walkthrough.vtt'), 'utf8');
assert(/^WEBVTT\r?\n\r?\n/.test(vtt), 'walkthrough captions must be WebVTT');
const captionText = vtt.split(/\r?\n/).filter((line) => line && !/^\d+$/.test(line) && !/-->/.test(line) && line !== 'WEBVTT').join(' ');
assert.deepStrictEqual(words(captionText), words(narration), 'walkthrough captions must retain the near-verbatim narration');
const timestamps = [...vtt.matchAll(/-->\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})/g)].map((match) => Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000);
assert(timestamps.length >= 12, 'walkthrough captions need sentence-level timing');
assert(timestamps.at(-1) >= 100 && timestamps.at(-1) <= 120, 'caption timing must cover the narration within the two-minute master');

const live = JSON.parse(fs.readFileSync(path.join(MEDIA, 'live-verification-output.json'), 'utf8'));
assert.strictEqual(live.commands.length, 3);
assert(live.commands.every((command) => command.exit_code === 0 && /^\w{64}$/.test(command.output_sha256)));
assert(/^[0-9a-f]{40}$/.test(live.source_revision));

console.log('application media passed: image dimensions, videos, near-verbatim timed captions, and real-command transcript');
