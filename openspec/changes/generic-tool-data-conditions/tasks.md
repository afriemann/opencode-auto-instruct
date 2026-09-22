# Tasks

## 1. Core resolver and equality primitives (`src/core.js`)

- [x] 1.1 Implement the dot-path resolver (D10): object-key and numeric-index segments, `__proto__`/`constructor`/`prototype` segment rejection returning not-applicable, and verify with unit tests covering nested keys, array indices, and each rejected prototype segment
- [x] 1.2 Implement the deep-equality helper (D7) and verify with unit tests covering primitives, nested arrays/objects, and key-order independence

## 2. Data-predicate condition evaluators (`src/core.js`)

- [x] 2.1 Implement `dataArrayEmpty` / `dataArrayNonEmpty` / `dataArrayLengthAtLeast` and verify with unit tests for each, including a non-array resolved value (not applicable)
- [x] 2.2 Implement the `{field, value}` matcher and `dataArrayAllMatch` / `dataArrayAnyMatch` / `dataArrayNoneMatch` (D6), and verify with unit tests including the `field: ""` element-comparison case
- [x] 2.3 Implement `dataEquals` (D7) and `dataNumberAtLeast` (D8), and verify with unit tests including a non-numeric resolved value for `dataNumberAtLeast` (not applicable)
- [x] 2.4 Implement tri-state "not applicable" propagation (D4) uniformly across all `data*` evaluators — verify with a unit test asserting no `once`/`edge` state update occurs when a condition is not applicable
- [x] 2.5 Implement optional `tool`/`toolIn` scoping on `data*` conditions (D5) and verify with a unit test showing an unrelated tool's completion is not applicable even when its metadata coincidentally contains the configured path

## 3. `once` / `edge` rule modifiers (`src/core.js`)

- [x] 3.1 Implement per-rule boolean-only state storage keyed by `rule.id`, with load-time detection and a single warning when `once`/`edge` is set without an `id` (D11), verified by a unit test for both the warning and the fail-closed (modifier ignored) behavior
- [x] 3.2 Implement `once` gating (fire at most once per session, marked fired after the full rule loop regardless of delivery outcome) and verify with a unit test
- [x] 3.3 Implement `edge: "rise"|"fall"` transition detection against each rule's own prior stored boolean and verify with a unit test covering both directions
- [x] 3.4 Implement the batch-commit invariant — all rules in one event read pre-event state and updates commit only after the full loop — and verify with a unit test using two rules with `edge` modifiers on the same event
- [x] 3.5 Verify the two condition-less modifier cases from design.md D14 (`once` fires first-event-only; `edge: "rise"` fires first-event-only) with dedicated unit tests

## 4. Load-time validation (`src/core.js`)

- [x] 4.1 Implement the generic "unknown condition type" warning and verify with a unit test
- [x] 4.2 Implement per-type missing/invalid `path`, `value`, `count`, or matcher warnings (D16) and verify with unit tests for each `data*` type
- [x] 4.3 Implement the specific removed-legacy-type warning (naming the type, distinct from the generic unknown-type warning) for all nine removed condition type names, and verify with a unit test
- [x] 4.4 Implement the specific `event: "todo.updated"` removal warning and verify with a unit test

## 5. Remove legacy todo-derived mechanism (`src/core.js`)

- [x] 5.1 Remove the nine todo-derived condition evaluators, `V2_UNSUPPORTED_CONDITION_TYPES`, `V2_UNSUPPORTED_EVENT_TYPES`, `prevTodos` tracking, and the `todos` field from `NormalizedEvent` — verify with `grep -rn "todos\|allTodosComplete\|todoListCreated" src/` returning no matches outside comments/docs referencing the migration table

## 6. V1 adapter: real tool-completion normalization (`src/plugin.v1.js`)

- [x] 6.1 Add the `message.part.updated` branch with the cheap early bail (`part.type === 'tool' && part.state.status === 'completed'`) before any other work, verified by a unit test asserting no session/agent resolution work occurs for a non-matching part
- [x] 6.2 Extract session ID from `properties.part.sessionID` for this branch, leaving the existing `properties.sessionID`/`properties.info.id` path unchanged for all other V1 event kinds, and verify with a unit test
- [x] 6.3 Extract `toolName` from `part.tool` and `toolMetadata` from `part.state.metadata` only (not `part.metadata`), emitting the synthetic `kind: "tool.execute.after"`, and verify with a unit test
- [x] 6.4 Implement per-session `callID` dedupe so repeated `message.part.updated` deliveries for the same completed tool call produce exactly one normalized event, verified by a unit test simulating two deliveries for the same `callID`
- [x] 6.5 Build V1 test fixtures that mirror the real `EventMessagePartUpdated`/`ToolPart`/`ToolStateCompleted` shapes exactly, including `part.sessionID` nesting — replacing any hand-invented `tool.execute.after`-shaped fixtures
- [x] 6.6 Add the bug-fix-in-isolation scenario: `toolName`/`toolNameIn` fire correctly on V1 via the real `message.part.updated` path with no data condition present

## 7. V2 adapter: expose tool-result metadata (`src/plugin.v2.js`)

- [x] 7.1 Extend `normalizeToolEvent()` to read `toolEvent.result?.metadata` into `toolMetadata` only when `status === "completed"`, `null` otherwise, and verify with a unit test for both the completed and error branches

## 8. Debug-mode observability (both adapters / `src/core.js`)

- [x] 8.1 Implement debug-mode key-path logging (tool name plus key paths to one level of nesting, with optional `typeof`/length, never resolved values) and verify with a unit test asserting no configured metadata value string appears in the emitted log line

## 9. Conformance and end-to-end verification

- [x] 9.1 Update `test/plugin-conformance.test.js` and `test/e2e/run.mjs` fixtures/assertions to the new condition vocabulary and the corrected V1 tool-event shapes
- [x] 9.2 Run the full test suite and linters and verify all pass with no suppressed failures

## 10. Documentation

- [x] 10.1 Update `README.md`: document the new condition schema, `once`/`edge` modifiers, the migration table, and fix the install section's stale `src/index.js` reference
- [x] 10.2 Update `docs/v2-compat-audit.md` to remove the now-inaccurate claims that V1 emits a generic `tool.execute.after` event and that V2 has a permanent todo-condition gap

## 11. Release

- [x] 11.1 Bump `package.json` version to reflect the breaking change
- [x] 11.2 Self-review the full diff for duplication, code smells, overengineering, and redundant comments per the `refactor` skill checklist
