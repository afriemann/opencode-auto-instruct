# Design

## Context

See `proposal.md` — Why, for the motivation and the incident that surfaced this gap. This section records only the current-state facts that constrain the approach.

**Where the state lives today.** `core.js`'s `createSessionState()` returns `{ modifierState: new Map() }`. `evaluate()` (`src/core.js`) is synchronous and pure with respect to I/O: it reads each modifier-using rule's prior `{lastMatch, fired}` out of that Map, accumulates every update into a local `pendingModifierUpdates` array, and commits them all in one trailing loop *after* the full per-event rule pass. That commit-together property is load-bearing — it is what makes two `edge` rules evaluated against the same event see a mutually consistent prior state (already specified in `openspec/specs/rule-based-instruction-injection/spec.md`, "Condition Evaluation"). Any design that introduces an `await` into the evaluation pass would break it.

**Who owns the Map.** Both adapters hold a `sessionStates: Map<sessionID, SessionState>` and a trivial synchronous `getSessionState(sessionID)` that lazily inserts a fresh state. Nothing ever writes it to disk, so it dies with the Node process.

**Two concurrent intake paths on V2.** `src/plugin.v2.js`'s `handleNormalizedEvent(nev)` is invoked from `ctx.tool.hook('execute.after', …)` *and* from the `ctx.event.subscribe()` async-iterator loop. These are genuinely independent; neither serializes against the other. `handleNormalizedEvent` already `await`s (`resolveAgent`, `ctx.session.synthetic`, `ctx.session.switchAgent`), so the two paths can interleave at any await point. Today that is harmless because `getSessionState` is synchronous and cannot be re-entered mid-way. The moment hydration becomes async, it can be — this is the single hardest constraint in this design.

**What V2 offers.** `ctx.storage` — a durable, disk-backed, SQLite-backed, per-plugin-namespaced JSON KV store with `get(key)`, `set(key, value)`, `remove(key)`, `scan({prefix, after?, limit?})`. Confirmed present at the pinned floor (`@opencode/plugin ^2.0.4`) against an installed copy. V2 also emits a real `session.deleted` event (confirmed by source read of `packages/core/src/bus.ts` and `session/message-updater.ts` in the local opencode-v2 checkout).

**What V1 offers.** Nothing equivalent. `src/plugin.v1.js` receives `{ client }` — the opencode SDK HTTP client (`client.session.*`, `client.app.log`). There is no plugin-scoped storage namespace anywhere in that surface, and the only durable thing reachable is the session itself, which the plugin does not own and must not scribble state into. V1 therefore stays in-memory-only.

**Hard constraints carried into this design:** `evaluate()` stays fully synchronous; `plugin.v1.js` gets zero functional changes; no new npm dependencies; no new config/schema keys (durability is transparent to `auto-instruct.json` authors).

## Goals / Non-Goals

**Goals:**

- On V2, a session's `once`/`edge` modifier state survives an opencode service restart within the same conversation session.
- Hydration is correct under the two concurrent intake paths — exactly one read per session per process, no lost-update between interleaved handlers.
- A corrupt, truncated, adversarial, or version-unknown stored payload can never make `evaluate()` throw, and can never wedge a session into a permanently broken state.
- Rule sets that use no modifiers pay zero storage cost — no reads, no writes.
- The persisted shape is defined once, in `core.js`, as pure functions that are unit-testable with no runtime adapter in the loop.
- Storage growth is bounded by live sessions, not by all sessions ever created.

**Non-Goals:**

- Durability on V1 — impossible without a storage surface; explicitly unchanged.
- Cross-process coordination or distributed locking (see Risks).
- A new config knob to opt out of persistence, or to reset a rule's state (see Decisions, D15).
- Persisting `sessionAgents` or `switchAgentLoggedFor` (see D12).
- Fixing the pre-existing agent-filter staleness interaction (see D17).
- Migrating or back-filling state for sessions that were already running before this change ships — they simply start with no stored state, which is exactly the fail-open path.

## Decisions

### D1 — Single-flight hydration: cache the *promise*, not the value

`sessionStates` changes type from `Map<sessionID, SessionState>` to `Map<sessionID, Promise<SessionState>>`, and `getSessionState` becomes `async`.

The critical detail is ordering: the promise is constructed and inserted into the map **synchronously, before the first `await`**. A second concurrent caller arriving while the storage read is still in flight finds the pending promise and awaits *it*, rather than issuing a second `ctx.storage.get()` and building a second state object.

```js
function getSessionState(sessionID, { hydrate }) {
  const cached = sessionStates.get(sessionID)
  if (cached) return cached
  if (!hydrate) return Promise.resolve(createSessionState())   // transient, see D6
  const promise = hydrateFromStorage(sessionID)                // async, but NOT awaited here
  sessionStates.set(sessionID, promise)                        // insert before any await
  return promise
}
```

*Alternative rejected:* caching the resolved value and guarding with an `inFlight` set. It works but needs a second map plus a waiter list — strictly more state for the same guarantee. Caching the promise makes single-flight a property of the data structure rather than of hand-written coordination code.

*Alternative rejected:* a global mutex around `handleNormalizedEvent`. This would serialize the tool-hook path behind the event path for every event, including the overwhelming majority that touch no modifier state, and would convert a storage-latency spike into plugin-wide head-of-line blocking.

### D2 — Hydration is total and non-throwing, and lives in `core.js`

A new pure exported function in `core.js` — proposed signature `hydrateSessionState(payload): SessionState` — is the *only* place a stored payload is interpreted. It is total: every input, including `undefined`, `null`, `42`, `[]`, `"{"`, or a well-formed object with hostile values, maps to a valid `SessionState`.

Rules it enforces:

- Top-level payload must be a non-null, non-array plain object; otherwise return `createSessionState()`.
- `payload.v` must equal the current version constant (`1`); unknown or missing → treat as no prior state.
- `payload.rules` must be a non-null, non-array object; otherwise no prior state.
- Per entry: the value must be a non-null object; `lastMatch` and `fired` are coerced with `=== true`. An entry failing the object check is **dropped**, not thrown on — one bad entry must not discard the other fifty good ones.
- Iterate with `Object.entries()` into a `new Map()`. Never `for…in`, never bare `obj[key]`.

Anything the caller could not even read (a rejected `ctx.storage.get()`, a JSON parse failure inside the host) is handled one level up by D9 and also yields a fresh state.

The reason this is a hard requirement rather than defensive politeness: `evaluate()` reads `sessionState.modifierState.get(id)` on every event. A hydrated state carrying a non-Map, or a Map whose values are strings, would throw *on every subsequent event for that session* — a permanently wedged session that no retry clears, because the same bad payload is re-read on every process start. Totality here is what makes the failure mode transient instead of sticky.

*Alternative rejected:* validating with a schema library. Adds a dependency for roughly fifteen lines of checks, against a payload shape this project fully owns.

### D3 — Prototype-pollution-safe serialization, with a deep copy

The mirror function, `serializeModifierState(sessionState): object`, builds its `rules` bag with `Object.create(null)` so that a rule id of `__proto__`, `constructor`, or `prototype` becomes an ordinary own key rather than mutating an object prototype. Rule ids come from a user-authored JSON config file; treating them as untrusted keys costs nothing.

It also **deep-copies** each entry into a fresh `{ lastMatch, fired }` plain object. It must never alias the live objects held in the Map — `evaluate()` mutates those in place (`state.lastMatch = matched`), so an aliased snapshot handed to an async write would silently reflect a *later* event's state, or a half-updated one.

**Serialization happens synchronously at enqueue time, not inside the queued write.** This is the same hazard one step further out: if the `JSON.stringify` ran inside the `.then()` of the write chain, a second event could have already mutated the Map by the time it executed, and the write would persist a state that was never a consistent commit point. Snapshot first, enqueue the snapshot.

### D4 — Persisted shape

```json
{ "v": 1, "rules": { "<ruleId>": { "lastMatch": true, "fired": false } }, "updatedAt": 1758648000000 }
```

`v` is an explicit envelope version so a future shape change is a recognisable no-prior-state rather than a silent misparse. `updatedAt` is diagnostic only — nothing reads it. It is deliberately **excluded from the dirty-check comparison** (D5), because including it would make every snapshot differ from the last and defeat the check entirely; it is stamped on at write time.

*Alternative rejected:* persisting the `Map` via a JSON array of pairs. Marginally more faithful to the in-memory type, but less readable when a human inspects the SQLite row, and the object form is what makes `Object.create(null)` the natural pollution guard.

### D5 — Dirty-check by serialized string, not by time-debounce

Before writing, compare the freshly serialized `rules` JSON string against the last string persisted for that session (`lastPersisted: Map<sessionID, string>`). If identical, skip the `ctx.storage.set()` call entirely.

`evaluate()` writes a modifier update on *every* applicable evaluation of a modifier-using rule, including the overwhelmingly common "no change" case (`lastMatch` re-set to the same boolean). Without this check, a busy `tool.execute.after` rule would issue a disk write per tool call. With it, writes occur only on genuine transitions.

`lastPersisted` is seeded from the hydrated payload at hydration time, so a session that restarts and then evaluates without changing anything issues no write at all.

*Alternative rejected: a time-based debounce.* Explicitly rejected — a debounce window is precisely a window in which a crash loses the state, which is the exact bug this change exists to close. A dirty-check gives the same write-amplification reduction with no durability hole: every state transition is enqueued immediately.

### D6 — Event-kind gating, and what happens to non-modifier events

At rule-load time, precompute `modifierEventKinds: Set<string>` — the set of `rule.event` values for which at least one loaded rule satisfies `ruleUsesModifiers(rule)`. Hydration and persistence are gated on `modifierEventKinds.has(nev.kind)`. When the set is empty (the common case for most rule sets), the plugin makes no storage calls at all and behaves exactly as it does today.

This creates one subtlety worth stating explicitly. If a non-modifier-kind event arrives first for a session, it still needs *a* `sessionState` to pass into `evaluate()`. Caching an un-hydrated fresh state under that session id would poison the cache — the later modifier-kind event would find it and never hydrate.

The resolution: for a non-gated event with no cached entry, return a **transient, uncached** `createSessionState()`. This is safe by construction, not by luck: `evaluate()` only touches `modifierState` for rules whose `event === nev.kind`, and `checkCondition` ignores `sessionState` entirely (its parameter is named `_sessionState` and is documented as kept only for call-site symmetry). So for a kind with no modifier-using rules, the transient state is guaranteed to be discarded still empty. Nothing is lost by throwing it away.

*Alternative rejected:* hydrate on every event kind and gate only the writes. Simpler control flow, but it pays a storage read per session for rule sets that can never use the result.

### D7 — One shared `ruleUsesModifiers(rule)` predicate

`core.js` exports a single predicate encoding today's inline condition:

```js
export function ruleUsesModifiers(rule) {
  return (rule.once === true || rule.edge === 'rise' || rule.edge === 'fall')
    && typeof rule.id === 'string'
}
```

`evaluate()` is refactored to call it in place of its current inline expression, and the adapter's `modifierEventKinds` computation calls the same function. The `typeof rule.id === 'string'` clause matters as much as the modifier clause: a modifier declared without an `id` is spec-defined to be treated as absent, so such a rule must *not* pull its event kind into the gating set and must not trigger storage traffic.

Two copies of this condition that disagree would produce the worst possible failure — a rule whose state `evaluate()` updates but the adapter never persists, i.e. a silent, partial version of the very bug being fixed. One exported function makes that drift unrepresentable.

### D8 — Serialized, non-blocking writes via a per-session promise chain

Writes are neither raced nor awaited inline.

- **Serialized:** a `writeChains: Map<sessionID, Promise<void>>` gives each session a single-threaded write queue — `chain = chain.then(() => ctx.storage.set(key, snapshot)).catch(logWarnOnce)`. Two unordered concurrent `set()` calls on the same key could otherwise land out of order and persist an older state over a newer one.
- **Non-blocking:** the handler enqueues onto that chain and returns immediately; it does not `await` the write. Disk I/O must not sit on the hot `execute.after` tool-hook path, which fires for every tool call host-wide.
- **Terminal `.catch`:** each link swallows its own error so one failed write cannot reject the chain and poison every subsequent write for that session, and so no unhandled rejection escapes.

**Placement:** the enqueue happens immediately after `evaluate()` returns, *before* the delivery loop (`ctx.session.synthetic`, `ctx.session.switchAgent`). `evaluate()` is where state changes; delivery is a long sequence of awaits during which a crash would lose an already-committed state update. Persist at the commit point, not at the end of the handler.

*Alternative rejected:* a single global write chain for all sessions. Simpler, but couples unrelated sessions' write latency together for no correctness gain — the ordering hazard is per-key.

### D9 — Fail-open on every storage error

Any `get`/`set`/`remove` rejection is caught, logged as a warning (deduplicated per session so a persistently failing backend cannot flood the log), and treated as "no prior state exists". Never thrown, never fatal to event processing, and never a reason to disable a rule.

This is not merely graceful degradation — it is *exactly today's behaviour*. In-memory-only is what every session gets right now, and it is a correct, shipped, documented mode of operation. Degrading to it is a return to a known-good baseline, not a novel failure state. The alternative — surfacing a storage failure as an event-processing error — would convert a cosmetic durability loss into a total loss of instruction injection.

### D10 — Key scheme: one entry per session

`modifierState:<sessionID>`, holding the whole per-session bag.

A per-session+rule key scheme would fragment the one thing `evaluate()` guarantees: that all rules' updates for an event commit together. Reconstructing that from N independent keys would require either N reads with no atomicity or a `scan()` per session, and would allow a crash to persist a half-committed cross-rule state — precisely the inconsistency the existing commit-together design prevents. A whole-state value makes the storage commit granularity match the evaluation commit granularity.

The `modifierState:` prefix also keeps the keyspace `scan()`-able, should a future maintenance or inspection need arise.

### D11 — Unconditional cleanup on `session.deleted`

V2 emits a real `session.deleted` event. Subscribe to it and enqueue `ctx.storage.remove('modifierState:' + sessionID)` **on the same per-session write chain** — ordering matters here too: a removal racing an in-flight write could otherwise be overtaken, resurrecting the entry after deletion. After the removal settles, drop the session's entries from `sessionStates`, `writeChains`, `lastPersisted`, `sessionAgents`, and `switchAgentLoggedFor`, so in-memory growth is bounded by the same signal.

*Alternative rejected:* an age-based sweep over `scan({prefix: 'modifierState:'})` using `updatedAt`. It needs a heuristic TTL that is either too short (deleting live long-running sessions' state — reintroducing the bug) or too long (unbounded in practice), plus a scheduler the plugin currently does not have. An exact deletion signal beats a guess, and the `session.deleted` event is exactly that signal.

Note the fail-open consequence: if the plugin is not running when a session is deleted, that session's entry is orphaned. This is a small, bounded leak of a few dozen bytes per missed deletion, not a correctness problem — an orphaned key is never read again, because keys are addressed by an id that no longer resolves to a session.

### D12 — `sessionAgents` and `switchAgentLoggedFor` stay in memory

Both are deliberately excluded, for different reasons.

`sessionAgents` is a **cache, not state**. Its authoritative source is `ctx.session.get({sessionID})`, which `resolveAgent()` already calls on a miss, and which is itself backed by opencode's own durable session store. Losing the cache on restart costs exactly one extra API call per session. Persisting it would be strictly worse than the cache miss: a stale persisted agent could be read back *after* the user switched agents through some path the plugin never observed, causing agent-filtered rules to evaluate against a wrong agent — trading a free correctness property (re-read from source of truth) for a staleness bug, to save one call.

`switchAgentLoggedFor` is **purely cosmetic**. It exists so the "persistently switched session" warning is logged once per session per rule rather than on every delivery. Its total consequence on restart is one additional log line. It has no effect on which rules fire, what is delivered, or what state is tracked. Persisting it would mean paying storage traffic, a serialization format, and a hydration path to suppress a duplicate log line.

Neither is part of the durability gap the proposal describes, and including either would widen the change's blast radius for no user-visible benefit.

### D13 — Defensive `ctx.storage` capability guard

`if (!ctx.storage?.get)` → log one warning at setup and run the entire in-memory-only path (equivalently: behave as if `modifierEventKinds` were empty). This follows the existing precedent in this very file, which already guards `if (ctx.tool?.hook)` before registering the tool hook.

`ctx.storage` is confirmed present at the pinned floor version, so this is insurance rather than necessity — but it is cheap insurance against a host that ships a reduced context, and it has a concrete immediate payoff: the existing `test/plugin-conformance.test.js` fake V2 ctx does not define `storage`, so the guard is what keeps that entire shared suite passing unchanged. That makes the guard a continuously exercised path, not dead defensive code.

**Refinement found during implementation:** the warning is only logged when `modifierEventKinds` is non-empty — i.e. only when the loaded rule set actually contains a rule that would benefit from persistence. A rule set with no `once`/`edge` rules never touches storage either way, so warning about its absence would be noise; this also keeps the existing conformance suite's "no warn lines" assertions passing without loosening them, since none of its fixture rules use modifiers.

### D14 — Debug-mode hydration logging

When `debug` is on, log at hydration time which rule ids were hydrated and with what `{lastMatch, fired}` values. This is the diagnosability answer to D15: when a maintainer is surprised that a `once` rule did not fire after a restart, the first question is "what state did it resume from?", and this log answers it directly with no storage spelunking.

### D15 — Accepted behaviour change: no more "restart to reset a stuck rule"

Today, restarting the opencode service implicitly clears all modifier state. That is a bug from the durability standpoint, but it has an informal use as a reset mechanism. After this change, on V2, a rule id that is **edited, removed and later re-added, or repurposed to a different meaning** will resurrect its prior `fired`/`lastMatch` state from storage, because identity is the rule id and nothing else.

This is documented, not engineered around. The manual reset procedure — delete the plugin's persisted storage entries for the session, or simply use a new rule id — is to be captured in the later README update. No config knob is being added: a knob to disable persistence would reintroduce the exact bug this change closes, and a knob to reset state duplicates what changing the rule id already achieves for free.

The alternative of versioning state by a hash of the rule body (so an edited rule loses its state automatically) was considered and rejected: it makes a whitespace or instruction-wording edit silently re-arm a `once` rule, which is a more surprising failure mode than the one it fixes, and it is not what the spec's "stable `id`" language promises.

### D16 — Positive side effect worth naming

A `once`-gated `switchToAgent` rule currently redundantly re-switches an already-switched V2 session after every restart, because the `once` gate is wiped while the session-level agent switch (which is persistent on V2) is not. Persisting the `once` state eliminates that redundant re-switch as a direct consequence — a second, independent user-visible improvement from the same fix, worth an acceptance scenario in the spec delta.

### D17 — Pre-existing staleness: unchanged, not fixed

An agent-filtered rule with `edge: "fall"` can sit at a stale `lastMatch: true` indefinitely while the session runs under a non-matching agent, because `matchesAgents()` is checked *before* condition evaluation — a filtered-out rule's state is never updated, so it cannot observe the true→false transition it is waiting for.

Persistence makes that staleness longer-lived (it now survives restarts too) but does not introduce it, and does not make any individual event behave differently. It is explicitly out of scope; fixing it means changing filter-vs-evaluation ordering, which is a semantic change to `evaluate()` affecting rules that have nothing to do with durability.

### D18 — Plugin-id namespacing

`ctx.storage` is namespaced by the plugin's own id at the host level (`PLUGIN_NAME`, `'opencode-auto-instruct'`). Renaming the plugin would silently orphan all previously persisted state — which fails open to "no prior state", not to an error, so it is a note rather than a hazard.

### D19 — Test placement: a new V2-only file

New tests go in a **new file, `test/plugin-v2-storage.test.js`**, with unit tests for the two `core.js` pure helpers added to the existing `test/core.test.js`.

Rationale, in three parts:

1. `test/plugin-conformance.test.js` exists for one stated purpose — a *shared* suite run against both a fake V1 host and a fake V2 ctx, so the adapters cannot drift. This feature has no V1 counterpart by design (D-context), so a durability test has nothing to conform to and would sit awkwardly in a parity suite.
2. Adding `storage` to the shared `makeFakeV2Ctx` would change what every existing V2 conformance test exercises, and would remove the incidental-but-valuable coverage that the storage-less fake currently gives the D13 capability guard.
3. The concurrency tests need a fake storage whose `get()` resolution can be **deferred and released by the test** — that is the only way to assert single-flight (start two handlers, hold the read open, release, assert exactly one `get` call and one shared state object). Building a deferred-promise harness into the shared fake, where no other test wants it, is the wrong place for it.

Scenarios the new file should cover: hydrate-on-restart round-trip; single-flight under two simultaneous events; malformed payloads of each rejected shape (non-object, array, wrong `v`, bad entry values, `__proto__` key); dirty-check suppressing a redundant write; write-chain ordering; `get`/`set` rejection fail-open; `session.deleted` removal; and zero storage calls when no loaded rule uses modifiers.

## Component Breakdown

| Component | Work kind | Done when |
|---|---|---|
| `ruleUsesModifiers(rule)` exported from `core.js`; `evaluate()` refactored to call it | Application code (JS, pure) | `evaluate()` has no inline modifier condition left; existing modifier tests pass unchanged |
| `serializeModifierState(sessionState)` / `hydrateSessionState(payload)` in `core.js` | Application code (JS, pure) | Round-trips a populated state; every malformed input in D2 returns a valid empty state without throwing; `__proto__` key does not pollute |
| `modifierEventKinds` precomputation at rule load | Application code (JS, pure) | Empty for a modifier-free rule set; excludes modifier rules lacking an `id` |
| Async single-flight `getSessionState` in `plugin.v2.js` | Application code (JS, async) | Two concurrent first-touch events produce exactly one `storage.get` and one shared state object |
| Per-session write chain + dirty-check persist in `plugin.v2.js` | Application code (JS, async) | A state transition writes once; a no-op evaluation writes zero times; writes land in order; handler does not await the write |
| `session.deleted` subscription + cleanup | Application code (JS, async) | `storage.remove` is called with the right key, ordered after pending writes; all per-session in-memory maps are cleared |
| `ctx.storage` capability guard | Application code (JS) | Existing conformance suite passes against the storage-less fake ctx; one warning logged at setup |
| Debug hydration logging | Application code (JS) | With `debug` on, hydrated rule ids and their values appear in stderr |
| `test/plugin-v2-storage.test.js` + `core.js` helper tests | Test code | The D19 scenario list is covered and green |
| Spec delta (`rule-based-instruction-injection`) | Spec authoring — **engineer-owned, not written here** | New "Modifier State Durability" requirement plus the one-sentence link from "Condition Evaluation", per `proposal.md` — Capabilities |
| `README.md` "Known limitation" update | Documentation | States V2 persists across restart and V1 does not; records the D15 manual-reset note |

## Risks / Trade-offs

- **Stored state outlives a rule's meaning (D15).** A reused or repurposed rule id resurrects state that no longer corresponds to the rule's current intent → Mitigated by debug hydration logging (D14), a documented manual-reset procedure, and the guidance that a changed rule should get a new id. Accepted, not engineered around.
- **Concurrent processes share one SQLite KV table.** The storage backend is a shared global table, confirmed by source read — not per-process-isolated. Two opencode processes touching the *same* session's key can last-write-wins over each other → Accepted, documented edge case. No distributed locking will be added: the scenario requires two live processes on one session, the loss is one session's modifier state, and the failure is the same in-memory-only behaviour that ships today.
- **Async `getSessionState` widens the interleaving surface in `handleNormalizedEvent`.** A new await point exists where none did before → Mitigated by the promise-caching single-flight design (D1), which makes the second caller's path a plain `await` on an existing promise rather than a second hydration, and by the concurrency tests in D19 that drive both intake paths simultaneously.
- **Storage latency on the tool-hook hot path.** `execute.after` fires for every tool call host-wide → Mitigated by non-blocking enqueued writes (D8), the dirty-check that suppresses the common no-change case (D5), event-kind gating that skips storage entirely for non-modifier kinds (D6), and the once-per-session-per-process cost of the hydration read.
- **Fail-open hides a persistently broken storage backend.** A silently degrading store looks exactly like the status quo → Mitigated by a deduplicated warning per session on first failure (D9); deliberately not escalated further, since the alternative is losing instruction injection entirely over a durability-only fault.
- **V1/V2 behavioural divergence becomes permanent.** The two adapters now differ in an observable way → Accepted and made explicit: it is forced by the runtime, is recorded in the spec delta as a stated V1 non-guarantee, and `ruleUsesModifiers` (D7) keeps the *evaluation* semantics — the part that could silently drift — identical on both sides.

## Migration Plan

No data migration and no rollout sequencing are required. Sessions already running when the change ships simply find no stored entry and take the fail-open path, which is today's behaviour; they begin persisting from their next modifier-affecting event onward.

Rollback is a plain revert: the persisted entries become unread orphans, bounded and harmless, and V2 returns to in-memory-only. Because `evaluate()`, `createSessionState()`, and the config schema are all unchanged, nothing outside `plugin.v2.js` and the new `core.js` helpers has to be undone.
