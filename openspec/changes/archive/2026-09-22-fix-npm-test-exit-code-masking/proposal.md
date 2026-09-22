# Proposal

## Why

`package.json`'s `test` script runs `node --test=test/`. Empirically confirmed:
this invocation exits `0` even when tests fail — it triggers a
"`node:test` `run()` is being called recursively within a test file, skipping
running files" warning and reports one pass per test *file* regardless of
that file's actual per-test results. `node --test test/` (no `=`) is
unaffected: it discovers and runs every test correctly and exits non-zero on
any failure. This was discovered while verifying a separate change ("verify
tests pass") returned a false-positive green from `npm test` while
`node --test test/` directly showed real failures. `npm test` currently
cannot be trusted to catch a regression.

## What Changes

- Change `package.json`'s `test` script from `node --test=test/` to
  `node --test test/` (drop the `=`) so failures propagate to a non-zero exit
  code as normal.
- No change to test content, `test:e2e`, or any other script.

## Capabilities

No capability's spec-level behaviour changes — this is a build-tooling
correctness fix with no observable product behaviour affected. `skip_specs`
is set in `.openspec.yaml`.

## Impact

- `package.json` — one script line.
