#!/usr/bin/env bun

'use strict';

const path = require('path');
const { createEnvelope } = require(path.join(__dirname, '..', '..', '..', 'core', 'hooks', 'normalize-event'));

function normalizeCodexHookInput(payload) {
  return createEnvelope('codex', payload.hook_event_name, payload);
}

module.exports = Object.freeze({
  normalizeCodexHookInput,
});
