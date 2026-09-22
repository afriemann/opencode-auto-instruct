# Proposal

## Why

CI on PR #3 is failing on both the Node 22 and Node 24 jobs after the `fix-npm-test-exit-code-masking` change. That change replaced `node --test=test/` with `node --test test/` to stop `npm test` from silently masking failures. The replacement command was only verified locally on Node v26.9.0, where a bare directory argument to `--test` is (leniently) treated as a recursive glob. On Node 22.23.2 and Node 24.20.0 — the exact versions the project's CI matrix runs — `node --test <dir>` instead tries to resolve `<dir>` as a single module to load, which fails immediately with `Cannot find module '.../test'` and aborts before any test runs. This was reproduced directly in Docker containers matching CI (`node:22`, `node:24`), isolating the Node version as the only variable versus the local success.

## What Changes

- Change the `test` script in `package.json` to pass an explicit, quoted glob pattern (`"test/**/*.test.js"`) to `node --test` instead of the bare directory path `test/`. This is the invocation form Node's own CLI documentation shows for explicit test-file targeting, and it works identically across Node 22, 24, and the local version — confirmed by direct reproduction, including a deliberate-break/revert regression check that still reports the correct non-zero exit code on failure.
- The glob also correctly excludes `test/e2e/run.mjs` (a separate e2e runner script, not a unit test file), which a bare `node --test` (no path argument) would otherwise pick up and fail.

No production logic changes; no test behavior changes; purely a test-runner invocation fix.

## Capabilities

No spec-level behavior changes — this is a build-tooling fix only (`skip_specs: true` set in `.openspec.yaml`).

## Impact

- `package.json` — `test` script only.
