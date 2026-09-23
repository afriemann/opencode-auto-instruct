# Proposal

## Why

A rule's `once`/`edge` modifier state (tracked in `sessionStates`, an in-memory `Map` created fresh per session inside `plugin.v1.js`/`plugin.v2.js`) lives only for the lifetime of the running opencode Node process. When the opencode service restarts mid-session — which happens in normal operation — every session's tracked modifier state is silently wiped, even though the underlying conversation session continues unchanged. The next matching event after a restart is misclassified against a false "never fired" baseline, causing `once`/`edge`-gated rules to spuriously re-fire (root cause of a real incident: `todo-creation-note`'s `edge: "rise"` rule re-fired mid-session after a service restart, alongside other rules, producing a confusing burst of contradictory notes).

The immediate incident was worked around by reformulating the specific rule (`todo-creation-note`) as a stateless condition in ai-dotfiles' rule config — no engine change was needed for that one case, and it remains the preferred fix whenever a rule's intent can be expressed statelessly (see `README.md`'s "Known limitation" section, added by change `document-modifier-state-limitation`). But the underlying gap remains for any rule — present or future — that genuinely needs `once`/`edge` semantics and cannot be reformulated statelessly (e.g. a true "fire exactly once ever" rule with no stateless equivalent). V2 ships a documented, durable, disk-backed plugin storage API (`ctx.storage` — `get`/`set`/`remove`/`scan`, JSON-valued, namespaced per plugin, explicitly recommended by opencode's own V1→V2 migration guidance for exactly this need: "use `ctx.storage` instead of inventing a global file when state belongs to a plugin"). This change closes the durability gap generally, for every `once`/`edge` rule, on V2.

## What Changes

- On V2 only, modifier (`once`/`edge`) state for a session is persisted to `ctx.storage`, keyed per session, immediately after every event evaluation that could have updated it — surviving an opencode service restart within the same conversation session.
- On session-state first access within a process, if no in-memory state exists yet for that session, the plugin hydrates it from `ctx.storage` before falling back to a fresh empty state — so a restart resumes from the last persisted state rather than losing it.
- `core.js` gains two small, pure, runtime-agnostic serialization helpers (Map ⇄ JSON-plain-object) so the persisted shape is defined once and unit-testable independently of any runtime adapter; `core.js`'s `evaluate()`/`createSessionState()` themselves remain synchronous and unchanged — no I/O is added to the runtime-agnostic core.
- As an optimization, hydration and persistence are skipped entirely when no loaded rule declares a `once`/`edge` modifier — no storage calls are made for a rule set that never uses this feature.
- V1 (`plugin.v1.js`) is unchanged: no `ctx.storage` equivalent exists in the legacy `@opencode-ai/plugin` runtime, so V1 keeps its current in-memory-only behavior and the previously documented restart-durability limitation continues to apply there.
- The already-shipped `todo-creation-note` fix (stateless condition, no `once`/`edge`) is left as-is — it is simpler and runtime-identical, and this change does not reintroduce `edge: "rise"` for it.
- `README.md`'s "Known limitation" section is updated to state that V2 now persists this state across a restart, while V1 does not.
- A storage read/write failure (e.g. a corrupt or unreadable stored value) is logged as a warning and treated as no prior state — never thrown, never fatal to event processing.
- On V2, a session's persisted modifier state is removed from `ctx.storage` when a `session.deleted` event fires, bounding storage growth to live sessions rather than accumulating indefinitely.

## Capabilities

### Modified Capabilities

- `rule-based-instruction-injection`: the "Condition Evaluation" requirement gains a one-sentence link stating that `once`/`edge` state durability across a process restart is runtime-dependent and defined by a new dedicated requirement (durability is a state-lifecycle concern, not a condition-evaluation concern, and this requirement is already the largest in the spec).

### New Capabilities

- `rule-based-instruction-injection`: a new requirement, "Modifier State Durability", specifying: the V2 persistence guarantee (state survives an opencode service restart within the same session), the V1 non-guarantee (state does not survive a restart, unchanged from today), hydrate-on-first-access-per-process semantics, single-flight hydration under concurrent events, total/non-throwing treatment of malformed or corrupted stored state (treated as no prior state), and storage-entry removal on `session.deleted`.

## Impact

- `src/core.js`: two new pure helper functions (serialize/hydrate modifier state); no change to `evaluate()`'s or `createSessionState()`'s signatures or synchronous contract.
- `src/plugin.v2.js`: `getSessionState` becomes async and storage-aware (hydrate-on-miss); a persistence call is added after each `evaluate()` invocation, gated on whether any loaded rule uses `once`/`edge`.
- `src/plugin.v1.js`: no code change.
- `README.md`: the existing "Known limitation" section is updated (not removed — the V1 gap remains real).
- `test/core.test.js`: new unit tests for the serialization helpers.
- `test/plugin-conformance.test.js` (or the V2-specific test file, to be confirmed against the existing test layout): new tests asserting hydrate-on-restart and skip-when-unused behavior against a mocked `ctx.storage`.
- No new dependencies. No configuration schema change (rule authors write `once`/`edge` exactly as before; the durability change is transparent).
