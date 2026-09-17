## 1. V2 tool-hook event intake (specs: toolName/toolNameIn on V2)

- [x] 1.1 Add a `tool.hook("execute.after", ...)` normalizer path in `src/plugin.v2.js`: map the hook payload `{tool, sessionID, agent, messageID, id, input, status, result|error}` into `NormalizedEvent` with `kind: 'tool.execute.after'`, `toolName: tool`; verify by unit-testing the normalizer in isolation or via the conformance suite
- [x] 1.2 Register the hook in `setup(ctx)` alongside the existing `ctx.event.subscribe()` loop (a second, independent intake path — not nested inside it), routing normalized events through the same `evaluate()`/decision-delivery pipeline already used for `ctx.event.subscribe()` events; verify no regression to the existing event-subscribe path (existing conformance tests still pass)
- [x] 1.3 Remove `toolName`, `toolNameIn` from `V2_UNSUPPORTED_CONDITION_TYPES` and remove `'tool.execute.after'` from `V2_UNSUPPORTED_EVENT_TYPES` in `src/core.js`; verify `node --check src/core.js`

## 2. Test suite updates (spec: rule-based-instruction-injection MODIFIED Condition Evaluation)

- [x] 2.1 Add a `tool.hook` fake to `test/plugin-conformance.test.js`'s fake V2 `ctx` (records registered callbacks, exposes an `emitToolEvent(event)` helper mirroring the existing `emitEvent`); verify the fake is usable independent of the event-subscribe fake
- [x] 2.2 Add test: `toolName matches a tool-hook event on V2` — a rule with `condition: {type: "toolName", tool: "bash"}` matches when the fake tool hook fires `{tool: "bash", status: "completed", ...}`; verify it passes
- [x] 2.3 Add test: `toolNameIn matches a tool-hook event on V2` — analogous, with `toolNameIn`; verify it passes
- [x] 2.4 Update the existing warn-and-skip tests (`warns once at load time for a rule with an unsupported condition type`, `warns once at load time for a rule bound to an unsupported trigger event`, `warns exactly once...`, `todo-derived and tool-derived conditions never match on V2`) to use only todo-derived condition types/`todo.updated` as their unsupported example, since `toolName`/`tool.execute.after` are no longer unsupported; verify all pass
- [x] 2.5 Run `npm test` (Layers 1-2); verify all green with no regressions

## 3. Documentation

- [x] 3.1 Update `docs/v2-compat-audit.md`: document the `ctx.tool.hook` fix for `toolName`/`toolNameIn` (with the source citation: `packages/core/src/tool.ts`, `packages/plugin/src/promise/adapter.ts`, tag v2.0.6) and correct the reasoning for the remaining 9 todo-derived conditions to "no server-side todo-management tool exists in V2 at all" rather than "no dedicated todo.* event"
- [x] 3.2 Reframe `README.md`'s `switchToAgent` V1/V2 divergence note from a "V1 regression" framing to an intentional durable-handoff feature, referencing the `review-on-completion` example pattern; no functional change
- [x] 3.3 Run `openspec validate fix-v2-tool-hook-condition-support --strict`; verify it passes

## 4. Final verification

- [x] 4.1 Confirm `npm test` is green end-to-end (all three source files pass `node --check`, all Layer 1-2 tests pass)
- [x] 4.2 Self-review the full diff against the `refactor` checklist (duplication, code smells, overengineering, redundant comments) since no `code-reviewer` subagent is reachable in this environment (no `task` tool available); document findings inline in the PR/commit
