# Tasks

## 1. `core.js` pure helpers

- [x] 1.1 Export `ruleUsesModifiers(rule)` from `core.js`, encoding `(rule.once === true || rule.edge === 'rise' || rule.edge === 'fall') && typeof rule.id === 'string'`; refactor `evaluate()`'s inline modifier-detection check to call it. Verify: existing `evaluate()`/modifier tests in `test/core.test.js` still pass unchanged.
- [x] 1.2 Add `serializeModifierState(sessionState)` to `core.js`: build `{ v: 1, rules: <Object.create(null) bag of {lastMatch, fired} deep copies>, updatedAt: Date.now() }` from the live `Map`. Verify: unit test asserts the returned `rules` object has a `null` prototype and that mutating the source Map after serializing does not change the returned snapshot.
- [x] 1.3 Add `hydrateSessionState(payload)` to `core.js`: total, non-throwing function returning a valid `SessionState`. Reject non-object/array/null top-level payloads, `v !== 1`, or a non-object `payload.rules` — all return `createSessionState()`. Per rule-id entry, require an object and coerce `lastMatch`/`fired` via `=== true`; drop invalid entries without throwing. Iterate with `Object.entries()` into a `new Map()`. Verify: unit tests cover every rejected shape (`undefined`, `null`, `42`, `[]`, `"{"`, wrong `v`, non-object `rules`, a bad per-entry value, and a `__proto__` key) and confirm each yields a valid empty-or-partial state with no thrown error and no prototype pollution.
- [x] 1.4 Add a round-trip unit test: `hydrateSessionState(serializeModifierState(state))` reproduces the same `lastMatch`/`fired` values for every rule id in `state.modifierState`.

## 2. `plugin.v2.js` — single-flight hydration

- [x] 2.1 Precompute `modifierEventKinds: Set<string>` at rule-load time from the loaded rule list, using `ruleUsesModifiers()`. Verify: unit test confirms the set is empty for a rule set with no modifiers, and excludes a modifier rule declared without an `id`.
- [x] 2.2 Change `sessionStates` to `Map<sessionID, Promise<SessionState>>` and make `getSessionState(sessionID, { hydrate })` async: return the cached promise if present; for a non-gated event with no cached entry, return a transient uncached `Promise.resolve(createSessionState())`; otherwise construct and synchronously cache a new hydration promise (via `ctx.storage.get('modifierState:' + sessionID)` → `hydrateSessionState(...)`, or `createSessionState()` on a storage-read rejection) before any `await` inside it. Verify: a unit/integration test drives two concurrent calls for the same never-before-seen session against a deferred-resolution fake `ctx.storage.get`, and asserts exactly one `get` call and that both callers resolve to the identical state object.
- [x] 2.3 Add the `ctx.storage` capability guard (`if (!ctx.storage?.get) { ...warn once, in-memory-only path... }`) following the existing `if (ctx.tool?.hook)` precedent. Verify: existing `test/plugin-conformance.test.js` (whose fake V2 ctx has no `storage`) continues to pass unchanged, and a single setup-time warning is logged.

## 3. `plugin.v2.js` — persistence

- [x] 3.1 Add `writeChains: Map<sessionID, Promise<void>>` and `lastPersisted: Map<sessionID, string>`. Immediately after `evaluate()` returns (before the delivery loop), if `nev.kind` is in `modifierEventKinds`: synchronously serialize the current state via `serializeModifierState`, compare its `rules` JSON string against `lastPersisted.get(sessionID)`; if unchanged, skip; otherwise update `lastPersisted` and enqueue `ctx.storage.set('modifierState:' + sessionID, snapshot)` onto that session's write chain (`chain = chain.then(...).catch(logWarnOnce)`), without awaiting it inline. Verify: a test drives a modifier-state-changing event and asserts one `storage.set` call with the expected shape; a second identical (no-op) event asserts zero additional `set` calls; the handler function returns before the enqueued write promise settles.
- [x] 3.2 Seed `lastPersisted` for a session from its hydrated payload's `rules` string at hydration time, so a restart-then-no-change session issues zero writes. Verify: test hydrates a session with existing state, evaluates a no-change event, asserts zero `storage.set` calls.
- [x] 3.3 Subscribe to `session.deleted` (or the confirmed equivalent V2 event) and, on receipt, enqueue `ctx.storage.remove('modifierState:' + sessionID)` on that session's existing write chain (not issued directly), then after it settles clear the session's entries from `sessionStates`, `writeChains`, `lastPersisted`, `sessionAgents`, and `switchAgentLoggedFor`. Verify: test enqueues a pending write for a session, then fires `session.deleted`, and asserts the write completes before the remove call, and all five maps no longer contain the session id afterward.
- [x] 3.4 Add debug-mode hydration logging: when `debug` is on, log the session id, and for each hydrated rule id its `{lastMatch, fired}`, at the point hydration resolves. Verify: test with `debug: true` asserts a log line naming a hydrated rule id and its state; with `debug` unset or `false`, asserts no such line.

## 4. Tests and verification

- [x] 4.1 Create `test/plugin-v2-storage.test.js` covering (per design.md D19): hydrate-on-restart round-trip; single-flight under two simultaneous first-touch events; each malformed-payload shape from 1.3 surfacing correctly through the adapter (not just the pure helper); dirty-check suppressing a redundant write; write ordering under two rapid state-changing events for one session; `get`/`set` rejection fail-open (event processing continues, rule still evaluated); `session.deleted` removal ordering; and zero `ctx.storage` calls for a rule set with no `once`/`edge` rules.
- [x] 4.2 Run the full existing test suite (`npm test`) and confirm all pre-existing tests pass unchanged alongside the new ones.
- [x] 4.3 Run the project's linter and fix any diagnostics introduced by this change. (No linter is configured in this project — `npm test` runs `node --check` on every source file plus the full test suite; confirmed clean. LSP diagnostics for `core.js`/`plugin.v2.js` also came back empty.)

## 5. Documentation

- [x] 5.1 Update `README.md`'s "Known limitation" section (added in the prior `document-modifier-state-limitation` change) to state that V2 now persists `once`/`edge` state across a service restart via `ctx.storage`, that V1 remains in-memory-only, and to document the manual-reset note from design.md D15 (a rule id that is reused after being edited/removed/re-added resurrects its prior state; use a new rule id, or delete the plugin's storage entries, to force a reset).

## 6. Review and ship

- [x] 6.1 Self-review the diff for duplication, code smells, overengineering, and redundant comments per the `refactor` checklist; document any accepted findings.
- [x] 6.2 Get the change reviewed by `code-reviewer` (proposal → specs → diff); resolve every `[BLOCKER]`; explicitly accept or reject every `[WARNING]` with a stated reason.
- [ ] 6.3 Commit, run `openspec archive persist-modifier-state-ctx-storage --yes`, commit the archival, push the branch, and open a PR.
