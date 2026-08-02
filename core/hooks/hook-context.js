#!/usr/bin/env bun

'use strict';

function toLegacyHookPayload(envelope) {
  const payload = {
    tool_name: envelope.tool_name,
    tool_input: envelope.tool_input,
  };

  if (envelope.session_id) payload._session_id = envelope.session_id;
  if (envelope.turn_id) payload._turn_id = envelope.turn_id;
  if (envelope.runtime) payload._runtime = envelope.runtime;
  if (envelope.event_id) payload._event_id = envelope.event_id;
  if (envelope.native_event_name) payload._native_event_name = envelope.native_event_name;
  if (envelope.cwd) payload._cwd = envelope.cwd;
  if (envelope.transcript_path) payload._transcript_path = envelope.transcript_path;
  if (envelope.model) payload._model = envelope.model;

  return payload;
}

module.exports = Object.freeze({
  toLegacyHookPayload,
});
