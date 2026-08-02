# `@citadel/contracts`

Dependency-free public contract surface for Citadel runtimes, clients, and
future hosted products. The package is alpha at `0.1.x`.

It is publishable and installable from its own directory without the Citadel
repository's `core/` tree:

```bash
npm pack ./packages/contracts
npm install ./citadel-contracts-0.1.0.tgz
```

It is not yet represented as registry-published evidence. Until a release is
actually published, external conformance should pin the generated tarball
digest rather than assume `npm install @citadel/contracts` resolves publicly.

## Purpose

This package will expose the stable schemas and types that external consumers are allowed to depend on.

Initial scope:

- event envelope definitions
- runtime capability contracts
- skill and agent manifest contracts
- project spec contracts
- operations protocol v0.1 contracts and canonical digests

## Source of Truth

Initial implementations should be adapted from:

- `core/contracts/events.js`
- `core/contracts/runtime.js`
- `core/contracts/capabilities.js`
- `core/contracts/skill-manifest.js`
- `core/contracts/project-spec.js`
- `core/contracts/agent-role.js`
- `core/operations/index.js`

The machine-readable operations declaration is
`schemas/operations-v0.1.json`. The executable CommonJS validators are exported
as `require('@citadel/contracts').operations`.

## Boundary Rule

This package should be smaller and more stable than the internal `core/contracts` implementation surface.

Cloud and external integrations should depend on this package, not on `core/*`.
The checked-in `vendor/` modules are generated public contract artifacts. Run
`bun scripts/generate-public-contracts.js --check` at the Citadel root to prove
they match the canonical contract sources.
