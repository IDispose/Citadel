#!/usr/bin/env bun

'use strict';

const path = require('path');
const { createEnvelope } = require(path.join(__dirname, '..', '..', '..', 'core', 'hooks', 'normalize-event'));

function normalizeClaudeHookInput(payload) {
  return createEnvelope('claude-code', payload.hook_event_name || payload.event_name, payload);
}

module.exports = Object.freeze({
  normalizeClaudeHookInput,
});
