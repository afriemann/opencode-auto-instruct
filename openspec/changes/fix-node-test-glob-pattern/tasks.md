# Tasks

## 1. Fix the test script

- [x] 1.1 Change `package.json`'s `test` script from `node --test test/` to `node --test "test/**/*.test.js"` and verify `npm test` passes locally (98/98) with exit code 0.

## 2. Cross-version verification

- [x] 2.1 Verify the fixed script passes on Node 22 and Node 24 (matching the CI matrix) via Docker containers `node:22`/`node:24`, and confirm `test/e2e/run.mjs` is correctly excluded from unit-test discovery.
- [x] 2.2 Regression-check the exit code: deliberately break one assertion, confirm `npm test` (or the equivalent container invocation) exits non-zero with the real failure reported, then revert.
