# Tasks

## 1. Fix the masking script

- [x] 1.1 Change `package.json`'s `test` script from `node --test=test/` to `node --test test/`
- [x] 1.2 Verify the fix catches a real failure: temporarily break an assertion in a test file, confirm `npm test` now exits non-zero, then revert the temporary breakage — confirmed: `npm test` exited 1 with the correct failing-test report while the breakage was in place
- [x] 1.3 Run `npm test` on the actual (unbroken) suite and confirm it passes with exit 0 — confirmed: 98/98 pass, exit 0
