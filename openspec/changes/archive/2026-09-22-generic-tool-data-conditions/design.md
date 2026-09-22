# Design

## Context

See `proposal.md` — *Why* for motivation. This section records only the
current-state facts and verified external shapes that constrain the approach.

### Current state

- `src/core.js` holds twelve condition evaluators, nine of which read
  `NormalizedEvent.todos` and two of which (`prevTodos`,
  `allTodosCompleteOnceFired`) require per-session mutable state committed
  *after* the rule loop, so every rule in one event sees the same prev/current
  pair.
- `V2_UNSUPPORTED_CONDITION_TYPES` / `V2_UNSUPPORTED_EVENT_TYPES` are the only
  load-time validation the plugin performs today, and they are V2-only.
- `src/plugin.v1.js`'s `normalize()` sets `toolName` only when
  `event.type === 'tool.execute.after'`. V1 emits no generic-bus event with
  that type, so `toolName`/`toolNameIn` are dead code on V1 today.
- `src/plugin.v2.js`'s `normalizeToolEvent()` reads `tool`, `sessionID`, and
  `agent` from the `ctx.tool.hook('execute.after', …)` payload and discards
  `result` entirely.

### Verified runtime shapes (source of truth for this design)

Re-read from the installed type definitions, not from memory:

| Fact | Source | Shape |
| --- | --- | --- |
| V1 tool-completion event | `@opencode-ai/sdk` `EventMessagePartUpdated` | `{type: "message.part.updated", properties: {part: Part, delta?}}` — **no `properties.sessionID`** |
| V1 tool part | `ToolPart` | `{id, sessionID, messageID, type: "tool", callID, tool, state, metadata?}` |
| V1 completed tool state | `ToolStateCompleted` | `{status: "completed", input, output: string, title, metadata: {…}, time, attachments?}` |
| V2 tool hook payload | `@opencode/plugin` `ToolHooks["execute.after"]` | `{tool, sessionID, agent, messageID, id, input} & ({status: "completed", result} \| {status: "error", error})` |
| V2 tool result | `@opencode/schema/tool` `Result` | `{…, metadata?: Readonly<Record<string, any>>}` |

Two consequences this design depends on:

1. The session ID for a V1 tool completion lives at `properties.part.sessionID`
   — nested inside the part, not on the envelope.
2. `ToolPart` carries **two** distinct metadata slots: an optional top-level
   `part.metadata` and the required `state.metadata` on a completed state. They
   are not the same field.

### Re-confirmed non-issues

Two concerns raised during proposal review were re-verified and are **closed**,
recorded here so they are not re-opened later:

- The `EventTodoUpdated` type visible in `@opencode-ai/sdk`'s `/v2` generated
  sub-export is a legacy generated artefact for a different remote-API variant.
  The real V2 plugin SDK (`@opencode/plugin`, `@opencode/schema`) contains no
  such type and no emitter for it — confirmed by direct grep of those packages.
  V2 genuinely has no todo event.
- V2's `ctx.event.subscribe()` envelope for `session.created` and
  `session.step.ended` really is `data`-shaped, exactly as `plugin.v2.js` and
  the current spec's *Event-to-Session Resolution* requirement already state.

## Goals / Non-Goals

**Goals**

- One runtime-neutral tool-completion event carrying a `toolMetadata` payload,
  emitted identically by both adapters.
- A condition vocabulary that is entirely tool-agnostic: no plugin code knows
  any tool's name or payload schema; all tool-specific knowledge lives in
  operator-authored rule configuration.
- Orthogonal `once` / `edge` rule modifiers that generalise the ad-hoc
  transition semantics the removed todo conditions hardcoded.
- Restore load-time validation coverage lost with the removal of the
  `V2_UNSUPPORTED_*` sets, and give migrating users actionable errors.

**Non-Goals**

- Boolean combinators across conditions (`all` / `any` / `not`) — see D5.
- Any expression language, regex, or dynamic evaluation over metadata — see D6.
- Conditions triggered by *failed* tool calls — see D3.
- Bounded/evicting per-session state — see T3.
- Rewriting the downstream `ai-dotfiles` rules — a separate follow-up (see
  *Migration Plan*).

## Decisions

### D1 — Synthetic, runtime-neutral event kind `tool.execute.after`

A completed tool call normalizes to `kind: "tool.execute.after"` on **both**
runtimes. On V2 this is unchanged (the hook's own name). On V1 this kind is
**synthetic** — it is emitted by the adapter in response to a
`message.part.updated` raw event, and deliberately does *not* pass through the
raw event's `type` string.

*Rationale.* Rule configuration (`event: "tool.execute.after"`) must be portable
across runtimes; a config authored for one host must behave identically on the
other. Naming the normalized kind after V1's raw event (`message.part.updated`)
would leak a V1 implementation detail into every config file, and naming it
differently per runtime would make portable configs impossible.

*Alternative rejected.* Emit `kind: "message.part.updated"` on V1 and
`"tool.execute.after"` on V2, documenting both. Rejected: it forces every rule
author to write two rules for one intent, and the difference carries no meaning
to the rule author.

### D2 — V1 tool-completion normalization from `message.part.updated`

The V1 adapter gains a dedicated branch for `message.part.updated` with this
evaluation order:

1. **Cheap early bail.** Return immediately unless
   `part.type === 'tool' && part.state.status === 'completed'` — *before* any
   session-agent resolution, state-map allocation, or debug logging. This event
   is high-frequency (it fires for every streamed part delta), so the hot path
   must terminate on two property reads.
2. **Dedupe.** `message.part.updated` fires repeatedly for the same part as it
   streams, and can re-fire after the terminal completed state. The adapter
   keeps a per-session `Set` of `part.callID` values it has already emitted and
   drops repeats. The Set is created lazily per session, in the same manner as
   the existing `sessionAgents` / `sessionStates` maps.
3. **Session ID.** From `properties.part.sessionID`. This is a *new* extraction
   case: `properties.sessionID` → `properties.info.id` remains the path for all
   other V1 event kinds, so the existing *Event-to-Session Resolution*
   requirement needs a MODIFIED delta adding this case, not a replacement.
4. **Payload.** `toolName` from `part.tool`; `toolMetadata` from
   `part.state.metadata`.

*Explicit exclusion.* `part.metadata` (the optional top-level `ToolPart` field)
is **not** read. It is a different slot with no defined cross-runtime analogue;
only `state.metadata` corresponds to V2's `result.metadata`.

### D3 — `toolMetadata` sourced only from the metadata slot, only on success

`toolMetadata` is populated from `result.metadata` (V2) / `part.state.metadata`
(V1), and from nothing else. `result.output` / `state.output` are never read.
Only successful completions populate it: V2 requires `status === "completed"`,
V1 requires `part.state.status === "completed"`. A failed or errored tool call
yields `toolMetadata: null`.

*Rationale.* The metadata slot is the only structurally-equivalent, portable
field across the two runtimes — V1's `output` is a `string`, V2's result shape
differs, and neither is a schema a dot-path can traverse reliably. Restricting
to metadata keeps the mechanism genuinely tool-agnostic rather than
accidentally string-parsing tool output.

Both restrictions are recorded as accepted trade-offs (T1, T2).

### D4 — Tri-state path resolution: match / no-match / **not applicable**

Applied uniformly to **every** data-predicate condition type. If the configured
dot-path does not resolve to a defined value on the current event's
`toolMetadata` — because the path is absent, or because `toolMetadata` itself is
`null` (the completed tool was not a metadata-bearing call) — the condition is
**not applicable**:

- it does **not** match, **and**
- it does **not** update that rule's `once` / `edge` tracking state for this
  event.

This single rule carries three loads at once. It prevents unrelated tool
completions (`bash`, `read`, `glob`) from clobbering `edge` transition state
meant for a specific tool's data; it defines path-absent handling for
`dataEquals` without a special case; and it makes "not applicable" distinct from
"evaluated to false", which is exactly the distinction edge detection needs.

*Alternative rejected.* Treat an unresolvable path as `false`. Rejected: every
intervening `bash` call would then drive a rule's stored boolean to `false`,
re-arming a `rise` edge and causing spurious repeat firings — the failure mode
that motivated tri-state in the first place.

### D5 — Optional `tool` / `toolIn` scoping field on data conditions

Data-predicate conditions MAY additionally carry `tool: string` or
`toolIn: string[]`, using the same naming and semantics as the existing
`toolName` / `toolNameIn` condition types. When present and the event's
`toolName` does not match, the condition is **not applicable** (identical
handling to D4 — no match, no state update).

This is deliberately belt-and-braces with D4: D4 makes unrelated tools harmless
automatically, `tool`/`toolIn` lets an operator state the intent explicitly and
get the same protection even when two different tools happen to expose the same
path.

*Alternative rejected — full boolean combinators (`all`/`any`/`not` over
conditions).* This would also solve the scoping problem, and more generally.
Rejected as out of scope and YAGNI for this change: it is a substantially larger
schema and evaluator surface, it introduces recursive evaluation and nested
edge-state questions this change has no requirement for, and a single optional
scalar field solves the one concrete case at hand. If a real rule later needs to
conjoin two independent predicates, revisit then.

### D6 — Array matcher shape: `{field, value}`, no expressions

`dataArrayAllMatch` / `dataArrayAnyMatch` / `dataArrayNoneMatch` take a matcher
object `{field: string, value: <scalar>}`. For each array element, `field` is
resolved as a dot-path **relative to that element**, and the resolved value is
compared to `value` using D7's deep-equality rule. `field: ""` compares the
element itself, supporting arrays of scalars.

**Hard constraint:** no expression language, no `eval` / `new Function`, and no
regex evaluation of any kind. Tool metadata is untrusted input produced by
arbitrary third-party tools; an expression evaluator over it would be a code
execution sink, and a regex evaluator over it a ReDoS sink.

### D7 — `dataEquals` uses deep structural equality

Primitives compare by strict equality; arrays and objects compare recursively by
value — standard deep-equal semantics (as in Node's `assert.deepStrictEqual`).

*Alternatives rejected.* Reference equality is useless for freshly-deserialised
metadata. `JSON.stringify` comparison produces key-order-dependent false
negatives and throws on cycles.

### D8 — `dataNumberAtLeast: {path, value: number}`

A new condition type mirroring the removed `todoCountAtLeast`. Resolves the
path, requires `typeof === "number"`, compares `>= value`. A non-numeric or
absent resolved value is **not applicable** per D4 — not `false`.

### D9 — Separate named condition types, not a single `{path, op, value}` shape

The vocabulary is eight named types: `dataArrayEmpty`, `dataArrayNonEmpty`,
`dataArrayLengthAtLeast`, `dataArrayAllMatch`, `dataArrayAnyMatch`,
`dataArrayNoneMatch`, `dataEquals`, `dataNumberAtLeast`.

*Rationale.* Consistency with the existing schema style — `toolName`,
`toolNameIn`, and `messageFinished` are already separate named types — and each
named type admits a precise load-time validation message ("`dataArrayAnyMatch`
requires a `{field, value}` matcher") instead of a generic one.

*Alternative rejected.* A single generic `{path, op, value}` condition with an
`op` enum. Rejected: it is terser in the schema but produces worse diagnostics,
breaks the established naming style mid-file, and the operator surface is the
same size either way since each `op` still needs documenting.

### D10 — Dot-path resolver semantics

- Split the path on `.`; each segment is an object-key lookup, or an
  array-index lookup when the segment is all digits.
- **Reject** any segment equal to `__proto__`, `constructor`, or `prototype` —
  treat the path as not-applicable (D4), do not throw. Metadata is
  tool-supplied, untrusted input, and a prototype-chain traversal from untrusted
  data is a pollution/escape vector.
- Keys containing a literal `.` are unaddressable by this resolver. This is a
  documented limitation, not a bug — no escaping syntax is introduced.
- **No artificial depth limit.** Rule configuration is operator-authored, read
  from the operator's own config file and plugin options; the threat model
  treats *config* as trusted and *tool metadata* as untrusted. Depth comes from
  config, not from metadata, so a depth cap protects nothing. This assumption is
  stated explicitly so a later change can revisit it if config ever becomes
  remotely sourced.

### D11 — `once` / `edge` require a stable rule `id`

`id` already exists as an optional rule field. When a rule sets `once: true` or
`edge: "rise" | "fall"` **without** an `id`, the plugin logs **one** warning at
load time — naming the rule by index and instruction prefix, since it has no id
— and the modifier is treated as absent for that rule.

This **fails closed** in the safe direction: the rule keeps working as an
unmodified rule rather than crashing the load or silently inventing an unstable
identity (an array index or instruction hash) that would change meaning the next
time the config is edited.

`once` state is marked "fired" after the rule loop completes for that event,
**regardless of whether delivery succeeded** — preserving the exact semantics of
the `allTodosCompleteOnce` behaviour being replaced.

### D12 — Per-rule `edge`/`once` state; batch-commit invariant preserved

The removed shared-`prevTodos` invariant is replaced by an equivalent per-rule
one, which must be documented as a requirement in its own right:

> Within a single normalized event, every rule's condition is evaluated against
> state as it stood **before** this event; all rules' `once`/`edge` state
> updates are committed together **after** the full rule loop for that event
> completes.

This is the same "batch commit, not read-your-own-write" guarantee the current
implementation gives via `prevTodos`, keyed per-rule instead of globally.

Per-rule evaluation order:

1. Resolve the raw condition value — with D4's (and D5's) not-applicable check
   **first**. Not-applicable short-circuits immediately: no match, no state
   update, no further steps.
2. Apply `edge` transition filtering against that rule's stored prior boolean.
3. Apply `once` gating.
4. Fire if all pass.

**State contents.** Edge/once state stores **only a boolean** — the last
resolved match/no-match — and never the resolved data value. Tool metadata can
be arbitrarily large and may contain file contents or credentials; it must not
be retained in session state.

### D13 — `once`/`edge` are documented under *Condition Evaluation*

Placement decision: `once` and `edge` are rule-level modifiers, but they belong
in the **Condition Evaluation** requirement rather than a new requirement or
*Instruction Delivery*.

*Rationale.* They gate whether a condition's match is *honoured* — they are
stateful filters layered directly on the condition result, and they replace
semantics (`todoListCreated`, `allTodosCompleteOnce`) that lived in that
requirement's own vocabulary. *Instruction Delivery* begins once a rule has
matched and is strictly about how the message reaches the session; putting a
match-gating modifier there would split one decision across two requirements. A
separate requirement was rejected because the modifiers are meaningless without
a condition result to gate and cannot be specified independently of it.

### D14 — Condition-less rules combined with modifiers

An absent `condition` is always-true. Combined with the modifiers this yields
two behaviours that must be documented with explicit scenarios, because they are
non-obvious:

- `once: true` — fires on the first matching event of the rule's configured kind
  in the session, and never again.
- `edge: "rise"` — fires **only on the very first event of that kind** in the
  session. The internal boolean has no prior `false` state to rise from except
  session start; thereafter it is permanently `true → true`, so no further rise
  ever occurs.

### D15 — Debug-mode observability, with a hard redaction constraint

When `debug: true`, every normalized tool-completion event logs the tool name
and the **key paths** present in `toolMetadata` — top level plus one level of
nesting, no deeper.

**Hard rule, not a suggestion:** the resolved **values** are never logged.
Optionally each key path may be annotated with the value's `typeof` and, for
arrays, its length. Nothing else. Arbitrary tool metadata may contain file
contents, command output, tokens, or credentials, and debug logs are routinely
pasted into issues.

### D16 — Load-time validation restored and extended

The `V2_UNSUPPORTED_*` static declarations are removed; load-time validation is
re-added in a runtime-neutral form. One warning each, at load time, for:

| Condition | Warning |
| --- | --- |
| Unknown condition type name | generic "unknown condition type" |
| Missing/invalid `path` on any data condition | per-type message |
| Missing `value`/`count` where required | per-type message |
| Malformed matcher on `dataArray*Match` | per-type message |
| `once`/`edge` without `id` (D11) | modifier ignored, rule named by index |
| Condition type is one of the **nine removed legacy names** | **specific** message naming the removed type and pointing at the migration table |
| `event: "todo.updated"` | **specific** message: that event kind is no longer emitted on **any** runtime as of this version |

The last two are deliberately distinct from the generic unknown-type warning: a
user migrating from the previous version hits them, and a message that says
"unknown condition type `allTodosComplete`" would read as a typo rather than as
a removal. The `todo.updated` warning replaces `V2_UNSUPPORTED_EVENT_TYPES` with
a **permanent removal notice** rather than a V2-only limitation notice.

## Migration-equivalence table

Every removed condition type, expressed in the new vocabulary. The payload
assumed below is a `todowrite`/`todoread`-shaped
`{todos: [{status}], counts: {…}}` metadata object.

> **This shape is illustrative only.** It documents how a migrating user maps an
> old rule; it must **not** appear anywhere in plugin code. No production code
> path may reference `todos`, `counts`, `status`, or any tool name.

| Removed type | Replacement condition | Rule modifiers |
| --- | --- | --- |
| `allTodosComplete` | `{type: "dataArrayNoneMatch", path: "todos", field: "status", value: "pending", tool: "todowrite"}` combined with a non-empty guard — or, more directly, `{type: "dataArrayAllMatch", path: "todos", field: "status", value: "completed", tool: "todowrite"}` plus `dataArrayNonEmpty` semantics via the counts path | — |
| `anyTodosComplete` | `{type: "dataArrayAnyMatch", path: "todos", field: "status", value: "completed", tool: "todowrite"}` | — |
| `noTodosInProgress` | `{type: "dataArrayNoneMatch", path: "todos", field: "status", value: "in_progress", tool: "todowrite"}` | — |
| `hasTodos` | `{type: "dataArrayNonEmpty", path: "todos", tool: "todowrite"}` | — |
| `todoListCreated` | `{type: "dataArrayNonEmpty", path: "todos", tool: "todowrite"}` | `edge: "rise"` |
| `todoListCleared` | `{type: "dataArrayEmpty", path: "todos", tool: "todowrite"}` | `edge: "rise"` |
| `firstTodoStarted` | `{type: "dataArrayAnyMatch", path: "todos", field: "status", value: "in_progress", tool: "todowrite"}` | `edge: "rise"` |
| `allTodosCompleteOnce` | same condition as `allTodosComplete` | `once: true` |
| `todoCountAtLeast` | `{type: "dataNumberAtLeast", path: "counts.total", value: N, tool: "todowrite"}` — or `{type: "dataArrayLengthAtLeast", path: "todos", count: N, tool: "todowrite"}` | — |

Note on `allTodosComplete`: the old evaluator required **non-empty and all
completed**. The new vocabulary expresses "all completed" and "non-empty" as two
predicates; the cleanest single-condition equivalent for a payload exposing
counts is `{type: "dataNumberAtLeast", path: "counts.completed", value: 1}`
combined by rule duplication, or a payload-level `counts.pending === 0` check
via `dataEquals`. This is the one place where the removal is genuinely lossy in
a single condition, and it is the concrete case a future combinators change (D5,
rejected here) would resolve.

Every `tool: "todowrite"` above is optional per D5 — D4 already makes the rules
safe without it — but is shown because it is the recommended form.

## Risks / Trade-offs

**T1 — `toolMetadata` reads metadata only; `output`/content is unreachable.**
A tool that returns everything interesting in its output string and nothing in
its metadata cannot drive a data condition at all. → *Accepted trade-off.*
Metadata is the only cross-runtime-portable slot; output shapes differ per
runtime and are unstructured. Mitigation is documentation: state plainly that a
tool must expose structured result metadata to be usable as a condition source.

**T2 — Failed tool calls cannot trigger conditions.**
`toolMetadata` is `null` for errored calls, so every data condition is
not-applicable for them. → *Accepted trade-off.* No current use case requires
failure-triggered instruction injection, and admitting failures would require a
second, differently-shaped error payload in the normalized event. Revisit if a
real use case appears.

**T3 — Per-session state maps grow unbounded.**
`sessionAgents`, `sessionStates`, and now the V1 per-session dedupe `Set` are
never evicted; a long-lived host process accumulates one entry per session
forever. → *Accepted trade-off, explicitly out of scope.* This is a
**pre-existing** pattern (`sessionAgents` predates this change), the per-entry
footprint is small, and fixing it properly needs a session-lifecycle eviction
hook that is its own change. This design adds one more map in the same style
rather than introducing a half-solution alongside the existing unbounded ones.

**T4 — V1 dedupe is best-effort and process-local.**
`callID`-based dedupe only holds within one plugin process lifetime and one
session entry. A host restart mid-session could in principle re-deliver. →
*Accepted.* The failure mode is a duplicate instruction injection, not
corruption, and the same limitation already applies to `once` state.

**T5 — Silent not-applicable is hard to debug.**
D4 makes a mistyped `path` behave identically to a legitimately absent one: the
rule simply never fires, with no error. → *Mitigated* by D15's debug key-path
logging (which shows the operator exactly which paths *are* present) and by
D16's load-time `path` validation (which catches a missing or non-string `path`,
though not a wrong one). Residual risk accepted: a *wrong-but-well-formed* path
cannot be distinguished from a legitimately-absent one at load time, because the
plugin has no schema for any tool by design.

**T6 — Breaking change with no shim.**
Nine condition types and one event kind disappear with no deprecation period. →
*Mitigated* by D16's two specific load-time warnings and the migration table
above, plus the human-gated deployment boundary described below. Accepted: a
compatibility shim would have to keep the todo-specific evaluators alive, which
is precisely what this change removes.

**T7 — `edge` semantics for condition-less rules are counter-intuitive.**
`edge: "rise"` with no condition means "first event only" (D14) — a reading most
operators will not reach unaided. → *Mitigated* by requiring explicit spec
scenarios for both D14 cases, so the behaviour is contract-tested rather than
emergent.

## Migration Plan

**Sequencing with the downstream `ai-dotfiles` consumer.** No SemVer range
coordination exists or is needed: `ai-dotfiles` pins this plugin by an explicit
commit SHA in `.chezmoiexternal.yaml`, advanced only by a deliberate `make bump`
or a manual SHA edit. That pin is already a safe, human-gated deployment
boundary — a breaking change here cannot reach the consumer until a human moves
the pin.

The intended sequence is therefore:

1. Complete and release this change in full, including the `package.json`
   version bump reflecting the break.
2. **Then**, in a separate follow-up commit in `ai-dotfiles`: bump the pinned
   SHA and rewrite the four existing rules to the new schema **together**, so
   the consumer never sits at a commit where the pin and the rules disagree.

No additional coordination mechanism is required, and none is designed here.

**Rollback.** Revert the pin SHA in `ai-dotfiles`; the plugin's own release is
independently revertable since it has no persisted state or migrations.

**Documentation updates in scope for this change.**

- `README.md`: document the new condition schema and the `once`/`edge`
  modifiers; include the migration table. Additionally **fix the install
  section**, which currently references the non-existent `src/index.js` — it
  must reference `src/plugin.v1.js` / `src/plugin.v2.js`, or the `package.json`
  `exports` map.
- `docs/v2-compat-audit.md`: remove the now-inaccurate claims that V1 emits a
  `tool.execute.after` generic event and that V2 has a permanent todo-condition
  gap.

## Component Breakdown

| # | Component | Work kind | Done criterion |
| --- | --- | --- | --- |
| 1 | `core.js` — dot-path resolver (D10) with prototype-segment rejection and tri-state return | Application code (JS) | Resolves nested keys and numeric indices; returns not-applicable for absent paths and for `__proto__`/`constructor`/`prototype` segments; unit-tested including the pollution cases |
| 2 | `core.js` — deep-equality helper (D7) | Application code (JS) | Key-order-independent; handles nested arrays/objects and primitives; unit-tested against the ordering false-negative case |
| 3 | `core.js` — the eight data-predicate evaluators (D6, D8, D9) plus `tool`/`toolIn` scoping (D5) | Application code (JS) | Each type returns match / no-match / not-applicable per D4; no `eval`, `Function`, or regex anywhere in the path |
| 4 | `core.js` — `once`/`edge` modifier handling and per-rule state (D11, D12) | Application code (JS) | Evaluation order as D12; boolean-only state; batch-commit-after-loop invariant holds across multiple rules in one event, proven by test |
| 5 | `core.js` — removal of the nine todo evaluators, `prevTodos`, and both `V2_UNSUPPORTED_*` sets | Application code (JS) | No `todos` field remains on `NormalizedEvent`; no reference to any tool name or payload key in `src/` |
| 6 | `core.js` — load-time validation (D16) | Application code (JS) | Every row of D16's table emits exactly one warning; the two migration-specific warnings are textually distinct from the generic unknown-type warning |
| 7 | `plugin.v1.js` — `message.part.updated` normalization (D2) | Application code (JS) | Early bail before any resolution/logging; `callID` dedupe; session ID from `properties.part.sessionID`; metadata from `part.state.metadata` only |
| 8 | `plugin.v2.js` — read `result.metadata` on `status === "completed"` (D3) | Application code (JS) | `toolMetadata` populated on success, `null` on error |
| 9 | Both adapters — debug key-path logging (D15) | Application code (JS) | Key paths to depth 2 plus optional `typeof`/length; a test asserts no metadata **value** appears in the emitted log line |
| 10 | V1 test fixtures built from the real SDK shapes | Test code (JS) | Fixtures mirror `EventMessagePartUpdated` / `ToolPart` / `ToolStateCompleted` exactly, **including `part.sessionID` nesting** — not hand-invented shapes. This is the direct corrective for how the original `tool.execute.after` dead-code bug went undetected: a hand-written fixture agreed with the wrong code |
| 11 | Bug-fix-in-isolation test | Test code (JS) | At least one scenario proves `toolName`/`toolNameIn` fire on V1 via the real `message.part.updated` path with **no data condition present**, verifying the fix independently of the new mechanism |
| 12 | Spec scenarios for D14's two condition-less modifier cases | Spec (Markdown) | Both `once`-without-condition and `edge: "rise"`-without-condition behaviours are contract-tested scenarios |
| 13 | `README.md` + `docs/v2-compat-audit.md` updates, incl. the `src/index.js` fix | Documentation | New schema documented; migration table present; install path corrected; stale V1/V2 claims removed |
| 14 | `package.json` version bump | Configuration | Version reflects the breaking change |
