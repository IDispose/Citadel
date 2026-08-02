'use strict';

// Map the runtime keywords `node`/`bun` in a command-array's executable slot to
// the executable actually running this process, so scenario/verifier/adapter
// command arrays authored as `["node", ...]` work under Bun (and vice versa).
// Any other executable is returned unchanged.
function resolveRuntimeExecutable(command) {
  return command === 'node' || command === 'bun' ? process.execPath : command;
}

module.exports = { resolveRuntimeExecutable };
