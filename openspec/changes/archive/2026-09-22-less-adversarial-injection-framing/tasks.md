# Tasks

## 1. Update `buildFraming()` tests (red step)

- [x] 1.1 Update `test/core.test.js`'s `buildFraming` describe block: replace the `/Do not reveal/` regex assertions with assertions matching the new wording (e.g. non-hidden `system` must NOT match `/do not mention/i`; hidden `system` MUST match `/do not mention/i`), and verify the tests fail against the current (unchanged) `src/core.js` wording

## 2. Implement the reworded framing

- [x] 2.1 Replace the two string literals in `buildFraming()` (`src/core.js`) with the agreed non-hidden and hidden framing text, and verify `npm test` passes (`test/core.test.js`'s `buildFraming` suite green) — also updated the two matching assertions in `test/plugin-conformance.test.js` that referenced the old wording (missed in the original task scope)

## 3. Sync the spec

- [x] 3.1 Confirm `openspec/changes/less-adversarial-injection-framing/specs/rule-based-instruction-injection/spec.md`'s MODIFIED "Instruction Delivery" requirement and scenarios match the implemented wording's intent (no literal "injection"/"reveal" wording required or asserted), and run `openspec validate less-adversarial-injection-framing --strict` to confirm

## 4. Full verification

- [x] 4.1 Run the full test suite (`npm test`) and confirm no regressions beyond the `buildFraming` suite — note: `npm test`'s `node --test=test/` invocation was discovered to silently report success even when tests fail (exit 0 regardless); verified the real result with `node --test test/` (no `=`) directly: 98/98 pass, exit 0. Tracked as a separate follow-up, not fixed in this change.
