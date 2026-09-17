## 1. Dependency and packaging setup

- [x] 1.1 Add `@opencode/plugin` and `@opencode/cli` as devDependencies; mark both `@opencode-ai/plugin` and `@opencode/plugin` optional peerDependencies (`peerDependenciesMeta`); verify `npm install` resolves cleanly from a clean `node_modules`
- [x] 1.2 Update `package.json`: `main`/`"."` and `"./v1"` resolve to `plugin.v1.js`, `"./v2"` to `plugin.v2.js`; verify both subpaths resolve via dynamic import

## 2. Extract the runtime-agnostic core (design.md §3)

- [x] 2.1 Create `src/core.js`: `loadRules`, `matchesAgents`, `checkCondition` (all 12 types operating on a `NormalizedEvent`), the per-session state machine (`prevTodos`, `allTodosCompleteOnceFired`, post-loop commit ordering), `buildFraming(rule)` returning `{system, text}`, `evaluate(normalizedEvent, sessionState) → Decision[]`, and a config-path resolver honoring an environment override (design.md D8) — no SDK imports, `log` injected; verify `node --check src/core.js` and no default export
- [x] 2.2 Rewrite `src/plugin.v1.js` (`git mv src/index.js src/plugin.v1.js` first) as a V1 adapter: normalizes V1 events (`properties` → `NormalizedEvent`) using the V1 event-source mapping (todo.updated/message.updated/tool.execute.after carry the payload directly), delivers via `client.session.promptAsync`, resolves agent via `client.session.get().data.agent`; verify behavior is unchanged from today's `src/index.js` (manual review — no pre-existing tests to regress)

## 3. V2 adapter (`src/plugin.v2.js`)

- [x] 3.1 Implement `Plugin.define({id, setup(ctx)})`: `ctx.event.subscribe({signal})` loop started detached (not awaited) in `setup()`, `AbortController` created and aborted in the returned cleanup; per-event handling fully guarded (one malformed event must not kill the loop); an `AbortError` after cleanup is expected (not logged as an error), any other throw is logged, an unexpected clean stream end is logged as a warning (design.md D6)
- [x] 3.2 Implement V2 event normalization: map `session.created` (`data.sessionID`/`data.agent`) directly; log one warning per rule at load time for any rule whose condition is todo-derived or tool-derived (`allTodosComplete`, `anyTodosComplete`, `noTodosInProgress`, `hasTodos`, `todoListCreated`, `todoListCleared`, `firstTodoStarted`, `allTodosCompleteOnce`, `todoCountAtLeast`, `toolName`, `toolNameIn`), since no V2 event carries this information (design.md D3(a) — the documented current-scope fallback; D3(b) synthesis from `session.message.content.updated` is out of scope for this change, recorded as future work in docs); map the nearest equivalent to `messageFinished` from `session.step.ended`'s `data.finish`, treating an error/failure finish as a non-match
- [x] 3.3 Implement delivery via `ctx.session.synthetic({sessionID, text, description, resume, metadata})`: `resume: false` when `rule.noReply`; `description` omitted when `rule.hidden`; framing text (from `core.js`'s `buildFraming`) prepended into `text` since `synthetic` has no `system` field; `metadata` set to `{plugin: 'opencode-auto-instruct', ruleId: rule.id}` for provenance; verify via adapter-conformance test that the correct fields are set for hidden/noReply/plain rule combinations
- [x] 3.4 Implement the `switchToAgent` guard: call `ctx.session.switchAgent({sessionID, agent: rule.switchToAgent})` before delivery, skipping the call when the target already equals the resolved agent, logging once per session per rule naming the previous agent (design.md D4); verify a test asserts the skip-when-equal case and the once-per-session-per-rule log
- [x] 3.5 Resolve agent via `ctx.session.get({sessionID})` — **unwrapped** result (`res.agent`, not `res.data.agent`, design.md D2's flagged silent-failure risk); verify a test asserts the correct field is read
- [x] 3.6 Implement stderr-only logging (V2's `Context.app` has no `log` method)

## 4. Spec compliance

- [x] 4.1 Confirm the delta spec's runtime-neutral wording (already drafted in `specs/rule-based-instruction-injection/spec.md`) matches what was implemented; verify `openspec validate v2-plugin-migration --strict` passes

## 5. Test suite (repo currently has zero tests)

- [x] 5.1 Layer 1 — `test/core.test.js`: unit tests for `loadRules` (merge order, missing/malformed config), `matchesAgents` (absent/`*`/string/array/unresolved-agent), all 12 `checkCondition` types (match + non-match cases, including `allTodosComplete` on an empty list, `todoCountAtLeast` with missing/non-numeric count, `toolNameIn` with a missing array, unknown condition type), the consistent prev/current pair across two transition rules in one event, `allTodosCompleteOnce`'s once-per-session + post-loop commit, and `buildFraming`'s hidden/non-hidden wording; verify all pass under `node --test`
- [x] 5.2 Layer 2 — one shared adapter-conformance suite executed against a fake V1 host and a fake V2 `ctx` (design.md §6 Layer 2): runtime-neutral assertions (matching rule delivers once, hidden/noReply/no-instruction behavior, one rule's delivery failure doesn't block another, no-session-ID events evaluate no rules, agent seeded from session.created) plus runtime-specific assertions (V1: `promptAsync` shape, `res.data.agent`; V2: `synthetic` shape, `res.agent`, `switchAgent` guard, envelope normalization, cleanup/abort behavior); verify all pass under `node --test`
- [x] 5.3 Add `package.json` `test` script running `node --check` on all three source files plus `node --test test/`

## 6. End-to-end verification (Layer 3, design.md §6 — release gate)

- [x] 6.1 Write `test/e2e/run.mjs`: a scratch-project run against the real, pinned `@opencode/cli` binary, using the config-path override (task 2.1's resolver) so no real user config is touched; a rule injects a unique sentinel string; assert the model's own response references the sentinel (positive evidence, not just absence of errors) — **this is the release-blocking gate**: if `ctx.session.synthetic()` does not reach model-visible context on the pinned 2.0.4 release, this port cannot ship as-is and must be escalated, not silently reworked
- [x] 6.2 In the same or a follow-up e2e run, verify: a hidden rule's synthetic row is not rendered in the TUI-visible output (or record that this could not be observed non-interactively); observed `switchAgent` persistence behavior for the README; a V1 regression run (same rule config against the V1 runtime) proving the refactor didn't change V1 behavior

## 7. Documentation

- [x] 7.1 Rewrite `docs/v2-compat-audit.md`: real V2 port status, the confirmed API mapping (synthetic vs prompt, resume vs noReply, unwrapped session.get), the D3(a) todo/tool-condition limitation and what would be needed to lift it, the D4 switchToAgent persistence behavior, and the measured Layer-3 results; update any repro-step paths from `src/index.js` to `src/plugin.v1.js`
- [x] 7.2 Update `README.md`'s rule reference to document the V1/V2 `switchToAgent` divergence and the V2 todo/tool-condition limitation

## 8. Final verification and review

- [x] 8.1 Run `npm test` (Layers 1-2) and the e2e script (Layer 3); verify both green, or explicitly escalate if gate 1 (synthetic visibility) fails
- [x] 8.2 Run `openspec validate v2-plugin-migration --strict`; verify it passes
- [x] 8.3 Commission `code-reviewer` for the full diff (proposal → specs → design → diff); resolve every `[BLOCKER]`, explicitly accept or reject every `[WARNING]`
