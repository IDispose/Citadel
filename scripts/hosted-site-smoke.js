#!/usr/bin/env bun
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE_URL = String(process.env.CITADEL_SITE_URL || 'https://sethgammon.github.io/Citadel').replace(/\/$/, '');
const LOCAL_RELEASE = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'docs', 'site-release-manifest.json'), 'utf8'));
const EXPECTED = Object.freeze([
  { path: '/', title: 'Citadel |', phrase: 'Start with /do' },
  { path: '/evidence.html', title: 'Citadel Evidence |', phrase: 'Inspect the claim' },
  { path: '/operation-control.html', title: 'Citadel Operation Control |', phrase: 'Control the operation' },
  { path: '/optimizer.html', title: 'Citadel Optimizer |', phrase: 'Route by evidence' },
  { path: '/research.html', title: 'Citadel Research Program |', phrase: 'Make agent optimization' },
  { path: '/walkthrough.html', title: 'Citadel | Two-minute', phrase: 'Start with the product' },
]);

async function waitForDeployment(page) {
  let last = null;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const response = await page.goto(`${BASE_URL}/site-release-manifest.json?attempt=${attempt}`, { waitUntil: 'load' });
    let deployed = null;
    try { deployed = JSON.parse(await page.locator('body').innerText()); } catch {}
    last = { attempt, status: response ? response.status() : null, source_digest: deployed?.source_digest || null };
    if (response && response.ok() && deployed?.source_digest === LOCAL_RELEASE.source_digest) return last;
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
  throw new Error(`deployed source digest did not match ${LOCAL_RELEASE.source_digest} after ${last ? last.attempt : 0} attempts (HTTP ${last ? last.status : 'unknown'}; saw ${last ? last.source_digest : 'unknown'})`);
}

async function inspectPage(browser, spec, viewport) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  const response = await page.goto(`${BASE_URL}${spec.path}`, { waitUntil: 'load' });
  assert(response && response.ok(), `${spec.path} returned ${response ? response.status() : 'no response'}`);
  const facts = await page.evaluate(() => ({
    title: document.title,
    h1: document.querySelector('h1')?.innerText || '',
    canonical: document.querySelector('link[rel="canonical"]')?.href || '',
    description: document.querySelector('meta[name="description"]')?.content || '',
    ogImage: document.querySelector('meta[property="og:image"]')?.content || '',
    scrollY: window.scrollY,
    active: document.activeElement?.tagName || '',
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    skipLink: Boolean(document.querySelector('.site-skip-link')),
    navToggle: Boolean(document.querySelector('[data-site-nav-toggle]')),
  }));
  assert(facts.title.startsWith(spec.title), `${spec.path} title mismatch: ${facts.title}`);
  assert(facts.h1.includes(spec.phrase), `${spec.path} h1 mismatch: ${facts.h1}`);
  assert(facts.canonical.startsWith(`${BASE_URL}/`) || facts.canonical === `${BASE_URL}/`, `${spec.path} canonical missing`);
  assert(facts.description.length >= 60, `${spec.path} description too short`);
  assert(facts.ogImage === `${BASE_URL}/assets/citadel-social-preview.png`, `${spec.path} social image mismatch`);
  assert.strictEqual(facts.scrollY, 0, `${spec.path} did not open at scroll zero`);
  assert.strictEqual(facts.active, 'BODY', `${spec.path} stole initial focus`);
  assert(facts.scrollWidth <= facts.clientWidth + 1, `${spec.path} has horizontal overflow ${facts.scrollWidth}/${facts.clientWidth}`);
  assert(facts.skipLink, `${spec.path} has no skip link`);
  assert(facts.navToggle, `${spec.path} has no responsive nav toggle`);
  if (viewport.width <= 620) {
    const toggle = page.locator('[data-site-nav-toggle]');
    assert(await toggle.isVisible(), `${spec.path} mobile menu toggle is not visible`);
    await toggle.click();
    assert.strictEqual(await toggle.getAttribute('aria-expanded'), 'true', `${spec.path} mobile menu did not open`);
    const mobile = page.locator('[data-site-nav-mobile]');
    assert(await mobile.isVisible(), `${spec.path} mobile navigation stayed hidden`);
  }
  assert.deepStrictEqual(consoleErrors, [], `${spec.path} console errors: ${consoleErrors.join(' | ')}`);
  await context.close();
  return { path: spec.path, viewport, facts, console_errors: consoleErrors };
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const warmup = await browser.newPage();
  await waitForDeployment(warmup);
  await warmup.close();
  const results = [];
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      for (const spec of EXPECTED) results.push(await inspectPage(browser, spec, viewport));
    }
  } finally { await browser.close(); }
  process.stdout.write(`${JSON.stringify({ schema: 1, status: 'passed', base_url: BASE_URL, checks: results.length, results }, null, 2)}\n`);
}

if (require.main === module) main().catch((error) => { process.stderr.write(`hosted site smoke failed: ${error.stack || error.message}\n`); process.exitCode = 1; });

module.exports = Object.freeze({ BASE_URL, EXPECTED, inspectPage, waitForDeployment });
